// The player's choices, kept in data/settings.json (next to the exe when packaged).

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { USER_DIR } from "./paths.js";

export interface Settings {
  /** UE_game.log picked by hand (tray menu), or null to find it. */
  logPath?: string | null;
  /** Random id of this install, sent with shared data (never the Steam id). */
  install?: string;
  /** Share anonymous data: null = not asked yet. */
  share?: boolean | null;
}

export const SETTINGS_FILE = join(USER_DIR, "settings.json");

export async function loadSettings(file = SETTINGS_FILE): Promise<Settings> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Settings;
  } catch {
    return {};
  }
}

/** Temp file + rename, like the other state files. */
export async function saveSettings(settings: Settings, file = SETTINGS_FILE): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(settings, null, 2) + "\n");
  await rename(`${file}.tmp`, file);
}
