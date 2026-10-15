import jsQR, { QRCode } from "jsqr";
import type { Finding } from "../core/engine";
import { Bitmap, blackout, resizeBilinear } from "../core/imageOps";
import { clampRect, padRect } from "../core/geometry";

interface Region { x: number; y: number; w: number; h: number }

function crop(bmp: Bitmap, r: Region): Uint8ClampedArray {
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) {
    const start = ((r.y + y) * bmp.width + r.x) * 4;
    out.set(bmp.data.subarray(start, start + r.w * 4), y * r.w * 4);
  }
  return out;
}

/** jsQR has known crashes on noisy images (e.g. "Cannot read properties of undefined"); treat those as "no code". */
function safeScan(data: Uint8ClampedArray, w: number, h: number, mode: "dontInvert" | "onlyInvert"): QRCode | null {
  try {
    return jsQR(data, w, h, { inversionAttempts: mode });
  } catch {
    return null;
  }
}

/** jsQR returns at most one code per call and can fail when several are in view, so we scan tiles too. */
function tiles(width: number, height: number): Region[] {
  const out: Region[] = [{ x: 0, y: 0, w: width, h: height }];
  for (const g of [2, 3]) {
    const tw = Math.ceil(width / g), th = Math.ceil(height / g);
    const ow = Math.round(tw * 0.25), oh = Math.round(th * 0.25); // overlap so a code on a seam is whole in some tile
    for (let gy = 0; gy < g; gy++) {
      for (let gx = 0; gx < g; gx++) {
        const x = Math.max(0, gx * tw - ow), y = Math.max(0, gy * th - oh);
        out.push({ x, y, w: Math.min(width, (gx + 1) * tw + ow) - x, h: Math.min(height, (gy + 1) * th + oh) - y });
      }
    }
  }
  return out;
}

const SCAN_MAX_SIDE = 1600;

/**
 * Finds up to `max` QR codes; each hit is blacked out in a working copy before scanning continues.
 * Scans a downscaled copy (QR codes in screenshots are large) so a 4K screen takes ~1 s, not ~10 s.
 * Rectangles are normalized, so they apply to the full-size image unchanged.
 */
export function findQrCodes(full: Bitmap, max = 8): Finding[] {
  const out: Finding[] = [];
  const longest = Math.max(full.width, full.height);
  const bmp = longest > SCAN_MAX_SIDE
    ? resizeBilinear(full, Math.round((full.width * SCAN_MAX_SIDE) / longest), Math.round((full.height * SCAN_MAX_SIDE) / longest))
    : full;
  let work = bmp;
  for (const region of tiles(bmp.width, bmp.height)) {
    while (out.length < max) {
      const pixels = crop(work, region);
      const code = safeScan(pixels, region.w, region.h, "dontInvert") ?? safeScan(pixels, region.w, region.h, "onlyInvert");
      if (!code) break;
      const pts = [code.location.topLeftCorner, code.location.topRightCorner, code.location.bottomLeftCorner, code.location.bottomRightCorner];
      const xs = pts.map((p) => p.x + region.x), ys = pts.map((p) => p.y + region.y);
      const raw = clampRect({
        left: Math.min(...xs) / bmp.width, right: Math.max(...xs) / bmp.width,
        top: Math.min(...ys) / bmp.height, bottom: Math.max(...ys) / bmp.height,
      });
      const rect = padRect(raw, (raw.right - raw.left) * 0.08, (raw.bottom - raw.top) * 0.08);
      out.push({ rect, category: "QR code", source: "local" });
      work = blackout(work, [rect]);
    }
    if (out.length >= max) break;
  }
  return out;
}
