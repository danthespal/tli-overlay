// Sends what the overlay records to the collector (worker/), only after the player said yes.
// Records wait in data/share-queue.jsonl and go up in batches, so nothing is lost offline or when
// the overlay quits; a failed upload is retried later, ever more slowly. What was sent is kept
// (the last KEEP_SENT records) in data/shared.jsonl, so the player can see it.

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Settings } from "../settings.js";
import { cleanRecord, MAX_RECORDS, randomId, type Kind, type ShareRecord } from "./schema.js";

const QUEUE_MAX = 5000; // offline for days: the oldest go first
const KEEP_SENT = 1000;
const RETRY_MIN = 5_000;
const RETRY_MAX = 300_000;

export interface SharerOptions {
  /** data/ folder for the queue and the sent records. */
  dir: string;
  /** Collector address; empty = sharing isn't available (nothing is asked or sent). */
  endpoint: string;
  app: string;
  settings: Settings;
  saveSettings: (s: Settings) => Promise<void>;
  /** Wait this long after a record before uploading, unless a batch fills (default 20 s). */
  delayMs?: number;
  fetch?: typeof fetch;
  onLog?: (message: string) => void;
}

export class Sharer {
  private queue: ShareRecord[] = [];
  private timer: NodeJS.Timeout | undefined;
  private busy: Promise<void> | null = null;
  private retry = RETRY_MIN;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly o: SharerOptions) {}

  private get queueFile() {
    return join(this.o.dir, "share-queue.jsonl");
  }
  private get sentFile() {
    return join(this.o.dir, "shared.jsonl");
  }
  private log(m: string) {
    this.o.onLog?.(m);
  }

  get available(): boolean {
    return !!this.o.endpoint;
  }
  /** The player hasn't answered yet. */
  get asking(): boolean {
    return this.available && (this.o.settings.share ?? null) === null;
  }
  get on(): boolean {
    return this.available && this.o.settings.share === true;
  }
  get pending(): number {
    return this.queue.length;
  }
  /** Made once and saved at once, so every record and "delete my data" use the same id. */
  private get install(): string {
    if (!this.o.settings.install) {
      this.o.settings.install = randomId();
      void this.o.saveSettings(this.o.settings).catch((err) => this.log(`settings: ${err}`));
    }
    return this.o.settings.install;
  }

  async load(): Promise<void> {
    try {
      const lines = (await readFile(this.queueFile, "utf8")).split("\n").filter(Boolean);
      this.queue = lines.map((l) => cleanRecord(JSON.parse(l))).filter((r) => r !== null);
    } catch {
      this.queue = [];
    }
    if (this.on && this.queue.length) this.schedule(this.o.delayMs ?? 20_000);
  }

  async setShare(on: boolean): Promise<void> {
    this.o.settings.share = on;
    void this.install; // made once, kept even when sharing is off (for "delete my data")
    await this.o.saveSettings(this.o.settings);
    if (!on) {
      clearTimeout(this.timer);
      this.queue = [];
      await this.rewriteQueue();
    }
    this.log(`sharing ${on ? "on" : "off"}`);
  }

  /** Queues one record (a dataset line) when sharing is on. */
  add(kind: Kind, data: Record<string, unknown>, now = new Date()): void {
    if (!this.on) return;
    const record = cleanRecord({ uid: randomId(), install: this.install, app: this.o.app, time: now.toISOString(), kind, data }, now.getTime());
    if (!record) return; // too large or odd: the collector would reject it
    this.queue.push(record);
    if (this.queue.length > QUEUE_MAX) {
      this.queue.splice(0, this.queue.length - QUEUE_MAX);
      void this.rewriteQueue();
    } else {
      this.writes = this.writes.then(() => this.append(this.queueFile, [record])).catch((err) => this.log(`queue: ${err}`));
    }
    if (this.queue.length >= MAX_RECORDS) this.schedule(0);
    else this.schedule(this.o.delayMs ?? 20_000);
  }

  private schedule(ms: number) {
    if (this.timer && ms > 0) return; // one is already set
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, ms);
  }

  /** Uploads what is queued, a batch at a time. */
  flush(): Promise<void> {
    if (!this.busy) this.busy = this.upload().finally(() => (this.busy = null));
    return this.busy;
  }

  private async upload(): Promise<void> {
    while (this.on && this.queue.length) {
      const batch = this.queue.slice(0, MAX_RECORDS);
      let status = 0;
      try {
        const res = await (this.o.fetch ?? fetch)(`${this.o.endpoint}/v1/records`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ records: batch }),
        });
        status = res.status;
      } catch (err) {
        this.log(`upload failed: ${err}`);
      }
      if (status === 0 || status === 429 || status >= 500) {
        // Offline, limit reached or collector down: try again later.
        this.schedule(this.retry);
        this.retry = Math.min(RETRY_MAX, this.retry * 2);
        return;
      }
      this.retry = RETRY_MIN;
      const done = new Set(batch.map((r) => r.uid));
      this.queue = this.queue.filter((r) => !done.has(r.uid));
      await this.rewriteQueue();
      // A 4xx batch would be rejected again: dropped, not kept as sent.
      if (status < 300) await this.keepSent(batch);
      else this.log(`collector refused ${batch.length} records (HTTP ${status})`);
    }
  }

  private async append(file: string, records: ShareRecord[]) {
    await mkdir(this.o.dir, { recursive: true });
    await appendFile(file, records.map((r) => JSON.stringify(r) + "\n").join(""));
  }

  private rewriteQueue(): Promise<void> {
    const lines = this.queue.map((r) => JSON.stringify(r) + "\n").join("");
    this.writes = this.writes
      .then(async () => {
        await mkdir(this.o.dir, { recursive: true });
        await writeFile(`${this.queueFile}.tmp`, lines);
        await rename(`${this.queueFile}.tmp`, this.queueFile);
      })
      .catch((err) => this.log(`queue: ${err}`));
    return this.writes;
  }

  private async keepSent(records: ShareRecord[]) {
    const old = await readFile(this.sentFile, "utf8").catch(() => "");
    const lines = (old + records.map((r) => JSON.stringify(r) + "\n").join("")).split("\n").filter(Boolean).slice(-KEEP_SENT);
    await writeFile(this.sentFile, lines.join("\n") + "\n");
  }

  /** Writes what this install shared (the last KEEP_SENT records) to a JSON file the player can open. */
  async exportShared(file: string): Promise<number> {
    const lines = (await readFile(this.sentFile, "utf8").catch(() => "")).split("\n").filter(Boolean);
    const records = lines.map((l) => JSON.parse(l) as ShareRecord);
    await writeFile(file, JSON.stringify({ about: "What this TLI Overlay shared with its collector (the latest records).", install: this.install, records }, null, 2));
    return records.length;
  }

  /** Deletes everything this install shared, on the collector and here. */
  async forget(): Promise<string> {
    try {
      const res = await (this.o.fetch ?? fetch)(`${this.o.endpoint}/v1/forget`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ install: this.install }),
      });
      if (!res.ok) return `Couldn't delete (HTTP ${res.status}), try again later`;
      const { deleted } = (await res.json()) as { deleted: number };
      await writeFile(this.sentFile, "");
      return `Deleted ${deleted} shared records and reports`;
    } catch {
      return "Couldn't reach the collector, try again later";
    }
  }

  /** Sends one "that was wrong" report at once. Returns null when sent, else what went wrong. */
  async report(r: { screen: string; text: string; read: Record<string, unknown> | null; image: Buffer | null }): Promise<string | null> {
    if (!this.available) return "Reports aren't available in this build";
    const report = { uid: randomId(), install: this.install, app: this.o.app, time: new Date().toISOString(), screen: r.screen, text: r.text, read: r.read };
    try {
      const res = await (this.o.fetch ?? fetch)(`${this.o.endpoint}/v1/reports`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ report, image: r.image ? r.image.toString("base64") : null }),
      });
      if (res.ok) return null;
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return body.error ?? `HTTP ${res.status}`;
    } catch {
      return "Couldn't reach the collector, try again later";
    }
  }
}
