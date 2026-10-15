import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { LocalDetector } from "../src/core/detector";
import { defaultSettings, DetectorKind } from "../src/core/settings";

type Piece = string | string[];
const join = (p: Piece): string => (Array.isArray(p) ? p.join("") : p);

interface Case {
  name: string;
  text: Piece;
  expect: Piece[];
  mode?: "exact" | "contains";
  detectors?: DetectorKind[];
  settings?: Record<string, string>;
}

const doc = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "shared", "detector-cases.json"), "utf8")) as { cases: Case[] };

function found(text: string, overrides: Record<string, unknown> = {}): string[] {
  const s = { ...defaultSettings(), ...overrides };
  return new LocalDetector(s).matches(text).map((m) => text.slice(m.start, m.end));
}

test("shared vector file is non-trivial", () => {
  assert.ok(doc.cases.length > 30);
});

for (const c of doc.cases) {
  test(`shared vector: ${c.name}`, () => {
    const text = join(c.text);
    const overrides: Record<string, unknown> = { ...(c.settings ?? {}) };
    if (c.detectors) overrides.enabledDetectors = c.detectors;
    const got = found(text, overrides);
    const expected = c.expect.map(join);
    if (c.mode === "contains") {
      for (const e of expected) assert.ok(got.includes(e), `expected ${e} in ${JSON.stringify(got)}`);
    } else {
      assert.deepEqual([...got].sort(), [...expected].sort());
    }
  });
}

test("invalid custom regexes are reported, not thrown", () => {
  const d = new LocalDetector({ ...defaultSettings(), customRegexesText: "([unclosed\nok\\d+" });
  assert.deepEqual(d.invalidCustomRegexes, ["([unclosed"]);
  assert.equal(LocalDetector.isValidRegex("a(b"), false);
  assert.equal(LocalDetector.isValidRegex("a(b)"), true);
});

test("matches never carry text and use UTF-16 offsets that survive emoji", () => {
  const text = "😀 mail bob@example.com";
  const ms = new LocalDetector(defaultSettings()).matches(text);
  assert.equal(ms.length, 1);
  assert.equal(text.slice(ms[0].start, ms[0].end), "bob@example.com");
});
