// Client of scripts/foreground.ps1: tells which app's window is in front and whether it covers the
// game, now and on each change (Windows reports the changes; nothing is polled). The overlay uses it
// to hide while the player works in another app over the game (not one on another monitor).

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { APP_DIR } from "../paths.js";

const SCRIPT = resolve(APP_DIR, "scripts/foreground.ps1");
/** Starts in a row that end without a single report (PowerShell blocked, say): then it gives up. */
const MAX_FAILED_STARTS = 3;

export interface Foreground {
  pid: number;
  /** Process name without ".exe" ("torchlight_infinite"); "" when Windows wouldn't say. */
  name: string;
  /** The front window overlaps the game's window (false on another monitor; true when the game's window isn't found). */
  covers: boolean;
}

export class ForegroundWatcher {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private stopped = false;
  private restartTimer: NodeJS.Timeout | undefined;
  private failedStarts = 0;

  constructor(
    private readonly onChange: (fg: Foreground) => void,
    private readonly onLog: (message: string) => void = () => {},
    /** It gave up (the helper can't run here): the overlay no longer knows what is in front. */
    private readonly onGiveUp: () => void = () => {},
  ) {}

  start(): void {
    this.stopped = false;
    if (this.proc) return;
    const proc = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT], { windowsHide: true });
    this.proc = proc;
    let reported = false;
    createInterface({ input: proc.stdout }).on("line", (line) => {
      try {
        const fg = JSON.parse(line) as Foreground;
        if (typeof fg.pid !== "number") return;
        reported = true;
        this.failedStarts = 0; // it works: a later crash starts the count over
        this.onChange(fg);
      } catch {
        // not a report line
      }
    });
    proc.stderr.on("data", (d) => this.onLog(`stderr: ${String(d).trim()}`));
    // A process that can't start at all ("error", and no "exit" may follow) counts as one that ended.
    let ended = false;
    const end = (why: string) => {
      if (ended) return;
      ended = true;
      if (this.proc === proc) this.proc = undefined;
      if (this.stopped) return;
      if (!reported) this.failedStarts++;
      if (this.failedStarts >= MAX_FAILED_STARTS) {
        this.onLog(`${why}; gave up after ${MAX_FAILED_STARTS} failed starts`);
        this.onGiveUp();
        return;
      }
      // Ended on its own (shouldn't): start again in a while, not in a tight loop.
      this.onLog(`${why}, restarting in 10 s`);
      this.restartTimer = setTimeout(() => this.start(), 10_000);
    };
    proc.on("error", (err) => end(`start failed: ${err.message}`));
    proc.on("exit", (code) => end(`exited (${code})`));
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    this.proc?.kill();
    this.proc = undefined;
  }
}
