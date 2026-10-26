// Recalibrates mechanics/black-sail/data/advisor-config.json from the play history.
//
//   npm run calibrate            -> read tool/data/history/, print old vs new, write the config
//   npm run calibrate -- --dry   -> print only
//   npm run calibrate -- --history <dir>

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ADVISOR_CONFIG, loadAdvisorConfig } from "../modules/black-sail/advisor.js";
import { calibrate, impliedBase, memoryValue, type ChestLike, type FlameLike, type SalvageLike, type ScreenLike } from "../modules/black-sail/calibrate.js";
import { SALVAGE_FILE } from "../modules/black-sail/salvageTracker.js";
import { writeConfig } from "../modules/black-sail/autoCalibrate.js";
import { MATERIALS } from "../modules/black-sail/modifiers.js";

const MIN_CHESTS = 10;

async function jsonl<T>(path: string): Promise<T[]> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

async function main() {
  const dry = process.argv.includes("--dry");
  const h = process.argv.indexOf("--history");
  const historyDir = h >= 0 ? resolve(process.argv[h + 1]!) : resolve(import.meta.dirname, "../../data/history");

  const cfg = await loadAdvisorConfig();
  const [chests, screens, flames, salvages] = await Promise.all([
    jsonl<ChestLike>(join(historyDir, "black-sail-chests.jsonl")),
    jsonl<ScreenLike>(join(historyDir, "black-sail-whispers.jsonl")),
    jsonl<FlameLike>(join(historyDir, "black-sail-flames.jsonl")),
    jsonl<SalvageLike>(join(historyDir, SALVAGE_FILE)),
  ]);
  const next = calibrate(cfg, { chests, screens, flames, salvages });

  console.log(`History: ${historyDir}`);
  console.log(`  ${next.calibration!.chests} complete chests, ${next.calibration!.screens} screens, ${next.calibration!.flames} flames read\n`);
  console.log("Implied base per chest (what would make the model exact):");
  for (const c of chests.filter((x) => x.complete)) {
    const b = impliedBase(c, cfg);
    console.log(`  ${MATERIALS.filter((m) => b[m] !== undefined).map((m) => `${m} ${b[m]!.toFixed(1)}`).join("  ")}`);
  }
  console.log("\nBase amount (when the material appears):");
  for (const m of MATERIALS) console.log(`  ${m.padEnd(13)} ${String(cfg.baseAmount[m]).padStart(7)} -> ${next.baseAmount[m]}`);
  console.log(`\nDoubled screens: ${cfg.lookahead.doubledRate} -> ${next.lookahead.doubledRate}`);
  console.log("Flame guarantees (share of screens):");
  for (const g of next.lookahead.flames) console.log(`  ${g.group} ${g.minRarity}+  ${(g.p * 100).toFixed(1)}%`);
  const memory = memoryValue(salvages, cfg);
  const need = cfg.salvage?.minMemories ?? 0;
  console.log(`\nHero Memory salvage value: ${cfg.weights.heroMemories} -> ${next.weights.heroMemories} FE (${memory.memories} fresh memories salvaged${memory.memories < need ? `, need ${need} before it is used` : ""})`);
  for (const [id, n] of Object.entries(memory.perMemory)) console.log(`  ${n.toFixed(3)} x #${id} per memory @ ${cfg.salvage?.threadPrices[id] ?? "?"} FE`);
  if (next.calibration!.chests < MIN_CHESTS) console.log(`\nOnly ${next.calibration!.chests} chests: base amounts are rough until ~${MIN_CHESTS}.`);

  if (dry) return console.log("\n--dry: config not written.");
  await writeConfig(next);
  console.log(`\nWritten: ${ADVISOR_CONFIG}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
