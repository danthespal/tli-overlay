// Works out where the Black Sail cycle stands from the game's logs, for an overlay started
// mid-cycle (picks confirmed while it wasn't running, a chest opened meanwhile, a screen open).
//
// The log names only the RARITY of each confirmed Seal Whisper (`Rarity{N}SelectedBtn`), not which
// Whisper it was. Entering the Void Sea Terminal ends a cycle. A cycle can span game restarts (each
// launch renames UE_game.log to UE_game-backup-<date>.log), so older logs are read too, newest
// first, back to the last Terminal visit and to the overlay's last save (to count the chests opened
// since).

import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { extractEvent } from "../../engine/events.js";
import type { LogLine } from "../../engine/logLine.js";
import { readLogLines } from "../../engine/logReader.js";
import type { Rarity } from "./effects.js";
import { PICK, RARITY_BY_BUTTON, TERMINAL_ZONE } from "./pickTracker.js";

const PAGE = /^TipMsgShowMgr@DispatchPageRunChange PageName = (VoidBeacon|VoidPort) , PageRunState = (\w+)/;
const BACKUP = /^UE_game-backup-.*\.log$/i;

/** A Terminal visit: when it started (epoch ms), and how many picks were confirmed since the one before. */
export interface TerminalVisit {
  at: number;
  picks: number;
}

/** What the logs say about the current cycle. */
export interface LogCycle {
  /** Rarities confirmed since the last Terminal visit, oldest first. */
  picks: Rarity[];
  /** The Terminal visits read, oldest first (at least one). */
  visits: TerminalVisit[];
}

/** Fed every line of one log, in order. */
export class CycleScanner {
  picks: Rarity[] = [];
  /** Terminal visits in this log; `picks` counts only this log's (the first may follow older ones). */
  visits: TerminalVisit[] = [];
  /** The opening line of the Black Sail screen still open at the end of the lines read. */
  openScreen: LogLine | null = null;

  line(line: LogLine): void {
    const t = line.text;
    let m;
    if ((m = PICK.exec(t))) this.picks.push(RARITY_BY_BUTTON[m[1]!]!);
    else if ((m = PAGE.exec(t))) {
      if (m[2] === "Run") this.openScreen = line;
      // Destory, or Hide (the handbook over it: its closing logs "Run" again).
      else if (this.openScreen && PAGE.exec(this.openScreen.text)![1] === m[1]) this.openScreen = null;
    } else if (t.startsWith("SceneLevelMgr@ OpenMainWorld END!")) {
      const e = extractEvent(line);
      if (e?.type === "mapEnter" && e.name.startsWith(TERMINAL_ZONE)) {
        this.visits.push({ at: e.time!, picks: this.picks.length }); // extractEvent needs a time
        this.picks = [];
      }
    }
  }
}

/**
 * The cycle from the live log's scanner, reading backup logs in the same folder (newest first)
 * until one has a Terminal visit, and on while they were written after `since` (the last save), so
 * every visit since is counted. Null when no log has one: where the cycle starts is unknown.
 */
export async function cycleFromLogs(live: CycleScanner, livePath: string, since = 0): Promise<LogCycle | null> {
  const scans = [live]; // newest first
  const dir = dirname(livePath);
  let backups: string[] = [];
  try {
    // The date in the name sorts them: newest first.
    backups = (await readdir(dir)).filter((n) => BACKUP.test(n) && n !== basename(livePath)).sort().reverse();
  } catch {
    /* no folder: the live log alone */
  }
  for (const name of backups) {
    const path = join(dir, name);
    const mtime = await stat(path).then((s) => s.mtimeMs, () => null);
    if (mtime === null) continue; // gone since the listing
    if (scans.some((s) => s.visits.length) && mtime <= since) break;
    const scan = new CycleScanner();
    for await (const line of readLogLines(path)) scan.line(line);
    scans.push(scan);
  }
  // Oldest first: picks after a log's last visit count toward the next visit, in a newer log.
  let picks: Rarity[] = [];
  const visits: TerminalVisit[] = [];
  for (const scan of scans.reverse()) {
    scan.visits.forEach((v, i) => visits.push(i ? v : { ...v, picks: v.picks + picks.length }));
    picks = scan.visits.length ? scan.picks : [...picks, ...scan.picks];
  }
  return visits.length ? { picks, visits } : null;
}
