import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { createRequire } from "node:module";
import { defaultSettings, normalizeSettings } from "../src/core/settings";
import { makeCapturePath } from "../src/main/util";
import type { FlowDeps } from "../src/main/flow";
import type { HostResult } from "../src/pipeline/host";

// Exercise the actual built save flow with inert Electron notifications/clipboard.
const file = path.join(__dirname, "..", "dist", "main", "flow.js");
const localRequire = createRequire(file);
const loaded = { exports: {} };
vm.runInNewContext(fs.readFileSync(file, "utf8"), {
  exports: loaded.exports, module: loaded,
  require: (name: string) => name === "electron" ? {
    Notification: { isSupported: () => false }, clipboard: {}, shell: {},
  } : localRequire(name),
}, { filename: file });
const { processAndSave } = loaded.exports as typeof import("../src/main/flow");

for (const redacted of [true, false]) {
  test(`save flow writes only the processed image to ${redacted ? "Redacted" : "Not Redacted"}`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jevsnap-storage-"));
    try {
      const raw = Buffer.from("raw secret pixels");
      const processed = Buffer.from("processed pixels");
      const rect = { left: 0, top: 0, right: 1, bottom: 1 };
      const host = { process: async () => {
        assert.deepEqual(fs.readdirSync(dir), [], "nothing is saved before analysis finishes");
        return { png: processed, width: 1, height: 1, ocrLineCount: 1,
          result: { findings: redacted ? [{ rect, category: "test", source: "rule" }] : [],
            rects: redacted ? [rect] : [], warnings: [], aiRan: false, visualRan: false } } as HostResult;
      } };
      let revealed: string | undefined;
      const deps = { host, getSettings: () => ({ ...defaultSettings(), copyToClipboard: false, showNotifications: false }),
        getApiKey: () => "", getSaveFolder: () => dir, setStatus: () => {}, onSaved: (p: string) => { revealed = p; } } as FlowDeps;
      const outcome = await processAndSave(raw, deps);
      assert.equal(path.basename(path.dirname(outcome.savedPath)), redacted ? "Redacted" : "Not Redacted");
      assert.deepEqual(fs.readFileSync(outcome.savedPath), processed);
      assert.equal(revealed, outcome.savedPath);
      assert.deepEqual(fs.readdirSync(dir), [redacted ? "Redacted" : "Not Redacted"]);
      assert.equal(fs.readdirSync(path.dirname(outcome.savedPath)).length, 1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test("processing failure leaves no persisted screenshot", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jevsnap-failed-storage-"));
  try {
    const deps = { host: { process: async () => { throw new Error("OCR failed"); } },
      getSettings: defaultSettings, getApiKey: () => "", getSaveFolder: () => dir,
      setStatus: () => {}, onSaved: () => assert.fail("must not save") } as unknown as FlowDeps;
    await assert.rejects(processAndSave(Buffer.from("raw"), deps), /OCR failed/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("legacy retention settings are discarded and capture filenames do not overwrite", () => {
  const settings = normalizeSettings({ saveOriginals: true });
  assert.ok(!("saveOriginals" in settings));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jevsnap-collision-"));
  try {
    const now = new Date(2026, 9, 14, 12, 0, 0);
    const first = makeCapturePath(dir, false, now);
    fs.writeFileSync(first, "first");
    const second = makeCapturePath(dir, false, now);
    assert.notEqual(first, second);
    assert.equal(fs.readFileSync(first, "utf8"), "first");
    assert.ok(second.endsWith(" (2).png"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
