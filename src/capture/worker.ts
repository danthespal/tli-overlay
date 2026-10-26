// Client of scripts/worker.ps1: one PowerShell process that does grabs and OCR without the
// 0.3-0.5 s start-up of a fresh process per request. It is started when a choice screen opens
// (warmOnScreens) or on the first request, and stopped after `idleMs` without requests, so it
// exists only while a Black Sail choice is being made. It never captures on its own.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { LogLine } from "../engine/logLine.js";
import type { ToolModule } from "../engine/module.js";
import type { OcrPage, Region } from "../ocr/windowsOcr.js";
import type { GrabResult } from "./windowCapture.js";

const SCRIPT = resolve(import.meta.dirname, "../../scripts/worker.ps1");

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type WindowInfo =
  | { ok: true; hwnd: number; title: string; minimized: boolean; foreground: boolean; window: WindowRect; client: WindowRect }
  | { ok: false; reason: string };

export interface WorkerOptions {
  /** Stop the process this long after its last reply (default 20 s). */
  idleMs?: number;
  /** Give up on a request after this long (default 15 s). */
  timeoutMs?: number;
  script?: string;
  onLog?: (message: string) => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class CaptureWorker {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private ready: Promise<void> | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private idleTimer: NodeJS.Timeout | undefined;
  private readonly idleMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: WorkerOptions = {}) {
    this.idleMs = opts.idleMs ?? 20_000;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  get running(): boolean {
    return this.proc !== undefined;
  }

  /** Starts the process now (if not running) so the next request doesn't pay the start-up. */
  warm(): void {
    void this.ensure().catch((err) => this.opts.onLog?.(`start failed: ${err}`));
  }

  async grab(outFile: string): Promise<GrabResult> {
    const r = (await this.request({ op: "grab", out: resolve(outFile) })) as GrabResult & { id?: number };
    delete r.id;
    return r;
  }

  /** Where the game window is (handle, frame and client area in screen pixels). */
  async window(): Promise<WindowInfo> {
    const r = (await this.request({ op: "window" })) as WindowInfo & { id?: number };
    delete r.id;
    return r;
  }

  async ocr(paths: string[], regions: Region[] = []): Promise<OcrPage[]> {
    const r = (await this.request({
      op: "ocr",
      paths: paths.map((p) => resolve(p)),
      regions: regions.map((x) => x.join(",")).join(";"),
    })) as { pages?: OcrPage | OcrPage[] };
    // ConvertTo-Json unwraps single-element arrays in places; normalise like ocrImages does.
    const list = <T>(v: T | T[] | undefined): T[] => (Array.isArray(v) ? v : v ? [v] : []);
    return list(r.pages).map((p) => ({ ...p, lines: list(p.lines), regions: list(p.regions) }));
  }

  /** Asks the process to quit; kills it if it doesn't within a second. */
  stop(): void {
    clearTimeout(this.idleTimer);
    const proc = this.proc;
    if (!proc) return;
    this.proc = undefined;
    this.ready = undefined;
    try {
      proc.stdin.write('{"op":"quit"}\n');
    } catch {
      /* already gone */
    }
    const killer = setTimeout(() => proc.kill(), 1000);
    proc.once("exit", () => clearTimeout(killer));
    this.failAll(new Error("capture worker stopped"));
  }

  private ensure(): Promise<void> {
    if (this.proc && this.ready) return this.ready;
    const t0 = Date.now();
    const proc = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this.opts.script ?? SCRIPT], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      let isReady = false;
      const rl = createInterface({ input: proc.stdout });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          this.opts.onLog?.(`unreadable line: ${line.slice(0, 120)}`);
          return;
        }
        if (!isReady && msg.ready) {
          isReady = true;
          this.opts.onLog?.(`ready in ${Date.now() - t0} ms`);
          resolveReady();
          return;
        }
        const id = msg.id as number | undefined;
        const p = id !== undefined ? this.pending.get(id) : undefined;
        if (!p) return;
        this.pending.delete(id!);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(String(msg.error)));
        else p.resolve(msg);
        this.touchIdle();
      });
      proc.stderr.on("data", (d: Buffer) => this.opts.onLog?.(`stderr: ${d.toString().trim().slice(0, 200)}`));
      // Only while this is still the current process: after stop() a new one may already have been
      // started (a screen opening right after the idle stop), and the old one's exit must not
      // forget the new one (it would run on, orphaned) or fail its requests.
      proc.on("error", (err) => {
        if (!isReady) rejectReady(err);
        if (this.proc === proc) this.gone(err);
      });
      proc.on("exit", (code) => {
        const err = new Error(`capture worker exited (${code})`);
        if (!isReady) rejectReady(err);
        if (this.proc === proc) this.gone(err);
      });
    });
    return this.ready;
  }

  /** The process is gone: forget it and fail whatever was waiting. A later request starts a new one. */
  private gone(err: Error): void {
    this.proc = undefined;
    this.ready = undefined;
    clearTimeout(this.idleTimer);
    this.failAll(err);
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private touchIdle(): void {
    clearTimeout(this.idleTimer);
    if (this.pending.size) return;
    this.idleTimer = setTimeout(() => {
      if (!this.pending.size) {
        this.opts.onLog?.("idle, stopping");
        this.stop();
      }
    }, this.idleMs);
  }

  private async request(body: Record<string, unknown>): Promise<unknown> {
    await this.ensure();
    const proc = this.proc!;
    const id = this.nextId++;
    clearTimeout(this.idleTimer);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`capture worker: no reply to ${String(body.op)} in ${this.timeoutMs} ms`));
        this.touchIdle();
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      proc.stdin.write(JSON.stringify({ id, ...body }) + "\n", (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }
}

const SCREEN_OPENED = /^TipMsgShowMgr@DispatchPageRunChange PageName = (VoidBeacon|VoidPort) , PageRunState = Run/;

/** Engine module: starts the worker (and the window share) the moment a choice screen opens. */
export function warmOnScreens(...targets: { warm(): void }[]): ToolModule {
  return {
    id: "capture-worker",
    name: "Capture warm-up",
    onLine(line: LogLine) {
      if (SCREEN_OPENED.test(line.text)) for (const t of targets) t.warm();
    },
    summary: () => ({ targets: targets.length }),
  };
}
