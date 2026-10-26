// Finding UE_game.log on any PC. While the game runs, the log beside the game itself: its program
// is UE_game\Binaries\Win64\torchlight_infinite.exe and the log is in UE_game\TorchLight\Saved\Logs.
// Otherwise the newest log under every Steam library that has the game and the standalone
// launcher's folder (a game under Program Files that can't write there has its log in Windows'
// VirtualStore copy). Without a log yet, an installed game's folder, where it appears once the
// game starts with logging on. A log the player chose wins, unless the game stopped writing it
// and writes another one.

import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const STEAM_APP = "1974050";
export const GAME_PROCESS = "torchlight_infinite";
/** A log unchanged this long while the game runs is not the one it writes. */
export const STALE_MS = 120_000;
const LOG_NAME = /^UE_game(_\d+)?\.log$/i;

function regQuery(key: string, value: string): string | null {
  try {
    const out = execFileSync("reg", ["query", key, "/v", value], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    return new RegExp(`${value}\\s+REG_SZ\\s+(.+)`).exec(out)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/** Steam's folder(s) from the registry, plus its default install folder. */
export function steamRoots(): string[] {
  const roots = [
    regQuery("HKCU\\Software\\Valve\\Steam", "SteamPath"),
    regQuery("HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath"),
    regQuery("HKLM\\SOFTWARE\\Valve\\Steam", "InstallPath"),
    "C:/Program Files (x86)/Steam",
  ];
  return [...new Set(roots.filter((p): p is string => !!p).map((p) => p.replace(/\\/g, "/").toLowerCase()))];
}

/** Every Steam library folder (libraryfolders.vdf lists them as "path" "D:\\SteamLibrary"). */
function steamLibraries(roots: string[]): string[] {
  const libs = new Set(roots);
  for (const root of roots) {
    try {
      const vdf = readFileSync(join(root, "steamapps/libraryfolders.vdf"), "utf8");
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1]!.replace(/\\\\/g, "/").toLowerCase());
    } catch {}
  }
  return [...libs];
}

/** The VirtualStore copy of a folder under Program Files, or null. */
function virtualStore(dir: string): string | null {
  const store = process.env.LOCALAPPDATA;
  return store && /^[a-z]:[\\/]program files/i.test(dir) ? join(store, "VirtualStore", dir.slice(3)) : null;
}

/** Log folders of every installed copy of the game: Steam libraries first, then the launcher's. */
export function gameLogDirs(roots = steamRoots()): string[] {
  const dirs: string[] = [];
  for (const lib of steamLibraries(roots)) {
    try {
      const acf = readFileSync(join(lib, `steamapps/appmanifest_${STEAM_APP}.acf`), "utf8");
      const dir = /"installdir"\s+"([^"]+)"/.exec(acf)?.[1];
      if (dir) dirs.push(join(lib, "steamapps/common", dir, "UE_game/TorchLight/Saved/Logs"));
    } catch {}
  }
  for (const base of ["C:/Program Files (x86)/Torchlight Infinite", "C:/Program Files/Torchlight Infinite"]) {
    dirs.push(join(base, "Game/UE_game/TorchLight/Saved/Logs"));
  }
  for (const d of [...dirs]) {
    const v = virtualStore(d);
    if (v) dirs.push(v);
  }
  return dirs;
}

/** The log folders beside a running game program (and their VirtualStore copy). */
export function besideGame(program: string | null): string[] {
  if (!program || !/torchlight/i.test(program)) return [];
  const own = resolve(dirname(program), "../../TorchLight/Saved/Logs");
  return [own, virtualStore(own)].filter((d): d is string => !!d);
}

function mtime(path: string): number | null {
  try {
    const s = statSync(path);
    return s.isFile() ? s.mtimeMs : null;
  } catch {
    return null;
  }
}

/** The newest UE_game.log / UE_game_2.log in these folders. */
export function newestLog(dirs: string[]): { path: string; mtime: number } | null {
  let best: { path: string; mtime: number } | null = null;
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => LOG_NAME.test(n));
    } catch {
      continue;
    }
    for (const n of names) {
      const t = mtime(join(dir, n));
      if (t !== null && (!best || t > best.mtime)) best = { path: join(dir, n), mtime: t };
    }
  }
  return best;
}

export interface LogSearch {
  /** TLI_LOG_DIR: a folder (UE_game.log in it) or a log file. */
  override?: string;
  /** The log the player chose (Choose UE_game.log...). */
  chosen?: string | null;
  /** The running game's program, when known. */
  program?: string | null;
  /** Since when the game runs (ms), 0 when it doesn't. */
  gameSince?: number;
  /** Log folders of installed games (default: gameLogDirs()). */
  dirs?: string[];
  now?: number;
}

export interface FoundLog {
  path: string;
  by: "given" | "chosen by the player" | "being written (the chosen one isn't)" | "beside the running game" | "in the game folders" | "installed game, no log yet";
}

export function findLog(o: LogSearch = {}): FoundLog | null {
  const now = o.now ?? Date.now();
  if (o.override) return { path: LOG_NAME.test(o.override.split(/[\\/]/).pop()!) ? o.override : join(o.override, "UE_game.log"), by: "given" };
  const running = !!o.gameSince;
  const beside = besideGame(o.program ?? null);
  if (o.chosen && existsSync(dirname(o.chosen))) {
    // A hand-picked log, unless the game stopped writing it and writes another, beside it or
    // beside the running game.
    const t = mtime(o.chosen);
    const idle = running && now - o.gameSince! > STALE_MS && (t === null || now - t > STALE_MS);
    const other = idle ? newestLog([dirname(o.chosen), ...beside]) : null;
    if (other && resolve(other.path) !== resolve(o.chosen) && now - other.mtime < STALE_MS) return { path: other.path, by: "being written (the chosen one isn't)" };
    return { path: o.chosen, by: "chosen by the player" };
  }
  const own = newestLog(beside);
  if (own) return { path: own.path, by: "beside the running game" };
  const dirs = o.dirs ?? gameLogDirs();
  const any = newestLog(dirs);
  if (any) return { path: any.path, by: "in the game folders" };
  // UE_game\TorchLight is there: the game is installed, and writes its log on start.
  const installed = dirs.find((d) => existsSync(resolve(d, "../..")));
  return installed ? { path: join(installed, "UE_game.log"), by: "installed game, no log yet" } : null;
}

/** Is the game running? tasklist takes ~50 ms. */
export function gameRunning(): Promise<boolean> {
  return new Promise((done) =>
    execFile("tasklist", ["/FI", `IMAGENAME eq ${GAME_PROCESS}.exe`, "/NH"], { windowsHide: true }, (err, out) => done(!err && out.toLowerCase().includes(`${GAME_PROCESS}.exe`))),
  );
}

/** The running game's program path (once per game start: PowerShell takes ~0.3 s). Null when Windows won't say (game elevated). */
export function gameProgram(): Promise<string | null> {
  return new Promise((done) =>
    execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", `(Get-Process -Name ${GAME_PROCESS} -ErrorAction SilentlyContinue | Where-Object Path | Select-Object -First 1).Path`],
      { windowsHide: true },
      (err, out) => done(!err && out.trim() ? out.trim() : null),
    ),
  );
}
