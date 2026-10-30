// Records every Hero Memory salvage the log shows, so `npm run calibrate` can keep the advisor's
// Hero Memory value equal to what salvaging really returns (09-card-advisor.md, "Measured salvage yield").
//
// A salvage is an `ExchangeItem` batch that deletes Hero Memories (71001 Origin, 71002 Discipline,
// 71003 Progress) and raises Thread stacks (5141-5144). The game salvages gear in the same batch
// kind, so a batch is `pure` only when nothing but memories was deleted.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Engine } from "../../engine/engine.js";
import { readLogLines } from "../../engine/logReader.js";
import type { ToolModule } from "../../engine/module.js";
import type { ItemBatch } from "../../engine/session.js";

export const MEMORY_IDS = new Set([71001, 71002, 71003]);
export const THREAD_IDS = new Set([5141, 5142, 5143, 5144]);
const SCRAP_ID = 5140;
export const SALVAGE_FILE = "black-sail-salvage.jsonl";

export interface SalvageRecord {
  /** Log time (UTC ISO); also the key that keeps a backfill from writing a batch twice. */
  time: string;
  /** ConfigBaseId -> memories salvaged. */
  memories: Record<string, number>;
  /** ConfigBaseId -> Threads gained. */
  threads: Record<string, number>;
  scraps: number;
  /** Anything else gained (gear salvage by-products). */
  other: Record<string, number>;
  /** True when only Hero Memories were deleted in the batch. */
  pure: boolean;
  uncertain: number;
}

/** The salvage in a batch, or null when it isn't one. */
export function salvageOf(batch: ItemBatch): SalvageRecord | null {
  if (batch.proto !== "ExchangeItem") return null;
  const memories: Record<string, number> = {};
  let pure = true;
  for (const [id, n] of batch.deleted) {
    if (MEMORY_IDS.has(id)) memories[id] = n;
    else pure = false;
  }
  if (!Object.keys(memories).length) return null;
  const threads: Record<string, number> = {};
  const other: Record<string, number> = {};
  let scraps = 0;
  for (const [id, n] of batch.gained) {
    if (THREAD_IDS.has(id)) threads[id] = n;
    else if (id === SCRAP_ID) scraps = n;
    else other[id] = n;
  }
  return { time: new Date(batch.time ?? Date.now()).toISOString(), memories, threads, scraps, other, pure, uncertain: batch.uncertain };
}

export interface SalvageDeps {
  /** Folder for black-sail-salvage.jsonl; omit to only emit events (backfill collects them itself). */
  historyDir?: string;
  onEvent?: (record: SalvageRecord) => void;
}

export class SalvageTracker implements ToolModule {
  readonly id = "black-sail-salvage";
  readonly name = "Black Sail: Hero Memory salvage";
  private count = 0;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly deps: SalvageDeps) {}

  onBatch(batch: ItemBatch): void {
    const record = salvageOf(batch);
    if (!record) return;
    this.count++;
    // Queue the write before telling listeners, so a listener's flush() covers this record.
    const dir = this.deps.historyDir;
    if (dir) {
      this.writes = this.writes
        .then(async () => {
          await mkdir(dir, { recursive: true });
          await appendFile(join(dir, SALVAGE_FILE), JSON.stringify(record) + "\n");
        })
        .catch((err) => console.error(`salvage history: ${err}`));
    }
    this.deps.onEvent?.(record);
  }

  flush(): Promise<void> {
    return this.writes;
  }

  summary() {
    return { salvages: this.count };
  }
}

export interface BackfillResult {
  found: number;
  added: number;
  memories: number;
}

/**
 * Reads salvages out of whole log files (or the first `bytes` of one) into the history file.
 * Batches already there (same log time) are skipped, so it is safe to run again and again.
 */
export async function backfillSalvage(logs: { path: string; bytes?: number }[], historyDir: string): Promise<BackfillResult> {
  await mkdir(historyDir, { recursive: true });
  const file = join(historyDir, SALVAGE_FILE);
  const existing = new Set<string>();
  try {
    for (const line of (await readFile(file, "utf8")).split("\n")) if (line) existing.add((JSON.parse(line) as SalvageRecord).time);
  } catch {
    /* no file yet */
  }
  const result: BackfillResult = { found: 0, added: 0, memories: 0 };
  for (const log of logs) {
    const fresh: SalvageRecord[] = [];
    const engine = new Engine([
      new SalvageTracker({
        onEvent: (r) => {
          result.found++;
          if (!existing.has(r.time)) fresh.push(r);
        },
      }),
    ]);
    for await (const line of readLogLines(log.path, log.bytes)) engine.feed(line);
    engine.finish();
    for (const r of fresh) {
      existing.add(r.time);
      result.memories += Object.values(r.memories).reduce((a, b) => a + b, 0);
      await appendFile(file, JSON.stringify(r) + "\n");
      result.added++;
    }
  }
  return result;
}

const SCANNED_FILE = "black-sail-scanned.json";

/**
 * Scans the game's log folder for salvages the tool wasn't running for: each backup log once, and
 * the live log up to its current size (the tailer takes over from there). Remembers what it read
 * in black-sail-scanned.json, so later starts only read what is new.
 */
export async function scanLogsForSalvage(logDir: string, historyDir: string): Promise<BackfillResult> {
  const { readdir, stat } = await import("node:fs/promises");
  const marker = join(historyDir, SCANNED_FILE);
  let scanned: Record<string, number> = {};
  try {
    scanned = JSON.parse(await readFile(marker, "utf8")) as Record<string, number>;
  } catch {
    /* first run */
  }
  let names: string[] = [];
  try {
    names = (await readdir(logDir)).filter((f) => /^UE_game.*\.log$/.test(f)).sort();
  } catch {
    return { found: 0, added: 0, memories: 0 }; // no log folder yet
  }
  const todo: { path: string; bytes?: number }[] = [];
  const next: Record<string, number> = {};
  for (const name of names) {
    const path = join(logDir, name);
    // Gone since the listing (the game renamed it on start): the next scan sees its new name.
    const size = await stat(path).then((s) => s.size, () => null);
    if (size === null) continue;
    next[name] = size;
    // The live log is rotated to a backup on each game start, so a backup is scanned once in full;
    // the live log is read when it grew (from the top: its old bytes were a different session only
    // if it was rotated, in which case the name's size shrank).
    const done = scanned[name];
    if (done === undefined || size < done || (name === "UE_game.log" && size > done)) todo.push({ path, bytes: name === "UE_game.log" ? size : undefined });
  }
  const result = await backfillSalvage(todo, historyDir);
  await mkdir(historyDir, { recursive: true });
  await writeFile(marker, JSON.stringify(next, null, 2));
  return result;
}
