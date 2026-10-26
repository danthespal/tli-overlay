import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Dataset } from "../src/capture/dataset.js";
import { Engine } from "../src/engine/engine.js";
import { extractEvent } from "../src/engine/events.js";
import { parseLogLine } from "../src/engine/logLine.js";
import { LogTailer, MAX_READ } from "../src/engine/logReader.js";
import type { ZoneVisit } from "../src/engine/session.js";
import { BlackSailModule } from "../src/modules/black-sail/index.js";

// Lines copied from a real UE_game.log (SS14).
const L = {
  modifier: "[2026.10.24-20.12.23:852][213]TLGame: Display: [Game] UCLevelSingleton::AddMapModifier(296208) success 22 ",
  enterMap:
    "[2026.10.24-20.12.24:544][311]TLLua: Display: [Game] SceneLevelMgr@ OpenMainWorld END! InMainLevelPath = /Game/Art/Maps/01SD/SD_GeBuLinShanZhai/SD_GeBuLinShanZhai",
  enterHideout:
    "[2026.10.24-20.18.29:218][211]TLLua: Display: [Game] SceneLevelMgr@ OpenMainWorld END! InMainLevelPath = /Game/Art/Maps/01SD/XZ_YuJinZhiXiBiNanSuo200/XZ_YuJinZhiXiBiNanSuo200",
  bagInit: "[2026.10.24-20.10.00:000][  1]TLLua: Display: [Game] BagMgr@:InitBagData PageId = 102 SlotId = 1 ConfigBaseId = 100300 Num = 1230",
  pickStart: "[2026.10.24-20.13.00:000][800]TLLua: Display: [Game] ItemChange@ ProtoName=PickItems start",
  update:
    "[2026.10.24-20.13.00:001][800]TLLua: Display: [Game] ItemChange@ Update Id=100300_3b4207e3-cbed-11f1-a03d-000000000034 BagNum=1232 in PageId=102 SlotId=1",
  modify: "[2026.10.24-20.13.00:002][800]TLLua: Display: [Game] BagMgr@:Modfy BagItem PageId = 102 SlotId = 1 ConfigBaseId = 100300 Num = 1232",
  add: "[2026.10.24-20.13.00:003][800]TLLua: Display: [Game] ItemChange@ Add Id=7357_8e15d547-cd44-11f1-b135-000000000083 BagNum=3 in PageId=103 SlotId=4",
  unknownUpdate:
    "[2026.10.24-20.13.00:004][800]TLLua: Display: [Game] ItemChange@ Update Id=5000_aaaa-bbbb BagNum=50 in PageId=103 SlotId=9",
  pickEnd: "[2026.10.24-20.13.00:005][800]TLLua: Display: [Game] ItemChange@ ProtoName=PickItems end",
  delete: "[2026.10.24-19.38.01:639][293]TLLua: Display: [Game] ItemChange@ Delete Id=10330_c0f4ea46-cf96-11f1-8c17-0000000000a1 in PageId=103 SlotId=36",
};

const feedAll = (engine: Engine, lines: string[]) => lines.forEach((raw, i) => engine.feed(parseLogLine(raw, i + 1)));

describe("parseLogLine", () => {
  it("splits header, category, verbosity and [Game] prefix", () => {
    const l = parseLogLine(L.pickStart, 1);
    expect(l.category).toBe("TLLua");
    expect(l.verbosity).toBe("Display");
    expect(l.text).toBe("ItemChange@ ProtoName=PickItems start");
    expect(new Date(l.time!).toISOString()).toBe("2026-10-24T20:13:00.000Z"); // log times are UTC
  });

  it("treats lines without header as continuation", () => {
    const l = parseLogLine("+Description [This stage has been marked by a Plane Anchor]", 5);
    expect(l.time).toBeUndefined();
    expect(l.text).toContain("Plane Anchor");
  });
});

describe("extractEvent", () => {
  it("reads map modifier and map enter", () => {
    expect(extractEvent(parseLogLine(L.modifier, 1))).toMatchObject({ type: "mapModifier", id: 296208 });
    expect(extractEvent(parseLogLine(L.enterMap, 1))).toMatchObject({ type: "mapEnter", name: "SD_GeBuLinShanZhai" });
  });

  it("reads item changes including Delete without BagNum", () => {
    expect(extractEvent(parseLogLine(L.update, 1))).toMatchObject({
      type: "itemChange", op: "Update", configBaseId: 100300, num: 1232, pageId: 102, slotId: 1,
    });
    expect(extractEvent(parseLogLine(L.delete, 1))).toMatchObject({
      type: "itemChange", op: "Delete", configBaseId: 10330, num: undefined, pageId: 103, slotId: 36,
    });
  });
});

describe("Engine + session", () => {
  it("attaches pending modifiers to the next zone and computes pickup deltas", () => {
    const zones: ZoneVisit[] = [];
    const bs = new BlackSailModule();
    const engine = new Engine([bs], (z) => zones.push(z));
    feedAll(engine, [
      L.bagInit, L.modifier, L.enterMap,
      L.pickStart, L.update, L.modify, L.add, L.unknownUpdate, L.pickEnd,
      L.enterHideout,
    ]);
    engine.finish();

    const map = zones[0]!;
    expect(map.modifiers).toEqual([296208]);
    expect(map.loot.get(100300)).toBe(2); // 1230 -> 1232
    expect(map.loot.get(7357)).toBe(3); // new stack
    expect(map.uncertainPickups).toBe(1); // stack never seen before
    expect(zones[1]!.modifiers).toEqual([]);

    const s = bs.summary();
    expect(s.anchorMaps.maps).toBe(1);
    expect(s.otherMaps.maps).toBe(0); // hideout has no modifiers, so it is skipped
  });
});

describe("LogTailer", () => {
  it("emits appended lines, holds partial lines, and restarts after truncation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tli-"));
    const file = join(dir, "UE_game.log");
    await writeFile(file, "﻿old line\n");
    const seen: string[] = [];
    const tailer = new LogTailer(file, (l) => seen.push(l.text), { fromEnd: true, pollMs: 60_000 });
    try {
      await tailer.start();
      await appendFile(file, `${L.pickStart}\npart`);
      await tailer.poll();
      expect(seen).toEqual(["ItemChange@ ProtoName=PickItems start"]);
      await appendFile(file, "ial\n");
      await tailer.poll();
      expect(seen.at(-1)).toBe("partial");

      await writeFile(file, "﻿new\n"); // simulated rotation: smaller file
      await tailer.poll();
      expect(seen.at(-1)).toBe("new");
    } finally {
      tailer.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("learns stack sizes from the log written before it started, so a later pickup is counted", async () => {
    // Real lines (2026-10-25): Epic Threads seen at 34 before the overlay started, +3 in the Terminal.
    const before = "[2026.10.25-12.59.12:992][321]TLLua: Display: [Game] ItemChange@ Add Id=5144_107017a0-cfed-11f1-85cd-0000000000ab BagNum=34 in PageId=102 SlotId=17";
    const terminal = "[2026.10.25-13.22.15:257][441]TLLua: Display: [Game] SceneLevelMgr@ OpenMainWorld END! InMainLevelPath = /Game/Art/Maps/S2/XuHaiZhongGang/XuHaiZhongGang";
    const pickup = "[2026.10.25-13.22.23:491][591]TLLua: Display: [Game] ItemChange@ Update Id=5144_107017a0-cfed-11f1-85cd-0000000000ab BagNum=37 in PageId=102 SlotId=17";
    const dir = await mkdtemp(join(tmpdir(), "tli-"));
    const file = join(dir, "UE_game.log");
    await writeFile(file, `﻿${before}\n`);
    const zones: ZoneVisit[] = [];
    const engine = new Engine([], (z) => zones.push(z));
    const tailer = new LogTailer(file, (l) => engine.feed(l), { fromEnd: true, pollMs: 60_000, prime: (l) => engine.prime(l) });
    try {
      await tailer.start();
      expect(zones).toEqual([]); // priming never reaches zones or modules
      await appendFile(file, `${terminal}\n${L.pickStart}\n${pickup}\n${L.pickEnd}\n${L.enterHideout}\n`);
      await tailer.poll();
      expect(zones[0]).toMatchObject({ name: "XuHaiZhongGang", uncertainPickups: 0 });
      expect(zones[0]!.loot.get(5144)).toBe(3);
    } finally {
      tailer.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("waits for a log file that doesn't exist yet, then reads it from its first line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tli-"));
    const file = join(dir, "UE_game.log");
    const seen: string[] = [];
    const tailer = new LogTailer(file, (l) => seen.push(l.text), { fromEnd: true, pollMs: 60_000 });
    try {
      await tailer.start(); // game not started yet: no throw
      expect(tailer.hasFile).toBe(false);
      await writeFile(file, "﻿first\nsecond\n");
      await tailer.poll();
      expect(tailer.hasFile).toBe(true);
      expect(seen).toEqual(["first", "second"]);
    } finally {
      tailer.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("after a jump reads only the newest MAX_READ bytes, and says when the log was replaced", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tli-"));
    const file = join(dir, "UE_game.log");
    await writeFile(file, "start\n");
    const seen: string[] = [];
    let rotations = 0;
    const tailer = new LogTailer(file, (l) => seen.push(l.text), { fromEnd: true, pollMs: 60_000, onRotate: () => rotations++ });
    try {
      await tailer.start();
      const filler = "x".repeat(99) + "\n"; // 100 bytes a line
      await appendFile(file, filler.repeat(MAX_READ / 100 + 500) + "last\n");
      await tailer.poll();
      expect(seen.at(-1)).toBe("last");
      expect(seen.length).toBe(Math.floor((MAX_READ - 5) / 100) + 1); // newest whole lines + "last"; the older part was skipped
      expect(seen.every((t) => t === "x".repeat(99) || t === "last")).toBe(true); // no cut-off piece
      await writeFile(file, "new log\n"); // smaller: the game started a new log
      await tailer.poll();
      expect(seen.at(-1)).toBe("new log");
      expect(rotations).toBe(1);
    } finally {
      tailer.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("goes on after a line handler throws, and delivers nothing once stopped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tli-"));
    const file = join(dir, "UE_game.log");
    await writeFile(file, "");
    const seen: string[] = [];
    const errors: string[] = [];
    const tailer = new LogTailer(
      file,
      (l) => {
        if (l.text === "bad") throw new Error("boom");
        seen.push(l.text);
      },
      { fromEnd: true, pollMs: 60_000, onError: (err) => errors.push(String(err)) },
    );
    try {
      await tailer.start();
      await appendFile(file, "a\nbad\nb\n");
      await tailer.poll();
      expect(seen).toEqual(["a", "b"]);
      expect(errors).toEqual(["Error: boom"]);
      tailer.stop();
      await appendFile(file, "after stop\n");
      await tailer.poll();
      expect(seen).toEqual(["a", "b"]);
    } finally {
      tailer.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Engine module isolation", () => {
  it("keeps feeding the other modules when one throws", () => {
    const seen: string[] = [];
    const failed: string[] = [];
    const engine = new Engine(
      [
        { id: "bad", name: "bad", onLine: () => { throw new Error("boom"); }, summary: () => ({}) },
        { id: "good", name: "good", onLine: (l) => void seen.push(l.text), summary: () => ({}) },
      ],
      undefined,
      (m) => failed.push(m.id),
    );
    feedAll(engine, [L.pickStart, L.pickEnd]);
    expect(seen).toEqual(["ItemChange@ ProtoName=PickItems start", "ItemChange@ ProtoName=PickItems end"]);
    expect(failed).toEqual(["bad", "bad"]);
  });
});

describe("Dataset", () => {
  it("rolls over to a new day's folder after midnight", async () => {
    const root = await mkdtemp(join(tmpdir(), "tli-data-"));
    let now = new Date("2026-10-25T23:59:59.000Z");
    const dataset = new Dataset(root, () => now);
    try {
      await dataset.init();
      dataset.record("cards", { n: 1 });
      now = new Date("2026-10-26T00:00:01.000Z");
      const frame = dataset.framePath("voidport", "open");
      dataset.record("cards", { n: 2 });
      await dataset.flush();
      expect(frame).toContain(join("2026-10-26", "frames"));
      expect(existsSync(join(root, "2026-10-26", "frames"))).toBe(true); // made for the capture script
      expect(await readFile(join(root, "2026-10-25", "events.jsonl"), "utf8")).toContain('"n":1');
      expect(await readFile(join(root, "2026-10-26", "events.jsonl"), "utf8")).toContain('"n":2');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prunes day folders older than the days it keeps, and nothing else", async () => {
    const root = await mkdtemp(join(tmpdir(), "tli-data-"));
    const dataset = new Dataset(root, () => new Date("2026-10-26T12:00:00.000Z"));
    try {
      for (const d of ["2026-10-01", "2026-10-12", "2026-10-13", "2026-10-26", "notes"]) await mkdir(join(root, d), { recursive: true });
      expect(await dataset.prune(14)).toEqual(["2026-10-01", "2026-10-12"]); // keeps 10-13 .. 10-26
      expect(existsSync(join(root, "2026-10-13"))).toBe(true);
      expect(existsSync(join(root, "notes"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
