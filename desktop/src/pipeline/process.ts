import { AnalysisInput, AnalysisResult, Finding, RedactionEngine } from "../core/engine";
import { blackout, fitForJev } from "../core/imageOps";
import { FetchLike, JevClient } from "../core/jevClient";
import type { AppSettings } from "../core/settings";
import { decodePng, encodePng } from "./png";
import type { OcrProvider } from "./ocr";
import { findQrCodes } from "./qr";

export interface ProcessOptions {
  settings: AppSettings;
  apiKey: string;
  ocr: OcrProvider;
  fetch?: FetchLike;
}

export interface ProcessedCapture {
  png: Buffer;
  result: AnalysisResult;
  ocrLineCount: number;
  width: number;
  height: number;
}

/**
 * OCR + detection + rendering for one screenshot. Throws on anything that would make the output unsafe to
 * share (e.g. OCR failure), so the caller never copies a half-processed image.
 */
export async function processScreenshot(png: Buffer, opts: ProcessOptions): Promise<ProcessedCapture> {
  const { settings } = opts;
  const bmp = decodePng(png);

  const localRegions: Finding[] = settings.detectBarcodes ? findQrCodes(bmp) : [];
  const lines = await opts.ocr.recognize(bmp);

  let client: JevClient | null = null;
  let clientWarning: string | undefined;
  if (opts.apiKey && (settings.aiEnabled || settings.visualEnabled)) {
    try {
      client = new JevClient({ apiKey: opts.apiKey, baseURL: settings.apiBaseURL, timeoutMs: settings.requestTimeoutSeconds * 1000, fetch: opts.fetch });
    } catch (e) {
      if (settings.abortIfAIUnavailable) throw e;
      clientWarning = e instanceof Error ? e.message : String(e);
    }
  }

  const input: AnalysisInput = {
    lines,
    localRegions,
    imageWidth: bmp.width,
    imageHeight: bmp.height,
    imageProvider: (rects) => {
      const fitted = fitForJev(blackout(bmp, rects));
      return fitted ? { data: encodePng(fitted, 6), format: "png" } : null;
    },
  };
  const result = await new RedactionEngine(settings, client).analyze(input);
  if (clientWarning) result.warnings.push(clientWarning);

  const redacted = blackout(bmp, result.rects);
  return { png: encodePng(redacted), result, ocrLineCount: lines.length, width: bmp.width, height: bmp.height };
}
