// Downloads the "that was wrong" reports players sent into data/reports/ (git ignores it: free
// text and pictures from anyone). One line per report in reports.jsonl, one .jpg/.png per frame.
//
//   npm run reports        (COLLECT_URL, COLLECT_TOKEN, like npm run pull)

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const DIR = resolve(import.meta.dirname, "../../data/reports");
const STATE = join(DIR, "state.json");

interface Report {
  id: number;
  time: string;
  screen: string;
  text: string;
  read: unknown;
  image: string | null;
  image_type: string | null;
  [k: string]: unknown;
}

async function main() {
  const url = (process.env.COLLECT_URL ?? "").replace(/\/+$/, "");
  const token = process.env.COLLECT_TOKEN ?? "";
  if (!url || !token) throw new Error("Set COLLECT_URL and COLLECT_TOKEN (the collector's EXPORT_TOKEN).");
  await mkdir(DIR, { recursive: true });
  const state = JSON.parse(await readFile(STATE, "utf8").catch(() => '{"last":0}')) as { last: number };
  let total = 0;
  for (;;) {
    const res = await fetch(`${url}/v1/reports?after=${state.last}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`The collector's report export failed: HTTP ${res.status}`);
    const { rows, last } = (await res.json()) as { rows: Report[]; last: number };
    if (!rows.length) break;
    for (const { image, ...r } of rows) {
      const file = image ? `report-${r.id}.${r.image_type === "png" ? "png" : "jpg"}` : null;
      if (file) await writeFile(join(DIR, file), Buffer.from(image!, "base64"));
      await appendFile(join(DIR, "reports.jsonl"), JSON.stringify({ ...r, file }) + "\n");
      console.log(`NEW REPORT #${r.id} ${r.screen}: ${r.text || "(no note)"}${file ? ` | ${file}` : ""}`);
    }
    state.last = last;
    await writeFile(STATE, JSON.stringify(state) + "\n");
    total += rows.length;
  }
  console.log(total ? `${total} new reports in data/reports/` : "No new reports.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
