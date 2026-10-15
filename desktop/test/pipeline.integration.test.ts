import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { decodePng } from "../src/pipeline/png";
import { processScreenshot } from "../src/pipeline/process";
import { TesseractOcr } from "../src/pipeline/ocr";
import { PipelineHost } from "../src/pipeline/host";
import { defaultSettings } from "../src/core/settings";
import { fakeJev, mockFetch } from "./support";

// Fixture (tools/make_fixture.py): 1000x400 dark terminal, 46px line pitch starting at y=40.
const fixture = fs.readFileSync(path.join(__dirname, "fixtures", "leaky-terminal.png"));
const ocr = new TesseractOcr();
const host = new PipelineHost(path.join(__dirname, "..", "dist", "pipeline", "worker.js"), 60_000);
after(async () => { await ocr.dispose(); await host.dispose(); });

const isBlack = (b: { data: Uint8Array; width: number }, x: number, y: number) => {
  const i = (y * b.width + x) * 4;
  return b.data[i] === 0 && b.data[i + 1] === 0 && b.data[i + 2] === 0;
};
// Vertical centre of line n of the fixture (text drawn at y = 40 + 46n, 24px font).
const rowY = (n: number) => 40 + 46 * n + 12;

test("OCR reads the fixture and exposes per-character boxes", async () => {
  const lines = await ocr.recognize(decodePng(fixture));
  const texts = lines.map((l) => l.text);
  assert.ok(texts.some((t) => t.includes("jane.doe@example.com")), JSON.stringify(texts));
  const line = lines.find((l) => l.text.includes("jane.doe@example.com") && l.text.includes("555"))!;
  assert.ok(line, "the Contact row (email + phone) should be one line: " + JSON.stringify(texts));
  const start = line.text.indexOf("jane.doe@example.com");
  const r = line.rangeRect!(start, start + "jane.doe@example.com".length)!;
  assert.ok(r.left > line.rect.left && r.right < line.rect.right, "range box is narrower than the whole line");
  const phone = line.text.indexOf("555-2671");
  assert.ok(phone > 0, texts.join("|"));
});

test("end to end (offline): secrets are blacked out, harmless lines are untouched", async () => {
  const out = await processScreenshot(fixture, { settings: { ...defaultSettings(), aiEnabled: false }, apiKey: "", ocr });
  const before = decodePng(fixture), after = decodePng(out.png);
  assert.equal(after.width, before.width);
  const cats = Object.keys(out.result.findings.reduce<Record<string, number>>((a, f) => ({ ...a, [f.category]: 1 }), {}));
  assert.ok(cats.includes("Email addresses"), cats.join());
  assert.ok(cats.some((c) => c.startsWith("API keys")) , cats.join());
  assert.ok(cats.includes("password= / token= / secret= values"), cats.join());
  // The Stripe-style key (line 1), the password value (line 2), and the email (line 3) are black.
  assert.ok(isBlack(after, 400, rowY(1)), "api key line should be covered");
  assert.ok(isBlack(after, 300, rowY(2)), "password value should be covered");
  assert.ok(isBlack(after, 330, rowY(3)), "email should be covered");
  // ... and the original pixels there were not black (the test is meaningful).
  assert.ok(!isBlack(before, 400, rowY(1)) || !isBlack(before, 300, rowY(2)));
  // Plain lines are byte-identical.
  for (const n of [5, 6]) {
    for (let x = 40; x < 300; x += 7) {
      for (let y = rowY(n) - 8; y < rowY(n) + 8; y += 3) {
        const i = (y * before.width + x) * 4;
        assert.deepEqual(Array.from(after.data.slice(i, i + 4)), Array.from(before.data.slice(i, i + 4)));
      }
    }
  }
});

test("end to end with the AI check: Jane Doe is hidden and the Owner label is preserved", async () => {
  const m = mockFetch(fakeJev);
  const out = await processScreenshot(fixture, { settings: defaultSettings(), apiKey: "k", ocr, fetch: m.fetch });
  assert.equal(out.result.aiRan, true, JSON.stringify(out.result.warnings));
  const after = decodePng(out.png);
  assert.ok(isBlack(after, 180, rowY(4)), "AI-flagged name covered");
  const before = decodePng(fixture);
  for (let x = 45; x < 125; x += 5) {
    for (let y = rowY(4) - 8; y < rowY(4) + 8; y += 3) {
      const i = (y * before.width + x) * 4;
      assert.deepEqual(Array.from(after.data.slice(i, i + 4)), Array.from(before.data.slice(i, i + 4)), "Owner label remains visible");
    }
  }
  assert.ok(!out.result.findings.some((f) => f.source === "ai" && f.rect.top > 0.8), "last lines are not flagged");
  for (const req of m.requests) {
    assert.ok(!/sk_live_[A-Za-z0-9]{8}/.test(req.rawBody), "api key must be masked before sending");
    assert.ok(!/hunter2/.test(req.rawBody), "password must be masked before sending");
    assert.equal(req.headers["TypeSafe-Danger-Zone-Images"], undefined, "image never uploaded by default");
  }
});

test("worker thread host returns the same result and survives repeated jobs", async () => {
  const s = { ...defaultSettings(), aiEnabled: false };
  const a = await host.process(fixture, s, "");
  const b = await host.process(fixture, s, "");
  assert.equal(a.result.findings.length, b.result.findings.length);
  assert.ok(a.result.findings.length >= 3);
  assert.ok(isBlack(decodePng(a.png), 330, rowY(3)));
});

test("a corrupt image fails closed (rejects instead of returning something unredacted)", async () => {
  await assert.rejects(host.process(Buffer.from("not a png"), defaultSettings(), ""));
  const ok = await host.process(fixture, { ...defaultSettings(), aiEnabled: false }, ""); // worker still usable
  assert.ok(ok.png.length > 0);
});
