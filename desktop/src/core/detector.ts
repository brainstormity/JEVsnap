import { AppSettings, DETECTOR_TITLES, DetectorKind, splitLines } from "./settings";

export interface LocalMatch {
  category: string;
  /** UTF-16 offsets into the scanned text; end is exclusive. */
  start: number;
  end: number;
}

interface Rule {
  kind: DetectorKind;
  regex: RegExp;
  group: number;
  validator?: (s: string) => boolean;
}

// ---------- validators ----------

export function luhnValid(s: string): boolean {
  const d = [...s].filter((c) => c >= "0" && c <= "9").map(Number);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  d.reverse().forEach((v, i) => {
    if (i % 2 === 1) {
      const x = v * 2;
      sum += x > 9 ? x - 9 : x;
    } else sum += v;
  });
  return sum % 10 === 0;
}

const plausiblePhone = (s: string): boolean => {
  const n = s.replace(/\D/g, "").length;
  return n >= 10 && n <= 15;
};

const plausibleSSN = (s: string): boolean => {
  const p = s.split("-");
  if (p.length !== 3) return false;
  const [area, group, serial] = p;
  return area !== "000" && area !== "666" && !area.startsWith("9") && group !== "00" && serial !== "0000";
};

const plausibleIP = (s: string): boolean => !["127.0.0.1", "0.0.0.0", "255.255.255.255"].includes(s);

export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const n = [...s].length;
  let e = 0;
  for (const c of counts.values()) e -= (c / n) * Math.log2(c / n);
  return e;
}

export function looksLikeSecretBlob(s: string): boolean {
  if (s.length < 32) return false;
  if ((s.match(/\//g) ?? []).length > 2) return false;
  if (/^[0-9a-fA-F]+$/.test(s)) return false; // git SHAs, checksums
  if (!/[0-9]/.test(s) || !/[A-Za-z]/.test(s)) return false;
  return shannonEntropy(s) >= 4.1;
}

const plausibleUser = (s: string): boolean =>
  !["shared", "public", "guest", "deleted users", "default", "all users"].includes(s.toLowerCase());

// ---------- rules ----------

const KNOWN_TOKEN = [
  String.raw`\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b`,
  String.raw`\bgh[pousr]_[A-Za-z0-9]{30,}\b`,
  String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}\b`,
  String.raw`\bglpat-[A-Za-z0-9_\-]{20,}`,
  String.raw`\bxox[abprs]-[A-Za-z0-9\-]{10,}`,
  String.raw`\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}\b`,
  String.raw`\bwhsec_[A-Za-z0-9]{16,}\b`,
  String.raw`\bAIza[0-9A-Za-z_\-]{35}\b`,
  String.raw`\bsk-[A-Za-z0-9_\-]{20,}`,
  String.raw`\bnpm_[A-Za-z0-9]{30,}\b`,
  String.raw`\bhf_[A-Za-z0-9]{30,}\b`,
  String.raw`\bSG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}`,
  String.raw`\bdop_v1_[a-f0-9]{40,}\b`,
].join("|");

function rule(kind: DetectorKind, pattern: string, opts: { group?: number; flags?: string; validator?: (s: string) => boolean } = {}): Rule {
  return { kind, regex: new RegExp(pattern, "gd" + (opts.flags ?? "")), group: opts.group ?? 0, validator: opts.validator };
}

const ALL_RULES: Rule[] = [
  rule("email", String.raw`[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}`),
  rule("phone", String.raw`(?<!\w)(?<!\d[\s.\-])(?<!\.)(?:\+\d{1,3}[\s.\-]?)?(?:\(\d{2,4}\)[\s.\-]?|\d{2,4}[\s.\-])\d{3,4}[\s.\-]\d{3,4}(?!\w)(?![\s.\-]\d)`, { validator: plausiblePhone }),
  rule("creditCard", String.raw`(?<!\d)(?:\d[ \-]?){12,18}\d(?!\d)`, { validator: luhnValid }),
  rule("ssn", String.raw`(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)`, { validator: plausibleSSN }),
  rule("ipAddress", String.raw`(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\d)(?!\.\d)`, { validator: plausibleIP }),
  rule("knownToken", KNOWN_TOKEN),
  rule("jwt", String.raw`\beyJ[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]{5,}`),
  rule("privateKey", String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`),
  rule("bearerToken", String.raw`\bbearer\s+([A-Za-z0-9._\-~+/]{16,}=*)`, { group: 1, flags: "i" }),
  rule(
    "credentialAssignment",
    String.raw`(?<![A-Za-z0-9])(?:api[_\- ]?key|apikey|secret(?:[_\- ]?key)?|access[_\- ]?token|auth[_\- ]?token|token|passwd|password|pwd|client[_\- ]?secret)(?![A-Za-z0-9])["']?\s*[:=]\s*["']?([^\s"'<>,;]{4,})`,
    { group: 1, flags: "i" },
  ),
  rule("urlCredentials", String.raw`\b[a-z][a-z0-9+.\-]*://[^\s/:@]+:([^\s/@]+)@`, { group: 1, flags: "i" }),
  rule("highEntropy", String.raw`[A-Za-z0-9+/_=\-]{32,}`, { validator: looksLikeSecretBlob }),
  rule("homePath", String.raw`(?:/Users/|/home/)([^/\s]+)`, { group: 1, validator: plausibleUser }),
  rule("homePath", String.raw`[A-Za-z]:\\Users\\([^\\\s]+)`, { group: 1, validator: plausibleUser }),
];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type DetectorSettings = Pick<AppSettings, "enabledDetectors" | "customPhrasesText" | "customRegexesText" | "allowlistText">;

/** Deterministic, offline detection of secrets and personal data in OCR text. */
export class LocalDetector {
  private readonly rules: Rule[];
  private readonly literals: RegExp[];
  private readonly customRegexes: RegExp[] = [];
  private readonly allowlist: string[];
  readonly invalidCustomRegexes: string[] = [];

  constructor(settings: DetectorSettings) {
    const enabled = new Set<DetectorKind>(settings.enabledDetectors);
    this.rules = ALL_RULES.filter((r) => enabled.has(r.kind));
    this.literals = splitLines(settings.customPhrasesText).map((p) => new RegExp(escapeRegExp(p), "gdi"));
    for (const p of splitLines(settings.customRegexesText)) {
      try {
        this.customRegexes.push(new RegExp(p, "gd"));
      } catch {
        this.invalidCustomRegexes.push(p);
      }
    }
    this.allowlist = splitLines(settings.allowlistText).map((a) => a.toLowerCase());
  }

  static isValidRegex(pattern: string): boolean {
    try {
      new RegExp(pattern, "g");
      return true;
    } catch {
      return false;
    }
  }

  matches(text: string): LocalMatch[] {
    const out: LocalMatch[] = [];
    const accept = (category: string, start: number, end: number) => {
      if (end <= start) return;
      const matched = text.slice(start, end).toLowerCase();
      if (this.allowlist.some((a) => matched.includes(a))) return;
      out.push({ category, start, end });
    };
    const scan = (re: RegExp, group: number, category: string, validator?: (s: string) => boolean) => {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        const idx = (m as RegExpMatchArray & { indices?: [number, number][] }).indices?.[group];
        if (!idx) continue;
        const [s, e] = idx;
        if (validator && !validator(text.slice(s, e))) continue;
        accept(category, s, e);
      }
    };
    for (const r of this.rules) scan(r.regex, r.group, DETECTOR_TITLES[r.kind], r.validator);
    for (const re of this.literals) scan(re, 0, "Custom phrase");
    for (const re of this.customRegexes) scan(re, 0, "Custom pattern");
    return out;
  }
}
