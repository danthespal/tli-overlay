// Which card is selected on the Seal Whisper screen, from pixels alone (no OCR).
//
// A clicked card's round check button becomes a wide pill (~200 px): first dark with a thin
// bright outline, then the glowing "Confirm" label (46 click frames, 2026-10-25). The pill's ends
// reach into the "wings" left and right of the round button, where an unselected card shows only
// dark background. Regions per card: centre, left wing, right wing (CHECK_REGIONS order).
// Shared by the Seal Whisper watcher and the Tesseract reader (which skips the Confirm-label OCR
// when the pill already answers).

import type { OcrRegion, Region } from "../../ocr/windowsOcr.js";
import type { Slot } from "./sealWhisperReader.js";

export const SLOTS: Slot[] = ["left", "middle", "right"];
export const CARD_CX = [518, 960, 1415];
export const CHECK_REGIONS: Region[] = CARD_CX.flatMap((cx): Region[] => [
  [cx - 30, 825, 60, 60],
  [cx - 100, 822, 55, 66],
  [cx + 45, 822, 55, 66],
]);
/**
 * A wing with an outline in it: at least this share of its pixels brighter than 90/255 and a
 * pixel at least this bright, in BOTH wings (the pill is symmetric). Measured through the OCR
 * script on 45 click frames: real pills 0.7-22% with max 123-250 in both wings; unselected wings
 * 0% with max <= 42; sparkles of the already-closed screen reach 1.0%/105 or 0.7%/130+ in one
 * wing, never both.
 */
const OUTLINE_LIT = 0.004;
const OUTLINE_MAX = 115;

/** The card whose button has become the pill: exactly one card with an outline in both wings. */
export function pillSlot(regions: Pick<OcrRegion, "lit" | "max">[]): Slot | null {
  const hits = SLOTS.filter((_, i) =>
    [regions[i * 3 + 1], regions[i * 3 + 2]].every((w) => w && (w.lit ?? 0) >= OUTLINE_LIT && (w.max ?? 0) >= OUTLINE_MAX),
  );
  return hits.length === 1 ? hits[0]! : null;
}
