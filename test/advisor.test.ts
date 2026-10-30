import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLogLine } from "../src/engine/logLine.js";
import { configForGoal, DEFAULT_GOAL, evaluate, loadAdvisorConfig, recommend, setScore, tierOf, type AdvisorConfig } from "../src/modules/black-sail/advisor.js";
import { flameTier } from "../src/modules/black-sail/flameReader.js";
import { loadEffectTable, type EffectEntry } from "../src/modules/black-sail/effects.js";
import { parseModifier } from "../src/modules/black-sail/modifiers.js";
import { PickTracker, type TrackerEvent } from "../src/modules/black-sail/pickTracker.js";
import type { SealWhisperRead, Slot } from "../src/modules/black-sail/sealWhisperReader.js";

let table: EffectEntry[];
let cfg: AdvisorConfig;
beforeAll(async () => {
  [table, cfg] = await Promise.all([loadEffectTable(), loadAdvisorConfig()]);
});

const mod = (t: string) => parseModifier(t)!;
const SCRAP_QTY = "+35% additional Memory Scrap Drop Quantity in base Void Sea Treasure drops";
const SCRAP_APPEAR = "+14% chance for Memory Scraps to appear among base Void Sea Treasure drops";
const SCRAP_FLAT = "Void Sea Treasures drop 10 additional Memory Scrap(s)";
const HM_CHANCE = "20% chance for 17 additional Hero Memory(ies) to drop from Void Sea Treasures";
const THREAD_X2 = "+42% chance for Memory Threads dropped from Void Sea Treasures to be multiplied by 2 time(s)";
const INVITE = "40% chance for 1 additional Void Sea Invitation(s) to drop from Void Sea Treasures";

describe("parseModifier", () => {
  it("reads every kind", () => {
    expect(mod(SCRAP_QTY)).toEqual({ kind: "qty", material: "scraps", value: 0.35 });
    expect(mod(SCRAP_APPEAR)).toEqual({ kind: "appear", material: "scraps", value: 0.14 });
    expect(mod(SCRAP_FLAT)).toEqual({ kind: "flat", material: "scraps", amount: 10 });
    expect(mod(HM_CHANCE)).toEqual({ kind: "chanceFlat", material: "heroMemories", chance: 0.2, amount: 17 });
    expect(mod(THREAD_X2)).toEqual({ kind: "multiply", material: "threads", chance: 0.42, times: 2 });
    expect(mod(INVITE)).toEqual({ kind: "chanceFlat", material: "invitations", chance: 0.4, amount: 1 });
    expect(mod("+9% Void Sea Treasure Base Drop Quantity")).toEqual({ kind: "baseQty", value: 0.09 });
    expect(mod("+2 additional Hero Memory(ies) drop from Void Sea Treasures".slice(1))).toEqual({ kind: "flat", material: "heroMemories", amount: 2 });
  });

  it("parses every effect in the table, base and doubled", () => {
    const failed = table.flatMap((e) => [e.text, e.doubledText]).filter((t) => !parseModifier(t));
    expect(failed).toEqual([]);
  });
});

describe("combo model", () => {
  const gain = (picked: string[], card: string) => evaluate([...picked, card].map(mod), cfg).value - evaluate(picked.map(mod), cfg).value;

  it("makes same-material effects worth more together than apart", () => {
    expect(gain([SCRAP_QTY], SCRAP_APPEAR)).toBeGreaterThan(gain([], SCRAP_APPEAR));
    expect(gain([THREAD_X2], "Void Sea Treasures drop 1 additional Memory Thread(s)")).toBeGreaterThan(
      gain([], "Void Sea Treasures drop 1 additional Memory Thread(s)"),
    );
  });

  it("treats appear chance as moving base drops between materials (SS12 K8 formula, 2F)", () => {
    const THREAD_APPEAR = "+53% chance for Memory Threads to appear among base Void Sea Treasure drops";
    const before = evaluate([SCRAP_QTY, SCRAP_QTY].map(mod), cfg).amounts;
    const after = evaluate([SCRAP_QTY, SCRAP_QTY, THREAD_APPEAR].map(mod), cfg).amounts;
    expect(after.threads).toBeGreaterThan(before.threads);
    expect(after.scraps).toBeLessThan(before.scraps); // some Scraps turned into Threads
    expect(after.invitations).toBe(before.invitations); // invitations aren't in the base pool
  });

  it("keeps a flat extra independent of other materials' picks", () => {
    expect(gain([THREAD_X2, HM_CHANCE], SCRAP_FLAT)).toBeCloseTo(gain([], SCRAP_FLAT));
  });

  it("ranks reproducibly and reports the combo part", () => {
    const cards = [SCRAP_APPEAR, HM_CHANCE].map((t, i) => ({ id: `c${i}`, entry: table.find((e) => e.text === t)!, doubled: false }));
    const a = recommend([mod(SCRAP_QTY)], cards, table, cfg);
    const b = recommend([mod(SCRAP_QTY)], cards, table, cfg);
    expect(a.map((r) => r.expected)).toEqual(b.map((r) => r.expected));
    expect(a.find((r) => r.candidate.id === "c0")!.combo).toBeGreaterThan(0);
  });
});

describe("PickTracker", () => {
  let dir: string;
  let events: TrackerEvent[];
  let tracker: PickTracker;
  const card = (slot: Slot, text: string, rarity: EffectEntry["rarity"]) => {
    const entry = table.find((e) => e.text === text && e.rarity === rarity) ?? table.find((e) => e.text === text)!;
    return { slot, title: "", type: null, rarity, doubled: false, effectText: text, match: { entry, textScore: 1, numbersMatch: true } };
  };
  const three = (...cards: SealWhisperRead["cards"]): SealWhisperRead => ({ view: "three", cards });
  const pickLine = (n: number) => parseLogLine(`[2026.10.25-02.51.19:865][948]TLGame: Display: [Game] UIButton@ normal-click Rarity${n}SelectedBtn`, 1);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tli-picks-"));
    events = [];
    tracker = new PickTracker({ table, config: cfg, historyDir: dir, onEvent: (e) => events.push(e) });
    await tracker.load();
  });
  afterEach(async () => {
    await tracker.flush();
    await rm(dir, { recursive: true, force: true });
  });

  it("matches the confirmed rarity to the card, records it, and survives a restart", async () => {
    tracker.onCards(three(card("left", SCRAP_QTY, "white"), card("middle", "+53% chance for Memory Threads to appear among base Void Sea Treasure drops", "blue"), card("right", INVITE, "orange")));
    expect(events[0]).toMatchObject({ kind: "advice", pick: 1 });
    tracker.onLine(pickLine(4)); // orange
    await tracker.flush();
    expect(tracker.currentPicks.map((p) => p.effect)).toEqual([INVITE]);

    const history = (await readFile(join(dir, "black-sail-whispers.jsonl"), "utf8")).trim().split("\n");
    expect(JSON.parse(history[0]!)).toMatchObject({ cycle: 1, pick: 1, assumed: false, picked: { id: "right" } });

    expect(existsSync(join(dir, "black-sail-state.json.tmp"))).toBe(false); // written via temp + rename
    const again = new PickTracker({ table, config: cfg, historyDir: dir, onEvent: () => {} });
    await again.load();
    expect(again.currentPicks.map((p) => p.effect)).toEqual([INVITE]);
  });

  it("a saved goal no longer offered (Best FE) falls back to the default; Best FE isn't offered", async () => {
    expect(cfg.goals.list.map((g) => g.id)).not.toContain("fe");
    await writeFile(join(dir, "black-sail-state.json"), JSON.stringify({ cycle: 3, picks: [], goal: "fe" }));
    const old = new PickTracker({ table, config: cfg, historyDir: dir, onEvent: () => {} });
    await old.load();
    expect(old.goal).toBe(DEFAULT_GOAL);
    expect(cfg.goals.list.map((g) => g.id)).toContain(DEFAULT_GOAL);
  });

  it("flags an ambiguous pick (two cards of the same rarity) and assumes the advised one", async () => {
    tracker.onCards(three(card("left", SCRAP_QTY, "white"), card("middle", SCRAP_FLAT, "white"), card("right", INVITE, "orange")));
    tracker.onLine(pickLine(1));
    const picked = events.find((e) => e.kind === "picked");
    expect(picked).toMatchObject({ kind: "picked", record: { assumed: true } });
  });

  it("takes the card selected on screen when the logged rarity agrees, even if two cards share it", async () => {
    tracker.onCards(three(card("left", SCRAP_QTY, "white"), card("middle", SCRAP_FLAT, "white"), card("right", INVITE, "orange")));
    tracker.onSelected("middle");
    tracker.onLine(pickLine(1));
    expect(events.find((e) => e.kind === "picked")).toMatchObject({ record: { method: "frame", assumed: false, picked: { id: "middle" } } });
  });

  it("keeps a purple +28% apart from a white +14% doubled by the pet (same text)", () => {
    const purple = "+28% chance for Memory Scraps to appear among base Void Sea Treasure drops";
    tracker.onCards(three(card("left", purple, "purple"), card("middle", SCRAP_FLAT, "white"), card("right", INVITE, "orange")));
    const advice = events.find((e) => e.kind === "advice");
    const left = advice && advice.kind === "advice" ? advice.ranked.find((r) => r.candidate.id === "left") : undefined;
    expect(left?.modifier).toEqual({ kind: "appear", material: "scraps", value: 0.28 });
  });

  it("follows the chosen goal and records it with the pick", () => {
    tracker.onCards(three(card("left", SCRAP_APPEAR, "white"), card("middle", HM_CHANCE, "purple"), card("right", THREAD_X2, "purple")));
    const best = () => {
      const a = events.filter((e) => e.kind === "advice").at(-1);
      return a && a.kind === "advice" ? a.ranked[0]!.candidate.id : null;
    };
    tracker.setGoal("scraps");
    expect(best()).toBe("left");
    tracker.setGoal("heroMemories");
    expect(best()).toBe("middle");
    tracker.onLine(pickLine(3));
    expect(events.find((e) => e.kind === "picked")).toMatchObject({ record: { goal: "heroMemories" } });
  });

  it("waits at Confirm for a card-click frame still being read", async () => {
    const click = parseLogLine("[2026.10.25-03.39.11:787][877]TLGame: Display: [Game] UIButton@ normal-click BtnSelect", 1);
    tracker.onCards(three(card("left", SCRAP_QTY, "white"), card("middle", SCRAP_FLAT, "white"), card("right", INVITE, "orange")));
    tracker.onLine(click);
    tracker.onLine(pickLine(1)); // confirmed before the click's frame was read
    expect(events.some((e) => e.kind === "picked")).toBe(false);
    tracker.onSelected("middle");
    expect(events.find((e) => e.kind === "picked")).toMatchObject({ record: { method: "frame", picked: { id: "middle" } } });
  });

  it("settles a Confirm still waiting for its frame when a second Confirm comes, keeping the picks in order", async () => {
    vi.useFakeTimers();
    try {
      const click = parseLogLine("[2026.10.25-03.39.11:787][877]TLGame: Display: [Game] UIButton@ normal-click BtnSelect", 1);
      tracker.onCards(three(card("left", SCRAP_QTY, "white"), card("middle", SCRAP_FLAT, "blue"), card("right", INVITE, "orange")));
      tracker.onLine(click);
      tracker.onLine(pickLine(1)); // waits for the click's frame
      tracker.onLine(pickLine(4)); // a second Confirm before that frame: the first is settled now
      expect(events.filter((e) => e.kind === "picked")).toMatchObject([{ record: { pick: 1, picked: { id: "left" } } }]);
      tracker.onSelected("right"); // the frame: settles the second
      await vi.advanceTimersByTimeAsync(5000); // no timer of the first is left to record it again
      expect(events.filter((e) => e.kind === "picked")).toMatchObject([
        { record: { pick: 1, picked: { id: "left" } } },
        { record: { pick: 2, picked: { id: "right" } } },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the chest to the cycle waiting for it, and keeps the picks already made after it", async () => {
    const taken = (effect: string, rarity: EffectEntry["rarity"]) => ({ id: "left", type: null, rarity, doubled: false, effect, group: "Wealth" });
    const finished = { cycle: 2, picks: Array.from({ length: 6 }, () => taken(SCRAP_QTY, "white")) };
    await writeFile(join(dir, "black-sail-state.json"), JSON.stringify({ cycle: 3, picks: [taken(INVITE, "orange")], finished }));
    const t = new PickTracker({ table, config: cfg, historyDir: dir, onEvent: (e) => events.push(e) });
    await t.load();
    t.onZoneEnd({
      index: 0, name: "XuHaiZhongGang", path: "/Game/Art/Maps/S2/XuHaiZhongGang/XuHaiZhongGang", start: 0, end: 30_000,
      startLine: 1, modifiers: [], loot: new Map([[5140, 120]]), uncertainPickups: 0, monstersCreated: 0,
    });
    await t.flush();
    expect(events.find((e) => e.kind === "chest")).toMatchObject({ record: { cycle: 2, complete: true, loot: { "5140": 120 } } });
    expect(events.some((e) => e.kind === "cycleDone")).toBe(false);
    expect(t.summary()).toEqual({ cycle: 3, picks: [taken(INVITE, "orange")] });
  });

  it("ignores a card-click result that arrives after the screen closed without a Confirm", () => {
    const closed = parseLogLine("[2026.10.24-13.36.39:168][202]TLLua: Display: [Game] TipMsgShowMgr@DispatchPageRunChange PageName = VoidPort , PageRunState = Destory ", 1);
    tracker.onCards(three(card("left", SCRAP_QTY, "white"), card("middle", SCRAP_FLAT, "white"), card("right", INVITE, "orange")));
    tracker.onLine(closed); // Esc
    tracker.onSelected("middle"); // late result of the old screen
    tracker.onCards(three(card("left", SCRAP_QTY, "white"), card("middle", SCRAP_FLAT, "white"), card("right", INVITE, "orange")));
    tracker.onLine(pickLine(1));
    expect(events.find((e) => e.kind === "picked")).toMatchObject({ record: { method: "assumed" } });
  });

  it("keeps writing history after one write fails", async () => {
    const broken = new PickTracker({ table, config: cfg, historyDir: join(dir, "missing", "deeper"), onEvent: () => {} });
    broken.setGoal("scraps"); // folder doesn't exist (no load()): this write fails
    await broken.flush();
    await mkdir(join(dir, "missing", "deeper"), { recursive: true });
    broken.setGoal("threads");
    await broken.flush();
    expect(JSON.parse(await readFile(join(dir, "missing", "deeper", "black-sail-state.json"), "utf8"))).toMatchObject({ goal: "threads" });
  });

  it("records the chest at the Terminal with the cycle's picks, and resyncs a short cycle", async () => {
    const terminal = (loot: [number, number][]) => ({
      index: 0, name: "XuHaiZhongGang", path: "/Game/Art/Maps/S2/XuHaiZhongGang/XuHaiZhongGang", start: 0, end: 30_000,
      startLine: 1, modifiers: [], loot: new Map(loot), uncertainPickups: 0, monstersCreated: 0,
    });
    tracker.onCards(three(card("left", SCRAP_QTY, "white"), card("middle", HM_CHANCE, "purple"), card("right", INVITE, "orange")));
    tracker.onLine(pickLine(4)); // only 1 pick seen this cycle (tracker started late)
    tracker.onZoneEnd(terminal([[5140, 149], [410201, 1]]));
    await tracker.flush();
    const chest = events.find((e) => e.kind === "chest");
    expect(chest).toMatchObject({ record: { cycle: 1, complete: false, unread: 0, loot: { "5140": 149, "410201": 1 } } });
    expect(tracker.summary()).toEqual({ cycle: 2, picks: [] });
    expect(await readFile(join(dir, "black-sail-chests.jsonl"), "utf8")).toContain('"5140":149');

    // Right after, an invitation boss fight in the same zone (real loot, 2026-10-25 14:00): not a chest.
    tracker.onZoneEnd(terminal([[5140, 6], [10022, 1], [71001, 1], [410202, 1]]));
    await tracker.flush();
    expect(events.filter((e) => e.kind === "chest")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: "bossRun", record: { afterCycle: 1, loot: { "410202": 1 } } });
    expect(await readFile(join(dir, "black-sail-boss-runs.jsonl"), "utf8")).toContain('"410202":1');
  });

  it("keeps an unreadable card on the list, records it as the pick when its rarity is confirmed, and leaves it out of the advice", async () => {
    const unread: SealWhisperRead["cards"][number] = { slot: "left", title: "", type: null, rarity: "blue", doubled: false, effectText: "+32 chonce for Memary Scrops", match: null };
    tracker.onCards(three(unread, card("middle", SCRAP_QTY, "white"), card("right", INVITE, "orange")));
    const advice = events.find((e) => e.kind === "advice");
    expect(advice && advice.kind === "advice" ? advice.ranked.map((r) => r.candidate.id).sort() : []).toEqual(["middle", "right"]);
    tracker.onLine(pickLine(2)); // blue: only the unread card
    await tracker.flush();
    expect(events.find((e) => e.kind === "picked")).toMatchObject({ record: { method: "rarity", picked: { id: "left", unread: true } } });
    expect(tracker.currentPicks).toHaveLength(1);
  });

  it("keeps an earlier clear selection when a later click's frame is unclear", async () => {
    tracker.onCards(three(card("left", SCRAP_QTY, "white"), card("middle", SCRAP_FLAT, "white"), card("right", INVITE, "orange")));
    tracker.onSelected("middle"); // clear
    tracker.onSelected(null); // clicked again, blank frame
    tracker.onLine(pickLine(1));
    expect(events.find((e) => e.kind === "picked")).toMatchObject({ record: { method: "frame", picked: { id: "middle" } } });
  });

  it("ignores an on-screen selection that contradicts the logged rarity", async () => {
    tracker.onCards(three(card("left", SCRAP_QTY, "white"), card("middle", HM_CHANCE, "purple"), card("right", INVITE, "orange")));
    tracker.onSelected("left"); // white, but an orange card was confirmed
    tracker.onLine(pickLine(4));
    expect(events.find((e) => e.kind === "picked")).toMatchObject({ record: { method: "rarity", picked: { id: "right" } } });
  });

  it("uses the Switch card when confirming in the Switch view, and closes the cycle after 6 picks", async () => {
    const screen = three(card("left", SCRAP_QTY, "white"), card("middle", HM_CHANCE, "purple"), card("right", INVITE, "orange"));
    for (let i = 0; i < 6; i++) {
      tracker.onCards(screen);
      tracker.onCards({ view: "switch", cards: [card("middle", "+9% Void Sea Treasure Base Drop Quantity", "white")] });
      if (i > 0) tracker.onCards(screen); // back to the 3 cards (watcher's "return" read)
      tracker.onLine(pickLine(i === 0 ? 1 : 3)); // first pick: the white Switch card; then the purple card
    }
    await tracker.flush();
    const picks = events.filter((e) => e.kind === "picked").map((e) => (e.kind === "picked" ? e.record.picked?.id : ""));
    expect(picks).toEqual(["switch", "middle", "middle", "middle", "middle", "middle"]);
    expect(events.some((e) => e.kind === "cycleDone")).toBe(true);
    expect(tracker.summary()).toEqual({ cycle: 2, picks: [] });
  });
});

describe("tiers, combo and set score (tartarus-style)", () => {
  const card = (text: string, rarity: EffectEntry["rarity"]) => ({ id: rarity, entry: table.find((e) => e.text === text && e.rarity === rarity)!, doubled: false });
  const ORANGE_QTY = "+140% additional Memory Scrap Drop Quantity in base Void Sea Treasure drops";
  const THREAD_APPEAR = "+35% chance for Memory Threads to appear among base Void Sea Treasure drops";
  const ORANGE_INVITE = "40% chance for 1 additional Void Sea Invitation(s) to drop from Void Sea Treasures";
  const SCRAP_X2 = "+84% chance for Memory Scraps dropped from Void Sea Treasures to be multiplied by 2 time(s)";

  it("reads a tier from the share of the table a card beats", () => {
    const pool = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect([10, 8, 5, 3, 1].map((g) => tierOf(g, pool))).toEqual(["S", "A", "B", "C", "D"]);
  });

  it("ranks the expert tiers: big quantity S, an invitation high under any goal, a wrong-material appear low", () => {
    const scraps = configForGoal(cfg, "scraps");
    const ranked = recommend([], [card(ORANGE_QTY, "orange"), card(ORANGE_INVITE, "orange"), card(THREAD_APPEAR, "white")], table, scraps);
    const tier = (text: string) => ranked.find((r) => r.candidate.entry.text === text)!.tier;
    expect(tier(ORANGE_QTY)).toBe("S");
    expect(["S", "A"]).toContain(tier(ORANGE_INVITE));
    expect(tier(THREAD_APPEAR)).toBe("D");
  });

  it("gives a doubling card a combo after a quantity pick, and the set score after taking it", () => {
    const scraps = configForGoal(cfg, "scraps");
    const picked = [mod(ORANGE_QTY)];
    const [r] = recommend(picked, [card(SCRAP_X2, "orange")], table, scraps);
    expect(r!.combo).toBeGreaterThan(0); // doubling multiplies the stacked quantity
    expect(r!.setAfter).toBeCloseTo(setScore([...picked, r!.modifier], scraps));
    expect(setScore(picked, scraps)).toBeGreaterThan(1);
    expect(setScore([], scraps)).toBe(1);
  });

  it("shows final ×N in the same order as the ranking, and now % of the current chest", () => {
    const scraps = configForGoal(cfg, "scraps");
    const picked = [mod(ORANGE_QTY)];
    const ranked = recommend(picked, [card(SCRAP_X2, "orange"), card(ORANGE_INVITE, "orange"), card(THREAD_APPEAR, "white")], table, scraps);
    const finals = ranked.map((r) => r.final);
    expect(finals).toEqual([...finals].sort((a, b) => b - a)); // ★ BEST has the highest final
    const before = setScore(picked, scraps);
    for (const r of ranked) expect(r.nowPct).toBeCloseTo((100 * (r.setAfter - before)) / before);
  });

  it("tiers flames by the research priority", () => {
    expect(["boss_whisper_rare", "wealth_magic", "boss_whisper", "fluorescent_memories", "rare_armor"].map((id) => flameTier(id, "fe"))).toEqual(["S", "A", "B", "C", "D"]);
    expect(flameTier("hero_memories", "heroMemories")).toBe("S");
  });
});
