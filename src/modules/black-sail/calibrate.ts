// Calibrates the advisor from the player's own history (tool/data/history/):
//   - base chest amounts from black-sail-chests.jsonl (picks + what the Terminal dropped)
//   - flame guarantee prior from black-sail-flames.jsonl (which flames get put in)
//   - doubled-screen rate from black-sail-whispers.jsonl ("(Effect has doubled)" on the cards)
// Pure functions here; the CLI (src/cli/calibrate.ts) reads the files and writes the config.
// See mechanics/black-sail/11-improvement-plan.md, step 1.

import type { Rarity } from "./effects.js";
import { evaluate, materialFactors, type AdvisorConfig, type FlameGuarantee } from "./advisor.js";
import { MATERIALS, parseModifier, type Material } from "./modifiers.js";

/** ConfigBaseIds that count as each material in the chest. */
export const MATERIAL_ITEMS: Record<Material, number[]> = {
  scraps: [5140],
  threads: [5142, 5143, 5144],
  heroMemories: [71001, 71002, 71003],
  invitations: [410201, 410202, 410203],
};

export interface ChestLike {
  picks: { effect: string; unread?: boolean }[];
  complete: boolean;
  /** Picks with an unknown effect; such a chest can't be fitted. */
  unread?: number;
  loot: Record<string, number>;
}

export interface ScreenLike {
  offered: { doubled: boolean }[];
  switchCard: { doubled: boolean } | null;
}

export interface FlameLike {
  effect: string | null;
}

/** What a chest actually dropped of each material. */
export function chestAmounts(loot: Record<string, number>): Record<Material, number> {
  return Object.fromEntries(
    MATERIALS.map((m) => [m, MATERIAL_ITEMS[m].reduce((s, id) => s + (loot[String(id)] ?? 0), 0)]),
  ) as Record<Material, number>;
}

export interface ChestReport {
  actual: Record<Material, number>;
  /** FE of the materials that dropped, at the config's plain weights. */
  actualFe: number;
  model: Record<Material, number>;
  /** What the model expected for these picks (materials only, same weights). */
  modelFe: number;
}

/** The chest against the model, for the panel: "272 Scraps … ≈ 85 FE (model 64)". */
export function chestReport(chest: Pick<ChestLike, "picks" | "loot">, cfg: AdvisorConfig): ChestReport {
  const mods = chest.picks.map((p) => parseModifier(p.effect)).filter((m) => m !== null);
  const model = evaluate(mods, cfg).amounts;
  const actual = chestAmounts(chest.loot);
  const fe = (a: Record<Material, number>) => MATERIALS.reduce((s, m) => s + cfg.weights[m] * a[m], 0);
  return { actual, actualFe: fe(actual), model, modelFe: fe(model) };
}

/**
 * The base amount (when the material appears) that would make the model hit this chest exactly:
 *   actual = (appear × base × scale + extra) × outer  →  base = (actual/outer − extra) / (appear × scale)
 * Null for materials the model doesn't draw from the base pool (baseAppear 0, i.e. invitations).
 */
export function impliedBase(chest: ChestLike, cfg: AdvisorConfig): Partial<Record<Material, number>> {
  const mods = chest.picks.map((p) => parseModifier(p.effect)).filter((m) => m !== null);
  const factors = materialFactors(mods, cfg);
  const actual = chestAmounts(chest.loot);
  const out: Partial<Record<Material, number>> = {};
  for (const mat of MATERIALS) {
    const f = factors[mat];
    if (f.appear <= 0) continue;
    out[mat] = Math.max(0, (actual[mat] / f.outer - f.extra) / (f.appear * f.scale));
  }
  return out;
}

/** Mean implied base over complete chests; materials without data keep the config value. `counts`: chests per material. */
export function calibrateBase(chests: ChestLike[], cfg: AdvisorConfig): { baseAmount: Record<Material, number>; chests: number; counts: Partial<Record<Material, number>> } {
  const used = chests.filter((c) => c.complete && !c.unread);
  const sums = {} as Partial<Record<Material, { total: number; n: number }>>;
  for (const chest of used) {
    for (const [mat, base] of Object.entries(impliedBase(chest, cfg)) as [Material, number][]) {
      const s = (sums[mat] ??= { total: 0, n: 0 });
      s.total += base;
      s.n++;
    }
  }
  const baseAmount = { ...cfg.baseAmount };
  const counts: Partial<Record<Material, number>> = {};
  for (const mat of MATERIALS) {
    const s = sums[mat];
    if (s?.n) {
      baseAmount[mat] = +(s.total / s.n).toFixed(mat === "scraps" ? 0 : 1);
      counts[mat] = s.n;
    }
  }
  return { baseAmount, chests: used.length, counts };
}

/** Flame effect id → the card it guarantees on the next screen. Loot flames guarantee nothing. */
const FLAME_GUARANTEE: Record<string, { group: string; minRarity: Rarity }> = {
  boss_whisper: { group: "Boss Whisper", minRarity: "white" },
  boss_whisper_magic: { group: "Boss Whisper", minRarity: "blue" },
  boss_whisper_rare: { group: "Boss Whisper", minRarity: "purple" },
  wealth: { group: "Wealth", minRarity: "white" },
  wealth_magic: { group: "Wealth", minRarity: "blue" },
  wealth_rare: { group: "Wealth", minRarity: "purple" },
};

/** How often each guarantee happens, over the flames whose effect was read. */
export function flamePrior(flames: FlameLike[]): { flames: FlameGuarantee[]; count: number } {
  const known = flames.filter((f) => f.effect !== null);
  const counts = new Map<string, number>();
  for (const f of known) counts.set(f.effect!, (counts.get(f.effect!) ?? 0) + 1);
  const out: FlameGuarantee[] = [];
  for (const [id, g] of Object.entries(FLAME_GUARANTEE)) {
    const n = counts.get(id) ?? 0;
    if (n) out.push({ ...g, p: +(n / known.length).toFixed(3) });
  }
  return { flames: out, count: known.length };
}

/** Share of screens where the cards were doubled (it applies to the whole screen at once). */
export function doubledRate(screens: ScreenLike[]): { rate: number; count: number } {
  const withCards = screens.filter((s) => s.offered.length || s.switchCard);
  const doubled = withCards.filter((s) => s.offered.some((c) => c.doubled) || s.switchCard?.doubled).length;
  return { rate: withCards.length ? +(doubled / withCards.length).toFixed(3) : 0, count: withCards.length };
}

export interface SalvageLike {
  memories: Record<string, number>;
  threads: Record<string, number>;
  scraps: number;
  pure: boolean;
}

export interface MemoryValue {
  /** FE a fresh Hero Memory salvages to. */
  fe: number;
  memories: number;
  /** Threads per memory by ConfigBaseId. */
  perMemory: Record<string, number>;
}

/**
 * What salvaging a fresh Hero Memory returns, from memory-only batches without Scraps (Scraps mean
 * a levelled memory was salvaged, which is worth far more and isn't what a chest drops).
 */
export function memoryValue(salvages: SalvageLike[], cfg: AdvisorConfig): MemoryValue {
  const prices = cfg.salvage?.threadPrices ?? {};
  const used = salvages.filter((s) => s.pure && !s.scraps);
  const memories = used.reduce((n, s) => n + Object.values(s.memories).reduce((a, b) => a + b, 0), 0);
  const threads: Record<string, number> = {};
  for (const s of used) for (const [id, n] of Object.entries(s.threads)) threads[id] = (threads[id] ?? 0) + n;
  const perMemory = Object.fromEntries(Object.entries(threads).map(([id, n]) => [id, memories ? +(n / memories).toFixed(3) : 0]));
  const fe = Object.entries(perMemory).reduce((s, [id, n]) => s + n * (prices[id] ?? 0), 0);
  return { fe: +fe.toFixed(3), memories, perMemory };
}

export interface History {
  chests: ChestLike[];
  screens: ScreenLike[];
  flames: FlameLike[];
  salvages?: SalvageLike[];
}

/** `v0` counted as `w` observations, plus `n` new ones averaging `v`. */
const blend = (v0: number, w: number, v: number, n: number, digits: number) => (n ? +((v0 * w + v * n) / (w + n)).toFixed(digits) : v0);

/**
 * The config with every measurable number fitted to the history.
 *
 * Without `blended`: replaced by what the history says (the shipped fit, made from all the data).
 * With `blended` (a player's copy): each number is the shipped fit, counted as the data it came
 * from (its `calibration` counts), averaged with the player's own data. One new chest then nudges
 * the numbers instead of replacing a fit made from dozens; a player who has played a lot ends up
 * mostly on their own numbers. `cfg` should be the shipped config itself, so nothing counts twice.
 */
export function calibrate(cfg: AdvisorConfig, history: History, now = new Date(), blended = false): AdvisorConfig {
  const base = calibrateBase(history.chests, cfg);
  const prior = flamePrior(history.flames);
  const doubled = doubledRate(history.screens);
  const memory = memoryValue(history.salvages ?? [], cfg);
  const own = { chests: base.chests, screens: doubled.count, flames: prior.count, salvaged: memory.memories };
  if (!blended) {
    const enough = memory.memories >= (cfg.salvage?.minMemories ?? Infinity);
    return {
      ...cfg,
      weights: enough ? { ...cfg.weights, heroMemories: memory.fe } : cfg.weights,
      baseAmount: base.baseAmount,
      lookahead: {
        ...cfg.lookahead,
        flames: prior.count ? prior.flames : cfg.lookahead.flames,
        doubledRate: doubled.count ? doubled.rate : cfg.lookahead.doubledRate,
      },
      calibration: { time: now.toISOString(), ...own },
    };
  }
  const w = { chests: 0, screens: 0, flames: 0, salvaged: 0, ...cfg.calibration };
  const baseAmount = { ...cfg.baseAmount };
  for (const m of MATERIALS) baseAmount[m] = blend(cfg.baseAmount[m], w.chests, base.baseAmount[m], base.counts[m] ?? 0, m === "scraps" ? 0 : 1);
  // Flame guarantees: per kind, the shipped share and the player's (0 where one side has none).
  const key = (g: FlameGuarantee) => `${g.group}|${g.minRarity}`;
  const flames = new Map<string, FlameGuarantee>();
  for (const g of [...cfg.lookahead.flames, ...prior.flames]) flames.set(key(g), { ...g, p: 0 });
  for (const g of flames.values()) {
    const p0 = cfg.lookahead.flames.find((x) => key(x) === key(g))?.p ?? 0;
    const p = prior.flames.find((x) => key(x) === key(g))?.p ?? 0;
    g.p = blend(p0, w.flames, p, prior.count, 3);
  }
  return {
    ...cfg,
    weights: { ...cfg.weights, heroMemories: blend(cfg.weights.heroMemories, w.salvaged ?? 0, memory.fe, memory.memories, 3) },
    baseAmount,
    lookahead: {
      ...cfg.lookahead,
      flames: [...flames.values()].filter((g) => g.p > 0),
      doubledRate: blend(cfg.lookahead.doubledRate, w.screens, doubled.rate, doubled.count, 3),
    },
    calibration: {
      time: now.toISOString(),
      chests: w.chests + own.chests,
      screens: w.screens + own.screens,
      flames: w.flames + own.flames,
      salvaged: (w.salvaged ?? 0) + own.salvaged,
      own,
    },
  };
}
