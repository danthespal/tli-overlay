// What a shop offer is worth in Flame Elementium (FE), and whether its Divinity Stone price is worth
// paying. Same rules as the web calculator ("Blessing from Gods" tool).

import { FLAME_ELEMENTIUM, STONE_ITEM, TRADE_HOUSE_TAX, type ShopItem } from "./items.js";
import type { ShopPrices } from "./shopPrices.js";

/** FE you get from selling `quantity` of an item on the Trade House, after tax. */
export function offerValue(itemId: number, quantity: number, unitPrice: number): number {
  const gross = quantity * unitPrice;
  return itemId === FLAME_ELEMENTIUM ? gross : gross * (1 - TRADE_HOUSE_TAX);
}

/** A farmed stone costs what selling it would earn instead: its price after tax. */
export function farmedStonePrice(stonePrice: number): number {
  return stonePrice * (1 - TRADE_HOUSE_TAX);
}

/**
 * Most Divinity Stones worth paying for an offer so that profit is at least `marginPercent` of what
 * the offer sells for: stones × stonePrice ≤ value × (1 − margin).
 */
export function maxStoneCost(value: number, stonePrice: number, marginPercent: number): number {
  return Math.floor((value * (1 - marginPercent / 100)) / stonePrice);
}

export type StoneSource = "bought" | "farmed";

export interface ValueOptions {
  source: StoneSource;
  marginPercent: number;
}

export type Verdict = "buy" | "skip" | "unknown";

export interface OfferValue {
  /** FE the offer sells for after tax; null = no price for the item. */
  value: number | null;
  /** Most stones worth paying; null = no item or stone price. */
  maxStones: number | null;
  /** With the offer's stone price: buy when it is at most maxStones. */
  verdict: Verdict;
  /** FE profit at the shown stone price (value − stones × stone price). */
  profit: number | null;
}

/** Average of a box's random amount (every amount taken as equally likely). */
export const boxAverage = (c: NonNullable<ShopItem["contents"]>) => (c.min + c.max) / 2;

/**
 * Values one offer from the item prices. `stones` = the price on the card, when read.
 * A box of Divinity Stones (Arcane Stone) is worth its average in stones, at the same stone price as
 * the cost: no tax, kept to spend here, so bought or farmed doesn't change its verdict.
 */
export function valueOffer(item: ShopItem | null, quantity: number, stones: number | null, prices: ShopPrices, opts: ValueOptions): OfferValue {
  const market = prices.get(STONE_ITEM)?.price;
  const stonePrice = market === undefined ? null : opts.source === "farmed" ? farmedStonePrice(market) : market;
  const box = item?.contents?.itemId === STONE_ITEM.itemId ? item.contents : undefined;
  const unit = item && !box ? prices.get(item)?.price : undefined;
  const value = box ? (stonePrice === null ? null : quantity * boxAverage(box) * stonePrice) : unit === undefined ? null : offerValue(item!.itemId ?? 0, quantity, unit);
  if (value === null || stonePrice === null) return { value, maxStones: null, verdict: "unknown", profit: null };
  const maxStones = maxStoneCost(value, stonePrice, opts.marginPercent);
  if (stones === null) return { value, maxStones, verdict: "unknown", profit: null };
  return { value, maxStones, verdict: stones <= maxStones ? "buy" : "skip", profit: value - stones * stonePrice };
}
