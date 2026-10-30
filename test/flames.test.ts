import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLogLine } from "../src/engine/logLine.js";
import {
  FLAME_REGIONS,
  flameScore,
  loadFlameEffects,
  loadIconRefs,
  readFlamePage,
  type FlameEffect,
  type IconKind,
  type IconRef,
} from "../src/modules/black-sail/flameReader.js";
import { FlameWatcher, type FlameEvent } from "../src/modules/black-sail/flameWatcher.js";
import { ocrImages, type OcrPage, type OcrRegion } from "../src/ocr/windowsOcr.js";

let icons: IconRef[];
let effects: FlameEffect[];
beforeAll(async () => {
  [icons, effects] = await Promise.all([loadIconRefs(), loadFlameEffects()]);
});

// Real log lines (2026-10-25 session).
const OPEN = "[2026.10.25-02.54.05:053][168]TLLua: Display: [Game] TipMsgShowMgr@DispatchPageRunChange PageName = VoidBeacon , PageRunState = Run ";
const CLICK = "[2026.10.25-02.23.27:728][ 83]TLGame: Display: [Game] UIButton@ normal-click PointerImgBtn";
const CLOSE = "[2026.10.25-02.54.17:892][ 15]TLLua: Display: [Game] TipMsgShowMgr@DispatchPageRunChange PageName = VoidBeacon , PageRunState = Destory ";
const SEAL_SWITCH = "[2026.10.25-02.26.30:854][218]TLGame: Display: [Game] UIButton@ normal-click BtnShowGVAC";

/** A fake flame-screen frame: icons copied from labelled samples, plus the selected flame's text. */
function frame(slots: Record<number, IconKind>, selectedText: string): OcrPage {
  const empty: OcrRegion = { gray: new Array(256).fill(20), color: [30, 20, 60], bright: 0 };
  const regions = FLAME_REGIONS.map((_, i) => {
    const kind = slots[i];
    if (!kind) return empty;
    const ref = icons.find((r) => r.kind === kind)!;
    return { gray: ref.gray, color: ref.color, bright: 0.3 };
  });
  return { file: "f.png", width: 1920, height: 1080, regions, lines: [{ text: selectedText, x: 700, y: 700, w: 520, h: 16 }] };
}

const RING_B = { 0: "wealth_gold", 1: "s_white", 5: "swirl_blue", 6: "s_white" } as const;

describe("FlameWatcher", () => {
  let events: FlameEvent[];
  let frames: OcrPage[];
  let grab: ReturnType<typeof vi.fn>;
  let watcher: FlameWatcher;
  const feed = (raw: string) => watcher.onLine(parseLogLine(raw, 1));
  const lastOffers = () => {
    const e = events.filter((x) => x.kind === "flames").at(-1);
    return e && e.kind === "flames" ? e.offers.map((o) => `${o.slot ?? "?"}:${o.effect?.id ?? "?"}${o.confirmed ? "!" : ""}`) : [];
  };

  beforeEach(() => {
    vi.useFakeTimers();
    events = [];
    frames = [];
    grab = vi.fn(async () => ({ ok: true as const, file: "f.png", width: 1920, height: 1080 }));
    watcher = new FlameWatcher({
      grab,
      ocr: async () => [frames.shift()!],
      icons,
      effects,
      onEvent: (e) => events.push(e),
      settleMs: { open: 1000, click: 400, retry: 500 },
    });
  });
  afterEach(() => vi.useRealTimers());

  it("reports the round's altar id, logged after the screen closed", () => {
    // Real line (2026-10-28), ~14 s after the flame screen's Confirm.
    feed("[2026.10.28-20.13.52:898][166]TLGame: Display: [Game] UMapGamePlayAction_SeasonAltar msgToServer pendingRouteIds num:3, selectAltarId:200001!");
    feed("[2026.10.28-20.11.48:857][802]TLGame: Display: [Game] UMapGamePlayAction_SeasonAltar msgToServer pendingAltarIds num:2, affixAltarIds num:1");
    expect(events).toEqual([{ kind: "altar", id: 200001 }]);
    expect(grab).not.toHaveBeenCalled();
  });

  it("knows most flames from their icons alone, and learns the two S flames by clicking them", async () => {
    frames = [
      frame(RING_B, "After defeating Pirates, a Whisper Of ot Rare quality or higher is guaranteed appear among the selectable Seal Whispers"),
      frame(RING_B, "chance for Void Pirates to drop additional Flame Fuel"),
      frame(RING_B, "chance for Void Pirates to drop 1 additional Embers"),
    ];
    feed(OPEN);
    await vi.advanceTimersByTimeAsync(1000);
    expect(lastOffers()).toEqual(["0:wealth_rare!", "1:?", "5:legendary_gear", "6:?"]);

    feed(CLICK);
    await vi.advanceTimersByTimeAsync(400);
    feed(CLICK);
    await vi.advanceTimersByTimeAsync(400);
    expect(lastOffers()).toEqual(["0:wealth_rare!", "1:flame_fuel!", "5:legendary_gear", "6:embers!"]);
    expect(grab).toHaveBeenCalledTimes(3);
  });

  it("keeps a read flame even when its icon wasn't recognised on any slot", async () => {
    // The Hero Memories hook flame read from the screen, but the ring's icons say otherwise.
    frames = [frame({ 0: "wealth_blue", 1: "swirl_blue" }, "100% chance for Void Pirates to drop 1 additional Hero Memories")];
    feed(OPEN);
    await vi.advanceTimersByTimeAsync(1000);
    expect(lastOffers()).toEqual(["0:wealth", "1:legendary_gear", "?:hero_memories!"]);
  });

  it("reports the flame selected at Confirm as the one put in", async () => {
    const CONFIRM = "[2026.10.25-03.13.11:801][433]TLGame: Display: [Game] UIButton@ normal-click BtnConfirm";
    frames = [
      frame(RING_B, "After defeating Pirates, a Whisper Of ot Rare quality or higher is guaranteed appear among the selectable Seal Whispers"),
      frame(RING_B, "chance for Void Pirates to drop 1 additional Embers"),
    ];
    feed(OPEN);
    await vi.advanceTimersByTimeAsync(1000);
    feed(CLICK);
    feed(CONFIRM); // clicked a flame and confirmed before its frame was read
    feed(CLOSE); // the game closes the screen right after Confirm
    expect(events.some((e) => e.kind === "chosen")).toBe(false); // waits for the click's frame

    await vi.advanceTimersByTimeAsync(400); // the click's frame is read: Embers selected
    expect(events.filter((e) => e.kind === "chosen")).toMatchObject([{ effect: { id: "embers" }, certain: true }]);
    expect(events.at(-1)).toEqual({ kind: "closed" });
  });

  it("reports a still-waiting Confirm as uncertain when the screen opens again, and leaves the new screen open", async () => {
    const CONFIRM = "[2026.10.25-03.13.11:801][433]TLGame: Display: [Game] UIButton@ normal-click BtnConfirm";
    frames = [
      frame(RING_B, "After defeating Pirates, a Whisper Of ot Rare quality or higher is guaranteed appear among the selectable Seal Whispers"),
      frame(RING_B, "chance for Void Pirates to drop 1 additional Embers"),
    ];
    feed(OPEN);
    await vi.advanceTimersByTimeAsync(1000);
    feed(CLICK);
    feed(CONFIRM); // waits for the click's frame
    feed(CLOSE);
    feed(OPEN); // a new screen before that frame was read
    expect(events.filter((e) => e.kind === "chosen")).toMatchObject([{ effect: { id: "wealth_rare" }, certain: false }]);
    expect(events.at(-1)).toEqual({ kind: "closed" }); // the old screen's close
    await vi.advanceTimersByTimeAsync(4000); // the new screen's read; the old Confirm's wait is over
    expect(events.filter((e) => e.kind === "chosen")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: "flames", trigger: "open", read: { selected: { effect: { id: "embers" } } } });
  });

  it("reports at once when nothing is still being read", async () => {
    const CONFIRM = "[2026.10.25-03.13.11:801][433]TLGame: Display: [Game] UIButton@ normal-click BtnConfirm";
    frames = [frame(RING_B, "After defeating Pirates, a Whisper Of ot Rare quality or higher is guaranteed appear among the selectable Seal Whispers")];
    feed(OPEN);
    await vi.advanceTimersByTimeAsync(1000);
    feed(CONFIRM);
    expect(events.at(-1)).toMatchObject({ kind: "chosen", effect: { id: "wealth_rare" }, certain: true });
  });

  it("ignores flame clicks when the screen is not open, and other screens' buttons", async () => {
    feed(CLICK);
    feed(SEAL_SWITCH);
    await vi.advanceTimersByTimeAsync(5000);
    expect(grab).not.toHaveBeenCalled();
  });

  it("drops a pending grab when the screen closes", async () => {
    feed(OPEN);
    feed(CLOSE);
    await vi.advanceTimersByTimeAsync(5000);
    expect(grab).not.toHaveBeenCalled();
    expect(events).toEqual([{ kind: "closed" }]);
  });
});

describe("flame advice (research priority)", () => {
  const order = (ids: string[], goal = "fe") => [...ids].sort((a, b) => flameScore(b, goal) - flameScore(a, goal));
  it("Boss > Wealth > Fluorescent > loot; higher tier wins; Boss wins a tie", () => {
    expect(order(["rare_armor", "fluorescent_memories", "wealth", "boss_whisper"])).toEqual(["boss_whisper", "wealth", "fluorescent_memories", "rare_armor"]);
    expect(order(["boss_whisper", "wealth_rare"])).toEqual(["wealth_rare", "boss_whisper"]); // gold Wealth beats blue Boss
    expect(order(["wealth_rare", "boss_whisper_rare"])).toEqual(["boss_whisper_rare", "wealth_rare"]);
    expect(order(["wealth_magic", "boss_whisper_magic"])).toEqual(["boss_whisper_magic", "wealth_magic"]); // Boss wins a tie
  });
  it("puts the Hero Memory flame before Wealth with the Memories goal", () => {
    expect(order(["wealth_magic", "hero_memories"], "heroMemories")).toEqual(["hero_memories", "wealth_magic"]);
    expect(order(["wealth_magic", "hero_memories"], "scraps")).toEqual(["wealth_magic", "hero_memories"]);
  });
});

describe("flame text matching", () => {
  it("does not force an unknown flame into a similar-sounding known one", () => {
    const page = frame({ 0: "hook_white" }, "100% chance for Void Pirates to drop 1 additional Stone of Infinity");
    expect(readFlamePage(page, icons, effects).selected).toBeNull();
  });
});

describe.runIf(process.platform === "win32")("flame screenshots (Windows OCR, leave-one-out icons)", () => {
  const dir = resolve(import.meta.dirname, "../../mechanics/black-sail/samples/screens/anchor");
  const samples: [string, string, string][] = [
    // file, expected icons by slot, expected selected flame
    ["voidbeacon_flame-boss-whisper_20261025042326.jpg", "0:boss_gold 1:swirl_blue 5:wealth_blue 6:crystal_white", "boss_whisper_rare"],
    ["voidbeacon_flame-legendary-gear_20261025042329.jpg", "0:boss_gold 1:swirl_blue 5:wealth_blue 6:crystal_white", "legendary_gear"],
    ["voidbeacon_flame-wealth_20261025042332.jpg", "0:boss_gold 1:swirl_blue 5:wealth_blue 6:crystal_white", "wealth"],
    ["voidbeacon_flame-rare-armor_20261025042337.jpg", "0:boss_gold 1:swirl_blue 5:wealth_blue 6:crystal_white", "rare_armor"],
    ["voidbeacon_20261025045409.jpg", "0:wealth_gold 1:s_white 5:swirl_blue 6:s_white", "wealth_rare"],
    ["voidbeacon_20261025045412.jpg", "0:wealth_gold 1:s_white 5:swirl_blue 6:s_white", "flame_fuel"],
    ["voidbeacon_20261025045413.jpg", "0:wealth_gold 1:s_white 5:swirl_blue 6:s_white", "legendary_gear"],
    ["voidbeacon_20261025045414.jpg", "0:wealth_gold 1:s_white 5:swirl_blue 6:s_white", "embers"],
    // Live watcher frames (game window grabs, PNG).
    ["live_voidbeacon_2026-10-25T03-10-12.png", "0:wealth_blue 1:swirl_blue 2:crystal_white 5:s_white 6:hook_white", "wealth"],
    ["live_voidbeacon_2026-10-25T03-12-53.png", "0:wealth_purple 1:s_white 2:crystal_white 5:hook_white 6:s_white", "wealth_magic"],
    ["live_voidbeacon_2026-10-25T03-12-59.png", "0:wealth_purple 1:s_white 2:crystal_white 5:hook_white 6:s_white", "rare_trinkets"],
    ["live_voidbeacon_2026-10-25T03-13-01.png", "0:wealth_purple 1:s_white 2:crystal_white 5:hook_white 6:s_white", "hero_memories"],
    // First purple Boss flame (Boss Whisper of Magic quality), 2026-10-25 13:18.
    ["live_voidbeacon_2026-10-25T13-18-39.jpg", "0:wealth_purple 1:s_white 2:crystal_white 5:boss_purple 6:s_white 7:crystal_white", "boss_whisper_magic"],
  ];

  it("reads every icon and the selected flame", async () => {
    const pages = await ocrImages(samples.map(([f]) => resolve(dir, f)), FLAME_REGIONS);
    const got = pages.map((p, i) => {
      const others = icons.filter((r) => !r.source.startsWith(samples[i]![0]));
      const read = readFlamePage(p, others, effects);
      return [read.slots.map((s) => `${s.index}:${s.kind}`).join(" "), read.selected?.effect.id];
    });
    expect(got).toEqual(samples.map(([, slots, sel]) => [slots, sel]));
  }, 30_000);
});
