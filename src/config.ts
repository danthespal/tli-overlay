// Game paths, found on any PC (Steam or the standalone launcher, see engine/findLog.ts). Override
// with the TLI_LOG_DIR / TLI_SCREENSHOT_DIR environment variables (other installs, development).
// The overlay looks again while it runs (findLog); these are for the command-line tools.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { findLog, gameLogDirs, steamRoots } from "./engine/findLog.js";

const STEAM = steamRoots()[0]!;

/** The folder with the newest UE_game.log; without any log yet, an installed game's folder. */
export const LOG_DIR = process.env.TLI_LOG_DIR ?? (() => {
  const found = findLog();
  return found ? dirname(found.path) : gameLogDirs()[0]!;
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
