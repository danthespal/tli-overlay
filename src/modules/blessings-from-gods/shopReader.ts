// Reads the Blessings from Gods shop (log page GroceryStoreV3) from a screenshot.
//
// Layout at 1920x1080 (other resolutions are scaled), measured on samples/screens/shop-8-offers.jpg:
//   cards in a grid of 7 columns, centres x = 582.5 + 191.5 * column
//   rows 268 px apart: card art from y = 109 + 268 * row, ~208 px tall, ending in a bright edge line
//   under the art: a dark 40 px strip with the stone icon and the price (white digits)
//   name and quantity: white text over the bottom of the art, 1-3 lines ("Energy Cores x20")
// Seen: 7 cards in the first row and 1 in the second. Rows 1-3 are checked; a third row would reach
// the Refresh button (x 1570-1810, y 840-935), so it may never exist. See mechanics/blessings-from-gods.

import type { OcrLine, OcrPage, Region } from "../../ocr/windowsOcr.js";
import type { Pixels } from "../../ocr/tesseractOcr.js";
import { similarity } from "../black-sail/effects.js";
import { SHOP_ITEMS, type ShopItem } from "./items.js";

export const SHOP_COLUMNS = 7;
export const SHOP_ROWS = 3;
const COL_X0 = 582.5;
const COL_DX = 191.5;
const ROW_Y0 = 109;
const ROW_DY = 268;
/** Art height: the bright edge line is its last 3 px, the price strip starts right under it. */
const ART_H = 211;

export interface ShopSlot {
  /** 0-based, row by row: slot = row * 7 + column. */
  slot: number;
  row: number;
  col: number;
  /** Card centre x and art top y (1920x1080). */
  cx: number;
  top: number;
}

export const SHOP_SLOTS: ShopSlot[] = Array.from({ length: SHOP_ROWS * SHOP_COLUMNS }, (_, slot) => {
  const row = Math.floor(slot / SHOP_COLUMNS);
  const col = slot % SHOP_COLUMNS;
  return { slot, row, col, cx: COL_X0 + COL_DX * col, top: ROW_Y0 + ROW_DY * row };
});

/** Name and quantity text over the bottom of the art. */
export const NAME_CROP = (s: ShopSlot): Region => [s.cx - 74, s.top + 125, 148, ART_H - 128];
/** The price, right of the stone icon (the icon's edge reads as ">", "°" or "b" when included). */
export const PRICE_CROP = (s: ShopSlot): Region => [s.cx - 5, s.top + ART_H + 4, 60, 32];

const mean = (px: Pixels, x0: number, y0: number, w: number, h: number) => {
  const sx = px.width / 1920;
  const sy = px.height / 1080;
  let sum = 0, n = 0;
  for (let y = Math.round(y0 * sy); y < Math.round((y0 + h) * sy); y++) {
    for (let x = Math.round(x0 * sx); x < Math.round((x0 + w) * sx); x++) {
      const i = (y * px.width + x) * 4;
      sum += (px.data[i]! + px.data[i + 1]! + px.data[i + 2]!) / 3;
      n++;
    }
  }
  return n ? sum / n : 0;
};

/**
 * A card is in the slot when the art's bright bottom edge sits right on top of the dark price strip
 * (measured: edge ~170, strip ~22; the empty background is 35-100 and has neither).
 */
export function cardInSlot(px: Pixels, s: ShopSlot): boolean {
  // The brightest line around where the edge should be (a pixel off at other resolutions).
  const edge = Math.max(...Array.from({ length: 8 }, (_, k) => mean(px, s.cx - 60, s.top + ART_H - 6 + k, 120, 1)));
  // The strip's left part: dark, unless a 3-digit price pushes the stone icon into it (~50 then,
  // shop-refreshed.jpg slot 7); the edge alone is far above the empty background either way.
  const strip = mean(px, s.cx - 60, s.top + ART_H + 4, 30, 26);
  return edge > 120 && strip < 70 && edge - strip > 90;
}

/**
 * How many digits the price under a card has, from the pixels: the white shapes in the price crop,
 * separated by dark columns. Only near-white pixels count (bright, colour spread under 50): the
 * purple stone icon pokes into the crop by a different amount for each price length (a lone "9"
 * put its edge right inside), and drops out by colour. Right on all 48 prices of 6 screens
 * (2026-10-31); catches a "1" read for "11". Digits touching each other would count as one: the
 * read is then refused, not wrong. Null when nothing is lit.
 */
export function priceDigits(px: Pixels, s: ShopSlot): number | null {
  const sx = px.width / 1920;
  const sy = px.height / 1080;
  const [x, y, w, h] = PRICE_CROP(s);
  const lit: boolean[] = [];
  for (let c = Math.round(x * sx); c < Math.round((x + w) * sx); c++) {
    let n = 0;
    for (let r = Math.round(y * sy); r < Math.round((y + h) * sy); r++) {
      const i = (r * px.width + c) * 4;
      const [R, G, B] = [px.data[i]!, px.data[i + 1]!, px.data[i + 2]!];
      if ((R + G + B) / 3 >= 140 && Math.max(R, G, B) - Math.min(R, G, B) < 50) n++;
    }
    lit.push(n >= 2);
  }
  let digits = 0;
  let start = -1;
  lit.push(false); // closes a shape running to the crop's right end
  lit.forEach((on, k) => {
    if (on && start < 0) start = k;
    if (on || start < 0) return;
    if ((k - start) / sx >= 2) digits++; // a 1 px speck isn't a digit
    start = -1;
  });
  return digits || null;
}

export interface ShopOffer {
  slot: number;
  row: number;
  col: number;
  /** Raw OCR of the name and quantity. */
  text: string;
  item: ShopItem | null;
  /** From "x20" on the card; 1 when the card shows none. */
  quantity: number;
  /** Divinity Stones, from the strip under the art; null = not read. */
  stones: number | null;
}

export interface ShopRead {
  offers: ShopOffer[];
}

const letters = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

/**
 * Best item for the card's name text, or null when nothing is close (a new item). Bits of the art
 * above the name can be read as words ("4a f toe, Flame Sand"), so the text is also tried without
 * its first words.
 */
export function matchItem(name: string): ShopItem | null {
  const words = name.split(/\s+/).filter(Boolean);
  let best: ShopItem | null = null;
  let bestScore = 0.75;
  for (let k = 0; k < words.length; k++) {
    const t = letters(words.slice(k).join(" "));
    for (const item of SHOP_ITEMS) {
      for (const n of [item.name, ...(item.aliases ?? [])]) {
        const s = similarity(t, letters(n));
        if (s > bestScore) [best, bestScore] = [item, s];
      }
    }
  }
  return best && arcaneSize(name, best);
}

/**
 * Arcane Stone (S) and (L) differ by one letter, which OCR reads as "‘Si" or "iL |": the size is
 * the letter after "Stone" (S before L: "Si" has an i, "iL" has no s).
 */
function arcaneSize(name: string, item: ShopItem): ShopItem {
  if (!item.id.startsWith("arcane-stone-")) return item;
  const after = /stone(.*)$/i.exec(name)?.[1] ?? "";
  const size = /s/i.test(after) ? "s" : /l/i.test(after) ? "l" : null;
  return (size && SHOP_ITEMS.find((i) => i.id === `arcane-stone-${size}`)) || item;
}

/** "Energy Cores x20" -> name "Energy Cores", 20. OCR reads the x as x/X/×, and 0 as O now and then. */
export function splitQuantity(text: string): { name: string; quantity: number } {
  const m = /\s*[xX×]\s*([0-9OoIl]+)\s*$/.exec(text);
  if (!m) return { name: text.trim(), quantity: 1 };
  const digits = m[1]!.replace(/[Oo]/g, "0").replace(/[Il]/g, "1");
  return { name: text.slice(0, m.index).trim(), quantity: +digits || 1 };
}

const inside = (l: OcrLine, [x, y, w, h]: Region) => {
  const cx = l.x + l.w / 2;
  const cy = l.y + l.h / 2;
  return cx >= x && cx < x + w && cy >= y && cy < y + h;
};

const reading = (lines: OcrLine[]) =>
  [...lines].sort((a, b) => (Math.abs(a.y - b.y) > 10 ? a.y - b.y : a.x - b.x)).map((l) => l.text).join(" ").replace(/\s+/g, " ").trim();

/**
 * A re-read of the same screen can lose names the last read had: a pop-up dims the cards (their
 * white names fall under the threshold), or a card is mid-animation. An offer whose name wasn't
 * read, in a slot that had the same stone price, keeps the last read's item and quantity.
 */
export function mergeReads(prev: ShopRead | null, next: ShopRead): ShopRead {
  if (!prev) return next;
  return {
    offers: next.offers.map((o) => {
      const old = prev.offers.find((p) => p.slot === o.slot);
      return !o.item && old?.item && old.stones === o.stones ? { ...o, text: old.text, item: old.item, quantity: old.quantity } : o;
    }),
  };
}

/**
 * The offer size the read amount stands for: one of the item's sizes, the closest by its digits
 * ("x1l00" read as 1100 is Netherrealm Resonance x100, not a 1100 that would value it 11 times
 * over: 2026-10-31). Null when two sizes are as close (a size not in the list, or a bad read).
 */
export function offerSize(item: ShopItem, quantity: number): number | null {
  if (item.quantities.includes(quantity)) return quantity;
  const scored = item.quantities.map((q) => ({ q, s: similarity(String(quantity), String(q)) })).sort((a, b) => b.s - a.s);
  const [best, next] = scored;
  if (!best || best.s < 0.5 || (next && next.s === best.s)) return null;
  return best.q;
}

/** Offers in reading order; a slot with no text read in it has no card. */
export function readShopPage(page: OcrPage): ShopRead {
  const sx = page.width / 1920;
  const sy = page.height / 1080;
  const lines = page.lines.map((l) => ({ ...l, x: l.x / sx, y: l.y / sy, w: l.w / sx, h: l.h / sy }));
  const offers: ShopOffer[] = [];
  for (const s of SHOP_SLOTS) {
    const text = reading(lines.filter((l) => inside(l, NAME_CROP(s))));
    const digits = reading(lines.filter((l) => inside(l, PRICE_CROP(s)))).replace(/[Oo]/g, "0").replace(/[^0-9]/g, "");
    if (!text && !digits) continue;
    const { name, quantity } = splitQuantity(text);
    const item = matchItem(name);
    const size = item && offerSize(item, quantity);
    // An amount that fits none of the item's sizes clearly gets no verdict (no item) rather than a guess.
    offers.push({ slot: s.slot, row: s.row, col: s.col, text, item: size ? item : null, quantity: size ?? quantity, stones: digits ? +digits : null });
  }
  return { offers };
}
