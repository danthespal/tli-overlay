import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLogLine } from "../src/engine/logLine.js";
import { loadEffectTable, type EffectEntry } from "../src/modules/black-sail/effects.js";
import { matchInGroup } from "../src/modules/black-sail/sealWhisperReader.js";
import { confirmSlot, hasCardText, pillSlot, SealWhisperWatcher, type SealWhisperEvent } from "../src/modules/black-sail/sealWhisperWatcher.js";
import type { OcrPage } from "../src/ocr/windowsOcr.js";

// Real log lines (2026-10-25 session).
const OPEN = "[2026.10.25-02.26.22:551][ 25]TLLua: Display: [Game] TipMsgShowMgr@DispatchPageRunChange PageName = VoidPort , PageRunState = Run ";
const SWITCH = "[2026.10.25-02.26.30:854][218]TLGame: Display: [Game] UIButton@ normal-click BtnShowGVAC";
const RETURN = "[2026.10.25-02.26.34:877][797]TLGame: Display: [Game] UIButton@ normal-click BtnReturnNVAC";
const CLOSE = "[2026.10.24-13.36.39:168][202]TLLua: Display: [Game] TipMsgShowMgr@DispatchPageRunChange PageName = VoidPort , PageRunState = Destory ";
const OTHER = "[2026.10.25-02.26.19:621][618]TLLua: Display: [Game] ItemChange@ ProtoName=PickItems start";

// OCR pieces from the real screenshots.
const line = (text: string, x: number, y: number, w: number) => ({ text, x, y, w, h: 16 });
const page = (lines: OcrPage["lines"]): OcrPage => ({ file: "frame.png", width: 1920, height: 1080, lines, regions: [] });
const THREE = page([
  line("hisper ofAhnamen", 413, 654, 225),
  line("(Effect has doubled)", 430, 719, 177),
  line("42", 372, 742, 28),
  line("+ % additional Hero Memory Drop", 359, 746, 319),
  line("Quantity in base Void Sea Treasure drops", 341, 770, 355),
  line("Bogs Whisper", 1334, 660, 164),
  line("(Effect has doubled)", 1327, 719, 177),
  line("80", 1255, 742, 27),
  line("% chance for I additional Void Sea", 1284, 742, 294),
  line("Invitation(s) to drop from Void Sea Treasures", 1220, 768, 393),
]);
const SWITCHED = page([
  line("hisp rof Wonder", 870, 659, 205),
  line("(Effect has doubled)", 872, 730, 176),
  line("+18", 768, 753, 35),
  line("% Void Sea Treasure Base Drop Quantity", 804, 757, 348),
]);
const EMPTY = page([line("Void Sea Terminal", 116, 26, 359)]);
/** Button regions (centre, left wing, right wing per card) for a card state. */
const buttons = (states: ("dark" | "pill")[]) =>
  states.flatMap((s) => {
    const centre = { gray: new Array(256).fill(s === "pill" ? 60 : 30), color: [30, 30, 30] as [number, number, number], bright: 0, max: 60, lit: 0 };
    const wing = s === "pill" ? { gray: new Array(256).fill(30), color: [30, 30, 30] as [number, number, number], bright: 0, max: 180, lit: 0.02 } : { ...centre, max: 35, lit: 0 };
    return [centre, wing, wing];
  });

let table: EffectEntry[];
beforeAll(async () => {
  table = await loadEffectTable();
});

describe("SealWhisperWatcher", () => {
  let events: SealWhisperEvent[];
  let grab: ReturnType<typeof vi.fn>;
  let pages: OcrPage[];
  let watcher: SealWhisperWatcher;
  const feed = (raw: string) => watcher.onLine(parseLogLine(raw, 1));

  beforeEach(() => {
    vi.useFakeTimers();
    events = [];
    pages = [];
    grab = vi.fn(async () => ({ ok: true as const, file: "frame.png", width: 1920, height: 1080 }));
    watcher = new SealWhisperWatcher({
      grab,
      ocr: async () => [pages.shift() ?? EMPTY],
      table,
      onEvent: (e) => events.push(e),
      settleMs: { open: 1000, switch: 500, retry: 500 },
    });
  });
  afterEach(() => vi.useRealTimers());

  it("grabs one frame after the screen opens, not before, and ignores other lines", async () => {
    pages = [THREE];
    feed(OTHER);
    feed(OPEN);
    await vi.advanceTimersByTimeAsync(999);
    expect(grab).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(grab).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.kind === "read" && e.read.cards.map((c) => `${c.type}/${c.match?.entry.rarity}`)).toEqual([
      "Armament/white",
      "Boss Whisper/orange",
    ]);
  });

  it("reads the Switch card, then reuses the 3 cards on return without grabbing", async () => {
    pages = [THREE, SWITCHED];
    feed(OPEN);
    await vi.advanceTimersByTimeAsync(1000);
    feed(SWITCH);
    await vi.advanceTimersByTimeAsync(500);
    feed(RETURN);
    expect(grab).toHaveBeenCalledTimes(2);
    expect(events.map((e) => (e.kind === "read" ? `${e.trigger}:${e.read.view}` : e.kind))).toEqual([
      "open:three",
      "switch:switch",
      "return:three",
    ]);
  });

  it("does not grab if the screen closes before the cards settle", async () => {
    feed(OPEN);
    feed(CLOSE);
    await vi.advanceTimersByTimeAsync(5000);
    expect(grab).not.toHaveBeenCalled();
    expect(events).toEqual([{ kind: "closed" }]);
  });

  it("hands back the frame of a grab the screen closed during (no file left behind)", async () => {
    const done = vi.fn(async () => {});
    let finishGrab!: () => void;
    const slow = vi.fn(() => new Promise<{ ok: true; file: string; width: number; height: number }>((r) => (finishGrab = () => r({ ok: true, file: "late.jpg", width: 1920, height: 1080 }))));
    watcher = new SealWhisperWatcher({ grab: slow, ocr: async () => [THREE], done, table, onEvent: (e) => events.push(e), settleMs: { open: 1000, switch: 500, retry: 500 } });
    feed(OPEN);
    await vi.advanceTimersByTimeAsync(1000); // grab started
    feed(CLOSE); // ... and the screen closes before it returns
    finishGrab();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toHaveBeenCalledWith("late.jpg");
    expect(events.map((e) => e.kind)).toEqual(["closed"]);
  });

  it("tries once more when the first frame has no cards yet (still animating)", async () => {
    pages = [EMPTY, THREE];
    feed(OPEN);
    await vi.advanceTimersByTimeAsync(1000 + 500);
    expect(grab).toHaveBeenCalledTimes(2);
    expect(events.map((e) => e.kind)).toEqual(["read"]);
  });

  it("grabs a frame on a card click and reports the card whose button became the pill", async () => {
    const SELECT = "[2026.10.25-03.39.11:787][877]TLGame: Display: [Game] UIButton@ normal-click BtnSelect";
    pages = [THREE, { ...THREE, regions: buttons(["dark", "pill", "dark"]) }];
    feed(OPEN);
    await vi.advanceTimersByTimeAsync(1000);
    feed(SELECT);
    await vi.advanceTimersByTimeAsync(400);
    expect(grab).toHaveBeenLastCalledWith("select");
    expect(events.at(-1)).toMatchObject({ kind: "selected", slot: "middle" });
  });

  it("grabs a second frame when the first shows no pill, and reports the result of that one", async () => {
    const SELECT = "[2026.10.25-03.39.11:787][877]TLGame: Display: [Game] UIButton@ normal-click BtnSelect";
    const unclear = { ...THREE, regions: buttons(["dark", "dark", "dark"]) };
    pages = [THREE, unclear, { ...THREE, regions: buttons(["dark", "pill", "dark"]) }];
    feed(OPEN);
    await vi.advanceTimersByTimeAsync(1000);
    feed(SELECT);
    await vi.advanceTimersByTimeAsync(400);
    expect(events.filter((e) => e.kind === "selected")).toHaveLength(0); // waiting for the second frame
    await vi.advanceTimersByTimeAsync(600);
    expect(grab.mock.calls.filter((c) => c[0] === "select")).toHaveLength(2);
    expect(events.filter((e) => e.kind === "selected")).toEqual([expect.objectContaining({ slot: "middle" })]);

    // Both frames unclear: one event, slot null, no third grab.
    events = [];
    pages = [unclear, unclear];
    feed(SELECT);
    await vi.advanceTimersByTimeAsync(400 + 600 + 600);
    expect(grab.mock.calls.filter((c) => c[0] === "select")).toHaveLength(4);
    expect(events).toEqual([expect.objectContaining({ kind: "selected", slot: null })]);
  });

  it("does not grab a second frame once the screen has closed (its sparkles are not a selection)", async () => {
    const SELECT = "[2026.10.25-03.39.11:787][877]TLGame: Display: [Game] UIButton@ normal-click BtnSelect";
    pages = [THREE, { ...THREE, regions: buttons(["dark", "dark", "dark"]) }];
    feed(OPEN);
    await vi.advanceTimersByTimeAsync(1000);
    feed(SELECT);
    feed(CLOSE); // confirmed at once; the click frame is read after the close
    await vi.advanceTimersByTimeAsync(400 + 600 + 600);
    expect(grab.mock.calls.filter((c) => c[0] === "select")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "selected")).toEqual([expect.objectContaining({ slot: null })]);
  });

  it("reads nothing from a frame without card text (the screen already closed), and does not retry", async () => {
    const SELECT = "[2026.10.25-03.39.11:787][877]TLGame: Display: [Game] UIButton@ normal-click BtnSelect";
    // Sparkles of the void background lit a wing pair (15:56:04 live): without card text it is not a selection.
    pages = [THREE, { ...EMPTY, regions: buttons(["dark", "pill", "dark"]) }];
    feed(OPEN);
    await vi.advanceTimersByTimeAsync(1000);
    feed(SELECT);
    await vi.advanceTimersByTimeAsync(400 + 600 + 600);
    expect(grab.mock.calls.filter((c) => c[0] === "select")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "selected")).toEqual([expect.objectContaining({ slot: null })]);
    expect(hasCardText(THREE)).toBe(true);
    expect(hasCardText(EMPTY)).toBe(false);
  });

  it("still reports the card click when the screen closes (after Confirm) before the frame is read", async () => {
    const SELECT = "[2026.10.25-03.39.11:787][877]TLGame: Display: [Game] UIButton@ normal-click BtnSelect";
    pages = [THREE, { ...THREE, regions: buttons(["pill", "dark", "dark"]) }];
    let finishGrab!: () => void;
    feed(OPEN);
    await vi.advanceTimersByTimeAsync(1000);
    grab.mockImplementationOnce(() => new Promise((r) => (finishGrab = () => r({ ok: true, file: "frame.png", width: 1920, height: 1080 }))));
    feed(SELECT);
    await vi.advanceTimersByTimeAsync(400); // the click's grab has started
    feed(CLOSE);
    finishGrab();
    await vi.advanceTimersByTimeAsync(0);
    expect(events.map((e) => e.kind)).toEqual(["read", "closed", "selected"]);
    expect(events.at(-1)).toMatchObject({ slot: "left" });
  });

  it("hides while the handbook covers the screen and re-reads when it closes", async () => {
    const HIDE = "[2026.10.25-02.27.06:970][397]TLLua: Display: [Game] TipMsgShowMgr@DispatchPageRunChange PageName = VoidPort , PageRunState = Hide ";
    pages = [THREE];
    feed(OPEN);
    feed(HIDE); // handbook opened before the cards were read: that read is dropped
    await vi.advanceTimersByTimeAsync(5000);
    expect(grab).not.toHaveBeenCalled();
    expect(events).toEqual([{ kind: "hidden" }]);
    feed(OPEN); // handbook closed: the game logs Run again
    await vi.advanceTimersByTimeAsync(1000);
    expect(events.map((e) => e.kind)).toEqual(["hidden", "read"]);
  });

  it("turns a failed grab or OCR into a skipped event", async () => {
    grab.mockRejectedValueOnce(new Error("powershell exited with code 1"));
    feed(OPEN);
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual([{ kind: "skipped", trigger: "open", reason: "error: powershell exited with code 1" }]);
  });

  it("finds the selected card from its Confirm label, even garbled (real OCR of late frames)", () => {
    expect(confirmSlot(page([line("C0\"firm", 888, 837, 145), line("Select a Seal Whisper", 855, 916, 210)]))).toBe("middle");
    expect(confirmSlot(page([line("Corf?\"\"", 1343, 837, 146)]))).toBe("right");
    expect(confirmSlot(page([line("Confirm", 445, 837, 146)]))).toBe("left");
    expect(confirmSlot(page([line("Select a Seal Whisper", 855, 916, 210)]))).toBeNull();
  });

  it("matches badly OCR'd effect text within the card's own type and rarity only", () => {
    expect(matchInGroup("% chance for Hero Meme among base Void Sea Tree", false, table, "Armament", "white")?.entry.text).toBe(
      "+28% chance for Hero Memories to appear among base Void Sea Treasure drops",
    );
    expect(matchInGroup("Void Sea", false, table, "Armament", "white")).toBeNull(); // too little to tell
  });

  it("finds the pill from a wing outline, with the thresholds measured on the day's click frames", () => {
    const wing = (lit: number, max: number) => ({ lit, max });
    const dark = wing(0, 35);
    // Real frames (2026-10-25), both wings of the selected card; the others dark.
    expect(pillSlot([dark, dark, dark, dark, dark, dark, dark, wing(0.011, 187), wing(0.007, 154)])).toBe("right"); // 15:44:50, dark pill
    expect(pillSlot([dark, wing(0.118, 253), wing(0.1, 240), dark, dark, dark, dark, dark, dark])).toBe("left"); // 13:33:16, lit Confirm
    expect(pillSlot([dark, wing(0.048, 123), wing(0.027, 137), dark, dark, dark, dark, dark, dark])).toBe("left"); // 15:44:20, dark pill
    expect(pillSlot([dark, wing(0.001, 121), dark, dark, dark, dark, dark, dark, dark])).toBeNull();
    expect(pillSlot([dark, dark, dark, dark, wing(0.009, 105), wing(0.006, 103), dark, dark, dark])).toBeNull(); // 15:41:24, closed screen
    expect(pillSlot([dark, dark, dark, dark, wing(0.01, 102), wing(0.004, 116), dark, dark, dark])).toBeNull(); // 15:44:52, closed screen
    expect(pillSlot([dark, dark, dark, dark, wing(0.007, 140), dark, dark, dark, dark])).toBeNull(); // one wing only: a sparkle
    expect(pillSlot([dark, wing(0, 73), dark, dark, dark, dark, dark, dark, dark])).toBeNull();
    // Two pills (frame between two clicks): unclear rather than a guess.
    expect(pillSlot([dark, wing(0.01, 200), wing(0.01, 200), dark, wing(0.01, 200), wing(0.01, 200), dark, dark, dark])).toBeNull();
    // Missing region data (old OCR output without max/lit): unclear.
    expect(pillSlot([])).toBeNull();
  });

  it("reports why nothing was captured", async () => {
    grab.mockResolvedValueOnce({ ok: false, reason: "game window is not in front" });
    feed(OPEN);
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual([{ kind: "skipped", trigger: "open", reason: "game window is not in front" }]);
  });
});
