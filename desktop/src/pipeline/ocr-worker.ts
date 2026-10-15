/**
 * Entry point for Tesseract.js's OCR worker thread when running inside Electron.
 *
 * Tesseract.js switches to a browser-style code path whenever `process.versions.electron` is set, and then
 * tries to fetch() the language data from a URL ("Only absolute URLs are supported"). Our OCR thread is plain
 * Node and reads the bundled model from disk, so we hide the Electron flag before loading the stock worker.
 */
try {
  Object.defineProperty(process, "versions", { value: { ...process.versions, electron: undefined }, configurable: true });
} catch {
  /* best effort */
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("tesseract.js/src/worker-script/node/index.js");
