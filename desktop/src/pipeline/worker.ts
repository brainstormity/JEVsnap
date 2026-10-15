/**
 * Runs the CPU-heavy screenshot pipeline (PNG decode, OCR, detection, rendering) on a worker thread so the
 * Electron main process stays responsive. The worker is long-lived so the OCR model is loaded only once.
 */
import { parentPort } from "node:worker_threads";
import { TesseractOcr } from "./ocr";
import { processScreenshot } from "./process";
import type { WorkerRequest, WorkerResponse } from "./host";

if (!parentPort) throw new Error("worker.ts must run in a worker thread");
const port = parentPort;
const ocr = new TesseractOcr();

port.on("message", async (msg: WorkerRequest) => {
  try {
    const out = await processScreenshot(Buffer.from(msg.png), { settings: msg.settings, apiKey: msg.apiKey, ocr });
    const res: WorkerResponse = {
      id: msg.id, ok: true,
      png: out.png, result: out.result, ocrLineCount: out.ocrLineCount, width: out.width, height: out.height,
    };
    port.postMessage(res); // copy, not transfer: Electron's memory sandbox rejects transferring Buffer-backed ArrayBuffers
  } catch (e) {
    const res: WorkerResponse = { id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    port.postMessage(res);
  }
});
