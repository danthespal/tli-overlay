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

/** Saves in flight, per file: two at once would share the temp file and one rename would fail. */
const saving = new Map<string, Promise<void>>();

/**
 * Temp file + rename, like the other state files. Saves of the same file run one after another
 * (a first "Share" click saves twice at once: the new install id, then the answer), each writing
 * the settings as they are when its turn comes.
 */
export function saveSettings(settings: Settings, file = SETTINGS_FILE): Promise<void> {
  const write = async () => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(settings, null, 2) + "\n");
    await rename(`${file}.tmp`, file);
  };
  const next = (saving.get(file) ?? Promise.resolve()).catch(() => undefined).then(write);
  saving.set(file, next);
  // Drop the entry once the last queued save is done (no growing map).
  void next.finally(() => saving.get(file) === next && saving.delete(file)).catch(() => undefined);
  return next;
}
