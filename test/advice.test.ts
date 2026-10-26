// Step 2 of the improvement plan: Switch outlook, reasons in words, chest vs model.
import { beforeAll, describe, expect, it } from "vitest";
import { loadAdvisorConfig, recommend, switchOutlook, type AdvisorConfig, type Ranked } from "../src/modules/black-sail/advisor.js";
import { chestReport } from "../src/modules/black-sail/calibrate.js";
import { loadEffectTable, type EffectEntry } from "../src/modules/black-sail/effects.js";
import { parseModifier, type Modifier } from "../src/modules/black-sail/modifiers.js";
import { reasonFor } from "../src/modules/black-sail/reasons.js";

let table: EffectEntry[];
let cfg: AdvisorConfig;
beforeAll(async () => {
  [table, cfg] = await Promise.all([loadEffectTable(), loadAdvisorConfig()]);
});

const SCRAP_QTY = "+35% additional Memory Scrap Drop Quantity in base Void Sea Treasure drops";
const SCRAP_QTY_GOLD = "+140% additional Memory Scrap Drop Quantity in base Void Sea Treasure drops";
const SCRAP_FLAT = "Void Sea Treasures drop 10 additional Memory Scrap(s)";
const THREAD_FLAT = "Void Sea Treasures drop 1 additional Memory Thread(s)";
const THREAD_APPEAR = "+53% chance for Memory Threads to appear among base Void Sea Treasure drops";
const ALL_QTY = "+21% Void Sea Treasure Drop Quantity";
const RARITY = "+25% Void Sea Treasure Drop Rarity";
const INVITE = "40% chance for 1 additional Void Sea Invitation(s) to drop from Void Sea Treasures";
const card = (id: string, text: string) => ({ id, entry: table.find((e) => e.text === text)!, doubled: false });
const mods = (...t: string[]) => t.map((x) => parseModifier(x)!);

describe("switchOutlook", () => {
  it("says skip when even the gold Switch card loses to the best card", () => {
    const ranked = recommend([], [card("left", SCRAP_QTY_GOLD), card("middle", THREAD_FLAT)], table, cfg);
    const o = switchOutlook([], ranked[0], false, table, cfg)!;
    expect(o.chance).toBe(0);
    expect(o.gain).toBe(0);
    expect(o.byRarity.map((b) => b.rarity)).toEqual(["white", "blue", "purple", "orange"]);
  });

  it("says worth a look when a better Switch rarity is likely, with the rarity mix as the chance", () => {
    const ranked = recommend([], [card("left", THREAD_FLAT), card("middle", SCRAP_FLAT)], table, cfg);
    const o = switchOutlook([], ranked[0], false, table, cfg)!;
    expect(o.chance).toBeGreaterThan(0.5); // most Switch rarities beat two weak flat cards
    expect(o.gain).toBeGreaterThan(0);
    const better = o.byRarity.filter((b) => b.expected > ranked[0]!.expected);
    expect(better.length).toBeGreaterThanOrEqual(3);
  });

  it("returns null without a best card", () => {
    expect(switchOutlook([], undefined, false, table, cfg)).toBeNull();
  });
});

describe("reasonFor", () => {
  const ranked = (text: string, picked: Modifier[] = []): Ranked => recommend(picked, [card("x", text)], table, cfg)[0]!;

  it("explains stacking, appear re-share, flats, boosts, rarity and invitations", () => {
    expect(reasonFor(ranked(SCRAP_QTY, mods(SCRAP_QTY, SCRAP_FLAT)), mods(SCRAP_QTY, SCRAP_FLAT), undefined)).toBe("stacks with your 2 Scrap cards");
    expect(reasonFor(ranked(SCRAP_QTY), [], "scraps")).toBe("feeds your Scrap goal; stack more of it");
    expect(reasonFor(ranked(SCRAP_QTY), [], undefined)).toBe("starts a Scrap stack; worth more with more Scrap cards");
    expect(reasonFor(ranked(THREAD_APPEAR, mods(SCRAP_QTY)), mods(SCRAP_QTY), undefined)).toBe("moves base drops from Scrap to Thread");
    expect(reasonFor(ranked(THREAD_APPEAR), [], undefined)).toBe("more Threads instead of other drops");
    expect(reasonFor(ranked(SCRAP_FLAT), [], undefined)).toBe("fixed extra Scraps, whatever else you pick");
    expect(reasonFor(ranked(ALL_QTY, mods(SCRAP_QTY)), mods(SCRAP_QTY), undefined)).toBe("boosts everything, incl. your 1 material card");
    expect(reasonFor(ranked(ALL_QTY), [], undefined)).toBe("boosts every drop; no stack needed");
    expect(reasonFor(ranked(RARITY), [], undefined)).toBe("rarity only: little value below gold");
    expect(reasonFor(ranked(INVITE), [], "scraps")).toBe("invitations: rare, full value under any goal");
  });
});

describe("chestReport", () => {
  it("sums the chest and values both it and the model's expectation at the plain weights", () => {
    const chest = { picks: [{ effect: SCRAP_QTY }], loot: { "5140": 200, "5144": 2, "71001": 10, "410201": 1, "100200": 5 } };
    const r = chestReport(chest, cfg);
    expect(r.actual).toEqual({ scraps: 200, threads: 2, heroMemories: 10, invitations: 1 });
    expect(r.actualFe).toBeCloseTo(200 * cfg.weights.scraps + 2 * cfg.weights.threads + 10 * cfg.weights.heroMemories + cfg.weights.invitations);
    expect(r.model.scraps).toBeCloseTo(cfg.baseAppear.scraps * cfg.baseAmount.scraps * 1.35);
    expect(r.modelFe).toBeGreaterThan(0);
  });
});
