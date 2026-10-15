import * as fs from "node:fs";
import { app, clipboard } from "electron";
import { captureDisplays } from "./capture";
import type { SettingsStore } from "./settingsStore";

/**
 * Developer smoke test, enabled only by JEVSNAP_SMOKE_IMAGE=<png>. Runs the real capture-less pipeline
 * (worker thread, OCR, save, clipboard) inside Electron, prints a JSON report, and exits.
 * Used by `npm run smoke` (under Xvfb in CI) to prove the packaged runtime works end to end.
 */
export async function runSmoke(deps: {
  processPng: (png: Buffer) => Promise<{ savedPath: string; headline: string; result: { result: { findings: { category: string }[]; warnings: string[] } } }>;
  getStore: () => SettingsStore;
  openSettings: () => Electron.BrowserWindow;
}): Promise<void> {
  const report: Record<string, unknown> = {};
  try {
    const png = fs.readFileSync(process.env.JEVSNAP_SMOKE_IMAGE!);
    const win = deps.openSettings();
    const consoleMessages: string[] = [];
    win.webContents.on("console-message", (e: any) => consoleMessages.push(String(e?.message ?? e)));
    report.consoleMessages = consoleMessages;
    await new Promise<void>((resolve) => win.webContents.once("did-finish-load", () => resolve()));
    report.settingsTitle = await win.webContents.executeJavaScript("document.title");
    report.settingsTabs = await win.webContents.executeJavaScript("document.querySelectorAll('nav button').length");
    report.apiBridge = await win.webContents.executeJavaScript("typeof window.jevsnap?.getState");
    for (let i = 0; i < 30 && !report.detectorToggles; i++) { // the page fills itself asynchronously over IPC
      report.detectorToggles = await win.webContents.executeJavaScript("document.querySelectorAll('#detectors input[type=checkbox]').length");
      if (!report.detectorToggles) await new Promise((r) => setTimeout(r, 100));
    }

    if (process.env.JEVSNAP_SMOKE_SHOTS) { // optional: screenshot every settings tab for visual review
      for (const tab of ["general", "api", "detection", "ai"]) {
        await win.webContents.executeJavaScript(`document.querySelector('nav button[data-tab="${tab}"]').click()`);
        await new Promise((r) => setTimeout(r, 250));
        fs.writeFileSync(`${process.env.JEVSNAP_SMOKE_SHOTS}/settings-${tab}.png`, (await win.webContents.capturePage()).toPNG());
      }
    }
    const out = await deps.processPng(png);
    report.headline = out.headline;
    report.savedPath = out.savedPath;
    report.captureSaved = fs.existsSync(out.savedPath);
    report.categories = [...new Set(out.result.result.findings.map((f) => f.category))];
    report.warnings = out.result.result.warnings;
    report.clipboardHasImage = await clipboard.has("image/png");

    if (process.env.JEVSNAP_SMOKE_CAPTURE) {
      const shots = await captureDisplays();
      report.capturedDisplays = shots.map((s) => s.image.getSize());
    }
    report.ok = consoleMessages.length === 0 && Number(report.detectorToggles) > 0;
  } catch (e) {
    report.ok = false;
    report.error = e instanceof Error ? e.stack : String(e);
  }
  const line = `SMOKE_REPORT ${JSON.stringify(report)}\n`;
  process.stdout.write(line);
  // Windows GUI executables don't reliably attach stdout, so CI reads the report from a file instead.
  if (process.env.JEVSNAP_SMOKE_OUT) fs.writeFileSync(process.env.JEVSNAP_SMOKE_OUT, JSON.stringify(report));
  app.exit(report.ok ? 0 : 1);
}
