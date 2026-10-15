import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RedactionEngine, rectForRange } from "../src/core/engine";
import { JevClient, JevError, Question } from "../src/core/jevClient";
import { defaultSettings } from "../src/core/settings";
import { targetImageSize } from "../src/core/geometry";
import { lineFromTesseract } from "../src/pipeline/ocr";
import { PipelineHost } from "../src/pipeline/host";
import { SettingsStore } from "../src/main/settingsStore";
import { makeCapturePath, writeFileAtomic } from "../src/main/util";
import { line, mockFetch, ok, fakeJev } from "./support";
const input = { lines: [line("Owner: Jane Doe", 0)], imageWidth: 1000, imageHeight: 1000 };
const client = (reply: Record<string, unknown>) => new JevClient({ apiKey: "test-key", fetch: mockFetch(() => ok(reply)).fetch });

test("required AI checks reject missing keys, unavailable images, and skipped line limits", async () => {
  const required = { ...defaultSettings(), abortIfAIUnavailable: true };
  await assert.rejects(new RedactionEngine(required, null).analyze(input), (e: JevError) => e.kind === "missingAPIKey");
  const visual = { ...required, aiEnabled: false, visualEnabled: true };
  await assert.rejects(new RedactionEngine(visual, null).analyze(input));
  for (const imageProvider of [undefined, () => null]) await assert.rejects(new RedactionEngine(visual, client({})).analyze({ ...input, imageProvider }));
  await assert.rejects(new RedactionEngine(required, client({})).analyze({ ...input, lines: Array.from({ length: 601 }, (_, i) => line("Visible text", i, 602)) }), /Too many text lines/);
});

test("incomplete or invalid answers fail closed and warn in fallback mode", async () => {
  for (const answers of [{}, { L0: { type: "noul", noul: 2 } }, { L0: { type: "score", score: 1, confidence: 1 } }]) {
    await assert.rejects(new RedactionEngine({ ...defaultSettings(), abortIfAIUnavailable: true }, client(answers)).analyze(input));
    const r = await new RedactionEngine(defaultSettings(), client(answers)).analyze(input);
    assert.equal(r.aiRan, false);
    assert.ok(r.warnings.some((w) => w.includes("invalid answers")));
  }
});

test("rejects nonfinite probabilities, invalid box confidence, and unexpected choice values", async () => {
  for (const noul of [NaN, Infinity, -0.1, 1.1]) assert.deepEqual(JevClient.parseAnswer({ type: "noul", noul }), { type: "unknown" });
  assert.deepEqual(JevClient.parseAnswer({ type: "box", box: { left: 0, top: 0, right: 1, bottom: 1 }, confidence: 2 }), { type: "unknown" });
  await assert.rejects(client({ q: { type: "choice", choice: "unexpected", confidence: 1 } }).systemOne({ model: "test", state: "test", questions: { q: Question.choice("?", { one: "one" }) } }));
});

test("missing precise glyph geometry covers the entire line or word", () => {
  const rect = { left: 0.1, top: 0.1, right: 0.9, bottom: 0.2 };
  assert.deepEqual(rectForRange({ text: "iiiiWWW", rect }, 4, 7), rect);
  const l = lineFromTesseract({ text: "iiiiWWW", bbox: { x0: 10, y0: 10, x1: 90, y1: 20 }, words: [{ text: "iiiiWWW", bbox: { x0: 10, y0: 10, x1: 90, y1: 20 } }] }, 100, 100)!;
  assert.deepEqual(l.rangeRect!(4, 7), rect);
});

test("complete PEM contents are hidden and masked before upload", async () => {
  const body = "shortBase64WithoutDigits";
  const texts = ["-----BEGIN PRIVATE KEY-----", body, "-----END PRIVATE KEY-----", "ordinary text"];
  const m = mockFetch(fakeJev);
  const result = await new RedactionEngine(defaultSettings(), new JevClient({ apiKey: "test", fetch: m.fetch })).analyze({ ...input, lines: texts.map((t, i) => line(t, i)) });
  assert.equal(result.findings.filter((f) => f.category === "Private key material").length, 3);
  assert.ok(m.requests.length > 0);
  assert.ok(m.requests.every((r) => !r.rawBody.includes(body)));
  assert.ok(!result.findings.some((f) => f.rect.top > 0.14));
});

test("valid narrow images meet the API minimum", () => {
  assert.deepEqual(targetImageSize(1568, 260), { width: 1568, height: 260 });
});

test("remote error bodies cannot expose credentials or screenshot contents", async () => {
  const m = mockFetch(() => ({ status: 422, body: { detail: { message: "test-key: Private screenshot content" } } }));
  await assert.rejects(new JevClient({ apiKey: "test-key", fetch: m.fetch }).listModels(), (e: Error) => !e.message.includes("test-key") && !e.message.includes("Private screenshot"));
});

test("screenshots have private permissions and failed settings writes preserve memory state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jevsnap-files-"));
  try {
    const paths = [makeCapturePath(dir, true), makeCapturePath(dir, false)];
    for (const p of paths) writeFileAtomic(p, Buffer.from("processed"));
    if (process.platform !== "win32") {
      for (const p of paths) {
        assert.equal(fs.statSync(p).mode & 0o777, 0o600);
        assert.equal(fs.statSync(path.dirname(p)).mode & 0o777, 0o700);
      }
    }
    const file = path.join(dir, "settings.json");
    const store = new SettingsStore(file);
    fs.mkdirSync(file);
    assert.throws(() => store.update({ copyToClipboard: false }));
    assert.equal(store.get().copyToClipboard, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("an exiting worker cannot reject a replacement worker's requests", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jevsnap-worker-"));
  const file = path.join(dir, "worker.cjs");
  fs.writeFileSync(file, `const { parentPort } = require('node:worker_threads'); parentPort.on('message', m => setTimeout(() => parentPort.postMessage({ id: m.id, ok: true, png: m.png, width: 1, height: 1, ocrLineCount: 0, result: { findings: [], rects: [], warnings: [], aiRan: false, visualRan: false } }), 100));`);
  const host = new PipelineHost(file);
  try {
    const old = host.process(Buffer.from([1]), defaultSettings(), "");
    const rejected = assert.rejects(old, /disposed/);
    const disposed = host.dispose();
    const replacement = host.process(Buffer.from([2]), defaultSettings(), "");
    await rejected;
    await disposed;
    assert.deepEqual((await replacement).png, Buffer.from([2]));
  } finally { await host.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a mostly locally-masked line still checks remaining sensitive text", async () => {
  const m = mockFetch(fakeJev);
  const longEmail = "a".repeat(100) + "@example.com";
  const r = await new RedactionEngine(defaultSettings(), new JevClient({ apiKey: "test", fetch: m.fetch })).analyze({
    ...input, lines: [line(longEmail + " Jane Doe", 0)],
  });
  assert.ok(r.findings.some((f) => f.source === "ai"));
  assert.ok(m.requests.every((q) => !q.rawBody.includes(longEmail)));
});

test("screenshot uploads explicitly disable HTTP redirects", async () => {
  let redirect: string | undefined;
  const c = new JevClient({ apiKey: "test", fetch: async (_url, init) => {
    redirect = init.redirect;
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(ok({}).body) };
  } });
  await c.systemOne({ model: "test", state: "image", questions: {} });
  assert.equal(redirect, "error");
});

test("required visual checks reject a target list that would be truncated", async () => {
  const settings = { ...defaultSettings(), aiEnabled: false, visualEnabled: true, abortIfAIUnavailable: true,
    visualTargetsText: Array.from({ length: 9 }, (_, i) => `target ${i}`).join("\n") };
  await assert.rejects(new RedactionEngine(settings, client({})).analyze({ ...input,
    imageProvider: () => ({ data: new Uint8Array([1]), format: "png" }),
  }), /Too many visual targets/);
});
