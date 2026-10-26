// Seal Whisper advisor: values a set of up to 6 Whispers and ranks the offered cards by how much
// they raise the value of the FINAL set, looking ahead at likely future offers.
// Model and assumptions: mechanics/black-sail/09-card-advisor.md.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { EffectEntry, Rarity } from "./effects.js";
import { MATERIALS, parseModifier, type Material, type Modifier } from "./modifiers.js";

export const ADVISOR_CONFIG = resolve(import.meta.dirname, "../../../../mechanics/black-sail/data/advisor-config.json");
export const PICKS_PER_CYCLE = 6;
export const RARITIES: Rarity[] = ["white", "blue", "purple", "orange"];
/** The table group of the card offered by the Switch button (always available, any screen). */
export const SWITCH_GROUP = "Switch pool (Timemark 100-100)";

/**
 * A flame put into the seal guarantees one card of a group (at least `minRarity`) on the next
 * Seal Whisper screen. `p` = how often the player puts in such a flame (from their own history).
 */
export interface FlameGuarantee {
  group: string;
  minRarity: Rarity;
  p: number;
}

export interface AdvisorConfig {
  /** Worth of one unit of each material (FE or points). */
  weights: Record<Material, number>;
  /** Assumed chance each material appears in the chest, and the amount when it does. */
  baseAppear: Record<Material, number>;
  baseAmount: Record<Material, number>;
  /** Value multiplier per +100% Drop Rarity, on Hero Memories and other loot. */
  rarityWeight: number;
  /** Assumed value of everything else in the chest. */
  otherLoot: number;
  lookahead: {
    simulations: number;
    /** Rarity mix of offered cards. */
    offerRarity: Record<Rarity, number>;
    /** Type mix of the cards not guaranteed by a flame (Wealth / Armament / Wonder). */
    offerTypes: Record<string, number>;
    /** Flame guarantees, mutually exclusive; the rest of the screens have no guaranteed card. */
    flames: FlameGuarantee[];
    /** Share of screens where every card shows "(Effect has doubled)". */
    doubledRate: number;
    /** Cards within this fraction of the best card's expected value count as a tie. */
    tieFraction: number;
  };
  /** What the player farms this cycle; chosen in the overlay. */
  goals: {
    focusBoost: number;
    othersFactor: number;
    /**
     * Materials counted like the focus under any goal (rare and valuable: invitations), so a good
     * invitation card still wins against the focus material's cards.
     */
    alwaysFull?: Material[];
    list: { id: string; label: string; focus?: Material }[];
  };
  /** Hero Memory value from salvage: Thread prices by ConfigBaseId, and how many memories the fit needs. */
  salvage?: { threadPrices: Record<string, number>; minMemories: number };
  /** Written by `npm run calibrate`: what the numbers above were measured from. */
  calibration?: { time: string; chests: number; screens: number; flames: number; salvaged?: number };
}

export const DEFAULT_GOAL = "fe";

/**
 * The config the advisor should use for a goal: the focus material counts `focusBoost` times its
 * FE weight, everything else (other materials, other loot) `othersFactor` times, so picks stack
 * the focus material and the rest only breaks ties. "fe" (or an unknown goal) = plain FE weights.
 */
export function configForGoal(cfg: AdvisorConfig, goalId: string): AdvisorConfig {
  const goal = cfg.goals?.list.find((g) => g.id === goalId);
  const focus = goal?.focus;
  if (!focus) return cfg;
  const { focusBoost, othersFactor, alwaysFull = [] } = cfg.goals;
  const factor = (m: Material) => (m === focus || alwaysFull.includes(m) ? focusBoost : othersFactor);
  const weights = Object.fromEntries(MATERIALS.map((m) => [m, cfg.weights[m] * factor(m)])) as Record<Material, number>;
  return { ...cfg, weights, otherLoot: cfg.otherLoot * othersFactor };
}

export async function loadAdvisorConfig(path = ADVISOR_CONFIG): Promise<AdvisorConfig> {
  return JSON.parse(await readFile(path, "utf8")) as AdvisorConfig;
}

export interface SetValue {
  value: number;
  amounts: Record<Material, number>;
}

/**
 * How a set of modifiers acts on one material:
 *   amount = (appear × baseAmount × scale + extra) × outer
 * `appear` already includes the re-shared base pool; `scale` = (1+Σqty)(1+ΣbaseQty);
 * `extra` = Σflat + Σ p·N; `outer` = (1+ΣtreasureQty)(1+doubling gain).
 */
export interface MaterialFactors {
  appear: number;
  scale: number;
  extra: number;
  outer: number;
}

export function materialFactors(mods: Modifier[], cfg: AdvisorConfig): Record<Material, MaterialFactors> {
  let baseQty = 0;
  let treasureQty = 0;
  for (const m of mods) {
    if (m.kind === "baseQty") baseQty += m.value;
    else if (m.kind === "treasureQty") treasureQty += m.value;
  }

  // "+X% chance to appear among base drops" re-shares the base drops: the material's weight
  // becomes (1 + X) and the others shrink so the total stays the same ("doesn't add quantity,
  // overwrites the other rewards", SS12 K8 formula). Equal starting weights are assumed.
  const pool = MATERIALS.filter((m) => cfg.baseAppear[m] > 0);
  const weight = Object.fromEntries(MATERIALS.map((m) => [m, 1])) as Record<Material, number>;
  for (const m of mods) if (m.kind === "appear") weight[m.material] += m.value;
  const meanWeight = pool.reduce((s, m) => s + weight[m], 0) / pool.length;

  const factors = {} as Record<Material, MaterialFactors>;
  for (const mat of MATERIALS) {
    let qty = 0;
    let extra = 0;
    let multiplyChance = 0;
    let multiplyGain = 0;
    for (const m of mods) {
      if (!("material" in m) || m.material !== mat) continue;
      if (m.kind === "qty") qty += m.value;
      else if (m.kind === "flat") extra += m.amount;
      else if (m.kind === "chanceFlat") extra += m.chance * m.amount;
      else if (m.kind === "multiply") {
        multiplyChance += m.chance;
        multiplyGain += m.chance * (m.times - 1);
      }
    }
    // Doubling chances add up, but past 100% there is nothing left to double ("~50% is enough",
    // SS12 K8 formula): scale the gain down once the summed chance exceeds 1.
    const multiply = multiplyChance > 1 ? multiplyGain / multiplyChance : multiplyGain;
    factors[mat] = {
      appear: cfg.baseAppear[mat] * (weight[mat] / meanWeight),
      scale: (1 + qty) * (1 + baseQty),
      extra,
      outer: (1 + treasureQty) * (1 + multiply),
    };
  }
  return factors;
}

/** Expected chest value for a set of modifiers. */
export function evaluate(mods: Modifier[], cfg: AdvisorConfig): SetValue {
  let baseQty = 0;
  let treasureQty = 0;
  let rarity = 0;
  for (const m of mods) {
    if (m.kind === "baseQty") baseQty += m.value;
    else if (m.kind === "treasureQty") treasureQty += m.value;
    else if (m.kind === "rarity") rarity += m.value;
  }
  const rarityFactor = 1 + cfg.rarityWeight * rarity;
  const amounts = {} as Record<Material, number>;
  let value = cfg.otherLoot * (1 + baseQty) * (1 + treasureQty) * rarityFactor;

  const factors = materialFactors(mods, cfg);
  for (const mat of MATERIALS) {
    const f = factors[mat];
    const amount = (f.appear * cfg.baseAmount[mat] * f.scale + f.extra) * f.outer;
    amounts[mat] = amount;
    value += cfg.weights[mat] * amount * (mat === "heroMemories" ? rarityFactor : 1);
  }
  return { value, amounts };
}

export interface Candidate {
  /** "left" | "middle" | "right" | "switch" */
  id: string;
  entry: EffectEntry;
  doubled: boolean;
}

/** How strong a card is on its own, against every Seal Whisper in the game (like a tier list). */
export type Tier = "S" | "A" | "B" | "C" | "D";

export interface Ranked {
  candidate: Candidate;
  modifier: Modifier;
  /** Value added right now: value(picked + card) − value(picked). */
  now: number;
  /** Value the card adds to an empty set (on its own). */
  alone: number;
  /** Part of `now` that comes from combining with earlier picks (now − alone). */
  combo: number;
  /** `alone` against every effect in the table (not doubled), for this goal. */
  tier: Tier;
  /** Chest value after taking this card, as a multiple of a chest with no Whispers. */
  setAfter: number;
  /** How much the card raises the current chest right now, in % of its value (with no picks: of an empty chest). */
  nowPct: number;
  /** `expected` as a multiple of a chest with no Whispers: the number the ranking (★ BEST) is based on. */
  final: number;
  /** Mean final-set value over simulated futures (greedy later picks). */
  expected: number;
  /** True when this card and at least one other are within `tieFraction` of the best card. */
  tie: boolean;
}

/** Small seeded RNG so recommendations are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const modifierOf = (e: EffectEntry, doubled: boolean) => parseModifier(doubled ? e.doubledText : e.text);

/** Share of the table a card must beat for each tier: S = top 10%, A = next 20%, B = next 30%, C = next 25%. */
const TIER_CUTS: [Tier, number][] = [["S", 0.9], ["A", 0.7], ["B", 0.4], ["C", 0.15]];

/** What every effect in the table adds on its own (not doubled): the scale tiers are read on. */
export function standaloneGains(table: EffectEntry[], cfg: AdvisorConfig): number[] {
  const empty = evaluate([], cfg).value;
  return table.map((e) => modifierOf(e, false)).filter((m): m is Modifier => m !== null).map((m) => evaluate([m], cfg).value - empty);
}

/** Tier of a standalone gain: by the share of the table's effects it beats. */
export function tierOf(gain: number, pool: number[]): Tier {
  if (!pool.length) return "C";
  const beaten = pool.filter((g) => g < gain).length / pool.length;
  return TIER_CUTS.find(([, cut]) => beaten >= cut)?.[0] ?? "D";
}

/** Chest value of a set as a multiple of a chest with no Whispers (the set's combo score). */
export function setScore(picked: Modifier[], cfg: AdvisorConfig): number {
  const empty = evaluate([], cfg).value;
  return empty > 0 ? evaluate(picked, cfg).value / empty : 1;
}

function pickWeighted<T>(items: [T, number][], rand: () => number): T | undefined {
  let roll = rand() * items.reduce((s, [, w]) => s + w, 0);
  return (items.find(([, w]) => (roll -= w) < 0) ?? items[0])?.[0];
}

/** One random card of a group, rarity by the offer mix, at least `minRarity` when given. */
function drawCard(table: EffectEntry[], cfg: AdvisorConfig, rand: () => number, group: string, minRarity?: Rarity): EffectEntry | undefined {
  const floor = minRarity ? RARITIES.indexOf(minRarity) : 0;
  const inGroup = table.filter((e) => e.group === group && RARITIES.indexOf(e.rarity) >= floor);
  const weights = RARITIES.filter((r) => inGroup.some((e) => e.rarity === r)).map((r): [Rarity, number] => [r, cfg.lookahead.offerRarity[r]]);
  const rarity = pickWeighted(weights, rand);
  const pool = inGroup.filter((e) => e.rarity === rarity);
  return pool[Math.floor(rand() * pool.length)];
}

/**
 * One future screen: the card a flame guarantees (if the player puts one in, by their own flame
 * history), the other cards by the measured type mix, plus the Switch card that is always there.
 * The whole screen is doubled with `doubledRate` (the pet doubles all cards of a screen at once).
 */
export function drawOffer(table: EffectEntry[], cfg: AdvisorConfig, rand: () => number): Modifier[] {
  const { flames, offerTypes, doubledRate } = cfg.lookahead;
  const doubled = rand() < doubledRate;
  const entries: EffectEntry[] = [];
  let roll = rand();
  for (const g of flames) {
    if ((roll -= g.p) < 0) {
      const e = drawCard(table, cfg, rand, g.group, g.minRarity);
      if (e) entries.push(e);
      break;
    }
  }
  const types = Object.entries(offerTypes);
  for (let guard = 0; entries.length < 3 && guard < 20; guard++) {
    const group = pickWeighted(types, rand);
    const e = group && drawCard(table, cfg, rand, group);
    if (e) entries.push(e);
  }
  const sw = drawCard(table, cfg, rand, SWITCH_GROUP);
  if (sw) entries.push(sw);
  return entries.map((e) => modifierOf(e, doubled)).filter((m): m is Modifier => m !== null);
}

/**
 * Ranks the offered cards. `picked` = modifiers of the Whispers already taken this cycle.
 * Uses the same simulated futures for every card, so differences come from the card itself.
 */
export function recommend(picked: Modifier[], candidates: Candidate[], table: EffectEntry[], cfg: AdvisorConfig, seed = 1): Ranked[] {
  const remaining = Math.max(0, PICKS_PER_CYCLE - picked.length - 1);
  const rand = rng(seed);
  const futures = Array.from({ length: remaining ? cfg.lookahead.simulations : 1 }, () =>
    Array.from({ length: remaining }, () => drawOffer(table, cfg, rand)),
  );
  const before = evaluate(picked, cfg).value;
  const empty = evaluate([], cfg).value;
  const pool = standaloneGains(table, cfg);

  const ranked: Ranked[] = [];
  for (const candidate of candidates) {
    const modifier = modifierOf(candidate.entry, candidate.doubled);
    if (!modifier) continue;
    const now = evaluate([...picked, modifier], cfg).value - before;
    const alone = evaluate([modifier], cfg).value - empty;
    let total = 0;
    for (const future of futures) {
      const set = [...picked, modifier];
      for (const offer of future) {
        if (!offer.length) continue; // a table without these groups draws nothing
        // Greedy: take the future card that adds the most to the set so far.
        let best = offer[0]!;
        let bestValue = -Infinity;
        for (const m of offer) {
          const v = evaluate([...set, m], cfg).value;
          if (v > bestValue) [best, bestValue] = [m, v];
        }
        set.push(best);
      }
      total += evaluate(set, cfg).value;
    }
    ranked.push({
      candidate,
      modifier,
      now,
      alone,
      combo: now - alone,
      tier: tierOf(alone, pool),
      setAfter: empty > 0 ? (before + now) / empty : 1,
      nowPct: before > 0 ? (100 * now) / before : 0,
      final: empty > 0 ? total / futures.length / empty : 1,
      expected: total / futures.length,
      tie: false,
    });
  }
  ranked.sort((a, b) => b.expected - a.expected);
  // Ties: everything within tieFraction of the best, when that is more than the best alone.
  const best = ranked[0];
  if (best) {
    const margin = cfg.lookahead.tieFraction * Math.abs(best.expected);
    const close = ranked.filter((r) => best.expected - r.expected <= margin);
    if (close.length > 1) for (const r of close) r.tie = true;
  }
  return ranked;
}

/** Is pressing Switch worth the clicks, before the Switch card has been read? */
export interface SwitchOutlook {
  /** Probability (over the rarity mix) that the Switch card beats the best card by more than the tie margin. */
  chance: number;
  /** Expected gain from switching when it does beat it, weighted by that probability. */
  gain: number;
  byRarity: { rarity: Rarity; expected: number }[];
}

/**
 * The Switch card is always from the Switch pool (so far "+X% Base Drop Quantity"); only its rarity
 * is unknown. Rank every pool row with the same futures as `recommend` (same seed) and compare with
 * the best of the 3 cards. `doubled` = the screen is doubled, so the Switch card is too.
 */
export function switchOutlook(picked: Modifier[], best: Ranked | undefined, doubled: boolean, table: EffectEntry[], cfg: AdvisorConfig, seed = 1): SwitchOutlook | null {
  if (!best) return null;
  const rows = table.filter((e) => e.group === SWITCH_GROUP);
  if (!rows.length) return null;
  const ranked = recommend(picked, rows.map((entry) => ({ id: entry.rarity, entry, doubled })), table, cfg, seed);
  const margin = cfg.lookahead.tieFraction * Math.abs(best.expected);
  const byRarity: SwitchOutlook["byRarity"] = [];
  let chance = 0;
  let gain = 0;
  let total = 0;
  for (const rarity of RARITIES) {
    const ofRarity = ranked.filter((r) => r.candidate.entry.rarity === rarity);
    if (!ofRarity.length) continue;
    const expected = Math.max(...ofRarity.map((r) => r.expected));
    const p = cfg.lookahead.offerRarity[rarity];
    byRarity.push({ rarity, expected });
    total += p;
    if (expected - best.expected > margin) {
      chance += p;
      gain += p * (expected - best.expected);
    }
  }
  return total ? { chance: chance / total, gain: gain / total, byRarity } : null;
}
