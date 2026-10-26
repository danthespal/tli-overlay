// Seal Whisper effect table (mechanics/black-sail/data/seal-whisper-effects.json) and
// matching of OCR'd card text against it.
//
// OCR quirks this handles (seen on real cards):
// - big bold numbers come back as separate pieces ("42" next to "+ % additional ...")
// - a bold "1" reads as "I"
// So we compare the text with all digits removed, and compare the numbers separately.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const EFFECTS_TABLE = resolve(
  import.meta.dirname,
  "../../../../mechanics/black-sail/data/seal-whisper-effects.json",
);

export type Rarity = "white" | "blue" | "purple" | "orange";

interface TableRow {
  group: string;
  rarity: Rarity;
  timemark: string | null;
  effect: string | null;
  wiki_effect?: string | null;
  wiki_doubled?: string | null;
}

export interface EffectEntry {
  group: string;
  rarity: Rarity;
  timemark: string | null;
  /** Base text (no pet doubling). */
  text: string;
  /** Text as shown with "(Effect has doubled)". */
  doubledText: string;
  /** "game" if seen in our handbook, otherwise "wiki". */
  source: "game" | "wiki";
}

export interface EffectMatch {
  entry: EffectEntry;
  /** 0..1 similarity of the digit-less text. */
  textScore: number;
  /** True when every number on the card equals the table's numbers. */
  numbersMatch: boolean;
}

/** Doubles the first number, for rows the wiki has no doubled text for (Boss Whisper). */
const doubleFirstNumber = (s: string) => s.replace(/\d+/, (n) => String(+n * 2));

export async function loadEffectTable(path = EFFECTS_TABLE): Promise<EffectEntry[]> {
  const rows = JSON.parse(await readFile(path, "utf8")) as TableRow[];
  const entries: EffectEntry[] = [];
  for (const r of rows) {
    const text = r.effect ?? r.wiki_effect;
    if (!text) continue; // still undiscovered
    entries.push({
      group: r.group,
      rarity: r.rarity,
      timemark: r.timemark,
      text,
      doubledText: r.wiki_doubled ?? doubleFirstNumber(text),
      source: r.effect ? "game" : "wiki",
    });
  }
  return entries;
}

/** Standalone I, l or | between spaces is a misread "1". */
const fixOnes = (s: string) => s.replace(/(^|\s)[Il|](?=\s|$)/g, "$11");

/** Lowercase letters and "%" only: the shape of the sentence without its numbers. */
export const template = (s: string) => fixOnes(s).toLowerCase().replace(/[^a-z%]/g, "");

export const numbers = (s: string) => (fixOnes(s).match(/\d+/g) ?? []).map(Number);

export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n]! / Math.max(m, n);
}

const MIN_TEXT_SCORE = 0.85;

/**
 * Finds the table row for an OCR'd effect. `doubled` = the card shows "(Effect has doubled)",
 * so its numbers are compared with the doubled values. `rarity` (from the card colour) is
 * needed where the text is the same across rarities, e.g. "drop 1 additional Memory Thread(s)"
 * is white, blue and purple.
 */
export function matchEffect(
  ocrText: string,
  doubled: boolean,
  table: EffectEntry[],
  rarity?: Rarity | null,
): EffectMatch | null {
  if (rarity) {
    const sameRarity = matchEffect(ocrText, doubled, table.filter((e) => e.rarity === rarity));
    if (sameRarity) return sameRarity;
    // Fall back to any rarity (e.g. an effect we haven't discovered at this rarity yet).
  }
  const t = template(ocrText);
  const nums = numbers(ocrText);
  let best: EffectMatch | null = null;
  let bestScore = -1;
  for (const entry of table) {
    const target = doubled ? entry.doubledText : entry.text;
    const textScore = similarity(t, template(target));
    if (textScore < MIN_TEXT_SCORE) continue;
    const want = numbers(target);
    // OCR can drop a number or read it out of order (big digits are separate pieces),
    // so count how many card numbers appear in the row, ignoring position.
    const left = [...want];
    let hits = 0;
    for (const n of nums) {
      const i = left.indexOf(n);
      if (i >= 0) {
        hits++;
        left.splice(i, 1);
      }
    }
    const numbersMatch = nums.length > 0 && nums.length === want.length && hits === want.length;
    const score = textScore + hits + (numbersMatch ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = { entry, textScore, numbersMatch };
    }
  }
  return best;
}
