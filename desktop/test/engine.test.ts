import { test } from "node:test";
import assert from "node:assert/strict";
import { AI_CATEGORY, AnalysisInput, RedactionEngine, maskText, readingOrder, rectForRange } from "../src/core/engine";
import { JevClient, JevError } from "../src/core/jevClient";
import { defaultSettings } from "../src/core/settings";
import { fakeJev, line, mockFetch, ok } from "./support";

const mk = (m: ReturnType<typeof mockFetch>) => new JevClient({ apiKey: "k", baseURL: "https://api.example.test", fetch: m.fetch, sleep: async () => {} });
const input = (texts: string[]): AnalysisInput => ({ lines: texts.map((t, i) => line(t, i, Math.max(20, texts.length))), imageWidth: 2000, imageHeight: 1000 });

test("local rules work with no API key; only the matching span is covered", async () => {
  const r = await new RedactionEngine(defaultSettings(), null).analyze(input(["hello", "mail bob@example.com please", "bye"]));
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].source, "rule");
  assert.equal(r.aiRan, false);
  assert.ok(r.warnings.some((w) => w.includes("No API key")));
  assert.equal(r.rects.length, 1);
  assert.ok(r.rects[0].right - r.rects[0].left < 0.8 * 0.6);
});

test("AI locates sensitive words, and secrets are masked before anything is sent", async () => {
  const m = mockFetch(fakeJev);
  const secret = "sk_live_" + "abcdefghijklmnop1234";
  const r = await new RedactionEngine(defaultSettings(), mk(m)).analyze(input(["Dashboard", "Owner: Jane Doe", `STRIPE=${secret}`, "Settings"]));
  assert.equal(r.aiRan, true);
  const ai = r.findings.filter((f) => f.source === "ai");
  assert.equal(ai.length, 1);
  assert.equal(ai[0].category, AI_CATEGORY);
  assert.ok(r.findings.some((f) => f.source === "rule"));
  for (const req of m.requests) {
    assert.ok(!req.rawBody.includes(secret), "secret leaked into request");
    if (!req.body.state.words) assert.ok(req.rawBody.includes("[HIDDEN]"));
    assert.equal(req.headers["TypeSafe-Danger-Zone-Images"], undefined);
  }
});

test("threshold controls sensitivity", async () => {
  const s = { ...defaultSettings(), aiThreshold: 0.99 };
  const r = await new RedactionEngine(s, mk(mockFetch(fakeJev))).analyze(input(["Owner: Jane Doe"]));
  assert.equal(r.findings.filter((f) => f.source === "ai").length, 0);
});

test("chunking covers every line and adds context windows", async () => {
  const texts = Array.from({ length: 95 }, (_, i) => (i === 77 ? "Owner: Jane Doe" : `plain text line number ${i}`));
  const m = mockFetch(fakeJev);
  const r = await new RedactionEngine(defaultSettings(), mk(m)).analyze(input(texts));
  const lineRequests = m.requests.filter((q) => !q.body.state.words);
  assert.equal(lineRequests.length, 3); // 40 + 40 + 15, followed by word localization
  assert.equal(r.findings.filter((f) => f.source === "ai").length, 1);
  const asked = new Set(lineRequests.flatMap((q) => Object.keys(q.body.questions)));
  assert.equal(asked.size, 95);
  for (const q of lineRequests) {
    const qk = Object.keys(q.body.questions);
    const sk = Object.keys(q.body.state.screen);
    assert.ok(qk.every((k) => sk.includes(k)));
    assert.ok(sk.length > qk.length);
  }
});

test("AI failure falls back to local rules by default", async () => {
  const m = mockFetch(() => ({ status: 401, body: {} }));
  const r = await new RedactionEngine(defaultSettings(), mk(m)).analyze(input(["mail bob@example.com"]));
  assert.equal(r.aiRan, false);
  assert.equal(r.findings.length, 1);
  assert.ok(r.warnings.some((w) => w.includes("AI check unavailable")));
});

test("AI failure aborts when configured", async () => {
  const s = { ...defaultSettings(), abortIfAIUnavailable: true };
  const m = mockFetch(() => ({ status: 401, body: {} }));
  await assert.rejects(new RedactionEngine(s, mk(m)).analyze(input(["hello world"])), (e: JevError) => e.kind === "unauthorized");
});

test("fully covered and blank lines are not sent", async () => {
  const m = mockFetch(fakeJev);
  await new RedactionEngine(defaultSettings(), mk(m)).analyze(input(["bob@example.com", "—", "real words here"]));
  assert.equal(m.requests.flatMap((q) => Object.keys(q.body.questions)).length, 1);
});

test("AI disabled sends nothing", async () => {
  const m = mockFetch(fakeJev);
  const r = await new RedactionEngine({ ...defaultSettings(), aiEnabled: false }, mk(m)).analyze(input(["Owner: Jane Doe"]));
  assert.equal(m.requests.length, 0);
  assert.equal(r.findings.length, 0);
});

test("visual pass: Box gated by yes/no + confidence; provider sees earlier findings first", async () => {
  const s = { ...defaultSettings(), aiEnabled: false, visualEnabled: true, visualTargetsText: "a face\na signature", visualMinConfidence: 0.6 };
  const m = mockFetch(() => ok({
    seen0: { type: "noul", noul: 0.9 },
    box0: { type: "box", box: { top: 0.1, bottom: 0.3, left: 0.2, right: 0.4 }, confidence: 0.9 },
    count0: { type: "choice", choice: "several", probabilities: { several: 0.9 }, confidence: 0.9 },
    seen1: { type: "noul", noul: 0.9 },
    box1: { type: "box", box: { top: 0.5, bottom: 0.6, left: 0.5, right: 0.7 }, confidence: 0.3 },
    count1: { type: "choice", choice: "one", probabilities: { one: 0.9 }, confidence: 0.9 },
  }));
  let seen = 0;
  const inp: AnalysisInput = {
    lines: [line("mail bob@example.com", 0)], imageWidth: 2000, imageHeight: 1000,
    imageProvider: (rects) => { seen = rects.length; return { data: new Uint8Array([1, 2, 3]), format: "png" }; },
  };
  const r = await new RedactionEngine(s, mk(m)).analyze(inp);
  assert.equal(r.visualRan, true);
  assert.equal(seen, 1, "provider must receive earlier findings so they are blacked out before upload");
  assert.equal(r.findings.filter((f) => f.source === "visual").length, 1);
  assert.ok(r.warnings.some((w) => w.includes("More than one match")));
  const req = m.requests[0];
  assert.equal(req.headers["TypeSafe-Danger-Zone-Images"], "true");
  assert.equal(req.body.model, "jev-preview");
  assert.equal(Object.keys(req.body.assets).length, 1);
  assert.equal(req.body.questions.box0.type, "box");
});

test("visual pass skipped when the image is outside API limits", async () => {
  const s = { ...defaultSettings(), aiEnabled: false, visualEnabled: true };
  const m = mockFetch(() => ok({}));
  const r = await new RedactionEngine(s, mk(m)).analyze({ lines: [], imageWidth: 50, imageHeight: 1500, imageProvider: () => null });
  assert.equal(m.requests.length, 0);
  assert.ok(r.warnings.some((w) => w.includes("Skipped visual check")));
});

test("padding and merge", async () => {
  const s = { ...defaultSettings(), aiEnabled: false, paddingPixels: 10 };
  const r = await new RedactionEngine(s, null).analyze({
    lines: [], imageWidth: 1000, imageHeight: 1000,
    localRegions: [
      { rect: { left: 0.1, top: 0.1, right: 0.2, bottom: 0.2 }, category: "x", source: "local" },
      { rect: { left: 0.2, top: 0.1, right: 0.3, bottom: 0.2 }, category: "y", source: "local" },
    ],
  });
  assert.equal(r.rects.length, 1);
  assert.ok(Math.abs(r.rects[0].left - 0.09) < 1e-9);
  assert.ok(Math.abs(r.rects[0].right - 0.31) < 1e-9);
});

test("maskText, readingOrder, safe fallback range rect", () => {
  const m = maskText("a bob@x.io b", [{ category: "e", start: 2, end: 10 }]);
  assert.equal(m.masked, "a [HIDDEN] b");
  assert.ok(Math.abs(m.covered - 8 / 12) < 1e-9);
  assert.deepEqual(readingOrder([line("second", 5), line("first", 1)]).map((l) => l.text), ["first", "second"]);
  const r = rectForRange({ text: "0123456789", rect: { left: 0, top: 0, right: 1, bottom: 0.1 } }, 2, 5);
  assert.deepEqual(r, { left: 0, top: 0, right: 1, bottom: 0.1 });
});

test("only Andy is hidden in 'Send custom invoice to Andy'", async () => {
  const m = mockFetch((request) => ok(Object.fromEntries(Object.keys(request.body.questions).map((id) => [id, {
    type: "noul", noul: request.body.state.words ? (request.body.state.words[id].text === "Andy" ? 0.99 : 0.01) : 0.99,
  }]))));
  const text = "Send custom invoice to Andy";
  const source = line(text, 0);
  const r = await new RedactionEngine(defaultSettings(), mk(m)).analyze({ lines: [source], imageWidth: 2000, imageHeight: 1000 });
  const ai = r.findings.filter((f) => f.source === "ai");
  assert.equal(ai.length, 1);
  assert.deepEqual(ai[0].rect, source.rangeRect!(text.indexOf("Andy"), text.length));
  assert.ok(ai[0].rect.left > source.rect.left + 0.5);
  assert.equal(m.requests.length, 2);
});

test("word localization never sends locally matched credentials", async () => {
  const secret = "sk_" + "live_" + "abcdefghijklmnop1234";
  const m = mockFetch((request) => ok(Object.fromEntries(Object.keys(request.body.questions).map((id) => [id, {
    type: "noul", noul: request.body.state.words ? (request.body.state.words[id].text === "Andy" ? 0.99 : 0.01) : 0.99,
  }]))));
  const source = line(`Send to Andy token=${secret}`, 0);
  const r = await new RedactionEngine(defaultSettings(), mk(m)).analyze({ lines: [source], imageWidth: 2000, imageHeight: 1000 });
  assert.ok(r.findings.some((f) => f.source === "ai"));
  for (const request of m.requests) assert.ok(!request.rawBody.includes(secret));
});

test("uncertain word localization retains a full-line fallback", async () => {
  const m = mockFetch((request) => request.body.state.words ? ok({}) : ok({ L0: { type: "noul", noul: 0.99 } }));
  const source = line("Send custom invoice to Andy", 0);
  const r = await new RedactionEngine(defaultSettings(), mk(m)).analyze({ lines: [source], imageWidth: 2000, imageHeight: 1000 });
  assert.deepEqual(r.findings.find((f) => f.source === "ai")!.rect, source.rect);
  assert.ok(r.warnings.some((w) => w.includes("located precisely")));
});
