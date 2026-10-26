// One-frame grab of the game window via scripts/capture/capture-window.ps1.
// Only called when a log trigger fires; nothing runs between triggers.

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const SCRIPT = resolve(import.meta.dirname, "../../scripts/capture/capture-window.ps1");

export type GrabResult =
  /** x, y: the game's client area on screen (physical pixels). */
  | { ok: true; file: string; x?: number; y?: number; width: number; height: number }
  | { ok: false; reason: string };

export async function grabGameWindow(outFile: string): Promise<GrabResult> {
  const { stdout } = await run(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-Out", resolve(outFile)],
    { windowsHide: true },
  );
  return JSON.parse(stdout.trim()) as GrabResult;
}
