// Refits the shipped config (data/black-sail/advisor-config.json) on all the data at hand: the local
// play history plus the records players shared (data/collected/raw/, after `npm run pull`). This
// is the only way the shipped fit changes; the overlay only blends a player's copy with it.
//
//   npm run calibrate            -> print old vs new, write the shipped config
//   npm run calibrate -- --dry   -> print only
//   npm run calibrate -- --history <dir>
//   npm run calibrate -- --no-collected   (local history only)

import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_ADVISOR_CONFIG, loadAdvisorConfig } from "../modules/black-sail/advisor.js";
import { calibrate, impliedBase, memoryValue, type ChestLike, type FlameLike, type SalvageLike, type ScreenLike } from "../modules/black-sail/calibrate.js";
import { SALVAGE_FILE } from "../modules/black-sail/salvageTracker.js";
import { jsonl, writeConfig } from "../modules/black-sail/autoCalibrate.js";
import { MATERIALS } from "../modules/black-sail/modifiers.js";

const MIN_CHESTS = 10;
const COLLECTED = resolve(import.meta.dirname, "../../data/collected/raw");

/** The shared records pulled from the collector, by kind (none when not pulled). */
async function collected(): Promise<Map<string, unknown[]>> {
  const byKind = new Map<string, unknown[]>();
  const files = (await readdir(COLLECTED).catch(() => [] as string[])).filter((f) => f.endsWith(".jsonl"));
  for (const f of files) {
    // Pushed in place: copying the list per record would be quadratic (100k records: ~5e9 copies).
    for (const row of await jsonl<{ kind: string; data: unknown }>(join(COLLECTED, f))) {
      const list = byKind.get(row.kind);
      if (list) list.push(row.data);
      else byKind.set(row.kind, [row.data]);
    }
  }
  return byKind;
}

async function main() {
  const dry = process.argv.includes("--dry");
  const h = process.argv.indexOf("--history");
  const historyDir = h >= 0 ? resolve(process.argv[h + 1]!) : resolve(import.meta.dirname, "../../data/history");

  const cfg = await loadAdvisorConfig(DEFAULT_ADVISOR_CONFIG);
  const [chests, screens, flames, salvages] = await Promise.all([
    jsonl<ChestLike>(join(historyDir, "black-sail-chests.jsonl")),
    jsonl<ScreenLike>(join(historyDir, "black-sail-whispers.jsonl")),
    jsonl<FlameLike>(join(historyDir, "black-sail-flames.jsonl")),
    jsonl<SalvageLike>(join(historyDir, SALVAGE_FILE)),
  ]);
  const shared = process.argv.includes("--no-collected") ? new Map<string, unknown[]>() : await collected();
  const of = <T>(kind: string) => (shared.get(kind) ?? []) as T[];
  const all = {
    chests: [...chests, ...of<ChestLike>("chest")],
    screens: [...screens, ...of<ScreenLike>("picked")],
    flames: [...flames, ...of<FlameLike>("flameChosen")],
    salvages: [...salvages, ...of<SalvageLike>("salvage")],
  };
  const next = calibrate(cfg, all);

  console.log(`History: ${historyDir}${shared.size ? ` + ${of("chest").length} shared chests (data/collected/raw)` : ""}`);
  console.log(`  ${next.calibration!.chests} complete chests, ${next.calibration!.screens} screens, ${next.calibration!.flames} flames read\n`);
  console.log("Implied base per chest (what would make the model exact):");
  for (const c of all.chests.filter((x) => x.complete)) {
    const b = impliedBase(c, cfg);
    console.log(`  ${MATERIALS.filter((m) => b[m] !== undefined).map((m) => `${m} ${b[m]!.toFixed(1)}`).join("  ")}`);
  }
  console.log("\nBase amount (when the material appears):");
  for (const m of MATERIALS) console.log(`  ${m.padEnd(13)} ${String(cfg.baseAmount[m]).padStart(7)} -> ${next.baseAmount[m]}`);
  console.log(`\nDoubled screens: ${cfg.lookahead.doubledRate} -> ${next.lookahead.doubledRate}`);
  console.log("Flame guarantees (share of screens):");
  for (const g of next.lookahead.flames) console.log(`  ${g.group} ${g.minRarity}+  ${(g.p * 100).toFixed(1)}%`);
  const memory = memoryValue(all.salvages, cfg);
  const need = cfg.salvage?.minMemories ?? 0;
  console.log(`\nHero Memory salvage value: ${cfg.weights.heroMemories} -> ${next.weights.heroMemories} FE (${memory.memories} fresh memories salvaged${memory.memories < need ? `, need ${need} before it is used` : ""})`);
  for (const [id, n] of Object.entries(memory.perMemory)) console.log(`  ${n.toFixed(3)} x #${id} per memory @ ${cfg.salvage?.threadPrices[id] ?? "?"} FE`);
  if (next.calibration!.chests < MIN_CHESTS) console.log(`\nOnly ${next.calibration!.chests} chests: base amounts are rough until ~${MIN_CHESTS}.`);

  if (dry) return console.log("\n--dry: config not written.");
  await writeConfig(next, DEFAULT_ADVISOR_CONFIG);
  console.log(`\nWritten: ${DEFAULT_ADVISOR_CONFIG}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
