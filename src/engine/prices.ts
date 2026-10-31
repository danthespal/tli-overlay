// Trade House prices from the player's own price checks, read from the log, and kept in
// data/prices.json so they outlive the game session. Any module can look prices up here.
//
// A price check is two multi-line dumps paired by SynId:
//   [..]TLNetGame: Display: [Game] ----Socket SendMessage STT----XchgSearchPrice----SynId = 27292
//   [..]TLNetGame: Display: [Game]
//   +filters+1+refer [100200]          <- the item's ConfigBaseId (plain item search: one filter)
//   |       | +key [4]
//   +typ3 [43]
//   [..]TLNetGame: Display: [Game] ----Socket SendMessage End----
//   [..]TLNetGame: Display: [Game] ----Socket RecvMessage STT----XchgSearchPrice----SynId = 27292
//   +prices+1+unitPrices+1 [0.0002000200020002]
//   |      | |          +2 [0.0002000200020002]   <- up to 100 cheapest unit prices, sorted
//   |      | +currency [100300]                    <- Flame Elementium
//   +itemGoldId [5201]                             <- sometimes: the item again
//   [..]TLNetGame: Display: [Game] ----Socket RecvMessage End----
// The fields come in any order (seen 2026-10-31: "+typ3 [78]", "+filters+1+key [4]", "|  | +refer
// [5210]"; "+prices+1+currency [100300]" before "|  | +unitPrices+1 [..]"), so a filter is told by
// its "+filters+1+" / "|  +N+" line, and its fields by the "|  | +" lines under it.
// Searches with several filters (equipment with affixes) have "+2+key" lines and refer [0]: skipped.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { USER_DIR } from "../paths.js";
import type { LogLine } from "./logLine.js";

export const FE = 100300;

export interface PriceCheck {
  itemId: number;
  /** Unit prices in FE, cheapest first, as the Trade House listed them. */
  prices: number[];
  time?: number;
  lineNo: number;
}

const SEND = /^----Socket SendMessage STT----XchgSearchPrice----SynId = (\d+)/;
const RECV = /^----Socket RecvMessage STT----XchgSearchPrice----SynId = (\d+)/;
const END = /^----Socket (?:Send|Recv)Message End----/;
/** The first filter's first field: "+filters+1+refer [5210]" or "+filters+1+key [4]". */
const FIRST_FILTER = /^\+filters\+1\+(\w+) \[([^\]]*)\]/;
/** Another filter: "|       +2+key [21]". */
const NEXT_FILTER = /^\|\s+\+\d+\+/;
/** A field of the current filter: "|       | +refer [5210]". */
const FILTER_REFER = /^\|\s+\|\s+\+refer \[([^\]]*)\]/;
const PRICE = /\+\d+ \[(\d+(?:\.\d+)?(?:e-?\d+)?)\]$/i;
const CURRENCY = /\+currency \[(\d+)\]/;
const GOLD_ID = /^\+itemGoldId \[(\d+)\]/;

/** Pairs the request and reply dumps of each price check. Feed it every line, headed or not. */
export class PriceCheckParser {
  /** SynId -> item asked for (null: not a plain item search). */
  private readonly asked = new Map<string, number | null>();
  private block: { kind: "send"; syn: string; item: number | null; filters: number } | { kind: "recv"; syn: string; prices: number[]; currency: number | null; goldId: number | null; time?: number; lineNo: number } | null = null;

  /** Returns a finished price check, or null. */
  line(line: LogLine): PriceCheck | null {
    const text = line.text;
    if (line.time !== undefined) {
      let m: RegExpExecArray | null;
      if ((m = SEND.exec(text))) {
        this.block = { kind: "send", syn: m[1]!, item: null, filters: 0 };
        return null;
      }
      if ((m = RECV.exec(text))) {
        this.block = { kind: "recv", syn: m[1]!, prices: [], currency: null, goldId: null, time: line.time, lineNo: line.lineNo };
        return null;
      }
      if (!END.test(text) || !this.block) return null;
      const b = this.block;
      this.block = null;
      if (b.kind === "send") {
        this.asked.set(b.syn, b.filters === 1 ? b.item : null);
        if (this.asked.size > 50) this.asked.delete(this.asked.keys().next().value!); // replies that never came
        return null;
      }
      const item = this.asked.get(b.syn);
      this.asked.delete(b.syn);
      // null: a search with filters (its itemGoldId is the base item, not what was priced).
      // undefined: the request was before the first line read; the reply's itemGoldId says what it was.
      if (item === null) return null;
      const itemId = item ?? b.goldId;
      if (!itemId || b.currency !== FE || !b.prices.length) return null;
      return { itemId, prices: b.prices, time: b.time, lineNo: b.lineNo };
    }
    const b = this.block;
    if (!b) return null;
    if (b.kind === "send") {
      // An item id is a whole number ("101010040_d1_mt4" refers to an affix, 0 to nothing).
      const id = (s: string) => (/^\d+$/.test(s) && +s > 0 ? +s : null);
      let m: RegExpExecArray | null;
      if ((m = FIRST_FILTER.exec(text))) {
        b.filters = 1;
        if (m[1] === "refer") b.item = id(m[2]!);
      } else if (NEXT_FILTER.test(text)) b.filters++;
      else if (b.filters === 1 && (m = FILTER_REFER.exec(text))) b.item = id(m[1]!);
      return null;
    }
    let m: RegExpExecArray | null;
    if ((m = CURRENCY.exec(text))) b.currency = +m[1]!;
    else if ((m = GOLD_ID.exec(text))) b.goldId = +m[1]!;
    else if ((m = PRICE.exec(text))) b.prices.push(+m[1]!);
    return null;
  }
}

/**
 * The price an item trades at: the one most listings ask (prices to 3 significant digits, 0.01802
 * counts as 0.0180), the higher one on a tie. A few cheap listings at the bottom don't set it
 * (2026-10-31: Divinity Stone 0.0159 once, but 0.020 thirty times among the 100 cheapest).
 */
export function referencePrice(prices: number[]): number {
  const counts = new Map<number, number>();
  for (const p of prices) {
    const r = +p.toPrecision(3);
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  let best = 0;
  let most = 0;
  for (const [price, n] of counts) if (n > most || (n === most && price > best)) [best, most] = [price, n];
  // No price asked twice (a few scattered listings): the middle one, not the dearest.
  if (most === 1) return [...prices].sort((a, b) => a - b)[Math.floor(prices.length / 2)]!;
  return best;
}

export interface PriceEntry {
  /** FE per unit. */
  price: number;
  /** Listings the price came from. */
  listings: number;
  /** When it was checked (epoch ms, from the log). */
  time: number;
}

export const PRICES_FILE = join(USER_DIR, "prices.json");

/** Latest price per ConfigBaseId, saved after each new price check. */
export class PriceBook {
  private entries = new Map<number, PriceEntry>();
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly file = PRICES_FILE) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Record<string, PriceEntry>;
      this.entries = new Map(Object.entries(raw).map(([id, e]) => [+id, e]));
    } catch {
      this.entries = new Map();
    }
  }

  get(itemId: number): PriceEntry | undefined {
    return itemId === FE ? { price: 1, listings: 0, time: 0 } : this.entries.get(itemId);
  }

  /** Records a price check; older checks than the one kept are ignored. Returns true when stored. */
  add(check: PriceCheck): boolean {
    const time = check.time ?? Date.now();
    const old = this.entries.get(check.itemId);
    if (old && old.time > time) return false;
    this.entries.set(check.itemId, { price: referencePrice(check.prices), listings: check.prices.length, time });
    return true;
  }

  all(): Record<number, PriceEntry> {
    return Object.fromEntries(this.entries);
  }

  /** Temp file + rename; saves run one after another. */
  save(): Promise<void> {
    const write = async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(`${this.file}.tmp`, JSON.stringify(this.all(), null, 1) + "\n");
      await rename(`${this.file}.tmp`, this.file);
    };
    this.saving = this.saving.catch(() => undefined).then(write);
    return this.saving;
  }
}
