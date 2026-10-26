// Game paths, found on any PC (Steam or the standalone launcher). Override with the TLI_LOG_DIR /
// TLI_SCREENSHOT_DIR environment variables (other installs, development).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const STEAM_APP = "1974050";

function regQuery(key: string, value: string): string | null {
  try {
    const out = execFileSync("reg", ["query", key, "/v", value], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    return new RegExp(`${value}\\s+REG_SZ\\s+(.+)`).exec(out)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/** Steam's folder(s) from the registry, plus its default install folder. */
const steamRoots = [
  ...new Set(
    [
      regQuery("HKCU\\Software\\Valve\\Steam", "SteamPath"),
      regQuery("HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath"),
      regQuery("HKLM\\SOFTWARE\\Valve\\Steam", "InstallPath"),
      "C:/Program Files (x86)/Steam",
    ]
      .filter((p): p is string => !!p)
      .map((p) => p.replace(/\\/g, "/").toLowerCase()),
  ),
];
const STEAM = steamRoots[0]!;

/** Every Steam library folder (libraryfolders.vdf lists them as "path" "D:\\SteamLibrary"). */
function steamLibraries(): string[] {
  const libs = new Set(steamRoots);
  for (const root of steamRoots) {
    try {
      const vdf = readFileSync(join(root, "steamapps/libraryfolders.vdf"), "utf8");
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1]!.replace(/\\\\/g, "/").toLowerCase());
    } catch {}
  }
  return [...libs];
}

/** Candidate log folders: each Steam library that has the game, then the standalone launcher's. */
function logDirs(): string[] {
  const dirs: string[] = [];
  for (const lib of steamLibraries()) {
    try {
      const acf = readFileSync(join(lib, `steamapps/appmanifest_${STEAM_APP}.acf`), "utf8");
      const dir = /"installdir"\s+"([^"]+)"/.exec(acf)?.[1];
      if (dir) dirs.push(join(lib, "steamapps/common", dir, "UE_game/TorchLight/Saved/Logs"));
    } catch {}
  }
  for (const base of ["C:/Program Files (x86)/Torchlight Infinite", "C:/Program Files/Torchlight Infinite"]) {
    dirs.push(join(base, "Game/UE_game/TorchLight/Saved/Logs"));
  }
  // A game under Program Files that may not write there has its log in Windows' VirtualStore copy.
  const store = process.env.LOCALAPPDATA;
  for (const d of [...dirs]) if (store && /^[a-z]:[\\/]program files/i.test(d)) dirs.push(join(store, "VirtualStore", d.slice(3)));
  return dirs;
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

/** The folder with the newest UE_game.log; without any log yet, an installed game's folder. */
export const LOG_DIR =
  process.env.TLI_LOG_DIR ??
  (() => {
    const dirs = logDirs();
    const newest = dirs.map((d) => ({ d, t: mtime(join(d, "UE_game.log")) })).sort((a, b) => b.t - a.t)[0];
    if (newest && newest.t >= 0) return newest.d;
    return dirs.find((d) => existsSync(join(d, "../.."))) ?? dirs[0]!;
  })();

/** Steam F12 screenshots for Torchlight: Infinite (app 1974050), for the Steam user that has them. */
export const SCREENSHOT_DIR =
  process.env.TLI_SCREENSHOT_DIR ??
  (() => {
    const shots = (id: string) => join(STEAM, "userdata", id, "760/remote/1974050/screenshots");
    let ids: string[] = [];
    try {
      ids = readdirSync(join(STEAM, "userdata"));
    } catch {}
    return ids.map(shots).find((d) => existsSync(d)) ?? shots(ids[0] ?? "0");
  })();

/** Known item ids (ConfigBaseId). Full names will come from an item table later. */
export const KNOWN_ITEMS: Record<number, string> = {
  100300: "Flame Elementium",
  100200: "Flame Sand",
  5140: "Memory Scrap",
  5141: "Memory Thread - Normal (unconfirmed)",
  5142: "Memory Thread - Magic",
  5143: "Memory Thread - Rare",
  5144: "Memory Thread - Epic",
  6007: "Lost Secrets",
  10011: "Lavish Novel Compass",
  200028: "Precious Ember",
  410201: "Void Sea Invitation - Craving",
  410202: "Void Sea Invitation - Ecstasy",
  410203: "Void Sea Invitation - Sorrow",
  10022: "Soldier Compass",
  200029: "Matchless Ember",
  10042: "Elite Compass",
  71001: "Memory of Origin",
  71002: "Memory of Discipline",
  71003: "Memory of Progress",
};
