import { test } from "node:test";
import assert from "node:assert/strict";
import { ImageLimits, mergeOverlapping, padRect, targetImageSize } from "../src/core/geometry";

const R = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

test("merges overlapping rectangles and keeps disjoint ones", () => {
  const merged = mergeOverlapping([R(0.1, 0.1, 0.3, 0.2), R(0.25, 0.15, 0.5, 0.3), R(0.8, 0.8, 0.9, 0.9)]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.find((r) => r.left === 0.1), R(0.1, 0.1, 0.5, 0.3));
});

test("merges chains", () => {
  const rs = [0, 1, 2, 3, 4].map((i) => R(i * 0.1, 0, i * 0.1 + 0.12, 0.1));
  assert.equal(mergeOverlapping(rs).length, 1);
});

test("drops invalid rectangles", () => {
  assert.deepEqual(mergeOverlapping([R(0.5, 0.5, 0.4, 0.6)]), []);
});

test("padding clamps to the image", () => {
  const r = padRect(R(0.01, 0.01, 0.5, 0.99), 0.05, 0.05);
  assert.equal(r.left, 0);
  assert.equal(r.top, 0);
  assert.equal(r.bottom, 1);
  assert.ok(Math.abs(r.right - 0.55) < 1e-9);
});

test("Retina screenshot is downscaled within API limits, keeping aspect", () => {
  const s = targetImageSize(2880, 1800)!;
  assert.equal(s.width, 1568);
  assert.ok(s.width * s.height <= ImageLimits.maxPixels);
  assert.ok(Math.abs(s.width / s.height - 2880 / 1800) < 0.01);
});

test("large square stays under the pixel cap", () => {
  const s = targetImageSize(4000, 4000)!;
  assert.ok(s.width * s.height <= ImageLimits.maxPixels);
  assert.ok(Math.max(s.width, s.height) <= ImageLimits.maxSide);
});

test("small images are upscaled to the minimum", () => {
  const s = targetImageSize(200, 120)!;
  assert.ok(Math.min(s.width, s.height) >= 256);
  assert.ok(s.width * s.height >= ImageLimits.minPixels);
});

test("impossible strips are rejected", () => {
  assert.equal(targetImageSize(50, 1500), null);
  assert.equal(targetImageSize(0, 10), null);
});
