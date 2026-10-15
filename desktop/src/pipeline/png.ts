import { PNG } from "pngjs";
import type { Bitmap } from "../core/imageOps";

export function decodePng(buf: Buffer): Bitmap {
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length) };
}

/** Encodes RGBA pixels as PNG. Lower deflate levels are much faster on big screenshots. */
export function encodePng(bmp: Bitmap, deflateLevel = 3): Buffer {
  const png = new PNG({ width: bmp.width, height: bmp.height });
  png.data = Buffer.from(bmp.data.buffer, bmp.data.byteOffset, bmp.data.length);
  return PNG.sync.write(png, { deflateLevel, colorType: 6 });
}
