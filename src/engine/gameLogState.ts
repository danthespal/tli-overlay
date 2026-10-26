// The game's own records of its logging, read (never written) next to its log. Seen 2026-10-26:
//
//   UE_game/TorchLight/Saved/Crash.ini
//     One byte: how many more game starts the game turns all logging on by itself after recent
//     crashes. At each start it logs "Log@ LogState on by HaveCrashedCount N" and writes N - 1
//     (10, 9, 8 on three starts in a row). At 0 the log stays off unless the player turns it on.
//   UE_game/Local/CommonCache/LogManuallyEnableState
//     {"LogManuallyStateModified":false,"LogManuallyEnableCount":0}: what the game reads at start
//     for a saved choice of the player. Pressing Enable Log didn't change it (4 presses, 2 days),
//     so a press lasts one game session.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface GameLogState {
  /** Game starts left with logging forced on by crashes; null = no Crash.ini (or unreadable). */
  crashStarts: number | null;
  /** The player's saved choice turns logging on; null = no state file. */
  manual: boolean | null;
}

/** The UE_game folder of a log at <UE_game>/TorchLight/Saved/Logs/UE_game.log. */
export function gameFolderOf(logPath: string): string {
  return resolve(dirname(logPath), "../../..");
}

/** Crash.ini holds a raw byte (0x07 = 7); a digit text is read the same way, in case. */
export function parseCrashCount(bytes: Buffer): number | null {
  const text = bytes.toString("latin1").trim();
  if (/^\d{1,3}$/.test(text)) return Number(text);
  return bytes.length === 1 ? bytes[0]! : null;
}

export function parseManualState(text: string): boolean | null {
  try {
    const s = JSON.parse(text) as { LogManuallyStateModified?: unknown; LogManuallyEnableCount?: unknown };
    return s.LogManuallyStateModified === true || (typeof s.LogManuallyEnableCount === "number" && s.LogManuallyEnableCount > 0);
  } catch {
    return null;
  }
}

export async function readGameLogState(logPath: string): Promise<GameLogState> {
  const game = gameFolderOf(logPath);
  const [crash, manual] = await Promise.all([
    readFile(join(game, "TorchLight/Saved/Crash.ini")).then(parseCrashCount, () => null),
    readFile(join(game, "Local/CommonCache/LogManuallyEnableState"), "utf8").then(parseManualState, () => null),
  ]);
  return { crashStarts: crash, manual };
}
