import { test } from "node:test";
import assert from "node:assert/strict";
import QRCode from "qrcode";
import { blackout, Bitmap, fitForJev, pixelBox, resizeBilinear } from "../src/core/imageOps";
import { decodePng, encodePng } from "../src/pipeline/png";
import { findQrCodes } from "../src/pipeline/qr";

const solid = (w: number, h: number, rgba: [number, number, number, number]): Bitmap => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { width: w, height: h, data };
};
const px = (b: Bitmap, x: number, y: number) => Array.from(b.data.slice((y * b.width + x) * 4, (y * b.width + x) * 4 + 4));

test("pixelBox rounds outward and clamps", () => {
  assert.deepEqual(pixelBox({ left: 0.105, top: 0.205, right: 0.395, bottom: 0.505 }, 100, 100), { x0: 10, y0: 20, x1: 40, y1: 51 });
  assert.deepEqual(pixelBox({ left: -1, top: -1, right: 2, bottom: 2 }, 10, 10), { x0: 0, y0: 0, x1: 10, y1: 10 });
});

test("blackout paints only inside the rectangles and leaves the input untouched", () => {
  const src = solid(100, 100, [200, 100, 50, 255]);
  const out = blackout(src, [{ left: 0.1, top: 0.1, right: 0.3, bottom: 0.3 }]);
  assert.deepEqual(px(out, 15, 15), [0, 0, 0, 255]);
  assert.deepEqual(px(out, 9, 15), [200, 100, 50, 255]);
  assert.deepEqual(px(out, 30, 15), [200, 100, 50, 255]);
  assert.deepEqual(px(src, 15, 15), [200, 100, 50, 255]);
});

test("PNG round trip preserves pixels", () => {
  const b = solid(8, 6, [1, 2, 3, 255]);
  b.data.set([9, 8, 7, 255], 0);
  const back = decodePng(encodePng(b));
  assert.equal(back.width, 8);
  assert.deepEqual(Array.from(back.data), Array.from(b.data));
});

test("resize + fitForJev respect API limits", () => {
  const big = solid(2880, 1800, [10, 20, 30, 255]);
  const fitted = fitForJev(big)!;
  assert.ok(fitted.width <= 1568 && fitted.width * fitted.height <= 2_458_624);
  assert.deepEqual(px(fitted, 5, 5), [10, 20, 30, 255]);
  assert.equal(fitForJev(solid(50, 1500, [0, 0, 0, 255])), null);
  const small = resizeBilinear(solid(4, 4, [255, 0, 0, 255]), 2, 2);
  assert.deepEqual(px(small, 1, 1), [255, 0, 0, 255]);
});

test("QR codes are found and blacked out (two codes)", async () => {
  const mk = async (text: string) => decodePng(await QRCode.toBuffer(text, { margin: 4, scale: 6 }));
  const a = await mk("https://example.com/login?token=abc"), b = await mk("WIFI:S:home;P:secret;;");
  const canvas = solid(800, 400, [255, 255, 255, 255]);
  const paste = (src: Bitmap, ox: number, oy: number) => {
    for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) {
      canvas.data.set(src.data.slice((y * src.width + x) * 4, (y * src.width + x) * 4 + 4), ((oy + y) * 800 + ox + x) * 4);
    }
  };
  paste(a, 40, 40);
  paste(b, 450, 120);
  const found = findQrCodes(canvas);
  assert.equal(found.length, 2);
  assert.ok(found.every((f) => f.category === "QR code" && f.source === "local"));
  assert.deepEqual(findQrCodes(solid(300, 300, [255, 255, 255, 255])), []);
});
