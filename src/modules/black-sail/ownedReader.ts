// Reads the "Seal Whispers Owned" panel of the Seal Whisper screen (toggle at the top right, log
// `UIButton@ normal-click BtnOpenCurAffix`): the Whispers picked so far this cycle. The log names
// only the rarity of each pick, so this is how picks made without the overlay get their effect.
//
// Layout at 1920x1080 (other resolutions are scaled), see 07-choice-screens.md:
//   a column on the right, entries grouped under grey type headings (x ~1543, not read);
//   each entry: a rarity diamond (x ~1554) beside 2-4 lines of effect text (x ~1579-1860), the
//   exact table text; "3 / 6" at the bottom (y ~1035).
// The text is white whatever the rarity, so the rarity comes from the diamond's colour.

import type { OcrLine, OcrPage, Region } from "../../ocr/windowsOcr.js";
import { matchEffect, type EffectEntry, type EffectMatch, type Rarity } from "./effects.js";
import { joinPieces } from "./sealWhisperReader.js";

/** The entries' text (right of the diamonds, so the headings and icons stay out). */
export const OWNED_TEXT: Region = [1572, 160, 330, 840];
/** The "N / 6" count. */
export const OWNED_COUNT: Region = [1600, 1012, 180, 46];
/** The diamond column in overlapping 16 px strips (a diamond is ~30 px tall). */
export const DIAMOND_REGIONS: Region[] = Array.from({ length: 105 }, (_, i): Region => [1540, 160 + i * 8, 28, 16]);
/** A strip this lit (share of pixels > 90/255) is part of a diamond; the grey headings stay below. */
const DIAMOND_LIT = 0.3;
/**
 * A diamond's most lit strip: 0.69-0.76 on the sample. The right card's effect text, which reaches
 * into the column when the panel is closed, peaks at ~0.31.
 */
const DIAMOND_PEAK = 0.5;

export interface OwnedWhisper {
  rarity: Rarity | null;
  /** True when the text matched the doubled value (Black Sail pet). */
  doubled: boolean;
  /** Effect text rebuilt from the OCR pieces. */
  text: string;
  match: EffectMatch | null;
  /** The diamond's centre (1080p y), top to bottom. */
  y: number;
}

export interface OwnedRead {
  whispers: OwnedWhisper[];
  /** The "N / 6" count; null when it couldn't be read. */
  count: number | null;
}

/**
 * Rarity from a diamond's colour (average of its brightest pixels). Measured 2026-10-28:
 * white (205,220,242), blue (175,228,254), orange (252,209,52). Purple not seen yet.
 */
export function diamondRarity([r, g, b]: [number, number, number]): Rarity | null {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max < 100) return null;
  if ((max - min) / max < 0.22) return "white";
  const d = max - min;
  let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue = (hue * 60 + 360) % 360;
  if (hue >= 20 && hue < 70) return "orange";
  if (hue >= 180 && hue < 260) return "blue";
  if (hue >= 260 && hue < 330) return "purple";
  return null;
}

/** The better of the plain and doubled readings: matching numbers first, then the text. */
function bestMatch(text: string, table: EffectEntry[], rarity: Rarity | null): { match: EffectMatch | null; doubled: boolean } {
  const plain = matchEffect(text, false, table, rarity);
  const doubled = matchEffect(text, true, table, rarity);
  const score = (m: EffectMatch | null) => (m ? (m.numbersMatch ? 1 : 0) + m.textScore : -1);
  return score(doubled) > score(plain) ? { match: doubled, doubled: true } : { match: plain, doubled: false };
}

/** `page.regions` must be DIAMOND_REGIONS, in order. */
export function readOwnedPage(page: OcrPage, table: EffectEntry[]): OwnedRead {
  const sx = page.width / 1920;
  const sy = page.height / 1080;
  const lines = page.lines.map((l) => ({ ...l, x: l.x / sx, y: l.y / sy, w: l.w / sx, h: l.h / sy }));

  // Diamonds: runs of lit strips; the colour of the most lit strip of each run.
  const diamonds: { y: number; color: [number, number, number] }[] = [];
  let run: number[] = [];
  const close = () => {
    if (!run.length) return;
    const top = run.reduce((a, b) => ((page.regions[b]!.lit ?? 0) > (page.regions[a]!.lit ?? 0) ? b : a));
    const ys = run.map((i) => DIAMOND_REGIONS[i]![1] + 8);
    if ((page.regions[top]!.lit ?? 0) >= DIAMOND_PEAK) diamonds.push({ y: (ys[0]! + ys.at(-1)!) / 2, color: page.regions[top]!.color });
    run = [];
  };
  DIAMOND_REGIONS.forEach((_, i) => {
    if ((page.regions[i]?.lit ?? 0) >= DIAMOND_LIT) run.push(i);
    else close();
  });
  close();

  // Each text line belongs to the nearest diamond (the diamond sits at its entry's middle).
  const [tx, ty, tw, th] = OWNED_TEXT;
  const text = lines.filter((l) => l.x >= tx - 10 && l.x < tx + tw && l.y >= ty && l.y < ty + th);
  const groups: OcrLine[][] = diamonds.map(() => []);
  for (const l of text) {
    if (!diamonds.length) break;
    const cy = l.y + l.h / 2;
    const i = diamonds.reduce((a, d, j) => (Math.abs(d.y - cy) < Math.abs(diamonds[a]!.y - cy) ? j : a), 0);
    groups[i]!.push(l);
  }

  // A bright spot with no panel text beside it is something else on the screen.
  const whispers = diamonds.flatMap((d, i): OwnedWhisper[] => {
    const t = joinPieces(groups[i]!);
    if (!t) return [];
    const rarity = diamondRarity(d.color);
    const { match, doubled } = bestMatch(t, table, rarity);
    return [{ rarity: rarity ?? match?.entry.rarity ?? null, doubled, text: t, match, y: d.y }];
  });

  const [, cy, , ch] = OWNED_COUNT;
  const countLine = lines.find((l) => l.y >= cy - 10 && l.y < cy + ch && /\d\s*\/\s*6/.test(l.text));
  const count = countLine ? Number(/(\d)\s*\/\s*6/.exec(countLine.text)![1]) : null;
  return { whispers, count };
}
