import * as fs from "node:fs";
import * as path from "node:path";
import { Menu, Notification, Tray, app, globalShortcut, nativeImage, screen, shell } from "electron";
import type { AppSettings } from "../core/settings";
import { PipelineHost } from "../pipeline/host";
import { captureDisplays, cropSelection, selectRegion } from "./capture";
import { processAndSave } from "./flow";
import { SecretStore } from "./secrets";
import { SettingsStore } from "./settingsStore";
import { getSettingsWindow, openSettingsWindow } from "./settingsWindow";
import { setLaunchAtLogin } from "./autostart";
import { runSmoke } from "./smoke";

const APP_NAME = "JEVsnap";
let tray: Tray | null = null;
let busy = false;
let statusText = "No captures yet";
let lastCapture: string | null = null;

const assets = path.join(__dirname, "..", "assets");
let store: SettingsStore;
let secrets: SecretStore;
const host = new PipelineHost();

function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
}

// ---------- tray ----------

function rebuildMenu(): void {
  if (!tray) return;
  const hk = store.get().hotkey.replace("CommandOrControl", process.platform === "darwin" ? "⌘" : "Ctrl");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Capture Region   (${hk})`, enabled: !busy, click: () => void capture("region") },
    { label: "Capture Full Screen", enabled: !busy, click: () => void capture("screen") },
    { type: "separator" },
    { label: statusText, enabled: false },
    { label: "Reveal Last Screenshot", enabled: lastCapture !== null, click: () => lastCapture && shell.showItemInFolder(lastCapture) },
    { label: "Open Screenshots Folder", click: () => { fs.mkdirSync(store.saveFolder, { recursive: true }); void shell.openPath(store.saveFolder); } },
    { type: "separator" },
    { label: "Settings…", click: () => openSettings() },
    { label: `Quit ${APP_NAME}`, click: () => app.quit() },
  ]));
}

function setStatus(text: string, isBusy: boolean): void {
  statusText = text;
  busy = isBusy;
  tray?.setToolTip(`${APP_NAME} — ${text}`);
  rebuildMenu();
}

// ---------- settings plumbing ----------

let registeredHotkeys: string[] = [];
function registerHotkey(accelerator: string): boolean {
  try {
    if (globalShortcut.isRegistered(accelerator)) return true;
    if (!globalShortcut.register(accelerator, () => void capture("region"))) return false;
    for (const previous of registeredHotkeys) globalShortcut.unregister(previous);
    registeredHotkeys = [accelerator];
    return true;
  } catch {
    return false;
  }
}

function onSettingsChanged(prev: AppSettings, next: AppSettings): boolean {
  let ok = true;
  if (prev.hotkey !== next.hotkey || !globalShortcut.isRegistered(next.hotkey)) {
    ok = registerHotkey(next.hotkey);
    if (!ok) store.update({ hotkey: prev.hotkey });
  }
  if (prev.launchAtLogin !== next.launchAtLogin) {
    try { setLaunchAtLogin(next.launchAtLogin); } catch (e) { notify(APP_NAME, `Could not change launch at login: ${(e as Error).message}`); }
  }
  rebuildMenu();
  return ok;
}

function openSettings() {
  return openSettingsWindow({ store, secrets, onChanged: onSettingsChanged });
}

// ---------- capture ----------

async function capture(mode: "region" | "screen"): Promise<void> {
  if (busy) return;
  setStatus("Capturing…", true);
  try {
    const settingsWin = getSettingsWindow();
    const wasVisible = !!settingsWin?.isVisible();
    if (wasVisible) { settingsWin!.hide(); await new Promise((r) => setTimeout(r, 200)); } // keep our own window out of the shot

    let png: Buffer | null = null;
    try {
      const shots = await captureDisplays();
      if (mode === "screen") {
        const primary = shots.find((shot) => shot.display.id === screen.getPrimaryDisplay().id) ?? shots[0];
        png = primary.image.toPNG();
      } else {
        const sel = await selectRegion(shots, path.join(__dirname, "..", "preload", "overlay.js"), path.join(__dirname, "..", "renderer", "overlay.html"));
        png = sel ? cropSelection(sel) : null;
      }
    } finally {
      if (wasVisible) settingsWin?.show();
    }
    if (!png) { setStatus(statusText === "Capturing…" ? "Capture cancelled" : statusText, false); return; }
    await processPng(png);
  } catch (e) {
    setStatus("Last capture failed", false);
    if (!(e as { jevsnapNotified?: boolean }).jevsnapNotified) notify(`${APP_NAME}: capture failed`, (e as Error).message);
  } finally {
    if (busy) setStatus(statusText, false);
  }
}

export async function processPng(png: Buffer) {
  return processAndSave(png, {
    host,
    getSettings: () => store.get(),
    getApiKey: () => secrets.get(),
    getSaveFolder: () => store.saveFolder,
    setStatus,
    onSaved: (p) => { lastCapture = p; },
  }).catch((e) => { (e as { jevsnapNotified?: boolean }).jevsnapNotified = true; throw e; });
}

// ---------- lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => openSettings()); // relaunching the app is the fallback when no tray is available
  app.on("window-all-closed", () => { /* keep running in the tray */ });
  app.on("will-quit", () => { globalShortcut.unregisterAll(); void host.dispose(); });

  void app.whenReady().then(async () => {
    app.setName(APP_NAME);
    const userData = app.getPath("userData");
    store = new SettingsStore(path.join(userData, "settings.json"));
    secrets = new SecretStore(path.join(userData, "apikey.bin"));

    if (process.env.JEVSNAP_SMOKE_IMAGE) {
      await runSmoke({ processPng, getStore: () => store, openSettings });
      return;
    }

    const icon = nativeImage.createFromPath(path.join(assets, "tray.png"));
    tray = new Tray(icon);
    tray.setToolTip(APP_NAME);
    tray.on("click", () => { if (process.platform === "win32") void capture("region"); });
    rebuildMenu();

    if (store.get().launchAtLogin) {
      try { setLaunchAtLogin(true); } catch { notify(APP_NAME, "Could not update launch at login. Toggle it in Settings."); }
    }
    const hk = store.get().hotkey;
    if (!registerHotkey(hk)) notify(APP_NAME, `Could not register ${hk}. Choose another shortcut in Settings, or use the tray menu.`);
    if (!store.existedAtStart) openSettings();
  });
}
