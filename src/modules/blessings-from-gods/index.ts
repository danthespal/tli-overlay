// Blessings from Gods module: the Divinity Stone shop.
// - Keeps Trade House prices from the player's price checks (engine/prices.ts) in data/prices.json.
// - Knows when the shop is open: log page GroceryStoreV3 ("Destory" is the game's spelling).
//   The shop's offers aren't in the log, so they are read from a screenshot (shopReader.ts).
// - Counts the Divinity Stones in the bag (BagMgr@ lines of item 5210: the login's InitBagData,
//   then every change), so a Buy the player can't afford is marked. Stones in the warehouse
//   ("BagMgr&WareHouseMgr@") don't count: the shop takes them from the bag.
// See mechanics/blessings-from-gods.

import { extractEvent } from "../../engine/events.js";
import type { LogLine } from "../../engine/logLine.js";
import type { ToolModule } from "../../engine/module.js";
import { PriceCheckParser, type PriceBook, type PriceCheck } from "../../engine/prices.js";
import { DIVINITY_STONE, SHOP_ITEMS } from "./items.js";
import { SHOP_PAGE } from "./shopWatcher.js";

/** The Trade House, where the player price-checks the shop's items (log page AuctionHouseV2). */
export const TRADE_HOUSE = /^TipMsgShowMgr@DispatchPageRunChange PageName = AuctionHouseV2 , PageRunState = (Run|Destory)/;

/** InitBagData lines further apart than this belong to different listings of the bag. */
const LISTING_GAP_MS = 5000;

export type BlessingEvent =
  | { kind: "shopOpen" | "shopClosed" | "tradeHouseOpen" | "tradeHouseClosed"; time?: number }
  | { kind: "price"; check: PriceCheck }
  /** The Divinity Stones in the bag changed. */
  | { kind: "stones"; count: number };

export interface BlessingOptions {
  prices: PriceBook;
  onEvent?: (e: BlessingEvent) => void;
  /** Save the price book after each new check (off in tests and one-shot audits). */
  save?: boolean;
}

export class BlessingsFromGodsModule implements ToolModule {
  readonly id = "blessings-from-gods";
  readonly name = "Blessings from Gods";

  private readonly parser = new PriceCheckParser();
  private open = false;
  private opened = 0;
  private checks = 0;
  /** Divinity Stones per bag slot ("page:slot"). */
  private readonly stoneSlots = new Map<string, number>();
  private stoneCount: number | null = null;
  /** Time of the last InitBagData line (a listing of the whole bag is one burst of them). */
  private lastListing: number | undefined;

  constructor(private readonly opts: BlessingOptions) {}

  get shopOpen(): boolean {
    return this.open;
  }

  /** Divinity Stones in the bag; null before the log has said (no bag line seen yet). */
  get stones(): number | null {
    return this.stoneCount;
  }

  onLine(line: LogLine): void {
    this.passiveLine(line);
    const trade = TRADE_HOUSE.exec(line.text);
    if (trade) {
      this.opts.onEvent?.({ kind: trade[1] === "Run" ? "tradeHouseOpen" : "tradeHouseClosed", time: line.time });
      return;
    }
    const page = SHOP_PAGE.exec(line.text);
    if (!page) return;
    this.open = page[1] === "Run";
    if (this.open) this.opened++;
    this.opts.onEvent?.({ kind: this.open ? "shopOpen" : "shopClosed", time: line.time });
  }

  /**
   * What only keeps data, no screens: price checks and the stone count. Also fed the lines written
   * before the tool started and those while the modules wait for the start checks.
   */
  passiveLine(line: LogLine): void {
    this.priceLine(line);
    this.stoneLine(line);
  }

  private stoneLine(line: LogLine): void {
    if (!line.text.startsWith("BagMgr@:") && !line.text.startsWith("ItemChange@ Delete")) return; // cheap filter
    const e = extractEvent(line);
    if (!e) return;
    if (e.type === "bagInit" || e.type === "bagModify") {
      if (e.type === "bagInit") {
        // A new listing of the whole bag (login, another character, sorting) comes as one burst of
        // InitBagData lines: only its stacks count, not those of a bag listed before.
        if (this.lastListing === undefined || e.time === undefined || e.time - this.lastListing > LISTING_GAP_MS) this.stoneSlots.clear();
        this.lastListing = e.time;
      }
      const key = `${e.pageId}:${e.slotId}`;
      if (e.configBaseId === DIVINITY_STONE) this.stoneSlots.set(key, e.num);
      else if (!this.stoneSlots.delete(key) && e.type !== "bagInit") return; // another item, in a slot that had no stones
    } else if (e.type === "itemChange" && e.op === "Delete" && e.configBaseId === DIVINITY_STONE) {
      this.stoneSlots.delete(`${e.pageId}:${e.slotId}`);
    } else return;
    const count = [...this.stoneSlots.values()].reduce((a, b) => a + b, 0);
    if (count === this.stoneCount) return;
    this.stoneCount = count;
    this.opts.onEvent?.({ kind: "stones", count });
  }

  /** Price checks: the request and reply dumps, paired. */
  private priceLine(line: LogLine): void {
    const check = this.parser.line(line);
    if (!check || !this.opts.prices.add(check)) return;
    this.checks++;
    if (this.opts.save !== false) this.opts.prices.save().catch((err) => console.error(`prices: ${err}`));
    this.opts.onEvent?.({ kind: "price", check });
  }

  summary() {
    const stone = this.opts.prices.get(DIVINITY_STONE);
    return {
      shopOpen: this.open,
      shopOpened: this.opened,
      priceChecks: this.checks,
      divinityStoneFe: stone?.price ?? null,
      divinityStones: this.stoneCount,
      // What each shop item is worth now (FE per unit), or why not.
      prices: SHOP_ITEMS.map((item) => {
        const p = item.itemId === null ? undefined : this.opts.prices.get(item.itemId);
        return { item: item.name, itemId: item.itemId, fe: p?.price ?? null, checked: p?.time ? new Date(p.time).toISOString() : null };
      }),
    };
  }
}
