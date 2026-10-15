import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Writes atomically (temp file + rename) with owner-only permissions. */
export function writeFileAtomic(file: string, data: string | Buffer, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode, flag: "wx" });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "Screenshot 2026-10-14 at 22.18.15" */
export function timestampName(d = new Date()): string {
  return `Screenshot ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} at ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
}

/** Returns a collision-free path for a completed capture. No originals are persisted. */
export function makeCapturePath(folder: string, hasRedactions: boolean, now = new Date()): string {
  const output = path.join(folder, hasRedactions ? "Redacted" : "Not Redacted");
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const base = timestampName(now);
  let name = base;
  for (let n = 2; fs.existsSync(path.join(output, `${name}.png`)); n++) name = `${base} (${n})`;
  return path.join(output, `${name}.png`);
}
