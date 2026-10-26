// Play dataset: every frame the tool grabs is kept, together with what was read from it, the
// advice shown and the pick made, so the readers and the advisor can be checked and improved later.
//
//   data/dataset/<YYYY-MM-DD>/frames/<time>_<screen>_<trigger>.jpg
//   data/dataset/<YYYY-MM-DD>/events.jsonl   one JSON object per line: { time, kind, ...data }
//
// Day folders older than KEEP_DAYS are deleted at start (prune), so it doesn't grow without end;
// the history files (data/history/) that the calibration uses are kept.

import { mkdirSync } from "node:fs";
import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export const KEEP_DAYS = 14;

export class Dataset {
  private writes: Promise<void> = Promise.resolve();

  /** `now` is for tests. */
  constructor(
    private readonly root: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Today's folder (UTC date, like the times inside), so a session past midnight rolls over. */
  get dir(): string {
    return join(this.root, this.now().toISOString().slice(0, 10));
  }

  async init(): Promise<void> {
    await mkdir(join(this.dir, "frames"), { recursive: true });
  }

  /** Deletes day folders older than `keepDays` (today counts as one). Returns the days removed. */
  async prune(keepDays = KEEP_DAYS): Promise<string[]> {
    const oldest = new Date(this.now().getTime() - (keepDays - 1) * 86_400_000).toISOString().slice(0, 10);
    const days = (await readdir(this.root).catch(() => [] as string[])).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < oldest);
    for (const d of days) await rm(join(this.root, d), { recursive: true, force: true });
    return days;
  }

  /** Path for a new frame, e.g. frames/2026-10-25T03-39-11-787_voidport_select.jpg (folder created). */
  framePath(screen: string, trigger: string): string {
    const now = this.now();
    const frames = join(this.root, now.toISOString().slice(0, 10), "frames");
    mkdirSync(frames, { recursive: true }); // the capture script can't create it
    return join(frames, `${now.toISOString().replace(/[:.]/g, "-").slice(0, 23)}_${screen}_${trigger}.jpg`);
  }

  record(kind: string, data: Record<string, unknown>): void {
    const now = this.now();
    const dir = join(this.root, now.toISOString().slice(0, 10));
    const line = JSON.stringify({ time: now.toISOString(), kind, ...data }) + "\n";
    // Catch per write: one failed write (file locked, disk full) must not block every later one.
    this.writes = this.writes
      .then(async () => {
        await mkdir(dir, { recursive: true });
        await appendFile(join(dir, "events.jsonl"), line);
      })
      .catch((err) => console.error(`dataset: ${err}`));
  }

  flush(): Promise<void> {
    return this.writes;
  }
}
