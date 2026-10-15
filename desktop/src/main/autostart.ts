import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { app } from "electron";

/** Launch at login: native login item on Windows/macOS, an XDG autostart entry on Linux. */
export function setLaunchAtLogin(enabled: boolean): void {
  if (process.platform === "linux") {
    const dir = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "autostart");
    const file = path.join(dir, "jevsnap.desktop");
    if (!enabled) {
      fs.rmSync(file, { force: true });
      return;
    }
    // AppImage runs from a temporary mount; APPIMAGE points at the real file.
    const exec = process.env.APPIMAGE ?? process.execPath;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=JEVsnap\nComment=Redact screenshots automatically\nExec="${exec}"\nX-GNOME-Autostart-enabled=true\n`);
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled });
}
