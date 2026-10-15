import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultSettings, normalizeSettings, splitLines } from "../src/core/settings";

test("round-trips through JSON", () => {
  const s = { ...defaultSettings(), saveFolderPath: "/tmp/shots", aiThreshold: 0.3, enabledDetectors: ["email", "jwt"] as const };
  assert.deepEqual(normalizeSettings(JSON.parse(JSON.stringify(s))), { ...s, enabledDetectors: ["email", "jwt"] });
});

test("older/partial settings fall back to defaults and unknown keys are dropped", () => {
  const s = normalizeSettings({ saveFolderPath: "/x", aiThreshold: 0.7, someFutureKey: 1 });
  assert.equal(s.saveFolderPath, "/x");
  assert.equal(s.aiThreshold, 0.7);
  assert.equal(s.hotkey, defaultSettings().hotkey);
  assert.equal(s.copyToClipboard, true);
  assert.ok(!("someFutureKey" in s));
});

test("wrong types fall back; numbers are clamped", () => {
  const s = normalizeSettings({ aiThreshold: "high", saveOriginals: false, paddingPixels: 9999, visualMinConfidence: -3, enabledDetectors: ["email", "bogus"] });
  assert.equal(s.aiThreshold, 0.5);
  assert.ok(!("saveOriginals" in s));
  assert.equal(s.paddingPixels, 50);
  assert.equal(s.visualMinConfidence, 0);
  assert.deepEqual(s.enabledDetectors, ["email"]);
});

test("garbage input yields defaults", () => {
  assert.deepEqual(normalizeSettings(null), defaultSettings());
  assert.deepEqual(normalizeSettings("nope"), defaultSettings());
});

test("line lists are trimmed and blank lines dropped", () => {
  assert.deepEqual(splitLines("  one \n\n two\r\n"), ["one", "two"]);
});
