// Reads the Blessings from Gods shop from screenshots and values each offer with the saved prices
// (data/prices.json, from the player's Trade House price checks).
//
//   npm run read-shop                          -> the saved samples
//   npm run read-shop -- <image> [image...]    -> any screenshots
//   npm run read-shop -- --farmed --margin 10  -> stones you farmed (priced after tax), 10% margin
//   npm run read-shop -- --log <UE_game.log>   -> also take the price checks in that log first

import { readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { readLogLines } from "../engine/logReader.js";
import { PriceBook, PriceCheckParser } from "../engine/prices.js";
import { valueOffer, type ValueOptions } from "../modules/blessings-from-gods/calc.js";
import { DEFAULT_PROFIT_MARGIN, DIVINITY_STONE } from "../modules/blessings-from-gods/items.js";
import { ShopPrices } from "../modules/blessings-from-gods/shopPrices.js";
import { readShopPage, type ShopRead } from "../modules/blessings-from-gods/shopReader.js";
import { TesseractOcr } from "../ocr/tesseractOcr.js";

const SAMPLES = resolve(import.meta.dirname, "../../../mechanics/blessings-from-gods/samples/screens");

const fmt = (n: number | null, digits = 3) => (n === null ? "-" : n.toLocaleString("en", { maximumFractionDigits: digits }));

export function formatShop(read: ShopRead, prices: PriceBook, opts: ValueOptions): string[] {
  return read.offers.map((o) => {
    const v = valueOffer(o.item, o.quantity, o.stones, new ShopPrices(prices, {}), opts);
    const name = o.item ? `${o.item.name} x${o.quantity}` : `? "${o.text}"`;
    const verdict = v.verdict !== "unknown" ? v.verdict.toUpperCase() : o.item?.itemId == null ? "no item id" : v.value === null ? "no price" : "stones not read";
    return `  r${o.row + 1}c${o.col + 1} ${name.padEnd(38)} ${String(o.stones ?? "?").padStart(4)} stones  worth ${fmt(v.value).padStart(7)} FE  max ${String(v.maxStones ?? "-").padStart(5)}  ${verdict}${v.profit === null ? "" : ` (${v.profit >= 0 ? "+" : ""}${fmt(v.profit)} FE)`}`;
  });
}

async function main() {
  const args = process.argv.slice(2);
  const take = (flag: string) => {
    const i = args.indexOf(flag);
    return i < 0 ? undefined : args.splice(i, 2)[1];
  };
  const farmed = args.includes("--farmed");
  if (farmed) args.splice(args.indexOf("--farmed"), 1);
  const opts: ValueOptions = { source: farmed ? "farmed" : "bought", marginPercent: +(take("--margin") ?? DEFAULT_PROFIT_MARGIN) };
  const log = take("--log");

  const prices = new PriceBook();
  await prices.load();
  if (log) {
    const parser = new PriceCheckParser();
    let n = 0;
    for await (const line of readLogLines(resolve(log))) {
      const c = parser.line(line);
      if (c && prices.add(c)) n++;
    }
    console.log(`${n} price checks taken from ${basename(log)} (not saved)`);
  }
  const stone = prices.get(DIVINITY_STONE);
  console.log(stone ? `Divinity Stone: ${fmt(stone.price, 4)} FE (${new Date(stone.time).toISOString().slice(0, 16)})` : "Divinity Stone: no price yet (price-check it in the Trade House)");

  let paths = args;
  if (!paths.length) paths = (await readdir(SAMPLES)).filter((f) => /\.(jpe?g|png)$/i.test(f)).map((f) => join(SAMPLES, f));
  const ocr = new TesseractOcr();
  const t0 = Date.now();
  const pages = await ocr.ocrImages(paths, [], "shop");
  await ocr.stop();
  console.log(`OCR of ${pages.length} image(s) in ${Date.now() - t0} ms\n`);
  for (const page of pages) {
    console.log(basename(page.file));
    console.log(formatShop(readShopPage(page), prices, opts).join("\n"));
  }
}

if (process.argv[1]?.endsWith("read-shop.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
