import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeRowFragments } from "../src/core/lines";
import { LocalDetector } from "../src/core/detector";
import { defaultSettings } from "../src/core/settings";
import { rectForRange } from "../src/core/engine";

const frag = (text: string, l: number, r: number, top = 0.1, bottom = 0.14) => ({ text, rect: { left: l, top, right: r, bottom } });

test("fragments on one row are joined so patterns that straddle them match", () => {
  const merged = mergeRowFragments([frag("Phone: +1 (415)", 0.5, 0.7), frag("555-2671", 0.72, 0.85), frag("Contact:", 0.1, 0.2)], 1000, 1000);
  const row = merged.find((l) => l.text.includes("555-2671"))!;
  assert.equal(row.text, "Phone: +1 (415) 555-2671");
  const m = new LocalDetector(defaultSettings()).matches(row.text);
  assert.ok(m.some((x) => row.text.slice(x.start, x.end) === "+1 (415) 555-2671"), row.text);
  // precise range: the box spans both fragments but not "Contact:" or "Phone:"
  const x = m.find((y) => row.text.slice(y.start, y.end) === "+1 (415) 555-2671")!;
  const r = rectForRange(row, x.start, x.end);
  assert.ok(r.right >= 0.85 - 1e-9 && r.left >= 0.5 - 1e-9);
});

test("distant fragments and different rows stay separate", () => {
  const out = mergeRowFragments([frag("left", 0.05, 0.1), frag("far right", 0.8, 0.9), frag("next row", 0.05, 0.2, 0.3, 0.34)], 1000, 1000);
  assert.equal(out.length, 3);
});

test("single lines pass through unchanged", () => {
  const l = frag("only", 0.1, 0.2);
  assert.deepEqual(mergeRowFragments([l], 1000, 1000), [l]);
});
