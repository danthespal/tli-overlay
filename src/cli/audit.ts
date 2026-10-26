// Log audit: reads one or more UE_game logs and reports what the engine sees.
//
//   npm run audit                      -> all UE_game*.log files in LOG_DIR
//   npm run audit -- <file|dir> ...    -> specific files / folders
//
// Writes reports/audit-<time>.json (everything) and .md (readable summary).

import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { KNOWN_ITEMS, LOG_DIR } from "../config.js";
import { Engine } from "../engine/engine.js";
import { extractEvent } from "../engine/events.js";
import { readLogLines } from "../engine/logReader.js";
import type { ZoneVisit } from "../engine/session.js";
import { BlackSailModule } from "../modules/black-sail/index.js";

const ID_LINE = /^\|?[\s|]*\+(?:CurrentOpenMapItemAffix\+\d+\+)?Id \[(\d+)\]/;
const DESC_LINE = /^\|?[\s|]*\+Description \[(.*)\]$/;

async function resolveInputs(args: string[]): Promise<string[]> {
  const inputs = args.length ? args : [LOG_DIR];
  const files: string[] = [];
  for (const input of inputs) {
    if ((await stat(input)).isDirectory()) {
      const names = (await readdir(input)).filter((n) => /^UE_game.*\.log$/.test(n)).sort();
      files.push(...names.map((n) => join(input, n)));
    } else files.push(input);
  }
  return files;
}

const inc = <K>(m: Map<K, number>, k: K, by = 1) => m.set(k, (m.get(k) ?? 0) + by);
const top = <K>(m: Map<K, number>, n = Infinity) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
const itemName = (id: number) => KNOWN_ITEMS[id] ?? `#${id}`;

async function auditFile(path: string) {
  const t0 = Date.now();
  const blackSail = new BlackSailModule();
  const zones: ZoneVisit[] = [];
  const engine = new Engine([blackSail], (z) => zones.push(z));

  let lines = 0;
  let headed = 0;
  let firstTime: number | undefined;
  let lastTime: number | undefined;
  const categories = new Map<string, number>();
  const eventTypes = new Map<string, number>();
  const itemProtos = new Map<string, number>();
  const modifierCounts = new Map<number, number>();
  const descriptions = new Map<number, string>();
  let pendingId: number | undefined;

  for await (const line of readLogLines(path)) {
    lines++;
    engine.feed(line);

    if (line.time !== undefined) {
      headed++;
      firstTime ??= line.time;
      lastTime = line.time;
      inc(categories, line.category!);
    } else {
      // Affix dumps: "+Id [296208]" followed a few lines later by "+Description [...]".
      const id = ID_LINE.exec(line.raw);
      if (id) pendingId = +id[1]!;
      else if (pendingId !== undefined) {
        const d = DESC_LINE.exec(line.raw);
        if (d) {
          if (!descriptions.has(pendingId)) descriptions.set(pendingId, d[1]!);
          pendingId = undefined;
        }
      }
    }

    const e = extractEvent(line);
    if (e) {
      inc(eventTypes, e.type);
      if (e.type === "itemBlockStart") inc(itemProtos, e.proto);
      if (e.type === "mapModifier") inc(modifierCounts, e.id);
    }
  }
  engine.finish();

  const zoneNames = new Map<string, number>();
  const loot = new Map<number, number>();
  let uncertain = 0;
  for (const z of zones) {
    inc(zoneNames, z.name);
    for (const [id, n] of z.loot) inc(loot, id, n);
    uncertain += z.uncertainPickups;
  }

  return {
    file: path,
    readSeconds: (Date.now() - t0) / 1000,
    lines,
    headedLines: headed,
    from: firstTime && new Date(firstTime).toISOString(),
    to: lastTime && new Date(lastTime).toISOString(),
    categories: top(categories, 25),
    eventTypes: top(eventTypes),
    itemProtos: top(itemProtos),
    zones: { visits: zones.length, byName: top(zoneNames) },
    modifiers: top(modifierCounts).map(([id, count]) => ({ id, count, description: descriptions.get(id) })),
    loot: { uncertainPickups: uncertain, byItem: top(loot).map(([id, n]) => ({ id, name: itemName(id), n })) },
    modules: { [blackSail.id]: blackSail.summary() },
  };
}

type FileReport = Awaited<ReturnType<typeof auditFile>>;

function toMarkdown(reports: FileReport[]): string {
  const out: string[] = ["# Log audit", ""];
  for (const r of reports) {
    const bs = r.modules["black-sail"];
    out.push(
      `## ${basename(r.file)}`,
      "",
      `- ${r.lines.toLocaleString()} lines (${r.headedLines.toLocaleString()} with header), read in ${r.readSeconds}s`,
      `- Time: ${r.from} → ${r.to}`,
      `- Zone visits: ${r.zones.visits}; uncertain pickups: ${r.loot.uncertainPickups}`,
      "",
      "**Events:** " + r.eventTypes.map(([t, n]) => `${t} ${n}`).join(", "),
      "",
      "**Item batches:** " + r.itemProtos.map(([t, n]) => `${t} ${n}`).join(", "),
      "",
      "**Top zones:** " + r.zones.byName.slice(0, 10).map(([z, n]) => `${z} ×${n}`).join(", "),
      "",
      "**Top map modifiers**",
      "",
      "| id | count | description |",
      "|---|---|---|",
      ...r.modifiers.slice(0, 25).map((m) => `| ${m.id} | ${m.count} | ${m.description ?? ""} |`),
      "",
      "**Top loot (all zones)**",
      "",
      ...r.loot.byItem.slice(0, 15).map((i) => `- ${i.name}: ${i.n}`),
      "",
      "### Black Sail",
      "",
      `- Anchor maps: ${bs.anchorMaps.maps} (avg ${bs.anchorMaps.avgSeconds}s); other maps: ${bs.otherMaps.maps} (avg ${bs.otherMaps.avgSeconds}s)`,
      `- Anchor screens (VoidBeacon): ${bs.screens.anchor.opened}, avg ${bs.screens.anchor.avgSecondsOpen}s open`,
      `- Seal screens (VoidPort): ${bs.screens.seal.opened}, avg ${bs.screens.seal.avgSecondsOpen}s open; Whisper rarity picks: ${JSON.stringify(bs.screens.sealRarityPicks)}`,
      ...bs.anchorMapList.map(
        (m) =>
          `  - ${m.name} at line ${m.startLine}: ${m.seconds}s, ${m.items} items, ` +
          `${m.anchorScreens} anchor / ${m.sealScreens} seal screens, picks [${m.sealPicks.join(",")}]`,
      ),
      "",
      "**Signal line shapes**",
      "",
      ...bs.signalShapes.slice(0, 30).map((s) => `- ×${s.count} \`${s.shape.replace(/`/g, "'")}\``),
      "",
    );
  }
  return out.join("\n");
}

async function main() {
  const files = await resolveInputs(process.argv.slice(2));
  if (!files.length) throw new Error("No UE_game*.log files found");

  const reports: FileReport[] = [];
  for (const f of files) {
    console.error(`Auditing ${f} ...`);
    reports.push(await auditFile(f));
  }

  const dir = join(import.meta.dirname, "../../reports");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const md = toMarkdown(reports);
  await writeFile(join(dir, `audit-${stamp}.json`), JSON.stringify(reports, null, 2));
  await writeFile(join(dir, `audit-${stamp}.md`), md);
  console.log(md);
  console.error(`Reports written to ${dir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
