import { randomUUID } from "node:crypto";
import { NormRect, clampRect, isValidRect, mergeOverlapping, padRect } from "./geometry";
import { JevClient, JevError, JevRequest, Json, JsonObject, Question } from "./jevClient";
import { LocalDetector, LocalMatch } from "./detector";
import { AppSettings, splitLines } from "./settings";

export type FindingSource = "rule" | "local" | "ai" | "visual";

/** One region that will be blacked out. Never stores the sensitive text itself. */
export interface Finding {
  rect: NormRect;
  category: string;
  source: FindingSource;
  confidence?: number;
}

export interface OCRLine {
  text: string;
  /** Whole-line rectangle (top-left origin, normalized). */
  rect: NormRect;
  /** Optional precise rectangle for text[start:end] (UTF-16 offsets). */
  rangeRect?: (start: number, end: number) => NormRect | null;
}

export function rectForRange(line: OCRLine, start: number, end: number): NormRect {
  const precise = line.rangeRect?.(start, end);
  if (precise && isValidRect(precise)) return precise;
  // Without glyph geometry, proportional widths can expose variable-width characters.
  return line.rect;
}

export interface ImagePayload {
  data: Uint8Array;
  format: "png" | "jpg";
}

export interface AnalysisInput {
  lines: OCRLine[];
  localRegions?: Finding[];
  imageWidth: number;
  imageHeight: number;
  /**
   * Produces the image sent to Jev Box with the given rectangles already blacked out, so nothing the
   * earlier stages found ever leaves the machine. Absent/null disables the visual pass.
   */
  imageProvider?: (rects: NormRect[]) => ImagePayload | null | Promise<ImagePayload | null>;
}

export interface AnalysisResult {
  findings: Finding[];
  /** Final merged + padded rectangles to black out. */
  rects: NormRect[];
  warnings: string[];
  aiRan: boolean;
  visualRan: boolean;
}

export function summarize(findings: Finding[]): Record<string, number> {
  const s: Record<string, number> = {};
  for (const f of findings) s[f.category] = (s[f.category] ?? 0) + 1;
  return s;
}

export const AI_CATEGORY = "AI: sensitive text";
const LINES_PER_REQUEST = 40;
const CONTEXT_LINES = 4;
const MAX_QUESTION_LINES = 600;
const MAX_CONCURRENT = 4;
const MAX_VISUAL_TARGETS = 8;

export function readingOrder(lines: OCRLine[]): OCRLine[] {
  return lines
    .filter((l) => isValidRect(l.rect) && l.text.trim().length > 0)
    .sort((a, b) => (Math.abs(a.rect.top - b.rect.top) > 0.004 ? a.rect.top - b.rect.top : a.rect.left - b.rect.left));
}

/** Replaces matched ranges with [HIDDEN]; returns masked text and the fraction of the line covered. */
export function maskText(text: string, matches: LocalMatch[]): { masked: string; covered: number } {
  if (matches.length === 0) return { masked: text, covered: 0 };
  const sorted = [...matches].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  let covered = 0;
  for (const m of sorted) {
    const start = Math.max(m.start, cursor);
    if (m.end <= start) continue;
    out += text.slice(cursor, start) + "[HIDDEN]";
    covered += m.end - start;
    cursor = m.end;
  }
  out += text.slice(cursor);
  return { masked: out, covered: covered / Math.max(1, text.length) };
}

export function lineQuestion(key: string, hide: string, keep: string): JsonObject {
  return Question.noul(
    `Does the text of \`screen.${key}\` contain something described under true? Judge only that one line; the lines around it are context.`,
    {
      true: `The line contains any of: ${hide}. A bare label such as "Password" with no value is not sensitive; the value is.`,
      false: `The line contains only: ${keep}. Text shown as [HIDDEN] was already removed and is not sensitive.`,
    },
  );
}

export function finalRects(findings: Finding[], imageWidth: number, imageHeight: number, paddingPixels: number): NormRect[] {
  const dx = paddingPixels / Math.max(1, imageWidth);
  const dy = paddingPixels / Math.max(1, imageHeight);
  return mergeOverlapping(findings.map((f) => padRect(clampRect(f.rect), dx, dy)));
}

/**
 * Orchestrates the detection stages:
 *   1. local rules on OCR text (offline),
 *   2. Jev text questions about each OCR line (only text leaves the machine, secrets masked),
 *   3. optional Jev Box questions on the image for user-defined visual targets.
 */
export class RedactionEngine {
  constructor(private readonly settings: AppSettings, private readonly client: JevClient | null) {}

  async analyze(input: AnalysisInput): Promise<AnalysisResult> {
    const findings: Finding[] = [...(input.localRegions ?? [])];
    const warnings: string[] = [];
    let aiRan = false;
    let visualRan = false;

    const lines = readingOrder(input.lines);
    const detector = new LocalDetector(this.settings);
    for (const bad of detector.invalidCustomRegexes) warnings.push(`Ignored invalid custom pattern: ${bad}`);

    // Stage 1: local rules.
    const masked: string[] = [];
    let inPrivateKey = false;
    for (const line of lines) {
      const ms = detector.matches(line.text);
      if (this.settings.enabledDetectors.includes("privateKey")) {
        if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line.text)) inPrivateKey = true;
        if (inPrivateKey) ms.push({ start: 0, end: line.text.length, category: "Private key material" });
        if (/-----END [A-Z ]*PRIVATE KEY-----/.test(line.text)) inPrivateKey = false;
      }
      for (const m of ms) findings.push({ rect: rectForRange(line, m.start, m.end), category: m.category, source: "rule" });
      const r = maskText(line.text, ms);
      masked.push(r.masked);
    }

    // Stage 2: Jev text check.
    if (this.settings.aiEnabled) {
      if (this.client) {
        try {
          const flagged = await this.classifyLines(lines, masked, this.client, warnings);
          aiRan = true;
          findings.push(...await this.refineSensitiveWords(lines, masked, flagged, detector, this.client, warnings));
        } catch (e) {
          if (this.settings.abortIfAIUnavailable) throw e;
          warnings.push(`AI check unavailable (${errMsg(e)}); used local rules only.`);
        }
      } else {
        if (this.settings.abortIfAIUnavailable) throw new JevError("missingAPIKey", "No API key is set; the required AI check could not run.");
        warnings.push("No API key set; used local rules only.");
      }
    }

    // Stage 3: optional visual targets via Box.
    if (this.settings.visualEnabled && splitLines(this.settings.visualTargetsText).length > 0) {
      if (this.client) {
        const soFar = finalRects(findings, input.imageWidth, input.imageHeight, this.settings.paddingPixels);
        try {
          const payload = await input.imageProvider?.(soFar);
          if (!payload) throw new JevError("badRequest", "Skipped visual check: image is unavailable or outside the API limits.");
          const v = await this.visualFindings(payload, this.client);
          findings.push(...v.findings);
          warnings.push(...v.warnings);
          visualRan = true;
        } catch (e) {
          if (this.settings.abortIfAIUnavailable) throw e;
          warnings.push(`Visual check unavailable (${errMsg(e)}).`);
        }
      } else {
        if (this.settings.abortIfAIUnavailable) throw new JevError("missingAPIKey", "No API key is set; the required visual check could not run.");
        warnings.push("Visual check skipped: no API key set.");
      }
    }

    const rects = finalRects(findings, input.imageWidth, input.imageHeight, this.settings.paddingPixels);
    return { findings, rects, warnings, aiRan, visualRan };
  }

  private async classifyLines(lines: OCRLine[], masked: string[], client: JevClient, warnings: string[]): Promise<[number, number][]> {
    let candidates: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const alnum = (masked[i].replaceAll("[HIDDEN]", "").match(/[\p{L}\p{N}]/gu) ?? []).length;
      if (alnum >= 2) candidates.push(i);
    }
    if (candidates.length > MAX_QUESTION_LINES) {
      if (this.settings.abortIfAIUnavailable) throw new JevError("badRequest", "Too many text lines to complete the required AI check.");
      warnings.push(`Screenshot has ${candidates.length} text lines; AI-checked the first ${MAX_QUESTION_LINES}.`);
      candidates = candidates.slice(0, MAX_QUESTION_LINES);
    }
    if (candidates.length === 0) return [];

    const requests: JevRequest[] = [];
    const targets: number[][] = [];
    for (let s = 0; s < candidates.length; s += LINES_PER_REQUEST) {
      const group = candidates.slice(s, s + LINES_PER_REQUEST);
      const context = new Set<number>();
      for (const idx of group) {
        for (let i = Math.max(0, idx - CONTEXT_LINES); i <= Math.min(lines.length - 1, idx + CONTEXT_LINES); i++) context.add(i);
      }
      const screen: Record<string, string> = {};
      for (const i of [...context].sort((a, b) => a - b)) screen[`L${i}`] = masked[i];
      const questions: Record<string, JsonObject> = {};
      for (const i of group) questions[`L${i}`] = lineQuestion(`L${i}`, this.settings.aiHideRules, this.settings.aiKeepRules);
      requests.push({
        model: this.settings.textModel,
        state: {
          about: "Text recognized in a screenshot, one entry per line in reading order. [HIDDEN] marks text that was already removed.",
          screen,
        },
        questions,
      });
      targets.push(group);
    }

    const flagged: [number, number][] = [];
    let failure: unknown;
    let failed = 0;
    for (let start = 0; start < requests.length; start += MAX_CONCURRENT) {
      const wave = requests.slice(start, start + MAX_CONCURRENT);
      const settled = await Promise.allSettled(wave.map((r) => client.systemOne(r)));
      settled.forEach((res, k) => {
        if (res.status === "fulfilled") {
          for (const idx of targets[start + k]) {
            const a = res.value.answers[`L${idx}`];
            if (a && a.type === "noul" && a.noul >= this.settings.aiThreshold) flagged.push([idx, a.noul]);
          }
        } else {
          failed++;
          failure = failure ?? res.reason;
        }
      });
    }
    if (failed > 0) {
      if (failed === requests.length || this.settings.abortIfAIUnavailable) throw failure;
      warnings.push(`${failed} of ${requests.length} AI requests failed (${errMsg(failure)}); some lines were only checked by local rules.`);
    }
    return flagged.sort((a, b) => a[0] - b[0]);
  }

  /** Locate sensitive words using text only; preserve the line if localization is incomplete. */
  private async refineSensitiveWords(lines: OCRLine[], masked: string[], flagged: [number, number][],
    detector: LocalDetector, client: JevClient, warnings: string[]): Promise<Finding[]> {
    const words: { line: number; start: number; end: number; text: string }[] = [];
    const fallback = new Set<number>();
    const maxWords = 1600;
    for (const [idx] of flagged) {
      const local = detector.matches(lines[idx].text);
      const tokens = [...lines[idx].text.matchAll(/[\p{L}\p{N}]+(?:[’'_-][\p{L}\p{N}]+)*/gu)]
        .map((m) => ({ line: idx, start: m.index!, end: m.index! + m[0].length, text: m[0] }))
        .filter((w) => !local.some((m) => m.start < w.end && m.end > w.start));
      if (!tokens.length || words.length + tokens.length > maxWords) fallback.add(idx);
      else words.push(...tokens);
    }
    const hits = new Map<number, { start: number; end: number; probability: number }[]>();
    const requests: JevRequest[] = [];
    const groups: number[][] = [];
    for (let start = 0; start < words.length; start += 80) {
      const ids = Array.from({ length: Math.min(80, words.length - start) }, (_, i) => start + i);
      const screen: Record<string, string> = {};
      const candidates: Record<string, Json> = {};
      const questions: Record<string, JsonObject> = {};
      for (const id of ids) {
        const word = words[id];
        screen[`L${word.line}`] = masked[word.line];
        candidates[`W${id}`] = { text: word.text, line: `L${word.line}` };
        questions[`W${id}`] = Question.noul(
          `Should only the word in \`words.W${id}.text\` be hidden? Read \`screen.L${word.line}\` for context. ` +
          "Judge this word, not the entire sentence. For a name or other multi-word sensitive value, judge whether this word belongs to that value.",
          { true: `This word is part of sensitive information: ${this.settings.aiHideRules}.`,
            false: `This word is ordinary wording, an action, a connector, a label, or: ${this.settings.aiKeepRules}. [HIDDEN] is already removed.` });
      }
      requests.push({ model: this.settings.textModel, state: { screen, words: candidates }, questions });
      groups.push(ids);
    }
    for (let start = 0; start < requests.length; start += MAX_CONCURRENT) {
      const responses = await Promise.allSettled(requests.slice(start, start + MAX_CONCURRENT).map((q) => client.systemOne(q)));
      responses.forEach((response, offset) => {
        const ids = groups[start + offset];
        if (response.status === "rejected") {
          if (this.settings.abortIfAIUnavailable) throw response.reason;
          for (const id of ids) fallback.add(words[id].line);
          return;
        }
        for (const id of ids) {
          const answer = response.value.answers[`W${id}`];
          if (answer.type === "noul" && answer.noul >= this.settings.aiThreshold) {
            const word = words[id];
            const selected = hits.get(word.line) ?? [];
            selected.push({ start: word.start, end: word.end, probability: answer.noul });
            hits.set(word.line, selected);
          }
        }
      });
    }
    const findings: Finding[] = [];
    for (const [idx, probability] of flagged) {
      const selected = hits.get(idx)?.sort((a, b) => a.start - b.start) ?? [];
      if (fallback.has(idx) || !selected.length) {
        fallback.add(idx);
        findings.push({ rect: lines[idx].rect, category: AI_CATEGORY, source: "ai", confidence: probability });
        continue;
      }
      const spans: typeof selected = [];
      for (const word of selected) {
        const previous = spans[spans.length - 1];
        if (previous && !lines[idx].text.slice(previous.end, word.start).trim()) {
          previous.end = word.end;
          previous.probability = Math.min(previous.probability, word.probability);
        } else spans.push({ ...word });
      }
      for (const span of spans) findings.push({ rect: rectForRange(lines[idx], span.start, span.end),
        category: AI_CATEGORY, source: "ai", confidence: span.probability });
    }
    if (fallback.size) warnings.push("Some sensitive text could not be located precisely; those lines were hidden in full.");
    return findings;
  }

  private async visualFindings(payload: ImagePayload, client: JevClient): Promise<{ findings: Finding[]; warnings: string[] }> {
    const ref = randomUUID();
    const allTargets = splitLines(this.settings.visualTargetsText);
    if (allTargets.length > MAX_VISUAL_TARGETS && this.settings.abortIfAIUnavailable) {
      throw new JevError("badRequest", "Too many visual targets to complete the required AI check.");
    }
    const targets = allTargets.slice(0, MAX_VISUAL_TARGETS);
    const questions: Record<string, JsonObject> = {};
    targets.forEach((t, i) => {
      // Box has no "not found" answer, so each target also gets a yes/no and a count question.
      questions[`seen${i}`] = Question.noul(`Is there ${t} in \`screenshot\`?`);
      questions[`box${i}`] = Question.box(`${t} in \`screenshot\``);
      questions[`count${i}`] = Question.choice(`How many separate instances of ${t} are in \`screenshot\`?`, {
        none: "There are none.",
        one: "There is exactly one.",
        several: "There are two or more.",
      });
    });
    const response = await client.systemOne({
      model: this.settings.visualModel,
      state: { screenshot: ref },
      questions,
      assets: { [ref]: { type: "image", format: payload.format, data_base64: Buffer.from(payload.data).toString("base64") } },
    });
    const findings: Finding[] = [];
    const warnings: string[] = allTargets.length > MAX_VISUAL_TARGETS ? ["Only the first 8 visual targets were checked."] : [];
    targets.forEach((t, i) => {
      const seen = response.answers[`seen${i}`];
      const box = response.answers[`box${i}`];
      if (!(seen?.type === "noul" && seen.noul >= this.settings.aiThreshold)) return;
      if (!(box?.type === "box" && box.confidence >= this.settings.visualMinConfidence)) return;
      findings.push({ rect: box.box, category: `Visual: ${t}`, source: "visual", confidence: box.confidence });
      const count = response.answers[`count${i}`];
      if (count?.type === "choice" && count.choice === "several") {
        warnings.push(`More than one match for "${t}"; Box returns a single region, so only one was hidden.`);
      }
    });
    return { findings, warnings };
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
