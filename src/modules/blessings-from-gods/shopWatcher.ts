// Watches the log for the Blessings from Gods shop and reads it from ONE captured frame per trigger.
//
//   GroceryStoreV3 ... Run      -> shop opened: wait for the cards, grab, read every offer
//   UIButton@ normal-click Btn  -> a card clicked: its item pop-up (More / Buy) opens on the left and
//                                  the other cards dim; nothing changed, no read
//   ... BtnCloseTips            -> the pop-up closed: no read either
//   UIButton@ normal-click ...  -> any other click in the shop (CommonButtonItem_Equip = the pop-up's
//                                  Buy), read again once the pop-up and the cards have settled
//   other page Run / Destory    -> a page over the shop (help, reward tips, ConfirmV2: the Refresh
//                                  confirm) hides it / shows it again
//   ... requested row 'RefreshBtn_Btn' (the Refresh click's sound)
//                               -> "changing" at once: the verdicts on screen are for the old cards
//   ItemChange@ ProtoName=RefreshVendorShop end / BuyVendorGoods end
//                               -> the offers changed (Refresh: new cards, read after 0.9 s and once
//                                  more if a card wasn't ready; buy: the card turns "Sold out", which
//                                  the reader skips, read once its pop-up closed)
//   GroceryStoreV3 ... Destory  -> shop closed: cancel anything pending
//
// A Refresh (2026-10-31): RefreshBtn_Btn (audio line), ConfirmV2 Run, "Btn" (confirm), ConfirmV2
// Destory, then the RefreshVendorShop batch (Divinity Stones 780 -> 730), Func_Vendor_refreshSuccess.
// A buy: Btn (card), CommonButtonItem_Equip (Buy), Push2 (the item), BuyVendorGoods (the stones),
// AutoReward Run (reward page, Func_Common_BuySuccess), FullBtn, AutoReward Destory.

import { TriggerScheduler } from "../../capture/triggerScheduler.js";
import type { GrabResult } from "../../capture/windowCapture.js";
import type { LogLine } from "../../engine/logLine.js";
import type { ToolModule } from "../../engine/module.js";
import type { ScreenKind } from "../../ocr/tesseractOcr.js";
import type { OcrPage, Region } from "../../ocr/windowsOcr.js";
import { readShopPage, type ShopRead } from "./shopReader.js";

const PAGE = /^TipMsgShowMgr@DispatchPageRunChange PageName = (\w+) , PageRunState = (Run|Destory)/;
/** The shop opening or closing (the overlay looks for it in the lines from before it started). */
export const SHOP_PAGE = /^TipMsgShowMgr@DispatchPageRunChange PageName = GroceryStoreV3 , PageRunState = (Run|Destory)/;
const CLICK = /^UIButton@ normal-click (\w+)/;
const SHOP_PAGE_NAME = "GroceryStoreV3";
/** Clicks that never change the offers: help, close, a card (opens its pop-up), the pop-up's close. */
const NO_REREAD = new Set(["BtnHelp", "CloseBtn", "CloseTipsBtn", "Btn", "BtnCloseTips"]);
const POPUP_CLOSED = "BtnCloseTips";
/** The server changed the shop's offers: RefreshVendorShop (new cards), BuyVendorGoods (one sold out). */
const OFFERS_CHANGED = /^ItemChange@ ProtoName=(\w*Vendor\w*) end/;
/**
 * Refresh clicked: the earliest sign, the click sound's lookup (an audio table warning), ~60 ms before
 * the new offers when the confirm page is turned off ("CheckOffBtn", 2026-10-31).
 */
export const REFRESH_CLICKED = /requested row 'RefreshBtn_Btn'/;

export type ShopTrigger = "open" | "click" | "shown" | "changed";

export type ShopEvent =
  | { kind: "read"; trigger: ShopTrigger; read: ShopRead; ms: number; file?: string }
  | { kind: "skipped"; trigger: ShopTrigger; reason: string }
  /** Refresh: the cards are being replaced, the verdicts on screen are for the old ones. */
  | { kind: "changing" }
  /** Another page is over the shop: draw nothing until it closes. */
  | { kind: "hidden" }
  | { kind: "closed" };

export interface ShopWatcherDeps {
  grab: (trigger: ShopTrigger) => Promise<GrabResult>;
  ocr: (paths: string[], regions?: Region[], kind?: ScreenKind) => Promise<OcrPage[]>;
  done?: (file: string) => Promise<void>;
  onEvent: (e: ShopEvent) => void;
  settleMs?: { open: number; click: number; retry: number };
}

/** click: after a Buy the pop-up closes and the card changes; give both time. */
const DEFAULT_SETTLE = { open: 900, click: 1500, retry: 700 };
/** After a Refresh click with no new offers following: read the (unchanged) cards again. */
const REFRESH_FALLBACK_MS = 3000;

export class ShopWatcher implements ToolModule {
  readonly id = "blessings-from-gods-shop";
  readonly name = "Blessings from Gods: shop reader";

  private readonly scheduler = new TriggerScheduler();
  private readonly settle: { open: number; click: number; retry: number };
  private open = false;
  /** Pages opened over the shop and not closed yet. */
  private readonly over = new Set<string>();
  /** The last read has a card whose name wasn't read. */
  private missedNames = false;

  constructor(private readonly deps: ShopWatcherDeps) {
    this.settle = deps.settleMs ?? DEFAULT_SETTLE;
  }

  onLine(line: LogLine): void {
    const page = PAGE.exec(line.text);
    if (page) {
      const [, name, state] = page as unknown as [string, string, string];
      if (name === SHOP_PAGE_NAME) {
        if (state === "Run") {
          this.open = true;
          this.over.clear();
          this.schedule("open", this.settle.open);
        } else this.close();
      } else if (this.open && state === "Run") {
        this.over.add(name);
        this.scheduler.cancel();
        this.deps.onEvent({ kind: "hidden" });
      } else if (this.open && this.over.delete(name) && this.over.size === 0) {
        this.schedule("shown", this.settle.click);
      }
      return;
    }
    if (this.open && this.over.size === 0 && REFRESH_CLICKED.test(line.text)) {
      this.deps.onEvent({ kind: "changing" });
      // The click's sound is logged whether or not a refresh follows (too few stones, no server
      // answer): read anyway in a while, so "Reading…" can't stay. The new offers' batch, ~60 ms
      // later when it comes, replaces this with the normal read.
      return this.schedule("changed", REFRESH_FALLBACK_MS);
    }
    const changed = this.open ? OFFERS_CHANGED.exec(line.text) : null;
    if (changed) {
      // New cards animate in for a moment (read again if one wasn't ready); a buy closes its pop-up first.
      if (/Refresh/.test(changed[1]!)) {
        this.deps.onEvent({ kind: "changing" });
        return this.schedule("changed", this.settle.open);
      }
      return this.schedule("changed", this.settle.click);
    }
    const click = this.open && this.over.size === 0 ? CLICK.exec(line.text) : null;
    if (!click) return;
    // The pop-up closing changes nothing, unless the last read missed names (read while it dimmed the cards).
    const reread = !NO_REREAD.has(click[1]!) || (click[1] === POPUP_CLOSED && this.missedNames);
    if (reread) this.schedule("click", click[1] === POPUP_CLOSED ? this.settle.open : this.settle.click);
  }

  private close(): void {
    if (!this.open) return;
    this.scheduler.cancel();
    this.open = false;
    this.over.clear();
    this.deps.onEvent({ kind: "closed" });
  }

  summary() {
    return { open: this.open, over: [...this.over] };
  }

  private schedule(trigger: ShopTrigger, delay: number, attempt = 1): void {
    this.scheduler.run(delay, (current) => this.guard(trigger, current, attempt), attempt === 1);
  }

  /** A failed grab or OCR becomes a "skipped" event, not an unhandled rejection. */
  private async guard(trigger: ShopTrigger, current: () => boolean, attempt: number): Promise<void> {
    try {
      await this.capture(trigger, current, attempt);
    } catch (err) {
      if (current()) this.deps.onEvent({ kind: "skipped", trigger, reason: `error: ${err instanceof Error ? err.message : err}` });
    }
  }

  private async capture(trigger: ShopTrigger, current: () => boolean, attempt: number): Promise<void> {
    const t0 = Date.now();
    const grab = await this.deps.grab(trigger);
    if (!current()) {
      if (grab.ok) await this.deps.done?.(grab.file);
      return;
    }
    if (!grab.ok) return this.deps.onEvent({ kind: "skipped", trigger, reason: grab.reason });
    let read: ShopRead;
    try {
      const [page] = await this.deps.ocr([grab.file], [], "shop");
      read = readShopPage(page!);
    } finally {
      await this.deps.done?.(grab.file);
    }
    if (!current()) return;
    if (!read.offers.length) {
      // Cards not drawn yet (opening animation); one more try.
      if (attempt < 2) return this.schedule(trigger, this.settle.retry, attempt + 1);
      return this.deps.onEvent({ kind: "skipped", trigger, reason: "no offers found on the captured frame" });
    }
    this.missedNames = read.offers.some((o) => !o.item);
    this.deps.onEvent({ kind: "read", trigger, read, ms: Date.now() - t0, file: grab.file });
    // New cards read too early (one still animating): shown as read, then read once more.
    const incomplete = this.missedNames || read.offers.some((o) => o.stones === null);
    if (trigger === "changed" && incomplete && attempt < 2) this.schedule(trigger, this.settle.retry, attempt + 1);
  }
}
