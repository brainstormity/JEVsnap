import type { OCRLine } from "./engine";
import type { NormRect } from "./geometry";

const unionOf = (a: NormRect, b: NormRect): NormRect => ({
  left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom),
});

/**
 * OCR engines sometimes split one visual row into several fragments (e.g. "Phone: +1 (415)" and "555-2671").
 * Patterns such as phone numbers then fail to match. This joins fragments that sit on the same row with a
 * small horizontal gap, keeping precise per-range boxes.
 */
export function mergeRowFragments(lines: OCRLine[], imageWidth: number, imageHeight: number, maxGapInLineHeights = 1.5): OCRLine[] {
  const sorted = [...lines].sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  const rows: OCRLine[][] = [];
  for (const line of sorted) {
    const placed = rows.find((row) => {
      const last = row[row.length - 1];
      const overlap = Math.min(last.rect.bottom, line.rect.bottom) - Math.max(last.rect.top, line.rect.top);
      const h = Math.min(last.rect.bottom - last.rect.top, line.rect.bottom - line.rect.top);
      if (h <= 0 || overlap / h < 0.6) return false;
      const gapPx = (line.rect.left - last.rect.right) * imageWidth;
      const heightPx = (last.rect.bottom - last.rect.top) * imageHeight;
      return gapPx >= -2 && gapPx <= maxGapInLineHeights * heightPx;
    });
    if (placed) placed.push(line);
    else rows.push([line]);
  }
  return rows.map((row) => (row.length === 1 ? row[0] : joinFragments(row)));
}

function joinFragments(frags: OCRLine[]): OCRLine {
  let text = "";
  const offsets: { start: number; end: number; frag: OCRLine }[] = [];
  for (const f of frags) {
    if (text) text += " ";
    offsets.push({ start: text.length, end: text.length + f.text.length, frag: f });
    text += f.text;
  }
  const rect = frags.map((f) => f.rect).reduce(unionOf);
  return {
    text,
    rect,
    rangeRect: (start, end) => {
      let acc: NormRect | null = null;
      for (const o of offsets) {
        if (o.end <= start || o.start >= end) continue;
        const ls = Math.max(start, o.start) - o.start;
        const le = Math.min(end, o.end) - o.start;
        const r = o.frag.rangeRect?.(ls, le) ?? o.frag.rect;
        acc = acc ? unionOf(acc, r) : r;
      }
      return acc;
    },
  };
}
