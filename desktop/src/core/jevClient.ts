import { NormRect, clampRect, isValidRect } from "./geometry";

// Minimal client for TypeSafe's System One endpoint (POST /v1/systemone).
// Reference: https://docs.typesafe.ai/api and https://docs.typesafe.ai/primitives/box

export type JevErrorKind =
  | "missingAPIKey" | "invalidBaseURL" | "insecureBaseURL" | "unauthorized" | "rateLimited"
  | "overloaded" | "badRequest" | "payloadTooLarge" | "server" | "network" | "invalidResponse";

export class JevError extends Error {
  constructor(readonly kind: JevErrorKind, message: string, readonly status?: number) {
    super(message);
    this.name = "JevError";
  }
  get retryable(): boolean {
    return this.kind === "rateLimited" || this.kind === "overloaded" || (this.kind === "server" && (this.status ?? 0) >= 500);
  }
}

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

export interface JevRequest {
  model: string;
  state: Json;
  questions: Record<string, JsonObject>;
  /** Image assets keyed by reference string; every key must appear in state/instructions/criteria. */
  assets?: Record<string, JsonObject>;
}

export const Question = {
  noul: (instructions: Json, criteria?: Json): JsonObject => ({ type: "noul", instructions, ...(criteria !== undefined ? { criteria } : {}) }),
  choice: (instructions: Json, criteria: Record<string, Json>): JsonObject => ({ type: "choice", instructions, criteria }),
  box: (instructions: Json): JsonObject => ({ type: "box", instructions }),
};

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "box"; box: NormRect; confidence: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; confidence: number }
  | { type: "unknown" };

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  inputTokens?: number;
  outputTokens?: number;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: "error" }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface JevClientOptions {
  apiKey: string;
  baseURL?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export class JevClient {
  readonly baseURL: URL;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchFn: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: JevClientOptions) {
    const key = (opts.apiKey ?? "").trim();
    if (!key) throw new JevError("missingAPIKey", "No TypeSafe API key is set. Add one in Settings → API.");
    // Header-injection guard: keys are single-line printable ASCII tokens.
    if (!/^[\x21-\x7e]+$/.test(key)) throw new JevError("badRequest", "The API key contains invalid characters.");
    let url: URL;
    try {
      url = new URL((opts.baseURL ?? "https://api.typesafe.ai").trim());
    } catch {
      throw new JevError("invalidBaseURL", `Invalid API base URL: ${opts.baseURL}`);
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new JevError("invalidBaseURL", "The API base URL must not contain credentials, a query, or a fragment.");
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback))) {
      throw new JevError("insecureBaseURL", "Refusing to send the API key over plain HTTP. Use an https:// base URL.");
    }
    this.apiKey = key;
    this.baseURL = url;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.fetchFn = opts.fetch ?? ((u, init) => fetch(u, init as RequestInit));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private url(path: string): string {
    return new URL(path.replace(/^\//, ""), this.baseURL.href.endsWith("/") ? this.baseURL.href : this.baseURL.href + "/").href;
  }

  async systemOne(req: JevRequest): Promise<JevResponse> {
    const body: JsonObject = { model: req.model, state: req.state, questions: req.questions };
    const hasAssets = !!req.assets && Object.keys(req.assets).length > 0;
    if (hasAssets) body.assets = req.assets as JsonObject;
    // Images and Box questions are behind the TypeSafe-Danger-Zone-Images header.
    const needsImages = hasAssets || Object.values(req.questions).some((q) => q.type === "box");
    const text = await this.perform("POST", "/v1/systemone", JSON.stringify(body), needsImages);
    const response = JevClient.parseResponse(text);
    for (const [id, question] of Object.entries(req.questions)) {
      const answer = response.answers[id];
      if (!answer || answer.type === "unknown" || answer.type !== question.type ||
          (answer.type === "choice" && (!isObj(question.criteria) || !Object.hasOwn(question.criteria, answer.choice)))) {
        throw new JevError("invalidResponse", "The TypeSafe API returned missing or invalid answers.");
      }
    }
    return response;
  }

  /** Cheap authenticated call used by Settings → "Test connection". */
  async listModels(): Promise<string[]> {
    const text = await this.perform("GET", "/v1/models", undefined, false);
    let json: unknown;
    try { json = JSON.parse(text); } catch { throw new JevError("invalidResponse", "Unexpected response from the TypeSafe API: not JSON"); }
    if (!isObj(json) || !Array.isArray(json.models)) throw new JevError("invalidResponse", "Unexpected response from the TypeSafe API: missing models list");
    return json.models.filter(isObj).map((m) => m.name).filter((n): n is string => typeof n === "string");
  }

  private async perform(method: string, path: string, body: string | undefined, images: boolean): Promise<string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "User-Agent": "JEVsnap-Desktop/0.1",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (images) headers["TypeSafe-Danger-Zone-Images"] = "true";

    for (let attempt = 0; ; attempt++) {
      let delay: number;
      try {
        const res = await this.fetchFn(this.url(path), { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs), redirect: "error" });
        const text = await res.text();
        if (res.status >= 200 && res.status < 300) return text;
        const err = JevClient.errorFor(res.status, "Request failed. Check the API configuration and model limits.");
        if (!err.retryable || attempt >= this.maxRetries) throw err;
        delay = JevClient.backoffMs(attempt, res.headers.get("retry-after"));
      } catch (e) {
        if (e instanceof JevError) throw e;
        if (!JevClient.isTransient(e) || attempt >= this.maxRetries) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new JevError("network", `Network error: ${msg}`);
        }
        delay = JevClient.backoffMs(attempt, null);
      }
      await this.sleep(delay);
    }
  }

  static backoffMs(attempt: number, retryAfter: string | null): number {
    const secs = retryAfter === null ? NaN : Number(retryAfter.trim());
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs, 10) * 1000;
    return Math.min(500 * 2 ** attempt, 8000) + Math.random() * 250;
  }

  static isTransient(e: unknown): boolean {
    if (!(e instanceof Error)) return false;
    if (e.name === "TimeoutError" || e.name === "AbortError") return true;
    // Node's fetch reports connection problems as TypeError("fetch failed") with a cause code.
    const code = (e as { cause?: { code?: string } }).cause?.code ?? "";
    return (e instanceof TypeError && e.message === "fetch failed") ||
      ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(code);
  }

  static errorFor(status: number, body: string): JevError {
    const message = JevClient.errorMessage(body);
    switch (status) {
      case 400: case 422: return new JevError("badRequest", `The TypeSafe API rejected the request: ${message}`, status);
      case 401: case 403: return new JevError("unauthorized", "The TypeSafe API rejected the API key (401).", status);
      case 413: return new JevError("payloadTooLarge", "The request was too large for the TypeSafe API (413).", status);
      case 429: return new JevError("rateLimited", "Rate limited by the TypeSafe API (429).", status);
      case 529: return new JevError("overloaded", "The TypeSafe API is overloaded (529).", status);
      default: return new JevError("server", `TypeSafe API error ${status}: ${message}`, status);
    }
  }

  /** Observed shapes: {"detail":{"error_type","message"}} and {"error":{"message"}}. */
  static errorMessage(body: string): string {
    let text = "";
    try {
      const j = JSON.parse(body) as unknown;
      if (isObj(j)) {
        const detail = j.detail, error = j.error;
        const cand = [isObj(detail) ? detail.message : undefined, isObj(error) ? error.message : undefined, error, j.message, detail];
        text = (cand.find((c) => typeof c === "string") as string | undefined) ?? "";
      }
    } catch { /* not JSON */ }
    if (!text) text = body.slice(0, 300);
    return text.slice(0, 300);
  }

  static parseResponse(text: string): JevResponse {
    let json: unknown;
    try { json = JSON.parse(text); } catch { throw new JevError("invalidResponse", "Unexpected response from the TypeSafe API: not JSON"); }
    if (!isObj(json) || !isObj(json.answers)) throw new JevError("invalidResponse", "Unexpected response from the TypeSafe API: missing answers");
    const answers: Record<string, JevAnswer> = {};
    for (const [id, a] of Object.entries(json.answers)) answers[id] = JevClient.parseAnswer(a);
    const usage = isObj(json.usage) ? json.usage : {};
    return {
      model: typeof json.model === "string" ? json.model : "",
      answers,
      inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
      outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
    };
  }

  static parseAnswer(a: unknown): JevAnswer {
    if (!isObj(a)) return { type: "unknown" };
    const probability = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
    const conf = probability(a.confidence) ? a.confidence : 0;
    switch (a.type) {
      case "noul":
        if (probability(a.noul)) return { type: "noul", noul: a.noul };
        break;
      case "box":
        if (isObj(a.box)) {
          const b = a.box;
          if ([b.left, b.top, b.right, b.bottom].every(probability) && probability(a.confidence)) {
            const rect = clampRect({ left: b.left as number, top: b.top as number, right: b.right as number, bottom: b.bottom as number });
            if (isValidRect(rect)) return { type: "box", box: rect, confidence: conf };
          }
        }
        break;
      case "choice":
        if (typeof a.choice === "string" && probability(a.confidence)) {
          const probs: Record<string, number> = {};
          if (isObj(a.probabilities)) for (const [k, v] of Object.entries(a.probabilities)) if (typeof v === "number") probs[k] = v;
          return { type: "choice", choice: a.choice, probabilities: probs, confidence: conf };
        }
        break;
      case "score":
        if (typeof a.score === "number" && Number.isFinite(a.score) && probability(a.confidence)) return { type: "score", score: a.score, confidence: conf };
        break;
    }
    return { type: "unknown" };
  }
}
