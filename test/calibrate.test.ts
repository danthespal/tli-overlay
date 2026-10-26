import { beforeAll, describe, expect, it } from "vitest";
import { drawOffer, evaluate, loadAdvisorConfig, recommend, SWITCH_GROUP, type AdvisorConfig } from "../src/modules/black-sail/advisor.js";
import { calibrate, calibrateBase, chestAmounts, doubledRate, flamePrior, impliedBase } from "../src/modules/black-sail/calibrate.js";
import { loadEffectTable, type EffectEntry } from "../src/modules/black-sail/effects.js";
import { parseModifier } from "../src/modules/black-sail/modifiers.js";

let table: EffectEntry[];
let cfg: AdvisorConfig;
beforeAll(async () => {
  [table, cfg] = await Promise.all([loadEffectTable(), loadAdvisorConfig()]);
});

const SCRAP_QTY = "+35% additional Memory Scrap Drop Quantity in base Void Sea Treasure drops";
const SCRAP_FLAT = "Void Sea Treasures drop 10 additional Memory Scrap(s)";
const ALL_QTY = "+21% Void Sea Treasure Drop Quantity";
const INVITE = "40% chance for 1 additional Void Sea Invitation(s) to drop from Void Sea Treasures";

/** A chest whose loot is exactly what the model predicts for these picks. */
function modelChest(picks: string[], c: AdvisorConfig) {
  const { amounts } = evaluate(picks.map((t) => parseModifier(t)!), c);
  return {
    complete: true,
    picks: picks.map((effect) => ({ effect })),
    loot: { "5140": amounts.scraps, "5144": amounts.threads, "71001": amounts.heroMemories, "410201": amounts.invitations },
  };
}

describe("calibration from chests", () => {
  it("sums the chest's item ids per material", () => {
    expect(chestAmounts({ "5140": 100, "5142": 1, "5144": 2, "71002": 3, "71003": 4, "410202": 1, "100200": 9 })).toEqual({
      scraps: 100,
      threads: 3,
      heroMemories: 7,
      invitations: 1,
    });
  });

  it("recovers the base amounts the chest was generated from, flats and multipliers included", () => {
    const truth = { ...cfg, baseAmount: { ...cfg.baseAmount, scraps: 90, threads: 2, heroMemories: 13 } };
    const chest = modelChest([SCRAP_QTY, SCRAP_FLAT, ALL_QTY, INVITE], truth);
    const implied = impliedBase(chest, cfg); // cfg has the wrong base; the picks are the same
    expect(implied.scraps).toBeCloseTo(90, 6);
    expect(implied.threads).toBeCloseTo(2, 6);
    expect(implied.heroMemories).toBeCloseTo(13, 6);
    expect(implied.invitations).toBeUndefined(); // not drawn from the base pool
  });

  it("averages complete chests only and keeps the config value for materials without data", () => {
    const a = { ...cfg, baseAmount: { ...cfg.baseAmount, scraps: 80 } };
    const b = { ...cfg, baseAmount: { ...cfg.baseAmount, scraps: 100 } };
    const chests = [modelChest([SCRAP_QTY], a), modelChest([ALL_QTY], b), { ...modelChest([], a), complete: false }];
    const fit = calibrateBase(chests, cfg);
    expect(fit.chests).toBe(2);
    expect(fit.baseAmount.scraps).toBe(90);
    expect(fit.baseAmount.invitations).toBe(cfg.baseAmount.invitations);
    expect(calibrateBase([], cfg).baseAmount).toEqual(cfg.baseAmount);
  });

  it("clamps an implied base at zero when the chest dropped less than the flat extras", () => {
    const chest = { complete: true, picks: [{ effect: SCRAP_FLAT }], loot: { "5140": 3 } };
    expect(impliedBase(chest, cfg).scraps).toBe(0);
  });
});

describe("calibration from flames and screens", () => {
  it("turns the flame history into guarantee shares, ignoring loot flames and unread ones", () => {
    const flames = [
      { effect: "boss_whisper_rare" },
      { effect: "boss_whisper_rare" },
      { effect: "wealth_magic" },
      { effect: "rare_armor" },
      { effect: null },
    ];
    const prior = flamePrior(flames);
    expect(prior.count).toBe(4);
    expect(prior.flames).toEqual([
      { group: "Boss Whisper", minRarity: "purple", p: 0.5 },
      { group: "Wealth", minRarity: "blue", p: 0.25 },
    ]);
  });

  it("measures the share of doubled screens", () => {
    const screens = [
      { offered: [{ doubled: true }, { doubled: true }], switchCard: { doubled: true } },
      { offered: [{ doubled: false }], switchCard: null },
      { offered: [], switchCard: null }, // nothing read: not a screen
    ];
    expect(doubledRate(screens)).toEqual({ rate: 0.5, count: 2 });
  });

  it("writes the measured numbers and a calibration stamp, keeping config values where history is empty", () => {
    const next = calibrate(cfg, { chests: [], screens: [], flames: [] }, new Date("2026-10-25T12:00:00Z"));
    expect(next.baseAmount).toEqual(cfg.baseAmount);
    expect(next.lookahead.flames).toEqual(cfg.lookahead.flames);
    expect(next.lookahead.doubledRate).toBe(cfg.lookahead.doubledRate);
    expect(next.calibration).toEqual({ time: "2026-10-25T12:00:00.000Z", chests: 0, screens: 0, flames: 0, salvaged: 0 });
    expect(next.goals).toBe(cfg.goals); // untouched
  });
});

describe("look-ahead futures", () => {
  const rand = (seed: number) => {
    let a = seed;
    return () => ((a = (a * 1103515245 + 12345) % 2147483648) / 2147483648);
  };
  const entryOf = (table: EffectEntry[], m: ReturnType<typeof parseModifier>) =>
    table.find((e) => parseModifier(e.text)?.kind === m!.kind && JSON.stringify(parseModifier(e.text)) === JSON.stringify(m)) ??
    table.find((e) => JSON.stringify(parseModifier(e.doubledText)) === JSON.stringify(m));

  it("always includes a purple+ Boss Whisper card when the flame prior says so, plus the Switch card", () => {
    const c: AdvisorConfig = {
      ...cfg,
      lookahead: { ...cfg.lookahead, doubledRate: 0, flames: [{ group: "Boss Whisper", minRarity: "purple", p: 1 }] },
    };
    const r = rand(7);
    for (let i = 0; i < 50; i++) {
      const offer = drawOffer(table, c, r);
      expect(offer).toHaveLength(4); // 3 cards + Switch
      const boss = offer.find((m) => m.kind === "chanceFlat" && m.material === "invitations");
      expect(boss).toBeDefined();
      expect(["purple", "orange"]).toContain(entryOf(table, boss!)!.rarity);
      const sw = offer.filter((m) => m.kind === "baseQty");
      expect(sw.length).toBeGreaterThanOrEqual(1);
      expect(table.some((e) => e.group === SWITCH_GROUP && JSON.stringify(parseModifier(e.text)) === JSON.stringify(sw.at(-1)))).toBe(true);
    }
  });

  it("never draws a Boss Whisper without a flame, and doubles the whole screen at the measured rate", () => {
    const c: AdvisorConfig = { ...cfg, lookahead: { ...cfg.lookahead, doubledRate: 1, flames: [] } };
    const r = rand(3);
    for (let i = 0; i < 50; i++) {
      const offer = drawOffer(table, c, r);
      expect(offer.some((m) => "material" in m && m.material === "invitations")).toBe(false);
      // Every card matches a doubled row (no doubled row reads like a base row of the same group+rarity).
      for (const m of offer) expect(table.some((e) => JSON.stringify(parseModifier(e.doubledText)) === JSON.stringify(m))).toBe(true);
    }
  });

  it("marks near-equal cards as a tie and clearly different ones not", () => {
    const card = (id: string, text: string) => ({ id, entry: table.find((e) => e.text === text)!, doubled: false });
    // Two identical cards at the top tie; the weaker third card doesn't (ties are only at the top).
    const twins = recommend([], [card("left", SCRAP_QTY), card("middle", SCRAP_QTY), card("right", SCRAP_FLAT)], table, cfg);
    expect(twins.map((r) => [r.candidate.id, r.tie]).sort()).toEqual([["left", true], ["middle", true], ["right", false]]);

    const apart = recommend([], [card("left", SCRAP_FLAT), card("right", "+140% additional Memory Scrap Drop Quantity in base Void Sea Treasure drops")], table, cfg);
    expect(apart[0]!.candidate.id).toBe("right");
    expect(apart.map((r) => r.tie)).toEqual([false, false]);
  });
});
