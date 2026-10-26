// Watches the log for the anchor (flame) screen and reads it from ONE captured frame per trigger.
//
//   VoidBeacon ... Run       -> screen opened: wait for the ring to appear, grab, read icons + text
//   PointerImgBtn            -> a flame was clicked: grab, read the newly selected flame's text
//   BtnConfirm               -> the selected flame was put in: report it (no grab)
//   VoidBeacon ... Destory   -> screen closed: cancel anything pending, forget this screen
//
// Across clicks it keeps what it has learned about each slot, so after clicking through the
// flames every offer is known exactly (the two "S" flames included).

import { TriggerScheduler } from "../../capture/triggerScheduler.js";
import type { GrabResult } from "../../capture/windowCapture.js";
import type { LogLine } from "../../engine/logLine.js";
import type { ToolModule } from "../../engine/module.js";
import type { OcrPage, Region } from "../../ocr/windowsOcr.js";
import { FLAME_REGIONS, readFlamePage, type FlameEffect, type FlameRead, type IconKind, type IconRef } from "./flameReader.js";

const OPENED = /^TipMsgShowMgr@DispatchPageRunChange PageName = VoidBeacon , PageRunState = Run/;
const CLOSED = /^TipMsgShowMgr@DispatchPageRunChange PageName = VoidBeacon , PageRunState = Destory/;
const CLICK = /^UIButton@ normal-click PointerImgBtn/;
const CONFIRM = /^UIButton@ normal-click BtnConfirm/;

export type FlameTrigger = "open" | "click";

/**
 * One flame on offer. Slot positions of two identical icons ("S") may be swapped. `slot` is null
 * for an effect read from the screen whose icon wasn't recognised on any slot.
 */
export interface FlameOffer {
  slot: number | null;
  /** Best icon guess for the slot (lowest distance over all frames of this screen). */
  icon: IconKind | null;
  /** Known effect: read from the screen (confirmed) or the only effect with this icon. */
  effect: FlameEffect | null;
  /** True once the effect was read from the screen for this offer. */
  confirmed: boolean;
  numbers: number[];
}

export type FlameEvent =
  | { kind: "flames"; trigger: FlameTrigger; read: FlameRead; offers: FlameOffer[]; ms: number; file?: string }
  /**
   * The flame put into the seal (the one selected at Confirm). `certain` is false when a flame
   * was clicked after the last frame was read, so the selection on screen may have changed.
   */
  | { kind: "chosen"; effect: FlameEffect | null; numbers: number[]; selectedText: string; certain: boolean }
  | { kind: "skipped"; trigger: FlameTrigger; reason: string }
  | { kind: "closed" };

export interface FlameWatcherDeps {
  grab: (trigger: FlameTrigger) => Promise<GrabResult>;
  ocr: (paths: string[], regions?: Region[], kind?: "cards" | "select" | "flames") => Promise<OcrPage[]>;
  done?: (file: string) => Promise<void>;
  icons: IconRef[];
  effects: FlameEffect[];
  onEvent: (e: FlameEvent) => void;
  settleMs?: { open: number; click: number; retry: number };
}

const DEFAULT_SETTLE = { open: 1000, click: 400, retry: 700 };
const CHOOSE_WAIT_MS = 3000;

export class FlameWatcher implements ToolModule {
  readonly id = "black-sail-flames";
  readonly name = "Black Sail: flame reader";

  private readonly scheduler = new TriggerScheduler();
  private readonly settle: { open: number; click: number; retry: number };
  private open = false;
  private offers: FlameOffer[] = [];
  /** Per slot, the most confident icon guess seen so far on this screen. */
  private bestIcon = new Map<number, { kind: IconKind; distance: number }>();
  /** Selected flame as of the last frame read, and whether a flame was clicked since. */
  private lastSelected: FlameRead["selected"] = null;
  private lastSelectedText = "";
  private clickedSinceRead = false;
  /** A frame (open or click) is being grabbed/read right now. */
  private readPending = false;
  /** Confirm pressed while a frame was still being read: waits for it (up to CHOOSE_WAIT_MS). */
  private choosing: NodeJS.Timeout | null = null;
  /** The screen closed while waiting; finish the close after reporting the choice. */
  private closePending = false;

  constructor(private readonly deps: FlameWatcherDeps) {
    this.settle = deps.settleMs ?? DEFAULT_SETTLE;
  }

  onLine(line: LogLine): void {
    const t = line.text;
    if (OPENED.test(t)) {
      this.open = true;
      this.offers = [];
      this.bestIcon.clear();
      this.lastSelected = null;
      this.lastSelectedText = "";
      this.clickedSinceRead = false;
      this.schedule("open", this.settle.open);
    } else if (this.open && CLICK.test(t)) {
      this.clickedSinceRead = true;
      this.schedule("click", this.settle.click);
    } else if (this.open && CONFIRM.test(t)) {
      // Confirmed faster than the last frame could be read: wait for that read.
      if (this.choosing) return; // already waiting for this screen's read
      if (this.readPending || this.clickedSinceRead) this.choosing = setTimeout(() => this.reportChosen(false), CHOOSE_WAIT_MS);
      else this.reportChosen(this.lastSelected !== null);
    } else if (CLOSED.test(t)) {
      if (this.choosing) this.closePending = true; // keep the pending read alive
      else this.close();
    }
  }

  private reportChosen(certain: boolean): void {
    if (this.choosing) clearTimeout(this.choosing);
    this.choosing = null;
    this.deps.onEvent({
      kind: "chosen",
      effect: this.lastSelected?.effect ?? null,
      numbers: this.lastSelected?.numbers ?? [],
      selectedText: this.lastSelectedText,
      certain,
    });
    if (this.closePending) {
      this.closePending = false;
      this.close();
    }
  }

  private close(): void {
    this.scheduler.cancel();
    this.readPending = false;
    this.open = false;
    this.offers = [];
    this.bestIcon.clear();
    this.deps.onEvent({ kind: "closed" });
  }

  summary() {
    return { offers: this.offers };
  }

  private schedule(trigger: FlameTrigger, delay: number, attempt = 1): void {
    this.readPending = true;
    this.scheduler.run(delay, (current) => this.guard(trigger, current, attempt), attempt === 1);
  }

  /** A failed grab or OCR (PowerShell error, bad output) becomes a "skipped" event, not an unhandled rejection. */
  private async guard(trigger: FlameTrigger, current: () => boolean, attempt: number): Promise<void> {
    try {
      await this.capture(trigger, current, attempt);
    } catch (err) {
      if (!current()) return;
      this.readPending = false;
      this.deps.onEvent({ kind: "skipped", trigger, reason: `error: ${err instanceof Error ? err.message : err}` });
      if (this.choosing) this.reportChosen(false);
    }
  }

  private async capture(trigger: FlameTrigger, current: () => boolean, attempt: number): Promise<void> {
    const t0 = Date.now();
    const grab = await this.deps.grab(trigger);
    if (!current()) return;
    if (!grab.ok) {
      this.readPending = false;
      this.deps.onEvent({ kind: "skipped", trigger, reason: grab.reason });
      if (this.choosing) this.reportChosen(false);
      return;
    }
    let read: FlameRead;
    try {
      const [page] = await this.deps.ocr([grab.file], FLAME_REGIONS, "flames");
      read = readFlamePage(page!, this.deps.icons, this.deps.effects);
    } finally {
      await this.deps.done?.(grab.file);
    }
    if (!current()) return;
    if (!read.slots.length) {
      // Ring not drawn yet; one more try (unless the screen is already closing after Confirm).
      if (attempt < 2 && !this.choosing) return this.schedule(trigger, this.settle.retry, attempt + 1);
      this.readPending = false;
      this.deps.onEvent({ kind: "skipped", trigger, reason: "no flames found on the captured frame" });
      if (this.choosing) this.reportChosen(false);
      return;
    }
    this.learn(read);
    this.lastSelected = read.selected;
    this.lastSelectedText = read.selectedText;
    this.clickedSinceRead = false;
    this.readPending = false;
    this.deps.onEvent({ kind: "flames", trigger, read, offers: this.offers, ms: Date.now() - t0, file: grab.file });
    if (this.choosing) this.reportChosen(this.lastSelected !== null);
  }

  /** Merges a read into what is known about each slot (public for the overlay's demo mode). */
  learn(read: FlameRead): void {
    for (const s of read.slots) {
      const best = this.bestIcon.get(s.index);
      if (!best || s.distance < best.distance) this.bestIcon.set(s.index, { kind: s.kind, distance: s.distance });
    }

    const confirmed = this.offers.filter((o) => o.confirmed);
    this.offers = [...this.bestIcon].sort((a, b) => a[0] - b[0]).map(([slot, { kind }]) => {
      const candidates = this.deps.effects.filter((e) => e.icon === kind);
      return { slot, icon: kind, effect: candidates.length === 1 ? candidates[0]! : null, confirmed: false, numbers: [] };
    });
    // Re-apply what was read on earlier clicks, then this read.
    for (const c of confirmed) this.place(c.effect!, c.numbers);
    if (read.selected) this.place(read.selected.effect, read.selected.numbers);
  }

  /** Puts a read effect on a slot with its icon (first one not already confirmed), else unplaced. */
  private place(effect: FlameEffect, numbers: number[]): void {
    const same = this.offers.find((o) => o.confirmed && o.effect?.id === effect.id);
    if (same) {
      if (numbers.length > same.numbers.length) same.numbers = numbers; // keep the fuller OCR
      return;
    }
    const target = this.offers.find((o) => o.icon === effect.icon && !o.confirmed);
    if (target) Object.assign(target, { effect, confirmed: true, numbers });
    else this.offers.push({ slot: null, icon: null, effect, confirmed: true, numbers });
  }
}
