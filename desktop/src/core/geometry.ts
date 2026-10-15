/**
 * Rectangle in normalized image coordinates: (0,0) is the TOP-left corner, (1,1) the bottom-right.
 * Same convention as the Jev Box type.
 */
export interface NormRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function isValidRect(r: NormRect): boolean {
  return [r.left, r.top, r.right, r.bottom].every(Number.isFinite) && r.right > r.left && r.bottom > r.top;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export function clampRect(r: NormRect): NormRect {
  return { left: clamp01(r.left), top: clamp01(r.top), right: clamp01(r.right), bottom: clamp01(r.bottom) };
}

export function unionRect(a: NormRect, b: NormRect): NormRect {
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

export function rectsIntersect(a: NormRect, b: NormRect, tolerance = 0): boolean {
  return (
    a.left <= b.right + tolerance &&
    b.left <= a.right + tolerance &&
    a.top <= b.bottom + tolerance &&
    b.top <= a.bottom + tolerance
  );
}

export function padRect(r: NormRect, dx: number, dy: number): NormRect {
  return clampRect({ left: r.left - dx, top: r.top - dy, right: r.right + dx, bottom: r.bottom + dy });
}

/** Repeatedly unions rectangles that overlap (or nearly touch) until none do. */
export function mergeOverlapping(rects: NormRect[], tolerance = 0): NormRect[] {
  const result = rects.filter(isValidRect).map((r) => ({ ...r }));
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < result.length; i++) {
      for (let j = i + 1; j < result.length; j++) {
        if (rectsIntersect(result[i], result[j], tolerance)) {
          result[i] = unionRect(result[i], result[j]);
          result.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  return result;
}

/** Size limits of the Jev image API (docs.typesafe.ai/images#limits). */
export const ImageLimits = {
  minSide: 256,
  maxSide: 1568,
  minPixels: 78_400,
  maxPixels: 2_458_624,
} as const;

/**
 * Size to resize an image to before sending it to Jev, preserving aspect ratio so Box fractions still map
 * onto the original. Returns null when no size can satisfy the API limits (e.g. a very thin strip).
 */
export function targetImageSize(width: number, height: number): { width: number; height: number } | null {
  if (!(width > 0 && height > 0)) return null;
  let scale = 1;
  if (Math.max(width, height) > ImageLimits.maxSide) scale = ImageLimits.maxSide / Math.max(width, height);
  const px = width * height * scale * scale;
  if (px > ImageLimits.maxPixels) scale *= Math.sqrt(ImageLimits.maxPixels / px) * 0.995;
  const minScale = Math.max(ImageLimits.minSide / Math.min(width, height), Math.sqrt(ImageLimits.minPixels / (width * height)));
  scale = Math.max(scale, minScale);
  const nw = Math.round(width * scale);
  const nh = Math.round(height * scale);
  const inSide = (v: number) => v >= ImageLimits.minSide && v <= ImageLimits.maxSide;
  if (!inSide(nw) || !inSide(nh)) return null;
  if (nw * nh < ImageLimits.minPixels || nw * nh > ImageLimits.maxPixels) return null;
  return { width: nw, height: nh };
}
