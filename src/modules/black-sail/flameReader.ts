// Reads the anchor screen ("Void Sea Seal / Put in Void Sea Flames", log page VoidBeacon).
//
// Two sources:
// - Icons: every filled slot on the ring is recognised from its picture (16x16 greyscale shape
//   + colour, nearest labelled sample). Works without any clicks. Exact for most flames; the
//   "S" icon is used by both Flame Fuel and Embers.
// - Text: only the SELECTED flame's description is shown (under the circle). It gives the exact
//   effect and numbers, and tells the two "S" flames apart.
// See mechanics/black-sail/07-choice-screens.md.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { OcrPage, OcrRegion, Region } from "../../ocr/windowsOcr.js";
import { numbers, similarity, template } from "./effects.js";
import { joinPieces } from "./sealWhisperReader.js";
import { APP_DIR } from "../../paths.js";

const DATA = resolve(APP_DIR, "data/black-sail");
export const FLAME_EFFECTS = resolve(DATA, "flame-effects.json");
export const FLAME_ICONS = resolve(DATA, "flame-icons.json");

/**
 * Icon = shape + colour. The Wealth and Boss figures come in colour tiers (blue = no minimum,
 * purple = Magic+, gold = Rare+; purple Boss first seen 2026-10-25). Some icons are shared: crystal = Rare armor / trinkets / weapons,
 * "S" = Flame Fuel or Embers.
 */
export type IconKind =
  | "boss_blue"
  | "boss_purple"
  | "boss_gold"
  | "wealth_blue"
  | "wealth_purple"
  | "wealth_gold"
  | "swirl_blue"
  | "crystal_white"
  | "s_white"
  | "hook_white"
  | "flame_white";

export interface FlameEffect {
  id: string;
  icon: IconKind;
  /** "whisper" = shapes the next Seal Whisper choice, "loot" = extra Void Pirate drops. */
  kind: "whisper" | "loot";
  text: string;
}

export interface IconRef {
  kind: IconKind;
  gray: number[];
  color: [number, number, number];
  source: string;
}

/**
 * Icon centres at 1920x1080, 5 slots per side of the ring, top to bottom.
 * Slots 0, 1, 5 and 6 are measured from screenshots (filled in every sample so far);
 * the lower slots are estimated from the empty slot frames.
 */
export const FLAME_SLOTS: [number, number][] = [
  [630, 262], [555, 392], [520, 540], [540, 690], [610, 835],
  [1288, 262], [1362, 392], [1400, 540], [1380, 690], [1310, 835],
];
/**
 * 50x50 around each icon: tight enough to leave out most of the selected slot's highlight frame.
 * Tried 80 / 60 / 50: the hardest case (selected swirl vs runner-up) was 0.32 vs 0.37 / 0.42 vs
 * 0.54 / 0.38 vs 0.71, so 50 separates best.
 */
export const FLAME_REGIONS: Region[] = FLAME_SLOTS.map(([x, y]) => [x - 25, y - 25, 50, 50]);

/** At 50x50: filled slots measured >= 0.165 bright, empty ones 0.00. */
const FILLED = 0.05;

export interface FlameSlot {
  index: number;
  kind: IconKind;
  /**
   * Distance to the nearest labelled sample (0 = identical). Correct ones seen up to ~0.75, but a
   * never-seen icon also lands ~0.5-0.8, so treat the kind as a guess until the text confirms it.
   */
  distance: number;
}

export interface SelectedFlame {
  effect: FlameEffect;
  textScore: number;
  /** Numbers read from the screen; OCR sometimes drops big bold digits, then this is shorter. */
  numbers: number[];
  /** Slot the selected flame is in, when only one slot has that icon. */
  slot: number | null;
}

export interface FlameRead {
  slots: FlameSlot[];
  selectedText: string;
  selected: SelectedFlame | null;
}

/** Minimum quality tier a whisper flame guarantees: 0 = none (blue icon), 1 = Magic+ (purple), 2 = Rare+ (gold). */
const WHISPER_TIER: Record<string, number> = {
  boss_whisper: 0,
  boss_whisper_magic: 1,
  boss_whisper_rare: 2,
  wealth: 0,
  wealth_magic: 1,
  wealth_rare: 2,
};

/**
 * Which flame to put in (higher = better). From the SS12 "K8 Black Sail formula" (Bahamut):
 * Boss Whisper flame > Wealth Whisper flame > Fluorescent Memories flame > anything else;
 * among whisper flames the higher quality tier wins and Boss wins a tie. Goal tweaks: with the
 * Memories goal the "+1 Hero Memory" flame comes before Wealth (Wealth only feeds Scraps/Threads).
 */
export function flameScore(effectId: string, goal: string): number {
  const tier = WHISPER_TIER[effectId];
  if (effectId.startsWith("boss_whisper")) return 100 + tier! * 10 + 1;
  if (goal === "heroMemories" && effectId === "hero_memories") return 100 + 2 * 10 + 0.5; // above every Wealth tier
  if (effectId.startsWith("wealth")) return 100 + tier! * 10;
  if (effectId === "fluorescent_memories") return 50;
  if (effectId === "hero_memories") return 40;
  return 10; // other loot flames
}

/** Flame tier for the overlay: S = Rare+ whisper (or the Memories goal's flame), A = Magic+ whisper,
 * B = any-quality whisper, C = Fluorescent / Hero Memory loot, D = other loot. */
export function flameTier(effectId: string, goal: string): "S" | "A" | "B" | "C" | "D" {
  const s = flameScore(effectId, goal);
  return s >= 120 ? "S" : s >= 110 ? "A" : s >= 100 ? "B" : s >= 40 ? "C" : "D";
}

export async function loadFlameEffects(path = FLAME_EFFECTS): Promise<FlameEffect[]> {
  return JSON.parse(await readFile(path, "utf8")) as FlameEffect[];
}

export async function loadIconRefs(path = FLAME_ICONS): Promise<IconRef[]> {
  return JSON.parse(await readFile(path, "utf8")) as IconRef[];
}

/** Zero-mean, unit-length copy, so the selected slot's brighter highlight doesn't matter. */
function normalise(g: number[]): number[] {
  const mean = g.reduce((a, b) => a + b, 0) / g.length;
  const d = g.map((v) => v - mean);
  const len = Math.hypot(...d) || 1;
  return d.map((v) => v / len);
}

export function iconDistance(region: Pick<OcrRegion, "gray" | "color">, ref: Pick<IconRef, "gray" | "color">): number {
  const a = normalise(region.gray);
  const b = normalise(ref.gray);
  const corr = a.reduce((s, v, i) => s + v * b[i]!, 0);
  const [r1, g1, b1] = region.color;
  const [r2, g2, b2] = ref.color;
  const colour = Math.hypot(r1 - r2, g1 - g2, b1 - b2) / 441; // 441 = max RGB distance
  // Colour weighted x3: tried 1-4 holding out one whole anchor at a time; 1 confused the blue /
  // purple / gold Wealth figures (54/71 right), 3 got 69/71.
  return 1 - corr + 3 * colour;
}

export function classifyIcon(
  region: Pick<OcrRegion, "gray" | "color">,
  refs: IconRef[],
): { kind: IconKind; distance: number } | null {
  let best: { kind: IconKind; distance: number } | null = null;
  for (const ref of refs) {
    const distance = iconDistance(region, ref);
    if (!best || distance < best.distance) best = { kind: ref.kind, distance };
  }
  return best;
}

// Flame texts share long phrases ("…chance for Void Pirates to drop 1 additional …"), so a
// lower bar turned an unknown "Hero Memories" flame into "Embers". OCR'd known texts score >= 0.92.
const MIN_TEXT_SCORE = 0.9;

export function readFlamePage(page: OcrPage, refs: IconRef[], effects: FlameEffect[]): FlameRead {
  const slots: FlameSlot[] = [];
  page.regions.forEach((region, index) => {
    if (region.bright < FILLED) return;
    const icon = classifyIcon(region, refs);
    if (icon) slots.push({ index, ...icon });
  });

  // The selected flame's text sits centred under the circle.
  const sx = page.width / 1920;
  const sy = page.height / 1080;
  const textLines = page.lines
    .map((l) => ({ ...l, x: l.x / sx, y: l.y / sy, w: l.w / sx, h: l.h / sy }))
    .filter((l) => l.y >= 660 && l.y <= 760 && l.x >= 640 && l.x + l.w <= 1290);
  const selectedText = joinPieces(textLines);

  let selected: SelectedFlame | null = null;
  if (selectedText) {
    // Compare with every known flame. Icons on the ring only break near-ties ("Boss Whisper of
    // Rare…" vs "Whisper of Wealth of Rare…" OCR alike): an icon can be misread, so it must not
    // be able to exclude the right flame.
    const present = new Set(slots.map((s) => s.kind));
    const t = template(selectedText);
    let bestScore = 0;
    for (const effect of effects) {
      const textScore = similarity(t, template(effect.text));
      const score = textScore + (present.has(effect.icon) ? 0.03 : 0);
      if (textScore >= MIN_TEXT_SCORE && score > bestScore) {
        bestScore = score;
        const withIcon = slots.filter((s) => s.kind === effect.icon);
        selected = {
          effect,
          textScore,
          numbers: numbers(selectedText),
          slot: withIcon.length === 1 ? withIcon[0]!.index : null,
        };
      }
    }
  }
  return { slots, selectedText, selected };
}
