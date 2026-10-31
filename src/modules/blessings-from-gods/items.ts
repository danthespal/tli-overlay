// Blessings from Gods shop pool (SS14 Tartarus): items bought with Divinity Stones.
// Sources: https://tlidb.com/en/Blessings_from_Gods, the Torchcodex calculator's game data, and
// the shop screen itself (2026-10-31: Arcane Stone (L) for 500 stones, not in either list).
// Item ids (ConfigBaseId) from TITrack's item table (tlidb_items_seed_en.json), confirmed by the
// player's own Trade House price checks of the same items.

export interface ShopItem {
  id: string;
  /** As the shop card shows it, without the quantity. */
  name: string;
  /** ConfigBaseId for Trade House prices; null = not known yet (no price, no advice). */
  itemId: number | null;
  /** Offer sizes the shop can show for this item. */
  quantities: number[];
  /** Other spellings on the card ("Energy Cores" vs the item name "Energy Core"). */
  aliases?: string[];
  /** The Trade House name, when not `name` (copied to search for it). */
  search?: string;
  /** Not in the Trade House (so no price check): read on a card, but not on the price checklist. */
  untraded?: boolean;
  /** A box opened in the inventory: gives `min`-`max` of another item (Divinity Stones), at random. */
  contents?: { itemId: number; min: number; max: number };
}

export const REFRESH_COST_STONES = 50;
/** The Trade House search box takes 16 characters ("Divinity Fragmen" still finds the item). */
export const SEARCH_MAX = 16;

/** What to paste in the Trade House search for an item, cut to what the box takes. */
export const searchText = (item: ShopItem) => (item.search ?? item.name).slice(0, SEARCH_MAX);
export const TRADE_HOUSE_TAX = 0.125;
export const DEFAULT_PROFIT_MARGIN = 20;

export const DIVINITY_STONE = 5210;
/** Flame Elementium is the currency itself: worth 1 FE, never sold, never taxed. */
export const FLAME_ELEMENTIUM = 100300;

/** The shop's currency, priced like the items (it's what each offer costs). */
export const STONE_ITEM: ShopItem = { id: "divinity-stone", name: "Divinity Stone", itemId: DIVINITY_STONE, quantities: [] };

export const SHOP_ITEMS: ShopItem[] = [
  { id: "flame-elementium", name: "Flame Elementium", itemId: FLAME_ELEMENTIUM, quantities: [1, 5, 10] },
  { id: "flame-sand", name: "Flame Sand", itemId: 100200, quantities: [20, 60] },
  { id: "divinity-fragment", name: "Divinity Fragment", itemId: 5201, quantities: [200, 600] },
  { id: "energy-cores", name: "Energy Cores", itemId: 5080, quantities: [10, 20], aliases: ["Energy Core"], search: "Energy Core" },
  { id: "netherrealm-resonance", name: "Netherrealm Resonance", itemId: 5028, quantities: [10, 20, 100] },
  { id: "wedge-magic", name: "Transcendence Wedge (Magic)", itemId: 5220, quantities: [10, 20] },
  { id: "wedge-rare", name: "Transcendence Wedge (Rare)", itemId: 5230, quantities: [10, 20] },
  { id: "wedge-legendary", name: "Transcendence Wedge (Legendary)", itemId: 5250, quantities: [1] },
  // From the old calculator's list; not in TLIDB's SS14 items nor in the Trade House (2026-10-31).
  { id: "wedge-new-god", name: "Transcendence Wedge (New God)", itemId: null, quantities: [1], untraded: true },
  // Not in the Trade House either (2026-10-31).
  { id: "truth-ember", name: "Truth Ember", itemId: null, quantities: [10], untraded: true },
  { id: "ultimate-ember", name: "Ultimate Ember", itemId: 200030, quantities: [1] },
  // Not in the Trade House (2026-10-31). Its tooltip: "Gives 100 to 900 Divinity Stones", opened in
  // the inventory after buying: a gamble on the shop's own currency (500 stones for 500 on average).
  { id: "arcane-stone-l", name: "Arcane Stone (L)", itemId: null, quantities: [1], untraded: true, contents: { itemId: DIVINITY_STONE, min: 100, max: 900 } },
  // Seen after a Refresh (2026-10-31) for 200 stones. Tooltip: "Gives 50 to 350 Divinity Stones".
  { id: "arcane-stone-s", name: "Arcane Stone (S)", itemId: null, quantities: [1], untraded: true, contents: { itemId: DIVINITY_STONE, min: 50, max: 350 } },
];
