import * as fs from "node:fs";
import * as path from "node:path";
import { createWorker, Worker } from "tesseract.js";
import type { NormRect } from "../core/geometry";
import type { OCRLine } from "../core/engine";
import type { Bitmap } from "../core/imageOps";
import { resizeBilinear } from "../core/imageOps";
import { mergeRowFragments } from "../core/lines";
import { encodePng } from "./png";

export interface OcrProvider {
  /** Recognizes text lines in an image; rectangles are normalized (top-left origin). */
  recognize(bitmap: Bitmap): Promise<OCRLine[]>;
  dispose?(): Promise<void>;
}

/** Inside a packaged Electron app, native-ish assets live in app.asar.unpacked. */
export function unpacked(p: string): string {
  return p.replace(/app\.asar(?![.\w])/, "app.asar.unpacked");
}

interface TessSymbol { text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }
interface TessWord { text: string; bbox: { x0: number; y0: number; x1: number; y1: number }; symbols?: TessSymbol[] | null }
interface TessLine { text: string; bbox: { x0: number; y0: number; x1: number; y1: number }; words: TessWord[] }

/**
 * Builds an OCRLine whose text is the words joined by single spaces, remembering the pixel box of every
 * character so a regex match inside the line can be redacted precisely instead of the whole line.
 */
export function lineFromTesseract(line: TessLine, width: number, height: number): OCRLine | null {
  let text = "";
  const spans: { start: number; end: number; box: NormRect }[] = [];
  const norm = (b: { x0: number; y0: number; x1: number; y1: number }): NormRect => ({
    left: b.x0 / width, top: b.y0 / height, right: b.x1 / width, bottom: b.y1 / height,
  });
  for (const word of line.words ?? []) {
    if (!word.text || !word.text.trim()) continue;
    if (text.length > 0) text += " ";
    if (word.symbols && word.symbols.length > 0) {
      for (const s of word.symbols) {
        if (!s.text) continue;
        spans.push({ start: text.length, end: text.length + s.text.length, box: norm(s.bbox) });
        text += s.text;
      }
    } else {
      // A partial match still covers the whole word if character boxes are unavailable.
      spans.push({ start: text.length, end: text.length + word.text.length, box: norm(word.bbox) });
      text += word.text;
    }
  }
  if (text.trim().length === 0) return null;
  const rect = norm(line.bbox);
  return {
    text,
    rect,
    rangeRect: (start, end) => {
      const hit = spans.filter((s) => s.end > start && s.start < end);
      if (hit.length === 0) return null;
      return hit.reduce<NormRect>(
        (acc, s) => ({
          left: Math.min(acc.left, s.box.left), top: Math.min(acc.top, s.box.top),
          right: Math.max(acc.right, s.box.right), bottom: Math.max(acc.bottom, s.box.bottom),
        }),
        { left: 1, top: 1, right: 0, bottom: 0 },
      );
    },
  };
}

export interface TesseractOcrOptions {
  /** Directory containing eng.traineddata(.gz). Defaults to the bundled model. */
  langPath?: string;
  lang?: string;
  /** Longest side fed to Tesseract; larger screenshots are downscaled (faster, little accuracy loss). */
  maxSide?: number;
  /** Tesseract page segmentation mode (default "3", automatic layout analysis). */
  pageSegMode?: string;
}

/** Our wrapper (compiled build) when present, else the stock worker (running from TypeScript sources in tests). */
function workerEntry(): string {
  const wrapper = path.join(__dirname, "ocr-worker.js");
  return fs.existsSync(wrapper) ? wrapper : unpacked(require.resolve("tesseract.js/src/worker-script/node/index.js"));
}

export function defaultLangPath(): string {
  const pkg = require.resolve("@tesseract.js-data/eng/package.json");
  return unpacked(path.join(path.dirname(pkg), "4.0.0_best_int"));
}

export class TesseractOcr implements OcrProvider {
  private worker: Promise<Worker> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: TesseractOcrOptions = {}) {}

  private getWorker(): Promise<Worker> {
    if (!this.worker) {
      const lang = this.opts.lang ?? "eng";
      this.worker = (async () => {
        const w = await createWorker(lang, 1, {
          langPath: this.opts.langPath ?? defaultLangPath(),
          gzip: true,
          cacheMethod: "none", // never write to disk or download: the model ships with the app
          workerPath: workerEntry(),
          corePath: unpacked(path.dirname(require.resolve("tesseract.js-core/package.json"))),
        });
        if (this.opts.pageSegMode) await w.setParameters({ tessedit_pageseg_mode: this.opts.pageSegMode as never });
        return w;
      })();
      this.worker.catch(() => { this.worker = null; });
    }
    return this.worker;
  }

  async recognize(bitmap: Bitmap): Promise<OCRLine[]> {
    const maxSide = this.opts.maxSide ?? 2400;
    const longest = Math.max(bitmap.width, bitmap.height);
    let input = bitmap;
    if (longest > maxSide) {
      const s = maxSide / longest;
      input = resizeBilinear(bitmap, Math.max(1, Math.round(bitmap.width * s)), Math.max(1, Math.round(bitmap.height * s)));
    }
    const png = encodePng(input, 1);
    const worker = await this.getWorker();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const res = await worker.recognize(png, {}, { blocks: true });
    this.idleTimer = setTimeout(() => void this.dispose(), 120_000); // free ~100 MB when idle
    this.idleTimer.unref?.();

    const out: OCRLine[] = [];
    for (const block of res.data.blocks ?? []) {
      for (const para of block.paragraphs ?? []) {
        for (const line of para.lines ?? []) {
          const l = lineFromTesseract(line as unknown as TessLine, input.width, input.height);
          if (l) out.push(l);
        }
      }
    }
    return mergeRowFragments(out, input.width, input.height);
  }

  async dispose(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const w = this.worker;
    this.worker = null;
    if (w) await (await w.catch(() => null))?.terminate();
  }
}
