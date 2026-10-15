import * as fs from "node:fs";
import { safeStorage } from "electron";
import { writeFileAtomic } from "./util";

/**
 * Stores the API key encrypted with the OS keystore (Windows DPAPI, macOS Keychain, Linux libsecret/kwallet)
 * via Electron's safeStorage. If no real keystore exists (Electron then falls back to a hard-coded password on
 * Linux, "basic_text"), the key is NOT written to disk; it is kept in memory for the session only.
 */
export class SecretStore {
  private sessionKey: string | null = null;

  constructor(private readonly file: string) {}

  /** True when keys can be persisted securely on this machine. */
  canPersist(): boolean {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      const backend = typeof safeStorage.getSelectedStorageBackend === "function" ? safeStorage.getSelectedStorageBackend() : "";
      return backend !== "basic_text";
    } catch {
      return false;
    }
  }

  hasStored(): boolean {
    return this.sessionKey !== null || (fs.existsSync(this.file) && this.readStored() !== null);
  }

  private readStored(): string | null {
    try {
      return safeStorage.decryptString(fs.readFileSync(this.file));
    } catch {
      return null;
    }
  }

  /** Session key, else the stored key, else the TYPESAFE_API_KEY environment variable. */
  get(): string {
    return this.sessionKey ?? this.readStored() ?? process.env.TYPESAFE_API_KEY?.trim() ?? "";
  }

  set(key: string): { persisted: boolean } {
    const k = key.trim();
    if (!k) {
      this.clear();
      return { persisted: false };
    }
    if (this.canPersist()) {
      writeFileAtomic(this.file, safeStorage.encryptString(k));
      this.sessionKey = null;
      return { persisted: true };
    }
    this.sessionKey = k;
    return { persisted: false };
  }

  clear(): void {
    fs.rmSync(this.file, { force: true });
    this.sessionKey = null;
  }
}
