// Reads the Seal Whisper screen ("Void Sea Terminal", log page VoidPort) from an OCR'd screenshot.
//
// Layout at 1920x1080 (other resolutions are scaled):
//   3-card view: card text centred at x ~518 / 960 / 1415
//   Switch view: one card at x ~960
//   per card: title y ~655-670, "(Effect has doubled)" y ~720-730, effect text y ~740-790
// See mechanics/black-sail/07-choice-screens.md.

import type { OcrLine, OcrPage } from "../../ocr/windowsOcr.js";
import { matchEffect, similarity, template, type EffectEntry, type EffectMatch, type Rarity } from "./effects.js";

export type WhisperType = "Wealth" | "Armament" | "Wonder" | "Boss Whisper";
export type Slot = "left" | "middle" | "right";

export interface SealWhisperCard {
  slot: Slot;
  /** Raw OCR of the title (often garbled by the stylised font). */
  title: string;
  type: WhisperType | null;
  /** From the title's colour. */
  rarity: Rarity | null;
  doubled: boolean;
  /** Effect text rebuilt from OCR pieces, in reading order. */
  effectText: string;
  match: EffectMatch | null;
}

export interface SealWhisperRead {
  /** "three" = normal 3 cards, "switch" = the single alternative card after pressing Switch. */
  view: "three" | "switch" | "none";
  cards: SealWhisperCard[];
}

const TITLES: [string, WhisperType][] = [
  ["whisperofwealth", "Wealth"],
  ["whisperofarmament", "Armament"],
  ["whisperofwonder", "Wonder"],
  ["bosswhisper", "Boss Whisper"],
];

function titleType(raw: string): WhisperType | null {
  const t = raw.toLowerCase().replace(/[^a-z]/g, "");
  let best: WhisperType | null = null;
  let bestScore = 0.5; // garbled titles still score ~0.6-0.8
  for (const [name, type] of TITLES) {
    const s = similarity(t, name);
    if (s > bestScore) [best, bestScore] = [type, s];
  }
  return best;
}

/**
 * Card rarity from the title text colour. Measured on real cards (RGB):
 * white ~(133,148,163) low saturation, blue (67,114,186), purple (165,78,197), orange ~(199,178,85).
 */
export function rarityFromColor(color: [number, number, number] | undefined): Rarity | null {
  if (!color) return null;
  const [r, g, b] = color;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return null;
  if ((max - min) / max < 0.35) return "white";
  const d = max - min;
  let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue = (hue * 60 + 360) % 360;
  if (hue >= 20 && hue < 70) return "orange";
  if (hue >= 180 && hue < 260) return "blue";
  if (hue >= 260 && hue < 330) return "purple";
  return null;
}

/** Joins OCR pieces into text: rows by y (pieces within 10 px), then left to right. */
export function joinPieces(lines: OcrLine[]): string {
  const rows: OcrLine[][] = [];
  for (const l of [...lines].sort((a, b) => a.y - b.y)) {
    const row = rows.find((r) => Math.abs(r[0]!.y - l.y) <= 10);
    if (row) row.push(l);
    else rows.push([l]);
  }
  return rows.map((r) => r.sort((a, b) => a.x - b.x).map((l) => l.text).join(" ")).join(" ");
}

/**
 * Last resort for badly OCR'd effect text ("% chance for Hero Meme among base Void Sea Tree"):
 * compare only with the 4-5 effects of the card's own type and rarity, which differ a lot, and
 * accept the best one if it is clearly ahead of the next.
 */
const GROUP_MIN_SCORE = 0.55;
const GROUP_MIN_LEAD = 0.1;
export function matchInGroup(ocrText: string, doubled: boolean, table: EffectEntry[], type: WhisperType, rarity: Rarity): EffectMatch | null {
  const t = template(ocrText);
  const scored = table
    .filter((e) => e.group === type && e.rarity === rarity)
    .map((entry) => ({ entry, textScore: similarity(t, template(doubled ? entry.doubledText : entry.text)) }))
    .sort((a, b) => b.textScore - a.textScore);
  const [best, next] = scored;
  if (!best || best.textScore < GROUP_MIN_SCORE || (next && best.textScore - next.textScore < GROUP_MIN_LEAD)) return null;
  return { entry: best.entry, textScore: best.textScore, numbersMatch: false };
}

export function readSealWhisperPage(page: OcrPage, table: EffectEntry[]): SealWhisperRead {
  const sx = page.width / 1920;
  const sy = page.height / 1080;
  // Normalise to 1920x1080 so the layout constants work at any resolution.
  const lines = page.lines.map((l) => ({ ...l, x: l.x / sx, y: l.y / sy, w: l.w / sx, h: l.h / sy }));

  const columns: Record<Slot, OcrLine[]> = { left: [], middle: [], right: [] };
  for (const l of lines) {
    const cx = l.x + l.w / 2;
    if (l.y < 630 || l.y > 805 || cx < 250 || cx > 1670) continue;
    columns[cx < 740 ? "left" : cx < 1180 ? "middle" : "right"].push(l);
  }

  const cards: SealWhisperCard[] = [];
  for (const slot of ["left", "middle", "right"] as Slot[]) {
    const col = columns[slot];
    const titleLines = col.filter((l) => l.y >= 640 && l.y < 700);
    const title = joinPieces(titleLines);
    const doubledLine = col.find((l) => /doubled/i.test(l.text));
    // Effect text starts right under the title: y ~727 without "(Effect has doubled)", ~742 with it.
    const effectLines = col.filter((l) => l !== doubledLine && l.y >= 700);
    const effectText = joinPieces(effectLines);
    const doubled = doubledLine !== undefined;
    const widestOf = (ls: OcrLine[]) => ls.reduce((a, b) => (b.w > a.w ? b : a));

    let type = titleType(title);
    let rarity: Rarity | null;
    let match: EffectMatch | null;
    if (type) {
      rarity = rarityFromColor(widestOf(titleLines).color);
      match = effectText ? matchEffect(effectText, doubled, table, rarity) : null;
      if (!match && effectText && rarity) match = matchInGroup(effectText, doubled, table, type, rarity);
    } else {
      // The glowing title can be missed by the OCR entirely (seen on a blue card). Accept the
      // card if its effect text matches a known effect: the effect text is drawn in the card's
      // rarity colour too. The flame screen's sentences in this band never match, so they stay out.
      if (!effectLines.length) continue;
      rarity = rarityFromColor(widestOf(effectLines).color);
      match = matchEffect(effectText, doubled, table, rarity);
      if (!match) continue;
      type = (TITLES.find(([, t]) => t === match!.entry.group)?.[1] ?? null) as WhisperType | null;
    }
    cards.push({ slot, title, type, rarity, doubled, effectText, match });
  }

  const view = cards.length === 0 ? "none" : cards.length === 1 && cards[0]!.slot === "middle" ? "switch" : "three";
  return { view, cards };
}
