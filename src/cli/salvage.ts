// Backfills data/history/black-sail-salvage.jsonl from old game logs. The overlay does this by
// itself at start-up; this command is for development.
//
//   npm run backfill-salvage                 -> every UE_game*.log in the game's Logs folder
//   npm run backfill-salvage -- a.log b.log  -> these logs
// Batches already in the file (same log time) are skipped, so it can be run again any time.

import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LOG_DIR } from "../config.js";
import { backfillSalvage } from "../modules/black-sail/salvageTracker.js";

async function main() {
  const args = process.argv.slice(2);
  const logs = args.length ? args.map((a) => resolve(a)) : (await readdir(LOG_DIR)).filter((f) => /^UE_game.*\.log$/.test(f)).sort().map((f) => join(LOG_DIR, f));
  const historyDir = resolve(import.meta.dirname, "../../data/history");
  const r = await backfillSalvage(logs.map((path) => ({ path })), historyDir);
  console.log(`${r.found} salvage batches in ${logs.length} log(s); ${r.added} added (${r.memories} memories) -> ${join(historyDir, "black-sail-salvage.jsonl")}`);
  if (r.added) console.log("Run `npm run calibrate` to update the Hero Memory value.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
