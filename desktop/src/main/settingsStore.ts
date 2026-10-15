import * as fs from "node:fs";
import * as path from "node:path";
import { AppSettings, defaultSettings, normalizeSettings } from "../core/settings";
import { expandHome, writeFileAtomic } from "./util";

export class SettingsStore {
  private current: AppSettings;
  readonly existedAtStart: boolean;

  constructor(private readonly file: string) {
    this.existedAtStart = fs.existsSync(file);
    let raw: unknown = null;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      /* missing or corrupt: start from defaults */
    }
    this.current = normalizeSettings(raw ?? defaultSettings());
  }

  get(): AppSettings {
    return this.current;
  }

  update(partial: Partial<AppSettings>): AppSettings {
    const next = normalizeSettings({ ...this.current, ...partial });
    writeFileAtomic(this.file, JSON.stringify(next, null, 2));
    this.current = next;
    return this.current;
  }

  get saveFolder(): string {
    return path.resolve(expandHome(this.current.saveFolderPath));
  }
}
