import { NormRect, targetImageSize } from "./geometry";

/** Raw RGBA bitmap, 4 bytes per pixel, row-major, top row first. */
export interface Bitmap {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Pixel box for a normalized rect, rounded outward so edges are always fully covered. */
export function pixelBox(r: NormRect, width: number, height: number): { x0: number; y0: number; x1: number; y1: number } {
  const x0 = Math.max(0, Math.floor(r.left * width));
  const y0 = Math.max(0, Math.floor(r.top * height));
  const x1 = Math.min(width, Math.ceil(r.right * width));
  const y1 = Math.min(height, Math.ceil(r.bottom * height));
  return { x0, y0, x1, y1 };
}

/** Returns a copy of `bmp` with opaque black rectangles over `rects`. */
export function blackout(bmp: Bitmap, rects: NormRect[]): Bitmap {
  const data = new Uint8Array(bmp.data);
  for (const r of rects) {
    const { x0, y0, x1, y1 } = pixelBox(r, bmp.width, bmp.height);
    for (let y = y0; y < y1; y++) {
      let i = (y * bmp.width + x0) * 4;
      for (let x = x0; x < x1; x++, i += 4) {
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
        data[i + 3] = 255;
      }
    }
  }
  return { width: bmp.width, height: bmp.height, data };
}

/** Bilinear resize (good enough for the downscaled copy sent to Jev Box). */
export function resizeBilinear(src: Bitmap, width: number, height: number): Bitmap {
  const out = new Uint8Array(width * height * 4);
  const xr = src.width / width;
  const yr = src.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.max(0, (y + 0.5) * yr - 0.5);
    const y0 = Math.min(src.height - 1, Math.floor(fy));
    const y1 = Math.min(src.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.max(0, (x + 0.5) * xr - 0.5);
      const x0 = Math.min(src.width - 1, Math.floor(fx));
      const x1 = Math.min(src.width - 1, x0 + 1);
      const wx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const p00 = src.data[(y0 * src.width + x0) * 4 + c];
        const p10 = src.data[(y0 * src.width + x1) * 4 + c];
        const p01 = src.data[(y1 * src.width + x0) * 4 + c];
        const p11 = src.data[(y1 * src.width + x1) * 4 + c];
        const top = p00 + (p10 - p00) * wx;
        const bot = p01 + (p11 - p01) * wx;
        out[(y * width + x) * 4 + c] = Math.round(top + (bot - top) * wy);
      }
    }
  }
  return { width, height, data: out };
}

/** Downscale (or upscale) to satisfy the Jev image limits; null if impossible. */
export function fitForJev(bmp: Bitmap): Bitmap | null {
  const size = targetImageSize(bmp.width, bmp.height);
  return size ? resizeBilinear(bmp, size.width, size.height) : null;
}
