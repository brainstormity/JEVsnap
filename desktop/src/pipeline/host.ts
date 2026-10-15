import * as path from "node:path";
import { Worker } from "node:worker_threads";
import type { AnalysisResult } from "../core/engine";
import type { AppSettings } from "../core/settings";

export interface WorkerRequest { id: number; png: Uint8Array; settings: AppSettings; apiKey: string }
export type WorkerResponse =
  | { id: number; ok: true; png: Uint8Array; result: AnalysisResult; ocrLineCount: number; width: number; height: number }
  | { id: number; ok: false; error: string };

export interface HostResult { png: Buffer; result: AnalysisResult; ocrLineCount: number; width: number; height: number }

/** Owns the long-lived pipeline worker: spawned on demand, recycled after being idle. */
export class PipelineHost {
  private worker: Worker | null = null;
  private pending = new Map<number, { resolve: (r: HostResult) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly workerFile = path.join(__dirname, "worker.js"), private readonly idleMs = 120_000) {}

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(this.workerFile);
    w.on("message", (m: WorkerResponse) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.ok) p.resolve({ png: Buffer.from(m.png), result: m.result, ocrLineCount: m.ocrLineCount, width: m.width, height: m.height });
      else p.reject(new Error(m.error));
    });
    const fail = (e: Error) => {
      if (this.worker !== w) return;
      this.worker = null;
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
      this.armIdle();
    };
    w.on("error", fail);
    w.on("exit", (code) => fail(new Error(`Processing worker stopped unexpectedly (exit code ${code}).`)));
    this.worker = w;
    return w;
  }

  process(png: Buffer, settings: AppSettings, apiKey: string): Promise<HostResult> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const w = this.ensure();
    const id = this.nextId++;
    return new Promise<HostResult>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (r) => { this.armIdle(); resolve(r); },
        reject: (e) => { this.armIdle(); reject(e); },
      });
      const req: WorkerRequest = { id, png: new Uint8Array(png), settings, apiKey };
      try { w.postMessage(req); }
      catch (e) {
        this.pending.delete(id);
        this.armIdle();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.pending.size > 0) return;
    this.idleTimer = setTimeout(() => void this.dispose(), this.idleMs);
    this.idleTimer.unref?.();
  }

  async dispose(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const w = this.worker;
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error("Processing worker was disposed."));
    this.pending.clear();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (w) await w.terminate();
  }
}
