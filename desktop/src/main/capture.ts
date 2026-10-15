import * as path from "node:path";
import { BrowserWindow, NativeImage, Display, desktopCapturer, screen } from "electron";

export interface ScreenShot {
  display: Display;
  image: NativeImage;
}

/** Captures every display at native pixel resolution. */
export async function captureDisplays(): Promise<ScreenShot[]> {
  const displays = screen.getAllDisplays();
  const maxW = Math.max(...displays.map((d) => Math.round(d.size.width * d.scaleFactor)));
  const maxH = Math.max(...displays.map((d) => Math.round(d.size.height * d.scaleFactor)));
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: maxW, height: maxH } });
  const shots: ScreenShot[] = [];
  displays.forEach((display, index) => {
    // display_id is empty on some Linux setups; fall back to enumeration order.
    const source = sources.find((s) => s.display_id === String(display.id)) ?? (sources.length === displays.length ? sources[index] : undefined);
    if (source && !source.thumbnail.isEmpty()) shots.push({ display, image: source.thumbnail });
  });
  if (shots.length === 0) {
    throw new Error("Could not capture the screen. On Wayland, allow screen sharing in the portal prompt, or run JEVsnap under X11.");
  }
  return shots;
}

export type Selection = { shot: ScreenShot; rect: { x: number; y: number; width: number; height: number } } | null;

/**
 * Freezes every display behind a dimmed full-screen overlay and lets the user drag a rectangle.
 * Resolves with the selection in the display's logical (DIP) pixels, or null on Esc / right-click.
 */
export function selectRegion(shots: ScreenShot[], preloadPath: string, pageUrl: string): Promise<Selection> {
  return new Promise((resolve) => {
    const windows: BrowserWindow[] = [];
    let done = false;
    const finish = (sel: Selection) => {
      if (done) return;
      done = true;
      for (const w of windows) if (!w.isDestroyed()) w.destroy();
      resolve(sel);
    };

    shots.forEach((shot, i) => {
      const b = shot.display.bounds;
      const win = new BrowserWindow({
        x: b.x, y: b.y, width: b.width, height: b.height,
        frame: false, show: false, resizable: false, movable: false, minimizable: false, maximizable: false,
        skipTaskbar: true, alwaysOnTop: true, hasShadow: false, enableLargerThanScreen: true, backgroundColor: "#000000",
        webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      win.setAlwaysOnTop(true, "screen-saver");
      win.removeMenu();
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (e) => e.preventDefault());
      windows.push(win);

      const preview = shot.image.resize({ width: b.width, height: b.height, quality: "good" }).toJPEG(85);
      win.webContents.ipc.once("overlay:done", (_e, rect: { x: number; y: number; width: number; height: number } | null) => {
        const valid = rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
          && rect.x >= 0 && rect.y >= 0 && rect.width >= 4 && rect.height >= 4
          && rect.x + rect.width <= b.width && rect.y + rect.height <= b.height;
        finish(valid ? { shot, rect } : null);
      });
      win.webContents.once("did-finish-load", () => {
        win.webContents.send("overlay:init", { image: `data:image/jpeg;base64,${preview.toString("base64")}`, width: b.width, height: b.height });
      });
      win.once("ready-to-show", () => {
        win.setBounds(b);
        win.show();
        if (i === 0) win.focus();
      });
      win.on("closed", () => finish(null));
      win.webContents.once("render-process-gone", () => finish(null));
      void win.loadFile(path.join(pageUrl)).catch(() => finish(null));
    });
  });
}

/** Crops a captured display image to a selection given in DIPs. */
export function cropSelection(sel: NonNullable<Selection>): Buffer {
  const { image, display } = sel.shot;
  const size = image.getSize();
  const sx = size.width / display.bounds.width;
  const sy = size.height / display.bounds.height;
  const x = Math.max(0, Math.round(sel.rect.x * sx));
  const y = Math.max(0, Math.round(sel.rect.y * sy));
  const w = Math.min(size.width - x, Math.round(sel.rect.width * sx));
  const h = Math.min(size.height - y, Math.round(sel.rect.height * sy));
  return image.crop({ x, y, width: Math.max(1, w), height: Math.max(1, h) }).toPNG();
}
