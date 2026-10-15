export const DETECTOR_KINDS = [
  "email", "phone", "creditCard", "ssn", "ipAddress",
  "knownToken", "jwt", "privateKey", "bearerToken", "credentialAssignment", "urlCredentials",
  "highEntropy", "homePath",
] as const;
export type DetectorKind = (typeof DETECTOR_KINDS)[number];

export const DETECTOR_TITLES: Record<DetectorKind, string> = {
  email: "Email addresses",
  phone: "Phone numbers",
  creditCard: "Credit card numbers",
  ssn: "US Social Security numbers",
  ipAddress: "IPv4 addresses",
  knownToken: "API keys (AWS, GitHub, Slack, Stripe, OpenAI…)",
  jwt: "JWT tokens",
  privateKey: "Private key headers",
  bearerToken: "Bearer tokens",
  credentialAssignment: "password= / token= / secret= values",
  urlCredentials: "Passwords inside URLs",
  highEntropy: "Long random-looking strings",
  homePath: "Usernames in file paths (/Users/…, C:\\Users\\…)",
};

export const DEFAULT_HIDE_RULES =
  "personal names of private individuals; personal email addresses, phone numbers and street addresses; " +
  "usernames, account IDs and customer, employee or patient data; passwords, tokens, API keys, secrets " +
  "and recovery codes; internal hostnames, internal URLs and private network addresses; financial " +
  "account numbers and balances";
export const DEFAULT_KEEP_RULES =
  "generic interface text such as menus, buttons, labels and headings; source code and shell commands " +
  "that contain no secrets; public product, company and brand names; public documentation text";

export interface AppSettings {
  // General
  saveFolderPath: string;
  copyToClipboard: boolean;
  showNotifications: boolean;
  playSound: boolean;
  launchAtLogin: boolean;
  /** Electron accelerator, e.g. "CommandOrControl+Shift+6". */
  hotkey: string;
  // Jev API
  apiBaseURL: string;
  textModel: string;
  visualModel: string;
  requestTimeoutSeconds: number;
  // Local detection
  enabledDetectors: DetectorKind[];
  detectBarcodes: boolean;
  customPhrasesText: string;
  customRegexesText: string;
  allowlistText: string;
  paddingPixels: number;
  // AI text check (sends OCR text, not the image)
  aiEnabled: boolean;
  aiHideRules: string;
  aiKeepRules: string;
  /** Lower hides more. A line is hidden when Jev's yes-probability >= this. */
  aiThreshold: number;
  abortIfAIUnavailable: boolean;
  // Visual check (sends the already-redacted image to Jev Box). Off by default.
  visualEnabled: boolean;
  visualTargetsText: string;
  visualMinConfidence: number;
}

export function defaultSettings(): AppSettings {
  return {
    saveFolderPath: "~/Pictures/JEVsnap",
    copyToClipboard: true,
    showNotifications: true,
    playSound: false,
    launchAtLogin: false,
    hotkey: "CommandOrControl+Shift+6",
    apiBaseURL: "https://api.typesafe.ai",
    textModel: "jev-latest",
    visualModel: "jev-preview",
    requestTimeoutSeconds: 30,
    enabledDetectors: [...DETECTOR_KINDS],
    detectBarcodes: true,
    customPhrasesText: "",
    customRegexesText: "",
    allowlistText: "",
    paddingPixels: 4,
    aiEnabled: true,
    aiHideRules: DEFAULT_HIDE_RULES,
    aiKeepRules: DEFAULT_KEEP_RULES,
    aiThreshold: 0.5,
    abortIfAIUnavailable: false,
    visualEnabled: false,
    visualTargetsText: "a person's face or profile photo\na handwritten signature",
    visualMinConfidence: 0.5,
  };
}

const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Tolerant loader: unknown keys are dropped, wrong types / missing keys fall back to defaults, numbers are
 * clamped. Settings saved by an older version keep working after an upgrade.
 */
export function normalizeSettings(raw: unknown): AppSettings {
  const d = defaultSettings();
  if (typeof raw !== "object" || raw === null) return d;
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...d };
  for (const key of Object.keys(d) as (keyof AppSettings)[]) {
    const v = r[key];
    const def = d[key];
    if (v === undefined) continue;
    if (typeof def === "string" && typeof v === "string") out[key] = v;
    else if (typeof def === "boolean" && typeof v === "boolean") out[key] = v;
    else if (typeof def === "number" && typeof v === "number" && Number.isFinite(v)) out[key] = v;
    else if (key === "enabledDetectors" && Array.isArray(v)) {
      out[key] = DETECTOR_KINDS.filter((k) => v.includes(k));
    }
  }
  const s = out as unknown as AppSettings;
  s.aiThreshold = clampNum(s.aiThreshold, 0.05, 0.99);
  s.visualMinConfidence = clampNum(s.visualMinConfidence, 0, 1);
  s.paddingPixels = clampNum(s.paddingPixels, 0, 50);
  s.requestTimeoutSeconds = clampNum(s.requestTimeoutSeconds, 5, 300);
  return s;
}

export function splitLines(text: string): string[] {
  return text
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}
