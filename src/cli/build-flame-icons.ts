// Builds the flame icon references (mechanics/black-sail/data/flame-icons.json) from the labelled
// anchor screenshots (samples/screens/anchor/labels.json), and reports a leave-one-out check:
// each screenshot is classified using only the OTHER screenshots' samples.
//
//   npm run build-flame-icons

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { classifyIcon, FLAME_ICONS, FLAME_REGIONS, type IconKind, type IconRef } from "../modules/black-sail/flameReader.js";
import { ocrImages } from "../ocr/windowsOcr.js";

const SAMPLES = resolve(import.meta.dirname, "../../../mechanics/black-sail/samples/screens/anchor");

async function main() {
  const labels = JSON.parse(await readFile(join(SAMPLES, "labels.json"), "utf8")) as Record<string, Record<string, IconKind> | string>;
  const files = Object.keys(labels).filter((f) => !f.startsWith("_"));
  const pages = await ocrImages(files.map((f) => join(SAMPLES, f)), FLAME_REGIONS);

  const refs: IconRef[] = [];
  pages.forEach((page, i) => {
    const file = files[i]!;
    for (const [slot, kind] of Object.entries(labels[file] as Record<string, IconKind>)) {
      const region = page.regions[+slot]!;
      refs.push({ kind, gray: region.gray, color: region.color, source: `${file}#${slot}` });
    }
  });

  let right = 0;
  let worst = 0;
  for (const ref of refs) {
    const file = ref.source.split("#")[0]!;
    const got = classifyIcon(ref, refs.filter((r) => !r.source.startsWith(file)));
    if (got?.kind === ref.kind) {
      right++;
      worst = Math.max(worst, got.distance);
    } else console.log(`  WRONG ${ref.source}: ${ref.kind} read as ${got?.kind} (${got?.distance.toFixed(3)})`);
  }
  console.log(`Leave-one-out: ${right}/${refs.length} slots correct, worst correct distance ${worst.toFixed(3)}`);

  await writeFile(FLAME_ICONS, JSON.stringify(refs));
  console.log(`Wrote ${refs.length} icon samples to ${FLAME_ICONS}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
