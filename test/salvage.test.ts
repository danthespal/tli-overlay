// Hero Memory salvage: engine item batches, the salvage tracker, backfill from a log, and the
// memory value that calibration derives from it.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../src/engine/engine.js";
import { parseLogLine } from "../src/engine/logLine.js";
import type { ItemBatch } from "../src/engine/session.js";
import { loadAdvisorConfig, type AdvisorConfig } from "../src/modules/black-sail/advisor.js";
import { calibrate, memoryValue } from "../src/modules/black-sail/calibrate.js";
import { backfillSalvage, salvageOf, SalvageTracker, scanLogsForSalvage, type SalvageRecord } from "../src/modules/black-sail/salvageTracker.js";

let cfg: AdvisorConfig;
beforeAll(async () => {
  cfg = await loadAdvisorConfig();
});

// Real lines (2026-10-25 13:29:58 UTC): three memories salvaged, Thread stacks grow. The InitBagData
// lines give the stack sizes before, so the gains are known.
const H = (t: string) => `[2026.10.25-13.29.${t}][843]TLLua: Display: [Game] `;
const SALVAGE_LINES = [
  `${H("50:000")}BagMgr@:InitBagData PageId = 102 SlotId = 29 ConfigBaseId = 5142 Num = 244`,
  `${H("50:000")}BagMgr@:InitBagData PageId = 102 SlotId = 17 ConfigBaseId = 5144 Num = 39`,
  `${H("58:083")}ItemChange@ ProtoName=ExchangeItem start`,
  `${H("58:083")}ItemChange@ Update Id=5142_9a34386d-c992-11f1-a350-0000000001b9 BagNum=245 in PageId=102 SlotId=29`,
  `${H("58:083")}ItemChange@ Update Id=5144_107017a0-cfed-11f1-85cd-0000000000ab BagNum=40 in PageId=102 SlotId=17`,
  `${H("58:084")}ItemChange@ Update Id=5143_7c6b9d39-cc13-11f1-8039-0000000000d4 BagNum=124 in PageId=102 SlotId=24`,
  `${H("58:084")}ItemChange@ Delete Id=71003_2178873e-d077-11f1-aa7d-000000000065 in PageId=100 SlotId=33`,
  `${H("58:084")}ItemChange@ Delete Id=71002_215a0405-d077-11f1-aa7d-000000000065 in PageId=100 SlotId=32`,
  `${H("58:084")}ItemChange@ Delete Id=71001_211935f3-d077-11f1-aa7d-000000000065 in PageId=100 SlotId=30`,
  `${H("58:085")}ItemChange@ ProtoName=ExchangeItem end`,
];
const feed = (engine: Engine, lines: string[]) => lines.forEach((l, i) => engine.feed(parseLogLine(l, i + 1)));

describe("engine item batches", () => {
  it("reports every batch with deleted stacks, gains and unknown previous sizes", () => {
    const batches: ItemBatch[] = [];
    const engine = new Engine([{ id: "t", name: "t", summary: () => null, onBatch: (b) => batches.push(b) }]);
    feed(engine, SALVAGE_LINES);
    expect(batches).toHaveLength(1);
    const b = batches[0]!;
    expect(b.proto).toBe("ExchangeItem");
    expect([...b.deleted]).toEqual([[71003, 1], [71002, 1], [71001, 1]]);
    expect([...b.gained]).toEqual([[5142, 1], [5144, 1]]); // 5143's previous size was unknown
    expect(b.uncertain).toBe(1);
  });
});

describe("salvageOf", () => {
  const batch = (proto: string, deleted: [number, number][], gained: [number, number][]): ItemBatch => ({
    proto, time: 0, lineNo: 1, deleted: new Map(deleted), gained: new Map(gained), uncertain: 0,
  });
  it("recognises a memory salvage and whether the batch was memories only", () => {
    expect(salvageOf(batch("ExchangeItem", [[71001, 2]], [[5141, 1], [5144, 1]]))).toMatchObject({ memories: { "71001": 2 }, threads: { "5141": 1, "5144": 1 }, scraps: 0, pure: true });
    expect(salvageOf(batch("ExchangeItem", [[71001, 1], [260402, 1]], [[5142, 1], [5201, 22]]))).toMatchObject({ pure: false, other: { "5201": 22 } });
    expect(salvageOf(batch("ExchangeItem", [[71001, 3]], [[5140, 729], [5143, 39]]))).toMatchObject({ scraps: 729, pure: true });
  });
  it("ignores other batches", () => {
    expect(salvageOf(batch("PickItems", [[71001, 1]], []))).toBeNull();
    expect(salvageOf(batch("ExchangeItem", [[260402, 1]], [[5201, 4]]))).toBeNull();
  });
});

describe("SalvageTracker and backfill", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tli-salvage-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes one history line per salvage, with the log time as key", async () => {
    const events: SalvageRecord[] = [];
    const tracker = new SalvageTracker({ historyDir: join(dir, "history"), onEvent: (r) => events.push(r) });
    feed(new Engine([tracker]), SALVAGE_LINES);
    await tracker.flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ time: "2026-10-25T13:29:58.083Z", memories: { "71001": 1, "71002": 1, "71003": 1 }, pure: true, uncertain: 1 });
    const lines = (await readFile(join(dir, "history", "black-sail-salvage.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  it("backfills from a log file and skips batches it already has", async () => {
    const log = join(dir, "UE_game.log");
    await writeFile(log, SALVAGE_LINES.join("\n") + "\n");
    const history = join(dir, "history");
    expect(await backfillSalvage([{ path: log }], history)).toEqual({ found: 1, added: 1, memories: 3 });
    expect(await backfillSalvage([{ path: log }], history)).toEqual({ found: 1, added: 0, memories: 0 });
  });

  it("scans the log folder once per backup log and only the new part of the live log", async () => {
    const logs = join(dir, "Logs");
    const history = join(dir, "history");
    await rm(logs, { recursive: true, force: true });
    await mkdtemp(logs).catch(() => {});
    const { mkdir } = await import("node:fs/promises");
    await mkdir(logs, { recursive: true });
    await writeFile(join(logs, "UE_game-backup-2026.10.24-15.33.36.log"), SALVAGE_LINES.join("\n") + "\n");
    await writeFile(join(logs, "UE_game.log"), SALVAGE_LINES.slice(0, 2).join("\n") + "\n"); // no batch yet
    expect(await scanLogsForSalvage(logs, history)).toMatchObject({ added: 1 });
    expect(await scanLogsForSalvage(logs, history)).toMatchObject({ found: 0, added: 0 }); // nothing new: nothing read
    // The live log grows by a (different-time) salvage: it is read again from the top, found once.
    const later = SALVAGE_LINES.slice(2).map((l) => l.replace("13.29.58", "13.31.58"));
    await writeFile(join(logs, "UE_game.log"), [...SALVAGE_LINES.slice(0, 2), ...later].join("\n") + "\n");
    expect(await scanLogsForSalvage(logs, history)).toMatchObject({ found: 1, added: 1 });
  });
});

describe("memory value", () => {
  const rec = (memories: number, threads: Record<string, number>, extra: Partial<SalvageRecord> = {}) => ({
    memories: { "71001": memories }, threads, scraps: 0, pure: true, ...extra,
  });
  it("values a fresh memory by its Thread yield at the configured prices, skipping mixed and levelled batches", () => {
    const prices = { "5141": 0.005, "5142": 0.01, "5143": 0.042, "5144": 0.69 };
    const c = { ...cfg, salvage: { threadPrices: prices, minMemories: 30 } };
    const v = memoryValue(
      [
        rec(10, { "5141": 5, "5142": 3, "5143": 1, "5144": 1 }),
        rec(10, { "5141": 5, "5142": 4, "5144": 1 }),
        rec(1, { "5142": 1 }, { pure: false }), // gear in the same batch
        rec(3, { "5143": 39 }, { scraps: 729 }), // levelled memories
      ],
      c,
    );
    expect(v.memories).toBe(20);
    expect(v.perMemory).toEqual({ "5141": 0.5, "5142": 0.35, "5143": 0.05, "5144": 0.1 });
    expect(v.fe).toBeCloseTo(0.5 * 0.005 + 0.35 * 0.01 + 0.05 * 0.042 + 0.1 * 0.69, 3);
  });

  it("only replaces the Hero Memory weight once enough memories were salvaged", () => {
    const c = { ...cfg, weights: { ...cfg.weights, heroMemories: 0.3 }, salvage: { threadPrices: { "5144": 0.69 }, minMemories: 30 } };
    const few = calibrate(c, { chests: [], screens: [], flames: [], salvages: [rec(10, { "5144": 10 })] });
    expect(few.weights.heroMemories).toBe(0.3);
    expect(few.calibration!.salvaged).toBe(10);
    const enough = calibrate(c, { chests: [], screens: [], flames: [], salvages: [rec(30, { "5144": 30 })] });
    expect(enough.weights.heroMemories).toBe(0.69);
  });
});
