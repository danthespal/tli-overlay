// Pulls what players shared from the collector (worker/) into data/collected/, then refits the
// advisor on everyone's history and writes a summary, for review:
//   data/collected/raw/<received date>.jsonl   every record, as the collector stored it
//   data/collected/state.json                  the last record id pulled
//   data/collected/advisor-config.json         the shipped config refitted on all players' data
//   data/collected/summary.md                  players, versions, screens, reader health, the refit
// The shipped config (data/black-sail/advisor-config.json) is never changed: copy the refit over
// once it looks right.
//
//   npm run pull              new records, then the refit     (COLLECT_URL, COLLECT_TOKEN)
//   npm run pull -- --refit   only the refit, on what is already pulled
//
// The repo's collect workflow runs it every 6 hours with the token from its secrets.

import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_ADVISOR_CONFIG, loadAdvisorConfig } from "../modules/black-sail/advisor.js";
import { calibrate, type ChestLike, type FlameLike, type SalvageLike, type ScreenLike } from "../modules/black-sail/calibrate.js";
import { MATERIALS } from "../modules/black-sail/modifiers.js";

const DIR = resolve(import.meta.dirname, "../../data/collected");
const RAW = join(DIR, "raw");
const STATE = join(DIR, "state.json");
const PAGE = 500;

interface Row {
  id: number;
  install: string;
  app: string;
  time: string;
  kind: string;
  data: Record<string, unknown>;
  received: string;
}

async function pull(): Promise<number> {
  const url = (process.env.COLLECT_URL ?? "").replace(/\/+$/, "");
  const token = process.env.COLLECT_TOKEN ?? "";
  if (!url || !token) throw new Error("Set COLLECT_URL and COLLECT_TOKEN (the collector's EXPORT_TOKEN).");
  await mkdir(RAW, { recursive: true });
  const state = JSON.parse(await readFile(STATE, "utf8").catch(() => '{"last":0}')) as { last: number };
  let total = 0;
  for (;;) {
    const res = await fetch(`${url}/v1/export?after=${state.last}&limit=${PAGE}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`The collector's export failed: HTTP ${res.status}`);
    const { rows, last } = (await res.json()) as { rows: Row[]; last: number };
    if (!rows.length) break;
    const byDay = new Map<string, string[]>();
    for (const r of rows) {
      const day = /^\d{4}-\d{2}-\d{2}$/.test(r.received) ? r.received : "unknown";
      byDay.set(day, [...(byDay.get(day) ?? []), JSON.stringify(r)]);
    }
    for (const [day, lines] of byDay) await appendFile(join(RAW, `${day}.jsonl`), lines.join("\n") + "\n");
    // Saved after every page: a pull that stops halfway keeps what it got.
    state.last = last;
    await writeFile(STATE, JSON.stringify(state) + "\n");
    total += rows.length;
    if (rows.length < PAGE) break;
  }
  return total;
}

async function allRows(): Promise<Row[]> {
  const files = (await readdir(RAW).catch(() => [] as string[])).filter((f) => f.endsWith(".jsonl")).sort();
  const rows: Row[] = [];
  for (const f of files) for (const l of (await readFile(join(RAW, f), "utf8")).split("\n")) if (l) rows.push(JSON.parse(l) as Row);
  return rows;
}

const count = <T>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};
const table = (rows: [string, number][]) => rows.map(([k, n]) => `| ${k} | ${n} |`).join("\n");

async function refit(rows: Row[]) {
  const of = (kind: string) => rows.filter((r) => r.kind === kind).map((r) => r.data);
  const history = {
    chests: of("chest") as unknown as ChestLike[],
    screens: of("picked") as unknown as ScreenLike[],
    flames: of("flameChosen") as unknown as FlameLike[],
    salvages: of("salvage") as unknown as SalvageLike[],
  };
  const cfg = await loadAdvisorConfig(DEFAULT_ADVISOR_CONFIG);
  // Dated by the newest record, not the clock: a pull with nothing new changes no file (no commit).
  const newest = rows.reduce((t, r) => (r.time > t ? r.time : t), "");
  const next = calibrate(cfg, history, newest ? new Date(newest) : new Date(0));
  await writeFile(join(DIR, "advisor-config.json"), JSON.stringify(next, null, 2) + "\n");

  // Reader health: cards read without a matching effect, and why frames weren't read.
  const cards = of("cards").flatMap((d) => (d.cards as { effect: string | null }[] | undefined) ?? []);
  const unmatched = cards.filter((c) => !c.effect).length;
  const flames = of("flameChosen") as { certain?: boolean }[];
  const sessions = rows.filter((r) => r.kind === "session");
  const captures = of("capture") as { width: number; height: number; via: string }[];

  const lines = [
    "# Collected Black Sail data",
    "",
    `${rows.length} records from ${new Set(rows.map((r) => r.install)).size} installs, ${sessions.length} sessions. Newest record: ${newest || "none"}.`,
    "",
    "## Records", "", "| kind | records |", "|---|---|", table(count(rows, (r) => r.kind)),
    "",
    "## App versions (sessions)", "", "| version | sessions |", "|---|---|", table(count(sessions, (r) => r.app)),
    "",
    "## Game screens", "", "| size, frames by | sessions |", "|---|---|", table(count(captures, (c) => `${c.width}x${c.height}, ${c.via}`)),
    "",
    "## How the log was found", "", "| found | sessions |", "|---|---|", table(count(sessions, (r) => String(r.data.log))),
    "",
    "## Reader health",
    "",
    `- Cards read: ${cards.length}, without a matching effect: ${unmatched} (${cards.length ? ((unmatched / cards.length) * 100).toFixed(1) : 0}%)`,
    `- Flames put in: ${flames.length}, uncertain: ${flames.filter((f) => !f.certain).length}`,
    "",
    "| frames not read, because | times |", "|---|---|", table(count(of("skipped"), (d) => String(d.reason).slice(0, 80))),
    "",
    "## Advisor refit on all players (data/collected/advisor-config.json)",
    "",
    `${next.calibration!.chests} complete chests, ${next.calibration!.screens} screens, ${next.calibration!.flames} flames, ${next.calibration!.salvaged ?? 0} memories salvaged.`,
    "",
    "| base amount | shipped | all players |", "|---|---|---|",
    ...MATERIALS.map((m) => `| ${m} | ${cfg.baseAmount[m]} | ${next.baseAmount[m]} |`),
    `| doubled screens | ${cfg.lookahead.doubledRate} | ${next.lookahead.doubledRate} |`,
    `| Hero Memory FE | ${cfg.weights.heroMemories} | ${next.weights.heroMemories} |`,
    "",
  ];
  await writeFile(join(DIR, "summary.md"), lines.join("\n"));
  console.log(`Refit on ${next.calibration!.chests} chests from ${new Set(rows.map((r) => r.install)).size} installs: data/collected/summary.md`);
}

async function main() {
  if (!process.argv.includes("--refit")) {
    const n = await pull();
    console.log(n ? `Pulled ${n} new records.` : "No new records.");
  }
  await mkdir(DIR, { recursive: true });
  await refit(await allRows());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
