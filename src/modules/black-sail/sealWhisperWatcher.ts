// Watches the log for the Seal Whisper screen and reads its cards from ONE captured frame.
//
//   VoidPort ... Run       -> screen opened: wait for the cards to animate in, grab, read
//   BtnShowGVAC            -> Switch pressed: grab, read the single alternative card
//   BtnReturnNVAC          -> back to the 3 cards: reuse the earlier read (no grab)
//   BtnSelect              -> a card was clicked: grab, work out which card is selected;
//                             if no card clearly is (glow not up yet), one more grab a bit later
//   VoidPort ... Hide      -> handbook opened over it: cancel a pending read, hide the drawings
//   VoidPort ... Destory   -> screen closed: cancel anything pending
// Nothing is captured at any other time.

import type { LogLine } from "../../engine/logLine.js";
import type { ToolModule } from "../../engine/module.js";
import { TriggerScheduler } from "../../capture/triggerScheduler.js";
import type { GrabResult } from "../../capture/windowCapture.js";
import type { OcrPage, OcrRegion, Region } from "../../ocr/windowsOcr.js";
import { similarity, template, type EffectEntry } from "./effects.js";
import { readSealWhisperPage, type SealWhisperRead, type Slot } from "./sealWhisperReader.js";

const OPENED = /^TipMsgShowMgr@DispatchPageRunChange PageName = VoidPort , PageRunState = Run/;
const CLOSED = /^TipMsgShowMgr@DispatchPageRunChange PageName = VoidPort , PageRunState = Destory/;
/** The handbook ("?") opened over the screen; closing it logs "Run" again, which re-reads the cards. */
const HIDDEN = /^TipMsgShowMgr@DispatchPageRunChange PageName = VoidPort , PageRunState = Hide/;
const SWITCH = /^UIButton@ normal-click BtnShowGVAC/;
const RETURN = /^UIButton@ normal-click BtnReturnNVAC/;
const SELECT = /^UIButton@ normal-click BtnSelect/;

// Which card is selected: the "pill" test on the check-button regions, see pill.ts.
export { CHECK_REGIONS, pillSlot } from "./pill.js";
import { CHECK_REGIONS, pillSlot, SLOTS } from "./pill.js";

export type Trigger = "open" | "switch" | "return" | "select";

export type SealWhisperEvent =
  | { kind: "read"; trigger: Trigger; read: SealWhisperRead; ms: number; file?: string }
  /** A card was clicked. `slot` is null when the frame doesn't make the selection clear. */
  | { kind: "selected"; slot: Slot | null; brightness: number[]; outline: number[]; file?: string }
  | { kind: "skipped"; trigger: Trigger; reason: string }
  /** Covered by the handbook: draw nothing until the next "read". */
  | { kind: "hidden" }
  | { kind: "closed" };

export interface WatcherDeps {
  /** Grabs one frame; `trigger` names it (e.g. for the dataset). */
  grab: (trigger: Trigger) => Promise<GrabResult>;
  /** `kind` tells a crop-based engine which screen the frame shows ("cards" or "select"). */
  ocr: (paths: string[], regions?: Region[], kind?: "cards" | "select" | "flames") => Promise<OcrPage[]>;
  /** Called with the frame file once it has been read (e.g. delete it). Omit to keep frames. */
  done?: (file: string) => Promise<void>;
  table: EffectEntry[];
  onEvent: (e: SealWhisperEvent) => void;
  /** Waits before grabbing. Defaults tuned for the card animations; 2 tries per read trigger. */
  settleMs?: { open: number; switch: number; retry: number; select?: number; selectRetry?: number };
}

// select: the player confirms 0.6-1.0 s after the card click (66 picks, 2026-10-25, median 0.9 s).
// With the window share a grab takes ~35 ms, and a frame 50 ms after the click caught the pill
// before it was drawn (outline 0-3.5% instead of 10-20%): 250 ms is after the pill, before the
// Confirm. selectRetry: when that frame shows no pill, one more this long AFTER THE CLICK
// (not after the first result, which the OCR can delay by ~0.5 s).
const DEFAULT_SETTLE = { open: 1200, switch: 700, retry: 800, select: 250, selectRetry: 750 };

export class SealWhisperWatcher implements ToolModule {
  readonly id = "black-sail-seal-whisper";
  readonly name = "Black Sail: Seal Whisper reader";

  private readonly scheduler = new TriggerScheduler();
  /** Separate, so a quick card click doesn't cancel the screen's own read. */
  private readonly selectScheduler = new TriggerScheduler();
  private open = false;
  private view: "three" | "switch" = "three";
  private lastThree: SealWhisperRead | undefined;
  /** When the last card click was logged (the retry grab is timed from it). */
  private lastSelectAt = 0;
  private readonly settle: { open: number; switch: number; retry: number; select?: number; selectRetry?: number };

  constructor(private readonly deps: WatcherDeps) {
    this.settle = deps.settleMs ?? DEFAULT_SETTLE;
  }

  onLine(line: LogLine): void {
    const t = line.text;
    if (OPENED.test(t)) {
      this.open = true;
      this.view = "three";
      this.schedule("open", this.settle.open);
    } else if (SWITCH.test(t)) {
      this.open = true; // these buttons only exist on this screen (covers a start mid-screen)
      this.view = "switch";
      this.schedule("switch", this.settle.switch);
    } else if (RETURN.test(t)) {
      this.open = true;
      this.view = "three";
      if (this.lastThree) {
        this.scheduler.cancel();
        this.deps.onEvent({ kind: "read", trigger: "return", read: this.lastThree, ms: 0 });
      } else this.schedule("return", this.settle.switch);
    } else if (this.open && SELECT.test(t)) {
      this.lastSelectAt = Date.now();
      this.selectScheduler.run(this.settle.select ?? DEFAULT_SETTLE.select, (current) =>
        this.guard("select", current, () => this.captureSelection(current)),
      );
    } else if (HIDDEN.test(t)) {
      this.scheduler.cancel();
      this.deps.onEvent({ kind: "hidden" });
    } else if (CLOSED.test(t)) {
      this.open = false;
      this.scheduler.cancel();
      // The card-click read is NOT cancelled: its frame is grabbed ~0.35 s after the click, while
      // the screen closes 2.7-5 s later (after Confirm). The pick tracker waits for this result.
      this.lastThree = undefined;
      this.deps.onEvent({ kind: "closed" });
    }
  }

  summary() {
    return { lastThree: this.lastThree ?? null };
  }

  private schedule(trigger: Trigger, delay: number, attempt = 1): void {
    this.scheduler.run(delay, (current) => this.guard(trigger, current, () => this.capture(trigger, current, attempt)), attempt === 1);
  }

  /** A failed grab or OCR (PowerShell error, bad output) becomes a "skipped" event, not an unhandled rejection. */
  private async guard(trigger: Trigger, current: () => boolean, job: () => Promise<void>): Promise<void> {
    try {
      await job();
    } catch (err) {
      if (current()) this.deps.onEvent({ kind: "skipped", trigger, reason: `error: ${err instanceof Error ? err.message : err}` });
    }
  }

  private async capture(trigger: Trigger, current: () => boolean, attempt: number): Promise<void> {
    const t0 = Date.now();
    const grab = await this.deps.grab(trigger);
    if (!current()) return; // screen closed or another trigger came in
    if (!grab.ok) {
      this.deps.onEvent({ kind: "skipped", trigger, reason: grab.reason });
      return;
    }
    let read: SealWhisperRead;
    try {
      const [page] = await this.deps.ocr([grab.file], [], "cards");
      read = readSealWhisperPage(page!, this.deps.table);
    } finally {
      await this.deps.done?.(grab.file);
    }
    if (!current()) return;

    const expected = trigger === "switch" ? "switch" : "three";
    if (read.view !== expected || read.cards.some((c) => !c.match)) {
      // Probably still animating; one more try.
      if (attempt < 2) return this.schedule(trigger, this.settle.retry, attempt + 1);
      if (read.view === "none") {
        this.deps.onEvent({ kind: "skipped", trigger, reason: "no cards found on the captured frame" });
        return;
      }
    }
    if (read.view === "three") this.lastThree = read;
    this.deps.onEvent({ kind: "read", trigger, read, ms: Date.now() - t0, file: grab.file });
  }

  private async captureSelection(current: () => boolean, attempt = 1): Promise<void> {
    const grab = await this.deps.grab("select");
    if (!current()) return;
    if (!grab.ok) {
      this.deps.onEvent({ kind: "skipped", trigger: "select", reason: grab.reason });
      return;
    }
    let regions: OcrRegion[];
    let byText: Slot | null;
    let page: OcrPage | undefined;
    try {
      [page] = await this.deps.ocr([grab.file], CHECK_REGIONS, "select");
      regions = page?.regions ?? [];
      byText = page ? confirmSlot(page) : null;
    } finally {
      await this.deps.done?.(grab.file);
    }
    if (!current()) return;
    const brightness = SLOTS.map((_, i) => regions[i * 3]).map((r) => (r ? r.gray.reduce((a, b) => a + b, 0) / r.gray.length : 0));
    const outline = SLOTS.map((_, i) => Math.min(regions[i * 3 + 1]?.lit ?? 0, regions[i * 3 + 2]?.lit ?? 0));
    // A quick Confirm closes the screen before the frame is grabbed (the log's "Destory" comes
    // seconds later): no card text on the frame means no selection can be read from it.
    const cardsOnScreen = page !== undefined && hasCardText(page);
    const slot = !cardsOnScreen ? null : this.view === "switch" ? "middle" : (byText ?? pillSlot(regions));
    // Unclear, and the screen is still open: the pill may not be drawn yet, one more frame a
    // little later (same generation, so a new click still cancels it).
    if (slot === null && attempt < 2 && this.open && cardsOnScreen) {
      const delay = Math.max(50, this.lastSelectAt + (this.settle.selectRetry ?? DEFAULT_SETTLE.selectRetry) - Date.now());
      this.selectScheduler.run(delay, (cur) => this.guard("select", cur, () => this.captureSelection(cur, attempt + 1)), false);
      return;
    }
    this.deps.onEvent({ kind: "selected", slot, brightness, outline, file: grab.file });
  }
}

/**
 * The selected card's check button turns into a big "Confirm" label (y ~837, ~146 px wide). Its
 * text is still readable after the glow has faded (a quick Confirm, 2026-10-25), unlike the button
 * brightness. OCR sometimes garbles it ("C0\"firm", "Corf?"), so the position decides.
 */
export function confirmSlot(page: OcrPage): Slot | null {
  const sx = page.width / 1920;
  const sy = page.height / 1080;
  const hit = page.lines.find((l) => {
    const [y, w] = [l.y / sy, l.w / sx];
    return y >= 815 && y <= 865 && w >= 110 && w <= 180 && similarity(template(l.text), "confirm") >= 0.4;
  });
  if (!hit) return null;
  const cx = (hit.x + hit.w / 2) / sx;
  return cx < 740 ? "left" : cx < 1180 ? "middle" : "right";
}

/** True when the frame still shows the card screen: OCR text in the cards' title/effect band. */
export function hasCardText(page: OcrPage): boolean {
  const sy = page.height / 1080;
  return page.lines.some((l) => l.y / sy >= 630 && l.y / sy <= 805);
}
