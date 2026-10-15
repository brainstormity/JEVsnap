import { ClipboardItem, Notification, clipboard, shell } from "electron";
import { summarize } from "../core/engine";
import type { AppSettings } from "../core/settings";
import type { HostResult, PipelineHost } from "../pipeline/host";
import { makeCapturePath, writeFileAtomic } from "./util";

export interface FlowDeps {
  host: PipelineHost;
  getSettings: () => AppSettings;
  getApiKey: () => string;
  getSaveFolder: () => string;
  setStatus: (text: string, busy: boolean) => void;
  onSaved: (savedPath: string) => void;
}

export interface FlowOutcome {
  savedPath: string;
  headline: string;
  body: string;
  result: HostResult;
}

function notify(settings: AppSettings, title: string, body: string): void {
  if (!settings.showNotifications || !Notification.isSupported()) return;
  new Notification({ title, body, silent: true }).show();
}

/**
 * Screenshot PNG in, redacted PNG out. Fail-closed: if anything before the redacted image exists goes wrong,
 * nothing is placed on the clipboard.
 */
export async function processAndSave(png: Buffer, deps: FlowDeps): Promise<FlowOutcome> {
  const settings = deps.getSettings();
  try {
    deps.setStatus("Redacting…", true);
    const result = await deps.host.process(png, settings, deps.getApiKey());

    const savedPath = makeCapturePath(deps.getSaveFolder(), result.result.rects.length > 0);
    writeFileAtomic(savedPath, result.png);
    if (settings.copyToClipboard) await clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(result.png)], { type: "image/png" }) })]);
    deps.onSaved(savedPath);

    const total = result.result.findings.length;
    const summary = Object.entries(summarize(result.result.findings)).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v}× ${k}`).join(", ");
    let headline = total === 0 ? "No sensitive info found" : `Hid ${total} item${total === 1 ? "" : "s"}`;
    if (settings.copyToClipboard) headline += " · copied";
    let body = total === 0 ? `Nothing to hide (${result.ocrLineCount} text lines checked).` : summary;
    if (result.result.warnings.length) body += `\n⚠ ${result.result.warnings.join(" ")}`;
    deps.setStatus(headline, false);
    notify(settings, `JEVsnap: ${headline}`, body);
    if (settings.playSound) shell.beep();
    return { savedPath, headline, body, result };
  } catch (e) {
    deps.setStatus("Last capture failed", false);
    const msg = e instanceof Error ? e.message : String(e);
    const body = `${msg} Nothing was copied to the clipboard.`;
    notify({ ...settings, showNotifications: true }, "JEVsnap: redaction failed", body);
    throw e;
  }
}
