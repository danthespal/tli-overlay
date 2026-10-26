// Reads the anchor (flame) screen from screenshots: icons on the ring + the selected flame's text.
//
//   npm run read-flames                        -> the saved samples
//   npm run read-flames -- <image> [image...]  -> any screenshots

import { readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { FLAME_REGIONS, loadFlameEffects, loadIconRefs, readFlamePage, type FlameRead } from "../modules/black-sail/flameReader.js";
import { ocrImages } from "../ocr/windowsOcr.js";

const SAMPLES = resolve(import.meta.dirname, "../../../mechanics/black-sail/samples/screens/anchor");

export function formatFlames(read: FlameRead): string[] {
  const out = read.slots.map((s) => `  slot ${s.index}: ${s.kind.padEnd(13)} (d=${s.distance.toFixed(2)})`);
  const sel = read.selected;
  out.push(
    sel
      ? `  selected: ${sel.effect.id} [${sel.effect.kind}] slot ${sel.slot ?? "?"}, numbers ${JSON.stringify(sel.numbers)}` +
          `\n            "${sel.effect.text}" (text ${(sel.textScore * 100).toFixed(0)}%)`
      : `  selected: ? "${read.selectedText}"`,
  );
  return out;
}

async function main() {
  let paths = process.argv.slice(2);
  if (!paths.length) paths = (await readdir(SAMPLES)).filter((f) => /\.(jpe?g|png)$/i.test(f)).map((f) => join(SAMPLES, f));
  const t0 = Date.now();
  const [refs, effects, pages] = await Promise.all([loadIconRefs(), loadFlameEffects(), ocrImages(paths, FLAME_REGIONS)]);
  console.log(`OCR of ${pages.length} image(s) in ${Date.now() - t0} ms\n`);
  for (const page of pages) {
    console.log(basename(page.file));
    console.log(formatFlames(readFlamePage(page, refs, effects)).join("\n"));
  }
}

if (process.argv[1]?.endsWith("read-flames.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
