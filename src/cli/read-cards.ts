// Reads Seal Whisper cards from screenshots and prints what the OCR + matcher found.
//
//   npm run read-cards                        -> the saved samples
//   npm run read-cards -- <image> [image...]  -> any screenshots

import { readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { ocrImages } from "../ocr/windowsOcr.js";
import { loadEffectTable } from "../modules/black-sail/effects.js";
import { readSealWhisperPage } from "../modules/black-sail/sealWhisperReader.js";

const SAMPLES = resolve(import.meta.dirname, "../../../mechanics/black-sail/samples/screens/seal-whisper");

async function main() {
  let paths = process.argv.slice(2);
  if (!paths.length) paths = (await readdir(SAMPLES)).filter((f) => /\.(jpe?g|png)$/i.test(f)).map((f) => join(SAMPLES, f));

  const t0 = Date.now();
  const [table, pages] = await Promise.all([loadEffectTable(), ocrImages(paths)]);
  console.log(`OCR of ${pages.length} image(s) in ${Date.now() - t0} ms, ${table.length} known effects\n`);

  for (const page of pages) {
    const read = readSealWhisperPage(page, table);
    console.log(`${basename(page.file)}  [view: ${read.view}]`);
    for (const c of read.cards) {
      const m = c.match;
      const what = m
        ? `${m.entry.rarity} ${m.entry.group}: ${c.doubled ? m.entry.doubledText : m.entry.text}` +
          ` (text ${(m.textScore * 100).toFixed(0)}%, numbers ${m.numbersMatch ? "ok" : "partial"}, ${m.entry.source})`
        : "NO MATCH";
      console.log(`  ${c.slot.padEnd(6)} ${String(c.type ?? "?").padEnd(12)} ${c.doubled ? "x2" : "  "}  ${what}`);
      console.log(`         ocr: "${c.effectText}"`);
    }
    console.log();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
