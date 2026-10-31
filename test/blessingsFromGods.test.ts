// Blessings from Gods: Trade House price checks from the log, offer values, and the shop reader.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { parseLogLine } from "../src/engine/logLine.js";
import { PriceBook, PriceCheckParser, referencePrice, type PriceCheck } from "../src/engine/prices.js";
import { farmedStonePrice, maxStoneCost, offerValue, valueOffer } from "../src/modules/blessings-from-gods/calc.js";
import { BlessingsFromGodsModule, type BlessingEvent } from "../src/modules/blessings-from-gods/index.js";
import { DIVINITY_STONE, FLAME_ELEMENTIUM, searchText, SHOP_ITEMS, type ShopItem } from "../src/modules/blessings-from-gods/items.js";
import { cardInSlot, matchItem, mergeReads, offerSize, priceDigits, readShopPage, SHOP_SLOTS, splitQuantity } from "../src/modules/blessings-from-gods/shopReader.js";
import { ShopPrices, TABLE_ITEMS } from "../src/modules/blessings-from-gods/shopPrices.js";
import { ShopWatcher, type ShopEvent } from "../src/modules/blessings-from-gods/shopWatcher.js";
import { decodeImage, TesseractOcr } from "../src/ocr/tesseractOcr.js";
import type { OcrPage } from "../src/ocr/windowsOcr.js";

const SHOP = resolve(import.meta.dirname, "../../mechanics/blessings-from-gods/samples/screens/shop-8-offers.jpg");

// A Divinity Fragment price check from a real UE_game.log (2026-10-31, listings cut to 4).
const H = "[2026.10.31-09.34.01:607][566]TLNetGame: Display: [Game] ";
const R = "[2026.10.31-09.34.01:766][589]TLNetGame: Display: [Game] ";
const CHECK = [
  `${H}----Socket SendMessage STT----XchgSearchPrice----SynId = 27320`,
  `${H}`,
  "+filters+1+refer [5201]",
  "|       | +key [4]",
  "+typ3 [107]",
  `${H}----Socket SendMessage End----`,
  "[2026.10.31-09.34.01:607][566]TLGame: Display: [Game] UIButton@ normal-click TradeQueryButton",
  `${R}----Socket RecvMessage STT----XchgSearchPrice----SynId = 27320`,
  `${R}`,
  "+prices+1+unitPrices+1 [0.001990019900199]",
  "|      | |          +2 [0.002]",
  "|      | |          +3 [0.0021]",
  "|      | |          +4 [0.0078740157480315]",
  "|      | +currency [100300]",
  "+itemGoldId [5201]",
  "+errCode",
  `${R}----Socket RecvMessage End----`,
];

// An equipment search: several filters, priced by its affixes, not a plain item price.
const GEAR = [
  `${H}----Socket SendMessage STT----XchgSearchPrice----SynId = 1`,
  "+filters+1+refer [112348]",
  "|       | +key [16]",
  "|       +2+key [21]",
  "+typ3 [8]",
  `${H}----Socket SendMessage End----`,
  `${R}----Socket RecvMessage STT----XchgSearchPrice----SynId = 1`,
  "+prices+1+unitPrices+1 [3]",
  "|      | +currency [100300]",
  "+itemGoldId [112348]",
  `${R}----Socket RecvMessage End----`,
];

const feed = (lines: string[], each: (l: ReturnType<typeof parseLogLine>) => void) => lines.forEach((raw, i) => each(parseLogLine(raw, i + 1)));

const checksOf = (lines: string[]) => {
  const parser = new PriceCheckParser();
  const out: PriceCheck[] = [];
  feed(lines, (l) => {
    const c = parser.line(l);
    if (c) out.push(c);
  });
  return out;
};

const book = (entries: Record<number, number>) => {
  const b = new PriceBook(join(tmpdir(), "unused-prices.json"));
  for (const [id, price] of Object.entries(entries)) b.add({ itemId: +id, prices: [price], time: 1, lineNo: 1 });
  return b;
};

describe("PriceCheckParser", () => {
  it("pairs the request and reply of a plain item price check", () => {
    const [c, ...rest] = checksOf(CHECK);
    expect(rest).toEqual([]);
    expect(c!.itemId).toBe(5201);
    expect(c!.prices).toEqual([0.001990019900199, 0.002, 0.0021, 0.0078740157480315]);
    expect(c!.time).toBe(Date.UTC(2026, 9, 31, 9, 34, 1, 766));
  });

  it("reads the request and reply with their fields in another order", () => {
    // A Divinity Stone check from the same day's log, fields dumped in a different order.
    const H2 = "[2026.10.31-12.56.30:792][376]TLNetGame: Display: [Game] ";
    const R2 = "[2026.10.31-12.56.30:951][399]TLNetGame: Display: [Game] ";
    const checks = checksOf([
      `${H2}----Socket SendMessage STT----XchgSearchPrice----SynId = 924`,
      `${H2}`,
      "+typ3 [78]",
      "+filters+1+key [4]",
      "|       | +refer [5210]",
      `${H2}----Socket SendMessage End----`,
      `${R2}----Socket RecvMessage STT----XchgSearchPrice----SynId = 924`,
      `${R2}`,
      "+prices+1+currency [100300]",
      "|      | +unitPrices+1 [0.01589103291714]",
      "|      | |          +2 [0.017961165048544]",
      "+errCode",
      `${R2}----Socket RecvMessage End----`,
    ]);
    expect(checks.map((c) => [c.itemId, c.prices])).toEqual([[5210, [0.01589103291714, 0.017961165048544]]]);
  });

  it("skips gear searches whose first filter is an affix, with the item in a later filter", () => {
    const checks = checksOf([
      `${H}----Socket SendMessage STT----XchgSearchPrice----SynId = 2`,
      "+filters+1+key [24]",
      "|       +2+key [4]",
      "|       | +refer [4011]",
      "+typ3 [12]",
      `${H}----Socket SendMessage End----`,
      `${R}----Socket RecvMessage STT----XchgSearchPrice----SynId = 2`,
      "+prices+1+unitPrices+1 [5]",
      "|      | +currency [100300]",
      `${R}----Socket RecvMessage End----`,
    ]);
    expect(checks).toEqual([]);
  });

  it("skips searches with filters (equipment by affixes)", () => {
    expect(checksOf([...GEAR, ...CHECK]).map((c) => c.itemId)).toEqual([5201]);
  });

  it("takes the reply's itemGoldId when the request was before the first line read", () => {
    expect(checksOf(CHECK.slice(7)).map((c) => c.itemId)).toEqual([5201]);
  });

  it("takes the price most listings ask, the higher one on a tie", () => {
    expect(referencePrice([0.5, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3])).toBe(2);
    expect(referencePrice([1, 1, 2, 2, 3])).toBe(2);
    // To 3 significant digits: 0.01802 asks the same as 0.0180.
    expect(referencePrice([0.0159, 0.018, 0.01802, 0.018015, 0.02, 0.02])).toBe(0.018);
    // Nothing asked twice: the middle listing.
    expect(referencePrice([1, 2, 3, 4])).toBe(3);
    expect(referencePrice([7])).toBe(7);
  });
});

describe("PriceBook", () => {
  const dir = mkdtemp(join(tmpdir(), "tli-prices-"));
  afterAll(async () => rm(await dir, { recursive: true, force: true }));

  it("keeps the newest check per item and survives a restart", async () => {
    const file = join(await dir, "prices.json");
    const a = new PriceBook(file);
    expect(a.add({ itemId: 5210, prices: [0.02], time: 2000, lineNo: 1 })).toBe(true);
    expect(a.add({ itemId: 5210, prices: [0.05], time: 1000, lineNo: 2 })).toBe(false); // older log
    await a.save();
    const b = new PriceBook(file);
    await b.load();
    expect(b.get(5210)).toEqual({ price: 0.02, listings: 1, time: 2000 });
    expect(b.get(FLAME_ELEMENTIUM)?.price).toBe(1);
  });
});

describe("offer values (same rules as the web calculator)", () => {
  it("takes the 12.5% Trade House tax off items, not off Flame Elementium", () => {
    expect(offerValue(5028, 20, 0.13)).toBeCloseTo(2.275);
    expect(offerValue(FLAME_ELEMENTIUM, 5, 1)).toBe(5);
    expect(farmedStonePrice(0.02)).toBeCloseTo(0.0175);
  });

  it("caps the stones so the profit is at least the margin", () => {
    expect(maxStoneCost(2.275, 0.02, 20)).toBe(91);
    expect(maxStoneCost(2.275, 0.02, 0)).toBe(113);
  });

  it("values a box of 100-900 Divinity Stones at its average, bought or farmed alike", () => {
    const prices = new ShopPrices(book({ [DIVINITY_STONE]: 0.018 }), {});
    const arcane = SHOP_ITEMS.find((i) => i.id === "arcane-stone-l")!;
    for (const source of ["bought", "farmed"] as const) {
      expect(valueOffer(arcane, 1, 500, prices, { source, marginPercent: 20 })).toMatchObject({ maxStones: 400, verdict: "skip" });
      expect(valueOffer(arcane, 1, 500, prices, { source, marginPercent: 0 })).toMatchObject({ maxStones: 500, verdict: "buy" });
    }
    expect(valueOffer(arcane, 1, 500, new ShopPrices(book({}), {}), { source: "bought", marginPercent: 0 }).verdict).toBe("unknown"); // no stone price
    // (S): 50-350, 200 on average.
    const small = SHOP_ITEMS.find((i) => i.id === "arcane-stone-s")!;
    expect(valueOffer(small, 1, 200, prices, { source: "farmed", marginPercent: 20 })).toMatchObject({ maxStones: 160, verdict: "skip" });
  });

  it("says buy or skip for the price on the card", () => {
    const prices = new ShopPrices(book({ [DIVINITY_STONE]: 0.02, 5028: 0.13 }), {});
    const resonance = SHOP_ITEMS.find((i) => i.id === "netherrealm-resonance")!;
    const opts = { source: "bought" as const, marginPercent: 20 };
    expect(valueOffer(resonance, 20, 127, prices, opts)).toMatchObject({ maxStones: 91, verdict: "skip" });
    expect(valueOffer(resonance, 20, 90, prices, opts)).toMatchObject({ maxStones: 91, verdict: "buy" });
    expect(valueOffer(resonance, 20, null, prices, opts).verdict).toBe("unknown"); // price not read
    expect(valueOffer(SHOP_ITEMS.find((i) => i.itemId === null)!, 1, 500, prices, opts).verdict).toBe("unknown");
    expect(valueOffer(resonance, 20, 90, new ShopPrices(book({ 5028: 0.13 }), {}), opts).verdict).toBe("unknown"); // no stone price
  });
});

describe("ShopPrices", () => {
  // The whole pool: the learning works for any item without an id (none is left on the checklist).
  const item = (id: string) => [...TABLE_ITEMS, ...SHOP_ITEMS].find((i) => i.id === id)!;
  const check = (itemId: number, price: number, time: number): PriceCheck => ({ itemId, prices: [price], time, lineNo: 1 });

  it("takes the newer of a price check and a typed price, and forgets a typed one", () => {
    let now = 1000;
    const b = book({});
    const p = new ShopPrices(b, {}, () => now);
    b.add(check(5028, 0.13, 500));
    expect(p.get(item("netherrealm-resonance"))).toMatchObject({ price: 0.13, source: "check" });
    p.setManual(item("netherrealm-resonance"), 0.2); // typed at 1000, after the check
    expect(p.get(item("netherrealm-resonance"))).toMatchObject({ price: 0.2, source: "manual", time: 1000 });
    b.add(check(5028, 0.15, 2000)); // a newer check wins again
    expect(p.get(item("netherrealm-resonance"))).toMatchObject({ price: 0.15, source: "check" });
    now = 3000;
    p.setManual(item("netherrealm-resonance"), 0.2);
    p.setManual(item("netherrealm-resonance"), null);
    expect(p.get(item("netherrealm-resonance"))?.price).toBe(0.15);
    expect(p.get(item("divinity-stone"))).toBeUndefined();
  });

  it("learns the id of an item the table has none for, from the next check after copying its name", () => {
    let now = 0;
    const custom = {};
    const p = new ShopPrices(book({}), custom, () => now);
    const arcane = item("arcane-stone-l");
    expect(p.learn(check(777, 1, 0))).toBeNull(); // nothing copied
    p.noteCopied(arcane);
    now += 200_000; // too long after the copy
    expect(p.learn(check(777, 1, 0))).toBeNull();
    p.noteCopied(arcane);
    now += 60_000;
    expect(p.learn(check(5028, 1, 0))).toBeNull(); // Netherrealm Resonance's id: not new
    p.noteCopied(arcane);
    expect(p.learn(check(777, 1, 0))).toBe(arcane);
    expect(p.idOf(arcane)).toBe(777);
    expect(custom).toEqual({ ids: { "arcane-stone-l": 777 } });
    p.noteCopied(item("netherrealm-resonance")); // has an id: nothing to learn
    expect(p.learn(check(889, 1, 0))).toBeNull();
  });

  it("prices typed for an item without an id", () => {
    const p = new ShopPrices(book({}), {});
    p.setManual(item("arcane-stone-l"), 12);
    expect(p.get(item("arcane-stone-l"))).toMatchObject({ price: 12, source: "manual" });
  });
});

describe("shop reader", () => {
  it("splits the quantity off the name", () => {
    expect(splitQuantity("Energy Cores x20")).toEqual({ name: "Energy Cores", quantity: 20 });
    expect(splitQuantity("Netherrealm Resonance x1O")).toEqual({ name: "Netherrealm Resonance", quantity: 10 });
    expect(splitQuantity("Flame Elementium")).toEqual({ name: "Flame Elementium", quantity: 1 });
  });

  it("copies at most the 16 characters the Trade House search box takes", () => {
    const text = (id: string) => searchText(SHOP_ITEMS.find((i) => i.id === id)!);
    expect(text("divinity-fragment")).toBe("Divinity Fragmen");
    expect(text("wedge-magic")).toBe("Transcendence We");
    expect(text("energy-cores")).toBe("Energy Core");
    expect(text("arcane-stone-l")).toBe("Arcane Stone (L)");
  });

  it("snaps a misread amount to the item's offer sizes, and gives up when two are as close", () => {
    const item = (id: string) => SHOP_ITEMS.find((i) => i.id === id)!;
    expect(offerSize(item("netherrealm-resonance"), 1100)).toBe(100); // "x1l00" (2026-10-31)
    expect(offerSize(item("netherrealm-resonance"), 20)).toBe(20);
    expect(offerSize(item("energy-cores"), 50)).toBeNull(); // 10 or 20: as close
    expect(offerSize(item("flame-elementium"), 1)).toBe(1);
  });

  it("keeps a name a dimmed re-read lost, when the card's price is the same", () => {
    const sand = SHOP_ITEMS.find((i) => i.id === "flame-sand")!;
    const offer = (slot: number, item: ShopItem | null, stones: number) => ({ slot, row: 0, col: slot, text: item?.name ?? "", item, quantity: item ? 20 : 1, stones });
    const merged = mergeReads({ offers: [offer(4, sand, 5), offer(5, sand, 10)] }, { offers: [offer(4, null, 5), offer(5, null, 12)] });
    expect(merged.offers.map((o) => [o.item?.id ?? null, o.quantity])).toEqual([["flame-sand", 20], [null, 1]]); // slot 5: new price, a new offer
    expect(mergeReads(null, { offers: [offer(4, null, 5)] }).offers[0]!.item).toBeNull();
  });

  it("matches names through OCR noise from the art", () => {
    expect(matchItem("4a f toe, Flame Sand")?.id).toBe("flame-sand");
    expect(matchItem("Transcendence Wedge (Magic!")?.id).toBe("wedge-magic");
    expect(matchItem("7 we Arcane Stone iL |")?.id).toBe("arcane-stone-l");
    expect(matchItem("St “L Arcane Stone ‘Si")?.id).toBe("arcane-stone-s"); // the "L" before "Stone" is art
    expect(matchItem("Energy Core")?.id).toBe("energy-cores");
    expect(matchItem("Something New")).toBeNull();
  });

  it("finds the 8 cards on the sample: 7 in the first row, 1 in the second", async () => {
    const px = await decodeImage(SHOP);
    expect(SHOP_SLOTS.filter((s) => cardInSlot(px, s)).map((s) => s.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("reads every offer after a Refresh: a 3-digit price, Flame Elementium x5, Arcane Stone (S)", async () => {
    const ocr = new TesseractOcr();
    try {
      const [page] = await ocr.ocrImages([SHOP.replace("shop-8-offers", "shop-refreshed")], [], "shop");
      const offers = readShopPage(page!).offers.map((o) => `${o.item?.id ?? o.text} x${o.quantity} ${o.stones}`);
      expect(offers).toEqual([
        "wedge-magic x20 13",
        "flame-sand x20 2",
        "energy-cores x10 52",
        "netherrealm-resonance x10 43",
        "flame-sand x60 13",
        "flame-elementium x1 40",
        "flame-elementium x5 172",
        "arcane-stone-s x1 200",
      ]);
    } finally {
      await ocr.stop();
    }
  }, 60_000);

  it("reads a second Refresh: x100 read as \"x1l00\", the Rare wedge, Arcane Stone (L)", async () => {
    const ocr = new TesseractOcr();
    try {
      const [page] = await ocr.ocrImages([SHOP.replace("shop-8-offers", "shop-refreshed-2")], [], "shop");
      const offers = readShopPage(page!).offers.map((o) => `${o.item?.id ?? o.text} x${o.quantity} ${o.stones}`);
      expect(offers).toEqual([
        "energy-cores x10 60",
        "flame-sand x60 7",
        "energy-cores x20 181",
        "flame-sand x20 3",
        "wedge-magic x20 20",
        "netherrealm-resonance x100 781",
        "wedge-rare x20 100",
        "arcane-stone-l x1 500",
      ]);
    } finally {
      await ocr.stop();
    }
  }, 60_000);

  it("counts each price's digits from the pixels on every sample (catches \"1\" read for \"11\")", async () => {
    const truth: Record<string, number[]> = {
      "shop-8-offers": [127, 171, 38, 63, 5, 10, 49, 500],
      "shop-refreshed": [13, 2, 52, 43, 13, 40, 172, 200],
      "shop-refreshed-2": [60, 7, 181, 3, 20, 781, 100, 500],
      "shop-refreshed-3": [46, 2, 11, 68, 35, 110, 187, 200],
      "shop-refreshed-4": [4, 20, 122, 79, 45, 51, 164, 200],
      "shop-refreshed-5": [9, 2, 426, 43, 105, 44, 10, 500],
    };
    for (const [name, prices] of Object.entries(truth)) {
      const px = await decodeImage(SHOP.replace("shop-8-offers", name));
      expect(SHOP_SLOTS.slice(0, 8).map((s) => priceDigits(px, s)), name).toEqual(prices.map((p) => String(p).length));
    }
  });

  it("reads a third Refresh: \"11\" for the Magic wedge (read as \"1\" live, a wrong BUY)", async () => {
    const ocr = new TesseractOcr();
    try {
      const [page] = await ocr.ocrImages([SHOP.replace("shop-8-offers", "shop-refreshed-3")], [], "shop");
      expect(readShopPage(page!).offers.map((o) => o.stones)).toEqual([46, 2, 11, 68, 35, 110, 187, 200]);
    } finally {
      await ocr.stop();
    }
  }, 60_000);

  it("reads a fourth Refresh: \"79\" for Energy Cores (binarised reads gave 19, a wrong BUY)", async () => {
    const ocr = new TesseractOcr();
    try {
      const [page] = await ocr.ocrImages([SHOP.replace("shop-8-offers", "shop-refreshed-4")], [], "shop");
      expect(readShopPage(page!).offers.map((o) => o.stones)).toEqual([4, 20, 122, 79, 45, 51, 164, 200]);
    } finally {
      await ocr.stop();
    }
  }, 60_000);

  it("skips sold-out cards (dimmed art, no bright edge, \"Sold out\" for a price)", async () => {
    const ocr = new TesseractOcr();
    try {
      const [page] = await ocr.ocrImages([SHOP.replace("shop-8-offers", "shop-sold-out")], [], "shop");
      const offers = readShopPage(page!).offers.map((o) => `${o.slot} ${o.item?.id ?? o.text} ${o.stones}`);
      expect(offers).toEqual(["0 wedge-magic 13", "1 flame-sand 2", "2 energy-cores 52", "4 flame-sand 13", "7 arcane-stone-s 200"]);
    } finally {
      await ocr.stop();
    }
  }, 60_000);

  it("reads every offer on the sample", async () => {
    const ocr = new TesseractOcr();
    try {
      const [page] = await ocr.ocrImages([SHOP], [], "shop");
      const offers = readShopPage(page!).offers.map((o) => `${o.item?.id ?? o.text} x${o.quantity} ${o.stones}`);
      expect(offers).toEqual([
        "netherrealm-resonance x20 127",
        "energy-cores x20 171",
        "energy-cores x10 38",
        "netherrealm-resonance x10 63",
        "flame-sand x20 5",
        "wedge-magic x20 10",
        "flame-elementium x1 49",
        "arcane-stone-l x1 500",
      ]);
    } finally {
      await ocr.stop();
    }
  }, 60_000);
});

describe("ShopWatcher", () => {
  // Real log lines (2026-10-31).
  const P = (name: string, state: string) => `[2026.10.31-09.14.59:134][ 20]TLLua: Display: [Game] TipMsgShowMgr@DispatchPageRunChange PageName = ${name} , PageRunState = ${state} `;
  const CLICK = (btn: string) => `[2026.10.31-09.15.00:667][239]TLGame: Display: [Game] UIButton@ normal-click ${btn}`;
  const OFFER: OcrPage = { file: "f.jpg", width: 1920, height: 1080, regions: [], lines: [
    { text: "Energy Cores x20", x: 721, y: 269, w: 110, h: 20 },
    { text: "171", x: 770, y: 336, w: 30, h: 16 },
  ] };

  const setup = (pages: OcrPage[]) => {
    const events: ShopEvent[] = [];
    const grabs: string[] = [];
    const w = new ShopWatcher({
      grab: async (t) => (grabs.push(t), { ok: true, file: "f.jpg", width: 1920, height: 1080 }),
      ocr: async () => [pages.shift() ?? OFFER],
      onEvent: (e) => events.push(e),
      settleMs: { open: 1000, click: 900, retry: 700 },
    });
    const feedW = (raw: string) => w.onLine(parseLogLine(raw, 1));
    return { events, grabs, feedW };
  };
  afterEach(() => vi.useRealTimers());

  it("reads the shop once it opened, and again after a click in it", async () => {
    vi.useFakeTimers();
    const { events, grabs, feedW } = setup([]);
    feedW(P("GroceryStoreV3", "Run"));
    await vi.advanceTimersByTimeAsync(999);
    expect(grabs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(events[0]).toMatchObject({ kind: "read", trigger: "open" });
    expect(events[0]!.kind === "read" && events[0]!.read.offers[0]).toMatchObject({ quantity: 20, stones: 171 });
    feedW(CLICK("BtnHelp")); // the help button changes nothing
    feedW(CLICK("UIButton_10272"));
    await vi.advanceTimersByTimeAsync(900);
    expect(grabs).toEqual(["open", "click"]);
  });

  it("reads the new offers after a Refresh: confirm page closed, then the RefreshVendorShop batch", async () => {
    vi.useFakeTimers();
    const { events, grabs, feedW } = setup([]);
    feedW(P("GroceryStoreV3", "Run"));
    await vi.advanceTimersByTimeAsync(1000);
    // Real lines of a Refresh (2026-10-31).
    feedW(P("ConfirmV2", "Run"));
    feedW(CLICK("CheckOffBtn")); // on the confirm page: not a shop click
    feedW(CLICK("Btn"));
    feedW(P("ConfirmV2", "Destory"));
    feedW("[2026.10.31-13.33.27:172][800]TLLua: Display: [Game] ItemChange@ ProtoName=RefreshVendorShop start");
    feedW("[2026.10.31-13.33.27:173][800]TLLua: Display: [Game] ItemChange@ ProtoName=RefreshVendorShop end");
    await vi.advanceTimersByTimeAsync(999);
    expect(grabs).toEqual(["open"]); // the read after the confirm page was replaced by the later one
    await vi.advanceTimersByTimeAsync(1);
    expect(grabs).toEqual(["open", "changed"]);
    expect(events.map((e) => e.kind)).toEqual(["read", "hidden", "changing", "read"]);
  });

  it("reads again after a Refresh click that no refresh follows (too few stones), so \"Reading…\" can't stay", async () => {
    vi.useFakeTimers();
    const { events, grabs, feedW } = setup([]);
    feedW(P("GroceryStoreV3", "Run"));
    await vi.advanceTimersByTimeAsync(1000);
    feedW("[2026.10.31-14.10.00:000][311]LogDataTable: Warning: UDataTable::FindRow : 'AudioMgr' requested row 'RefreshBtn_Btn' not in DataTable '/Game/Audio/BluePrint/AudioAndUIDataTable.AudioAndUIDataTable'.");
    await vi.advanceTimersByTimeAsync(2999);
    expect(grabs).toEqual(["open"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(grabs).toEqual(["open", "changed"]);
    expect(events.map((e) => e.kind)).toEqual(["read", "changing", "read"]);
  });

  it("hides the old verdicts at the Refresh click (no confirm page), reads again if a card wasn't ready", async () => {
    vi.useFakeTimers();
    const noPrice: OcrPage = { ...OFFER, lines: [OFFER.lines[0]!] }; // a card still animating: name, no price
    const { events, grabs, feedW } = setup([OFFER, noPrice]);
    feedW(P("GroceryStoreV3", "Run"));
    await vi.advanceTimersByTimeAsync(1000);
    // Real lines of a Refresh with the confirm page turned off (2026-10-31 13:45:02).
    feedW("[2026.10.31-13.45.02:584][311]LogDataTable: Warning: UDataTable::FindRow : 'AudioMgr' requested row 'RefreshBtn_Btn' not in DataTable '/Game/Audio/BluePrint/AudioAndUIDataTable.AudioAndUIDataTable'.");
    expect(events.map((e) => e.kind)).toEqual(["read", "changing"]); // at once, before the server answers
    feedW(CLICK("Btn"));
    feedW("[2026.10.31-13.45.02:646][320]TLLua: Display: [Game] ItemChange@ ProtoName=RefreshVendorShop end");
    await vi.advanceTimersByTimeAsync(1000);
    expect(grabs).toEqual(["open", "changed"]);
    await vi.advanceTimersByTimeAsync(700); // the price wasn't read: once more
    expect(grabs).toEqual(["open", "changed", "changed"]);
    expect(events.map((e) => e.kind)).toEqual(["read", "changing", "changing", "read", "read"]);
  });

  it("doesn't read while a card's item pop-up opens or closes (it dims the other cards)", async () => {
    vi.useFakeTimers();
    const { grabs, feedW } = setup([]);
    feedW(P("GroceryStoreV3", "Run"));
    await vi.advanceTimersByTimeAsync(1000);
    feedW(CLICK("Btn")); // a card: its pop-up opens
    feedW(CLICK("BtnCloseTips"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(grabs).toEqual(["open"]);
  });

  it("reads again when the pop-up closes after a read that missed names (it was open at the read)", async () => {
    vi.useFakeTimers();
    const dimmed: OcrPage = { ...OFFER, lines: [OFFER.lines[1]!] }; // the price, no name
    const { events, grabs, feedW } = setup([dimmed]);
    feedW(P("GroceryStoreV3", "Run"));
    await vi.advanceTimersByTimeAsync(1000);
    feedW(CLICK("BtnCloseTips"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(grabs).toEqual(["open", "click"]);
    const last = events.at(-1)!;
    expect(last.kind === "read" && last.read.offers[0]!.item?.id).toBe("energy-cores");
  });

  it("draws nothing while a page is over the shop, reads again once it closes", async () => {
    vi.useFakeTimers();
    const { events, grabs, feedW } = setup([]);
    feedW(P("GroceryStoreV3", "Run"));
    feedW(P("SystemHelp", "Run")); // before the first read: it's dropped
    await vi.advanceTimersByTimeAsync(2000);
    expect(grabs).toEqual([]);
    expect(events.map((e) => e.kind)).toEqual(["hidden"]);
    feedW(CLICK("UIButton_1")); // a click on the help page isn't a shop click
    feedW(P("SystemHelp", "Destory"));
    await vi.advanceTimersByTimeAsync(900);
    expect(grabs).toEqual(["shown"]);
    feedW(P("GroceryStoreV3", "Destory"));
    expect(events.map((e) => e.kind)).toEqual(["hidden", "read", "closed"]);
  });

  it("tries once more when the cards aren't drawn yet", async () => {
    vi.useFakeTimers();
    const empty: OcrPage = { ...OFFER, lines: [] };
    const { events, grabs, feedW } = setup([empty, empty]);
    feedW(P("GroceryStoreV3", "Run"));
    await vi.advanceTimersByTimeAsync(1000 + 700);
    expect(grabs).toEqual(["open", "open"]);
    expect(events).toEqual([{ kind: "skipped", trigger: "open", reason: "no offers found on the captured frame" }]);
  });
});

describe("BlessingsFromGodsModule stone count", () => {
  // Real bag lines (2026-10-31): the login's snapshot, a Refresh, the stones moved to the warehouse.
  const BAG = (op: string, slot: number, id: number, n: number) => `[2026.10.31-13.54.21:115][322]TLLua: Display: [Game] BagMgr@:${op} PageId = 102 SlotId = ${slot} ConfigBaseId = ${id} Num = ${n}`;

  it("counts the Divinity Stones in the bag from the log", () => {
    const counts: number[] = [];
    const m = new BlessingsFromGodsModule({ prices: book({}), save: false, onEvent: (e) => e.kind === "stones" && counts.push(e.count) });
    expect(m.stones).toBeNull();
    feed(
      [
        BAG("InitBagData", 24, 5210, 780),
        BAG("InitBagData", 25, 100300, 4), // another item: no change
        BAG("Modfy BagItem", 24, 5210, 730), // a Refresh
        "[2026.10.31-12.44.59:176][542]TLLua: Display: [Game] BagMgr&WareHouseMgr@:AddWHItem PageId = 1 SlotId = 16 ConfigBaseId = 5210 Num = 780", // warehouse: not counted
        BAG("InitBagData", 30, 5210, 20), // a second stack
        "[2026.10.31-13.54.22:000][322]TLLua: Display: [Game] ItemChange@ Delete Id=5210_d54afd34-cd5f-11f1-b135-000000000083 in PageId=102 SlotId=24",
        BAG("Modfy BagItem", 30, 100300, 1), // the stack's slot now holds something else
      ],
      (l) => m.passiveLine(l),
    );
    expect(counts).toEqual([780, 730, 750, 20, 0]);
    expect(m.stones).toBe(0);
  });

  it("starts over at each new listing of the bag (another character), and counts 0 when it has none", () => {
    const at = (time: string, slot: number, id: number, n: number) => `[2026.10.31-${time}][322]TLLua: Display: [Game] BagMgr@:InitBagData PageId = 102 SlotId = ${slot} ConfigBaseId = ${id} Num = ${n}`;
    const m = new BlessingsFromGodsModule({ prices: book({}), save: false });
    // First character: stones in slots 24 and 30. A minute later, the second one: only slot 5.
    feed([at("12.44.44:026", 24, 5210, 780), at("12.44.44:027", 30, 5210, 20), at("12.45.44:000", 5, 5210, 25)], (l) => m.passiveLine(l));
    expect(m.stones).toBe(25);
    // A third character with no stones at all.
    feed([at("12.47.00:000", 1, 100300, 4)], (l) => m.passiveLine(l));
    expect(m.stones).toBe(0);
  });
});

describe("BlessingsFromGodsModule", () => {
  it("records price checks and tells when the shop opens and closes", () => {
    const prices = book({});
    const events: BlessingEvent[] = [];
    const m = new BlessingsFromGodsModule({ prices, save: false, onEvent: (e) => events.push(e) });
    feed(
      [
        "[2026.10.31-12.21.39:238][331]TLLua: Display: [Game] TipMsgShowMgr@DispatchPageRunChange PageName = GroceryStoreV3 , PageRunState = Run ",
        ...CHECK,
        "[2026.10.31-09.33.27:862][782]TLLua: Display: [Game] TipMsgShowMgr@DispatchPageRunChange PageName = GroceryStoreV3 , PageRunState = Destory ",
      ],
      (l) => m.onLine(l),
    );
    expect(events.map((e) => e.kind)).toEqual(["shopOpen", "price", "shopClosed"]);
    expect(m.shopOpen).toBe(false);
    expect(prices.get(5201)?.price).toBe(0.0021); // 4 different listings: the middle one
    expect(m.summary().prices.find((p) => p.itemId === 5201)?.fe).toBe(0.0021);
  });
});
