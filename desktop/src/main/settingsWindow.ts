import * as path from "node:path";
import { BrowserWindow, app, dialog, ipcMain, shell } from "electron";
import { JevClient } from "../core/jevClient";
import { AppSettings, DEFAULT_HIDE_RULES, DEFAULT_KEEP_RULES, DETECTOR_KINDS, DETECTOR_TITLES, defaultSettings } from "../core/settings";
import { LocalDetector } from "../core/detector";
import type { SecretStore } from "./secrets";
import type { SettingsStore } from "./settingsStore";
import { expandHome } from "./util";

export interface SettingsDeps {
  store: SettingsStore;
  secrets: SecretStore;
  /** Called after settings change (re-register hotkey, autostart, ...). Returns false if the hotkey failed. */
  onChanged: (prev: AppSettings, next: AppSettings) => boolean;
  /** Hides the window while capturing so it never appears in a screenshot. */
}

let win: BrowserWindow | null = null;
let registered = false;

export function getSettingsWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

function state(deps: SettingsDeps) {
  return {
    settings: deps.store.get(),
    defaults: defaultSettings(),
    detectors: DETECTOR_KINDS.map((kind) => ({ kind, title: DETECTOR_TITLES[kind] })),
    defaultRules: { hide: DEFAULT_HIDE_RULES, keep: DEFAULT_KEEP_RULES },
    apiKey: { stored: deps.secrets.hasStored(), canPersist: deps.secrets.canPersist(), fromEnv: !!process.env.TYPESAFE_API_KEY },
    platform: process.platform,
    version: app.getVersion(),
    invalidRegexes: new LocalDetector(deps.store.get()).invalidCustomRegexes,
  };
}

function registerIpc(deps: SettingsDeps): void {
  if (registered) return;
  registered = true;
  const only = (e: Electron.IpcMainInvokeEvent) => {
    if (!win || e.sender !== win.webContents) throw new Error("Unexpected IPC sender");
  };
  ipcMain.handle("settings:get", (e) => { only(e); return state(deps); });
  ipcMain.handle("settings:save", (e, partial: Partial<AppSettings>) => {
    only(e);
    const prev = deps.store.get();
    const next = deps.store.update(partial ?? {});
    const hotkeyOk = deps.onChanged(prev, next);
    return { ...state(deps), hotkeyOk };
  });
  ipcMain.handle("settings:setApiKey", (e, key: string) => {
    only(e);
    try {
      const { persisted } = deps.secrets.set(String(key ?? ""));
      return { ok: true, persisted, ...state(deps) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), ...state(deps) };
    }
  });
  ipcMain.handle("settings:pickFolder", async (e) => {
    only(e);
    const r = await dialog.showOpenDialog(win!, {
      title: "Choose screenshots folder",
      defaultPath: expandHome(deps.store.get().saveFolderPath),
      properties: ["openDirectory", "createDirectory"],
    });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });
  ipcMain.handle("settings:openFolder", async (e) => {
    only(e);
    const dir = deps.store.saveFolder;
    await shell.openPath(dir);
  });
  ipcMain.handle("settings:testConnection", async (e) => {
    only(e);
    const s = deps.store.get();
    try {
      const client = new JevClient({ apiKey: deps.secrets.get(), baseURL: s.apiBaseURL, timeoutMs: s.requestTimeoutSeconds * 1000, maxRetries: 1 });
      const models = await client.listModels();
      return { ok: true, message: `Connected ✓ (${models.length} models available)` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("settings:openExternal", (e, url: string) => {
    only(e);
    if (typeof url === "string" && url.startsWith("https://")) void shell.openExternal(url);
  });
}

export function openSettingsWindow(deps: SettingsDeps): BrowserWindow {
  registerIpc(deps);
  const existing = getSettingsWindow();
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return existing;
  }
  win = new BrowserWindow({
    width: 700, height: 680, minWidth: 560, minHeight: 480,
    title: "JEVsnap Settings", show: false, autoHideMenuBar: true,
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "settings.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.once("ready-to-show", () => win?.show());
  win.on("closed", () => { win = null; });
  void win.loadFile(path.join(__dirname, "..", "renderer", "settings.html"));
  return win;
}
