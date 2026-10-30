import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Settings } from "../src/settings.js";
import { Sharer } from "../src/share/sharer.js";

let dir: string;
let calls: { url: string; body: any }[];
let answer: number | "offline";

const fakeFetch = (async (url: string, init: RequestInit) => {
  calls.push({ url, body: JSON.parse(String(init.body)) });
  if (answer === "offline") throw new Error("offline");
  return new Response(JSON.stringify({ deleted: 7 }), { status: answer });
}) as unknown as typeof fetch;

function sharer(settings: Settings = {}, endpoint = "http://collector") {
  return new Sharer({ dir, endpoint, app: "0.1.0", settings, saveSettings: async () => {}, delayMs: 60_000, fetch: fakeFetch });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tli-share-"));
  calls = [];
  answer = 200;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("Sharer", () => {
  it("asks first, and sends nothing until the player says yes", async () => {
    const s = sharer();
    expect(s.asking).toBe(true);
    s.add("chest", { cycle: 1 });
    await s.flush();
    expect(calls).toHaveLength(0);
    await s.setShare(true);
    expect(s.asking).toBe(false);
    s.add("chest", { cycle: 2 });
    await s.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.records.map((r: any) => r.data.cycle)).toEqual([2]);
  });

  it("never asks or sends without a collector address (development builds)", async () => {
    const s = sharer({ share: true }, "");
    expect(s.asking).toBe(false);
    expect(s.on).toBe(false);
    s.add("chest", { cycle: 1 });
    await s.flush();
    expect(calls).toHaveLength(0);
  });

  it("sends the same install id every time, and batches of at most 50", async () => {
    const settings: Settings = { share: true };
    const s = sharer(settings);
    for (let i = 0; i < 120; i++) s.add("picked", { pick: i });
    await s.flush();
    expect(calls.map((c) => c.body.records.length)).toEqual([50, 50, 20]);
    const installs = new Set(calls.flatMap((c) => c.body.records.map((r: any) => r.install)));
    expect([...installs]).toEqual([settings.install]);
    expect(s.pending).toBe(0);
  });

  it("keeps the records when offline or the collector is busy, drops a refused batch", async () => {
    const s = sharer({ share: true });
    s.add("chest", { cycle: 1 });
    answer = "offline";
    await s.flush();
    answer = 503;
    await s.flush();
    expect(s.pending).toBe(1);
    answer = 400;
    await s.flush();
    expect(s.pending).toBe(0);
    // Refused records are not listed as shared.
    expect(await readFile(join(dir, "shared.jsonl"), "utf8").catch(() => "")).toBe("");
  });

  it("waits out the retry delay when offline, even once a full batch is queued", async () => {
    const s = sharer({ share: true });
    answer = "offline";
    s.add("chest", { cycle: 0 });
    await s.flush();
    expect(calls).toHaveLength(1);
    for (let i = 1; i <= 60; i++) s.add("picked", { pick: i });
    await new Promise((r) => setTimeout(r, 20)); // an immediate upload would have run by now
    expect(calls).toHaveLength(1);
    expect(s.pending).toBe(61);
    await s.setShare(false); // clears the retry timer
  });

  it("drops what is still queued when the player deletes their shared data", async () => {
    const s = sharer({ share: true });
    answer = "offline";
    s.add("chest", { cycle: 1 });
    await s.flush(); // not sent: queued
    answer = 200;
    expect(await s.forget()).toBe("Deleted 7 shared records and reports");
    expect(s.pending).toBe(0);
    await s.flush();
    expect(calls.map((c) => c.url)).toEqual(["http://collector/v1/records", "http://collector/v1/forget"]);
    await new Promise((r) => setTimeout(r, 50)); // queue file rewritten
    expect(await readFile(join(dir, "share-queue.jsonl"), "utf8")).toBe("");
    await s.setShare(false); // clears the retry timer
  });

  it("saves the install id as soon as it is made", async () => {
    const saved: Settings[] = [];
    const settings: Settings = { share: true };
    const s = new Sharer({ dir, endpoint: "http://collector", app: "0.1.0", settings, saveSettings: async (x) => void saved.push({ ...x }), fetch: fakeFetch });
    s.add("chest", { cycle: 1 });
    expect(saved.at(-1)?.install).toMatch(/^[0-9a-f]{24}$/);
    s.add("chest", { cycle: 2 });
    expect(saved).toHaveLength(1);
  });

  it("keeps the queue across restarts", async () => {
    const settings: Settings = { share: true };
    const a = sharer(settings);
    answer = "offline";
    a.add("chest", { cycle: 9 });
    await a.flush();
    await new Promise((r) => setTimeout(r, 50)); // queue file written
    const b = sharer(settings);
    await b.load();
    expect(b.pending).toBe(1);
    answer = 200;
    await b.flush();
    expect(calls.at(-1)!.body.records[0].data).toEqual({ cycle: 9 });
  });

  it("keeps the rest of the queue when a line was cut off by a crash", async () => {
    const settings: Settings = { share: true };
    const a = sharer(settings);
    answer = "offline";
    a.add("chest", { cycle: 1 });
    a.add("chest", { cycle: 2 });
    await a.flush();
    await new Promise((r) => setTimeout(r, 50));
    const { appendFile } = await import("node:fs/promises");
    await appendFile(join(dir, "share-queue.jsonl"), '{"uid":"abc","install":'); // cut-off last line
    const b = sharer(settings);
    await b.load();
    expect(b.pending).toBe(2);
  });

  it("turning sharing off drops what is still queued", async () => {
    const s = sharer({ share: true });
    s.add("chest", { cycle: 1 });
    await s.setShare(false);
    await s.flush();
    expect(calls).toHaveLength(0);
    expect(s.pending).toBe(0);
  });

  it("lists what was shared, and forgets it on request", async () => {
    const s = sharer({ share: true });
    s.add("chest", { cycle: 1 });
    await s.flush();
    const out = join(dir, "export.json");
    expect(await s.exportShared(out)).toBe(1);
    expect(JSON.parse(await readFile(out, "utf8")).records[0].data).toEqual({ cycle: 1 });
    expect(await s.forget()).toBe("Deleted 7 shared records and reports");
    expect(calls.at(-1)!.url).toBe("http://collector/v1/forget");
    expect(await s.exportShared(out)).toBe(0);
  });
});
