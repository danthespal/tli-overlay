import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseLogLine } from "../src/engine/logLine.js";
import { loadAdvisorConfig, type AdvisorConfig } from "../src/modules/black-sail/advisor.js";
import { CycleScanner, cycleFromLogs } from "../src/modules/black-sail/cycleScan.js";
import { loadEffectTable, type EffectEntry } from "../src/modules/black-sail/effects.js";
import type { OwnedRead } from "../src/modules/black-sail/ownedReader.js";
import { PickTracker } from "../src/modules/black-sail/pickTracker.js";

// Real line shapes (2026-10-28 session).
const pick = (n: number, t = "16.05.53") => `[2026.10.28-${t}:080][776]TLGame: Display: [Game] UIButton@ normal-click Rarity${n}SelectedBtn`;
const terminal = (t = "16.05.57") => `[2026.10.28-${t}:672][378]TLLua: Display: [Game] SceneLevelMgr@ OpenMainWorld END! InMainLevelPath = /Game/Art/Maps/S2/XuHaiZhongGang/XuHaiZhongGang`;
const page = (name: string, state: string) => `[2026.10.28-16.05.49:050][197]TLLua: Display: [Game] TipMsgShowMgr@DispatchPageRunChange PageName = ${name} , PageRunState = ${state} `;
const other = "[2026.10.28-16.05.52:656][715]TLLua: Display: [Game] TCP Ping Result: 42";
const TERMINAL_AT = Date.UTC(2026, 9, 28, 16, 5, 57, 672);

function scan(lines: string[]): CycleScanner {
  const s = new CycleScanner();
  lines.forEach((l, i) => s.line(parseLogLine(l, i + 1)));
  return s;
}

describe("CycleScanner", () => {
  it("keeps only the picks after the last Terminal visit", () => {
    const s = scan([pick(1), pick(2), terminal(), other, pick(4), pick(2)]);
    expect(s.picks).toEqual(["orange", "blue"]);
    expect(s.visits).toEqual([{ at: TERMINAL_AT, picks: 2 }]);
  });

  it("knows which Black Sail screen is still open", () => {
    expect(scan([page("VoidPort", "Run")]).openScreen?.text).toContain("VoidPort");
    expect(scan([page("VoidPort", "Run"), page("VoidPort", "Destory")]).openScreen).toBeNull();
    expect(scan([page("VoidPort", "Run"), page("VoidPort", "Hide")]).openScreen).toBeNull();
    // Another page closing doesn't close this one.
    expect(scan([page("VoidBeacon", "Run"), page("VoidPort", "Destory")]).openScreen?.text).toContain("VoidBeacon");
  });
});

describe("cycleFromLogs", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tli-cycle-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("uses the live log alone when it has a Terminal visit", async () => {
    expect(await cycleFromLogs(scan([terminal(), pick(3)]), join(dir, "UE_game.log"))).toEqual({ picks: ["purple"], visits: [{ at: TERMINAL_AT, picks: 0 }] });
  });

  it("reads backups newest first back to the last Terminal visit", async () => {
    // Oldest: a chest, then 1 pick. Newer: 2 picks, no chest. Live: 1 pick.
    await writeFile(join(dir, "UE_game-backup-2026.10.27-23.27.47.log"), "﻿" + [pick(1), terminal(), pick(3)].join("\r\n") + "\r\n");
    await writeFile(join(dir, "UE_game-backup-2026.10.28-11.32.46.log"), [pick(2), pick(2)].join("\n") + "\n");
    const live = join(dir, "UE_game.log");
    await writeFile(live, pick(4) + "\n");
    expect(await cycleFromLogs(scan([pick(4)]), live)).toEqual({ picks: ["purple", "blue", "blue", "orange"], visits: [{ at: TERMINAL_AT, picks: 1 }] });
  });

  it("reads on to the last save, counting picks across logs", async () => {
    // Saved before the older log was written: both chests since count, the second after picks
    // that span the game restart.
    const older = join(dir, "UE_game-backup-2026.10.27-23.27.47.log");
    await writeFile(older, [pick(1), terminal("12.00.00"), pick(3)].join("\n") + "\n");
    const live = join(dir, "UE_game.log");
    const since = Date.UTC(2026, 9, 28, 11, 0, 0);
    await utimes(older, (since + 7_200_000) / 1000, (since + 7_200_000) / 1000);
    const visits = [{ at: Date.UTC(2026, 9, 28, 12, 0, 0, 672), picks: 1 }, { at: TERMINAL_AT, picks: 2 }];
    expect(await cycleFromLogs(scan([pick(2), terminal()]), live, since)).toEqual({ picks: [], visits });
    // Saved after it: the live log's visit is enough.
    expect(await cycleFromLogs(scan([pick(2), terminal()]), live, since + 9_000_000)).toEqual({ picks: [], visits: [{ at: TERMINAL_AT, picks: 1 }] });
  });

  it("gives up when no log has a Terminal visit", async () => {
    await writeFile(join(dir, "UE_game-backup-2026.10.28-11.32.46.log"), pick(2) + "\n");
    expect(await cycleFromLogs(scan([pick(4)]), join(dir, "UE_game.log"))).toBeNull();
  });
});

describe("PickTracker.reconcile", () => {
  let table: EffectEntry[];
  let cfg: AdvisorConfig;
  let dir: string;
  beforeAll(async () => {
    [table, cfg] = await Promise.all([loadEffectTable(), loadAdvisorConfig()]);
  });
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tli-reconcile-"));
  });
  let made: PickTracker[] = [];
  afterEach(async () => {
    await Promise.all(made.map((t) => t.flush())); // queued state writes, before the folder goes
    made = [];
    await rm(dir, { recursive: true, force: true });
  });

  const card = (rarity: "white" | "blue" | "purple" | "orange", effect = "known") => ({ id: "left", type: null, rarity, doubled: false, effect, group: "g" });
  /** A tracker loaded from a saved state written at `savedAt`. */
  async function tracker(saved: object, savedAt: number) {
    const path = join(dir, "black-sail-state.json");
    await writeFile(path, JSON.stringify(saved));
    await utimes(path, savedAt / 1000, savedAt / 1000);
    const t = new PickTracker({ table, config: cfg, historyDir: dir, onEvent: () => {} });
    made.push(t);
    await t.load();
    return t;
  }
  const VISITS = [{ at: TERMINAL_AT, picks: 2 }];
  const before = TERMINAL_AT - 60_000;
  const after = TERMINAL_AT + 60_000;

  it("adds picks made while the overlay was closed as unread picks", async () => {
    const t = await tracker({ cycle: 4, picks: [] }, after);
    expect(t.reconcile({ picks: ["orange", "blue"], visits: VISITS })).toBe(true);
    expect(t.summary().cycle).toBe(4);
    expect(t.currentPicks.map((p) => [p.rarity, p.unread])).toEqual([["orange", true], ["blue", true]]);
    await t.flush();
    expect(JSON.parse(await readFile(join(dir, "black-sail-state.json"), "utf8")).picks).toHaveLength(2);
  });

  it("keeps saved picks whose rarities agree with the log", async () => {
    const t = await tracker({ cycle: 4, picks: [card("orange")] }, after);
    t.reconcile({ picks: ["orange", "blue"], visits: VISITS });
    expect(t.currentPicks.map((p) => p.effect)).toEqual(["known", "(picked while the overlay was closed)"]);
  });

  it("changes nothing when the saved cycle matches the log", async () => {
    const t = await tracker({ cycle: 4, picks: [card("orange"), card("blue")] }, after);
    expect(t.reconcile({ picks: ["orange", "blue"], visits: VISITS })).toBe(false);
  });

  it("starts a new cycle when a chest was opened after the last save", async () => {
    const t = await tracker({ cycle: 4, picks: [card("orange"), card("blue")] }, before);
    t.reconcile({ picks: ["white"], visits: VISITS });
    expect(t.summary().cycle).toBe(5);
    expect(t.currentPicks.map((p) => [p.rarity, p.unread])).toEqual([["white", true]]);
  });

  it("counts every chest opened since the last save, not boss fights", async () => {
    // Seen 2026-10-30: saved at cycle 31 (1 pick, cycle 30 waiting for its chest), then 2 cycles
    // played and their chests opened with the overlay closed.
    const visits = [{ at: TERMINAL_AT, picks: 5 }, { at: TERMINAL_AT + 600_000, picks: 0 }, { at: TERMINAL_AT + 900_000, picks: 6 }];
    const t = await tracker({ cycle: 31, picks: [card("blue")], finished: { cycle: 30, picks: [] } }, before);
    expect(t.reconcile({ picks: [], visits })).toBe(true);
    expect(t.summary().cycle).toBe(33);
    expect(t.currentPicks).toEqual([]);
    await t.flush(); // the trackers below share its state file
    // Only the cycle waiting for its chest: its chest doesn't move the count, the next one does.
    const waiting = await tracker({ cycle: 31, picks: [], finished: { cycle: 30, picks: [] } }, before);
    waiting.reconcile({ picks: ["white"], visits: visits.slice(0, 2) });
    expect(waiting.summary().cycle).toBe(31);
    await waiting.flush();
    const next = await tracker({ cycle: 31, picks: [], finished: { cycle: 30, picks: [] } }, before);
    next.reconcile({ picks: [], visits });
    expect(next.summary().cycle).toBe(32);
    await next.flush();
    // Nothing saved, picks then a chest with the overlay closed: that cycle is over too.
    const fresh = await tracker({ cycle: 7, picks: [] }, before);
    fresh.reconcile({ picks: [], visits: visits.slice(0, 1) });
    expect(fresh.summary().cycle).toBe(8);
  });

  it("replaces saved picks that disagree with the log", async () => {
    const t = await tracker({ cycle: 4, picks: [card("white")] }, after);
    t.reconcile({ picks: ["orange", "blue"], visits: VISITS });
    expect(t.currentPicks.every((p) => p.unread)).toBe(true);
  });

  /** A panel read of table rows (group, rarity, text). */
  const panel = (rows: [string, "white" | "blue" | "orange", string][], count: number | null = rows.length): OwnedRead => ({
    count,
    whispers: rows.map(([group, rarity, text], i) => ({ rarity, doubled: false, text, y: 260 + i * 120, match: { entry: table.find((e) => e.group === group && e.rarity === rarity && e.text === text)!, textScore: 1, numbersMatch: true } })),
  });
  const SCRAPS: [string, "white", string] = ["Wealth", "white", "Void Sea Treasures drop 10 additional Memory Scrap(s)"];
  const BOSS_BLUE: [string, "blue", string] = ["Boss Whisper", "blue", "10% chance for 1 additional Void Sea Invitation(s) to drop from Void Sea Treasures"];
  const BOSS_ORANGE: [string, "orange", string] = ["Boss Whisper", "orange", "40% chance for 1 additional Void Sea Invitation(s) to drop from Void Sea Treasures"];

  it("fills unread picks from the Seal Whispers Owned panel by rarity (the panel is grouped by type)", async () => {
    const t = await tracker({ cycle: 4, picks: [] }, after);
    t.reconcile({ picks: ["orange", "blue", "white"], visits: VISITS });
    expect(t.onOwned(panel([SCRAPS, BOSS_BLUE, BOSS_ORANGE]))).toBe(true);
    expect(t.currentPicks.map((p) => [p.rarity, p.group, p.unread ?? false])).toEqual([
      ["orange", "Boss Whisper", false],
      ["blue", "Boss Whisper", false],
      ["white", "Wealth", false],
    ]);
    // Read again: nothing to change.
    expect(t.onOwned(panel([SCRAPS, BOSS_BLUE, BOSS_ORANGE]))).toBe(false);
    await t.flush();
    expect(JSON.parse(await readFile(join(dir, "black-sail-state.json"), "utf8")).picks[2].effect).toBe(SCRAPS[2]);
  });

  it("keeps known picks and replaces everything when the panel disagrees", async () => {
    const known = { id: "left", type: "Boss Whisper", rarity: "blue" as const, doubled: false, effect: BOSS_BLUE[2], group: "Boss Whisper" };
    const t = await tracker({ cycle: 4, picks: [known] }, after);
    t.reconcile({ picks: ["blue", "white"], visits: VISITS });
    t.onOwned(panel([SCRAPS, BOSS_BLUE]));
    expect(t.currentPicks.map((p) => p.id)).toEqual(["left", "owned"]);
    // 3 on the panel, 2 known to the tracker: the panel wins.
    t.onOwned(panel([SCRAPS, BOSS_BLUE, BOSS_ORANGE]));
    expect(t.currentPicks.map((p) => p.rarity)).toEqual(["white", "blue", "orange"]);
  });

  it("puts a full panel (opened after the 6th pick) on the cycle waiting for its chest, not the new one", async () => {
    // Seen live 2026-10-28: pick 6, then the panel, still listing all 6.
    const t = await tracker({ cycle: 4, picks: [] }, after);
    t.reconcile({ picks: ["white", "blue", "orange", "white", "blue", "orange"], visits: VISITS });
    expect(t.summary().cycle).toBe(5);
    expect(t.onOwned(panel([SCRAPS, BOSS_BLUE, BOSS_ORANGE, SCRAPS, BOSS_BLUE, BOSS_ORANGE]))).toBe(true);
    expect(t.currentPicks).toEqual([]);
    await t.flush();
    const saved = JSON.parse(await readFile(join(dir, "black-sail-state.json"), "utf8"));
    expect(saved.picks).toEqual([]);
    expect(saved.finished.cycle).toBe(4);
    expect(saved.finished.picks.map((p: { rarity: string; unread?: boolean }) => [p.rarity, p.unread ?? false])).toEqual([
      ["white", false], ["blue", false], ["orange", false], ["white", false], ["blue", false], ["orange", false],
    ]);
    // Read again: the same, nothing changes; and with no cycle waiting, a full panel is ignored.
    expect(t.onOwned(panel([SCRAPS, BOSS_BLUE, BOSS_ORANGE, SCRAPS, BOSS_BLUE, BOSS_ORANGE]))).toBe(false);
    const fresh = await tracker({ cycle: 9, picks: [] }, after);
    expect(fresh.onOwned(panel([SCRAPS, BOSS_BLUE, BOSS_ORANGE, SCRAPS, BOSS_BLUE, BOSS_ORANGE]))).toBe(false);
    expect(fresh.currentPicks).toEqual([]);
  });

  it("ignores a panel read with an unmatched Whisper or a count that disagrees", async () => {
    const t = await tracker({ cycle: 4, picks: [] }, after);
    t.reconcile({ picks: ["white"], visits: VISITS });
    expect(t.onOwned(panel([SCRAPS], 2))).toBe(false);
    const unmatched = panel([SCRAPS]);
    unmatched.whispers[0]!.match = null;
    expect(t.onOwned(unmatched)).toBe(false);
    expect(t.currentPicks[0]!.unread).toBe(true);
  });

  it("puts 6 logged picks into a cycle waiting for its chest", async () => {
    const t = await tracker({ cycle: 4, picks: [card("orange")] }, after);
    t.reconcile({ picks: ["orange", "blue", "blue", "white", "white", "purple"], visits: VISITS });
    expect(t.summary().cycle).toBe(5);
    expect(t.currentPicks).toEqual([]);
    await t.flush();
    const saved = JSON.parse(await readFile(join(dir, "black-sail-state.json"), "utf8"));
    expect(saved.finished.cycle).toBe(4);
    expect(saved.finished.picks[0].effect).toBe("known");
    expect(saved.finished.picks).toHaveLength(6);
  });
});
