// Frames of the GAME WINDOW through Electron's window capture (Windows Graphics Capture), as
// tartarus-simulator does: the game's own pixels, without anything drawn on top (this overlay,
// other windows), and without the game having to be in front.
//
// A hidden window (capture.html) holds the share. It is started when a choice screen opens
// (warm()) and stopped after `idleMs` without a grab, so a share exists only while a Black Sail
// choice is being made. Frames are taken only on request. When Windows won't share the window
// (e.g. the game runs elevated and this app doesn't), grab() says so and the caller falls back
// to the worker's screen copy.

import { BrowserWindow, desktopCapturer, ipcMain, session } from "electron";
import { writeFile } from "node:fs/promises";
import type { CaptureWorker, WindowInfo } from "./worker.js";
import type { GrabResult } from "./windowCapture.js";

export interface GameCaptureOptions {
  worker: CaptureWorker;
  page: string;
  preload: string;
  idleMs?: number;
  onLog?: (message: string) => void;
}

interface Started {
  ok: boolean;
  width?: number;
  height?: number;
  reason?: string;
}

interface Grabbed {
  id: number;
  ok: boolean;
  buffer?: Uint8Array;
  width?: number;
  height?: number;
  reason?: string;
}

export class GameCapture {
  private win: BrowserWindow | undefined;
  private loaded: Promise<void> | undefined;
  private starting: Promise<Started> | undefined;
  private running = false;
  private sourceId: string | undefined;
  private sourceName = "";
  private nextId = 1;
  private readonly waiting = new Map<number, (g: Grabbed) => void>();
  private onStarted: ((s: Started) => void) | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private readonly idleMs: number;
  /** Bumped by stop(): a start still in flight then knows it was cancelled. */
  private generation = 0;

  constructor(private readonly opts: GameCaptureOptions) {
    this.idleMs = opts.idleMs ?? 20_000;
    ipcMain.on("capture:started", (_e, s: Started) => this.onStarted?.(s));
    ipcMain.on("capture:grabbed", (_e, g: Grabbed) => {
      const w = this.waiting.get(g.id);
      if (w) {
        this.waiting.delete(g.id);
        w(g);
      }
    });
    ipcMain.on("capture:ended", () => {
      this.opts.onLog?.("window share ended");
      this.running = false;
    });
    ipcMain.on("capture:log", (_e, m: string) => this.opts.onLog?.(m));
    // Should the page fall back to getDisplayMedia, hand it the game window, never a picker.
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      callback(this.sourceId ? { video: { id: this.sourceId, name: this.sourceName } } : {});
    });
  }

  get active(): boolean {
    return this.running;
  }

  /** Starts the share now (if not running) so the first grab of the screen is fast. */
  warm(): void {
    void this.ensure().catch((err) => this.opts.onLog?.(`start failed: ${err}`));
  }

  stop(): void {
    clearTimeout(this.idleTimer);
    if (!this.running && !this.starting) return;
    this.generation++;
    this.running = false;
    this.starting = undefined;
    this.send("capture:stop");
    this.opts.onLog?.("window share stopped");
  }

  /** The window itself is kept; only the share stops. Call on app quit. */
  dispose(): void {
    this.stop();
    this.win?.destroy();
    this.win = undefined;
  }

  /**
   * One JPEG of the game's client area to `outFile`. `ok: false` with a reason when there is no
   * share (then the caller may use the screen copy instead).
   */
  async grab(outFile: string): Promise<GrabResult> {
    let started: Started;
    try {
      started = await this.ensure();
    } catch (err) {
      return { ok: false, reason: `no window share: ${err instanceof Error ? err.message : err}` };
    }
    if (!started.ok) return { ok: false, reason: `no window share: ${started.reason}` };
    const info = await this.opts.worker.window();
    if (!info.ok) return { ok: false, reason: info.reason };
    if (info.minimized) return { ok: false, reason: "game window is minimized" };
    const g = await this.frame(info);
    this.touchIdle();
    if (!g.ok || !g.buffer) {
      if (g.reason === "no window stream") this.running = false;
      return { ok: false, reason: `no window share: ${g.reason ?? "no frame"}` };
    }
    await writeFile(outFile, Buffer.from(g.buffer));
    return { ok: true, file: outFile, x: info.client.x, y: info.client.y, width: info.client.width, height: info.client.height };
  }

  /** Messages to the hidden page; nothing once it is gone (app quitting). */
  private send(channel: string, payload?: unknown): boolean {
    if (!this.win || this.win.isDestroyed()) return false;
    this.win.webContents.send(channel, payload);
    return true;
  }

  private frame(info: Extract<WindowInfo, { ok: true }>): Promise<Grabbed> {
    const id = this.nextId++;
    if (!this.win || this.win.isDestroyed()) return Promise.resolve({ id, ok: false, reason: "no window stream" });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve({ id, ok: false, reason: "frame timed out" });
      }, 3000);
      this.waiting.set(id, (g) => {
        clearTimeout(timer);
        resolve(g);
      });
      this.send("capture:grab", { id, win: info.window, client: info.client });
    });
  }

  private async ensure(): Promise<Started> {
    if (this.running) return { ok: true };
    if (this.starting) return this.starting;
    // Clear only our own promise: after a stop() a newer start may already be in `starting`.
    const starting: Promise<Started> = this.start().finally(() => {
      if (this.starting === starting) this.starting = undefined;
    });
    this.starting = starting;
    return starting;
  }

  private async start(): Promise<Started> {
    const t0 = Date.now();
    const gen = this.generation;
    await this.page();
    const info = await this.opts.worker.window();
    if (!info.ok) throw new Error(info.reason);
    // The game's window in Chromium's list, by its handle (a browser tab can share its title).
    // When the list leaves it out (seen by tartarus-simulator), it is asked for by handle anyway.
    const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
    const source = sources.find((s) => s.id.startsWith(`window:${info.hwnd}:`));
    this.sourceId = source?.id ?? `window:${info.hwnd}:0`;
    this.sourceName = source?.name ?? info.title;
    let handler: ((s: Started) => void) | undefined;
    const started = await new Promise<Started>((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, reason: "share did not start in 8 s" }), 8000);
      handler = (s) => {
        clearTimeout(timer);
        resolve(s);
      };
      this.onStarted = handler;
      if (!this.send("capture:start", this.sourceId)) resolve({ ok: false, reason: "capture window closed" });
    });
    // Clear the slot only if it is still ours: a newer start (after a stop) may have taken it.
    if (this.onStarted === handler) this.onStarted = undefined;
    // stop() came while this was starting (the screen closed): don't leave the share running.
    if (gen !== this.generation) {
      if (started.ok) this.send("capture:stop");
      return { ok: false, reason: "stopped while starting" };
    }
    this.running = started.ok;
    this.opts.onLog?.(started.ok ? `window share of "${this.sourceName}" ${started.width}x${started.height} in ${Date.now() - t0} ms` : `window share refused: ${started.reason}`);
    if (started.ok) this.touchIdle();
    return started;
  }

  /** The hidden page, created once. */
  private page(): Promise<void> {
    if (this.loaded) return this.loaded;
    this.win = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      webPreferences: { preload: this.opts.preload, autoplayPolicy: "no-user-gesture-required" },
    });
    // A failed load must not stay cached (no share for the rest of the session): the next start retries.
    this.loaded = this.win.loadFile(this.opts.page).catch((err) => {
      this.win?.destroy();
      this.win = undefined;
      this.loaded = undefined;
      throw err;
    });
    return this.loaded;
  }

  private touchIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.opts.onLog?.("idle, stopping the window share");
      this.stop();
    }, this.idleMs);
  }
}
