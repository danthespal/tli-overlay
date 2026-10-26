// Keeps the advisor calibrated without the player doing anything: reads the history files, refits
// the config in place (the running advisor sees the new numbers at once) and saves it.
// Called by the overlay at start-up and after every chest and salvage, for the player's copy (the shipped
// fit blended with their own history). `npm run calibrate` refits the shipped fit itself.

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ADVISOR_CONFIG, DEFAULT_ADVISOR_CONFIG, type AdvisorConfig } from "./advisor.js";
import { calibrate, type ChestLike, type FlameLike, type History, type SalvageLike, type ScreenLike } from "./calibrate.js";
import { SALVAGE_FILE } from "./salvageTracker.js";

/** A .jsonl history file, one record per line (missing file = none). */
export async function jsonl<T>(path: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  // Line by line: a line cut off by a crash mid-append costs that line, not the whole history.
  const out: T[] = [];
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l) as T);
    } catch {
      /* cut-off line */
    }
  }
  return out;
}

export async function loadHistory(historyDir: string): Promise<History> {
  const [chests, screens, flames, salvages] = await Promise.all([
    jsonl<ChestLike>(join(historyDir, "black-sail-chests.jsonl")),
    jsonl<ScreenLike>(join(historyDir, "black-sail-whispers.jsonl")),
    jsonl<FlameLike>(join(historyDir, "black-sail-flames.jsonl")),
    jsonl<SalvageLike>(join(historyDir, SALVAGE_FILE)),
  ]);
  return { chests, screens, flames, salvages };
}

/**
 * Refits `config` from the history and writes it back. `config` is mutated so every holder of the
 * object (the pick tracker, the overlay) uses the new numbers without reloading.
 *
 * Always from the shipped config (`shippedPath`), blended with the player's whole history: never
 * from the previous copy, so no chest counts twice, and a new release's settings reach old copies.
 */
export async function autoCalibrate(
  config: AdvisorConfig,
  historyDir: string,
  configPath = ADVISOR_CONFIG,
  shippedPath = DEFAULT_ADVISOR_CONFIG,
): Promise<NonNullable<AdvisorConfig["calibration"]>> {
  const shipped = JSON.parse(await readFile(shippedPath, "utf8")) as AdvisorConfig;
  const next = calibrate(shipped, await loadHistory(historyDir), new Date(), true);
  Object.assign(config, next);
  await writeConfig(next, configPath);
  return next.calibration!;
}

/** Temp file + rename: a crash mid-write can't leave a cut-off config that stops the next start. */
export async function writeConfig(config: AdvisorConfig, configPath = ADVISOR_CONFIG): Promise<void> {
  const tmp = `${configPath}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2) + "\n");
  await rename(tmp, configPath);
}
