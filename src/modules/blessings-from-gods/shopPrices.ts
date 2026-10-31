// What each shop item is worth: the newer of the player's last Trade House price check (price book,
// by item id) and a price the player typed in the overlay's table. Also learns the ids the item table
// doesn't have: the player copies an item's name from the table, searches it in the Trade House and
// price-checks it; that check's id belongs to the copied item.

import type { PriceBook, PriceCheck } from "../../engine/prices.js";
import { FLAME_ELEMENTIUM, SHOP_ITEMS, STONE_ITEM, type ShopItem } from "./items.js";

/** The player's own data, kept in settings.json (settings.blessing). */
export interface BlessingCustom {
  /** Typed prices (FE per unit) by item id ("truth-ember"), with when they were typed. */
  manual?: Record<string, { price: number; time: number }>;
  /** Item ids learned from price checks, for items the table has none for. */
  ids?: Record<string, number>;
}

export interface ItemPrice {
  price: number;
  /** Epoch ms of the check or the edit. */
  time: number;
  source: "check" | "manual";
  /** Listings the checked price came from. */
  listings?: number;
}

/** A copy of an item's name counts for the next price check within this time. */
export const LEARN_MS = 180_000;
/** Prices older than this are on the Trade House checklist again. */
export const STALE_PRICE_MS = 24 * 3_600_000;
/** Checked within this time: ticked off on the checklist (this Trade House visit). */
export const FRESH_PRICE_MS = 3_600_000;

/** The price table / checklist: the stone and every item the Trade House sells (not the currency). */
export const TABLE_ITEMS: ShopItem[] = [STONE_ITEM, ...SHOP_ITEMS.filter((i) => i.itemId !== FLAME_ELEMENTIUM && !i.untraded)];

export class ShopPrices {
  private copied: { item: ShopItem; at: number } | null = null;

  constructor(
    private readonly book: PriceBook,
    private readonly custom: BlessingCustom,
    private readonly now: () => number = Date.now,
  ) {}

  idOf(item: ShopItem): number | null {
    return item.itemId ?? this.custom.ids?.[item.id] ?? null;
  }

  get(item: ShopItem): ItemPrice | undefined {
    const id = this.idOf(item);
    if (id === FLAME_ELEMENTIUM) return { price: 1, time: 0, source: "check" };
    const check = id === null ? undefined : this.book.get(id);
    const manual = this.custom.manual?.[item.id];
    if (manual && (!check || manual.time >= check.time)) return { ...manual, source: "manual" };
    return check && { price: check.price, time: check.time, source: "check", listings: check.listings };
  }

  /** A typed price; null forgets it (the last price check counts again). */
  setManual(item: ShopItem, price: number | null): void {
    this.custom.manual ??= {};
    if (price === null) delete this.custom.manual[item.id];
    else this.custom.manual[item.id] = { price, time: this.now() };
  }

  /** The player copied this item's name (to search it in the Trade House). */
  noteCopied(item: ShopItem): void {
    this.copied = { item, at: this.now() };
  }

  /**
   * A price check came in: when its id belongs to no table item and the player copied the name of an
   * item without an id just before, it is that item's id. Returns the item that learned it.
   */
  learn(check: PriceCheck): ShopItem | null {
    const c = this.copied;
    this.copied = null; // one check per copy
    if (!c || this.now() - c.at > LEARN_MS || c.item.itemId !== null) return null;
    if (TABLE_ITEMS.some((i) => i !== c.item && this.idOf(i) === check.itemId)) return null;
    this.custom.ids ??= {};
    this.custom.ids[c.item.id] = check.itemId;
    return c.item;
  }
}
