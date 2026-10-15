import type { FetchLike } from "../src/core/jevClient";
import type { OCRLine } from "../src/core/engine";

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
  rawBody: string;
}

export type Reply = { status: number; body: unknown; headers?: Record<string, string> };

/** Scriptable fetch: records every request and answers via `handler(request, callNumber)`. */
export function mockFetch(handler: (req: Recorded, n: number) => Reply): { fetch: FetchLike; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fetch: FetchLike = async (url, init) => {
    const rawBody = init.body ?? "";
    const rec: Recorded = { url, method: init.method, headers: init.headers, rawBody, body: rawBody ? JSON.parse(rawBody) : undefined };
    requests.push(rec);
    const r = handler(rec, requests.length);
    const headers = r.headers ?? {};
    return {
      status: r.status,
      headers: { get: (n: string) => headers[n] ?? headers[n.toLowerCase()] ?? null },
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
    };
  };
  return { fetch, requests };
}

export const ok = (answers: Record<string, unknown>): Reply => ({
  status: 200,
  body: { model: "jev-1.14.0", answers, usage: { input_tokens: 10, output_tokens: 2 } },
});

export function line(text: string, row: number, total = 20): OCRLine {
  const h = 1 / total;
  const rect = { left: 0.1, top: row * h, right: 0.9, bottom: row * h + h * 0.8 };
  return { text, rect, rangeRect: (start, end) => ({ ...rect, left: rect.left + 0.8 * start / text.length, right: rect.left + 0.8 * end / text.length }) };
}

/** Fake Jev: flags any line containing "Jane Doe" (p=0.95); everything else p=0.05. */
export function fakeJev(req: Recorded): Reply {
  const screen = req.body?.state?.screen ?? {};
  const answers: Record<string, unknown> = {};
  for (const id of Object.keys(req.body.questions ?? {})) {
    const word = req.body?.state?.words?.[id]?.text;
    const sensitive = word !== undefined ? ["Jane", "Doe", "Andy"].includes(word) : String(screen[id] ?? "").includes("Jane Doe");
    answers[id] = { type: "noul", noul: sensitive ? 0.95 : 0.05 };
  }
  return ok(answers);
}
