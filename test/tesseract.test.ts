// Tesseract.js reader: same card and flame readings as Windows OCR on the saved samples, with
// the English model shipped in data/tessdata-fast (no Windows language pack involved).
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEffectTable, type EffectEntry } from "../src/modules/black-sail/effects.js";
import { FLAME_REGIONS, loadFlameEffects, loadIconRefs, readFlamePage, type FlameEffect, type IconRef } from "../src/modules/black-sail/flameReader.js";
import { readSealWhisperPage } from "../src/modules/black-sail/sealWhisperReader.js";
import { CHECK_REGIONS, hasCardText } from "../src/modules/black-sail/sealWhisperWatcher.js";
import { decodeImage, fingerprint, TesseractOcr, textColor } from "../src/ocr/tesseractOcr.js";
import { ocrImages } from "../src/ocr/windowsOcr.js";

const SCREENS = resolve(import.meta.dirname, "../../mechanics/black-sail/samples/screens");
let table: EffectEntry[];
let icons: IconRef[];
let effects: FlameEffect[];
const tess = new TesseractOcr();
beforeAll(async () => {
  [table, icons, effects] = await Promise.all([loadEffectTable(), loadIconRefs(), loadFlameEffects()]);
  tess.warm();
});
afterAll(() => tess.stop());

const cardKey = (p: Awaited<ReturnType<typeof ocrImages>>[number]) =>
  readSealWhisperPage(p, table).cards.map((c) => `${c.slot}:${c.rarity}:${c.doubled ? "x2" : ""}:${c.match?.entry.text ?? "??"}`);

describe("TesseractOcr", () => {
  it("reads the Seal Whisper samples exactly as Windows OCR does (cards, rarity, doubling)", async () => {
    const dir = join(SCREENS, "seal-whisper");
    const files = (await readdir(dir)).filter((f) => /\.jpe?g$/i.test(f)).map((f) => join(dir, f));
    const [mine, win] = await Promise.all([tess.ocrImages(files, CHECK_REGIONS, "cards"), ocrImages(files, CHECK_REGIONS)]);
    for (let i = 0; i < files.length; i++) {
      expect(cardKey(mine[i]!), files[i]).toEqual(cardKey(win[i]!));
      expect(hasCardText(mine[i]!)).toBe(true);
    }
  }, 60_000);

  it("reads the selected flame's text on the anchor samples", async () => {
    const dir = join(SCREENS, "anchor");
    const files = (await readdir(dir)).filter((f) => /^voidbeacon_flame-.*\.jpe?g$/i.test(f)).map((f) => join(dir, f));
    expect(files.length).toBeGreaterThan(0);
    const [mine, win] = await Promise.all([tess.ocrImages(files, FLAME_REGIONS, "flames"), ocrImages(files, FLAME_REGIONS)]);
    for (let i = 0; i < files.length; i++) {
      expect(readFlamePage(mine[i]!, icons, effects).selected?.effect.id, files[i]).toBe(readFlamePage(win[i]!, icons, effects).selected?.effect.id);
    }
  }, 60_000);

  it("stops its engines when idle, never under a read, and starts them again for the next one", async () => {
    const file = join(SCREENS, "anchor", (await readdir(join(SCREENS, "anchor"))).find((f) => /^voidbeacon_flame-.*\.jpe?g$/i.test(f))!);
    const idle = new TesseractOcr({ idleMs: 100, workers: 1 });
    const engines = () => (idle as unknown as { scheduler: unknown }).scheduler;
    try {
      const [first] = await idle.ocrImages([file], [], "flames");
      expect(engines()).toBeDefined();
      await new Promise((r) => setTimeout(r, 400));
      expect(engines()).toBeUndefined(); // stopped after 100 ms without a read
      const [again] = await idle.ocrImages([file], [], "flames");
      expect(again!.lines.map((l) => l.text)).toEqual(first!.lines.map((l) => l.text));
    } finally {
      await idle.stop();
    }
  }, 30_000);

  it("computes the same region statistics as the PowerShell script", async () => {
    const dir = join(SCREENS, "seal-whisper");
    const file = join(dir, (await readdir(dir)).find((f) => /\.jpe?g$/i.test(f))!);
    const px = await decodeImage(file);
    const [win] = await ocrImages([file], CHECK_REGIONS);
    const sx = px.width / 1920;
    const sy = px.height / 1080;
    CHECK_REGIONS.forEach(([x, y, w, h], i) => {
      const mine = fingerprint(px, x * sx, y * sy, w * sx, h * sy);
      const ref = win!.regions[i]!;
      expect(Math.abs(mine.bright - ref.bright)).toBeLessThan(0.01);
      expect(Math.abs((mine.lit ?? 0) - (ref.lit ?? 0))).toBeLessThan(0.01);
      expect(Math.abs((mine.max ?? 0) - (ref.max ?? 0))).toBeLessThanOrEqual(2);
      const d = mine.gray.reduce((s, v, k) => s + Math.abs(v - ref.gray[k]!), 0) / mine.gray.length;
      expect(d).toBeLessThan(3);
    });
    // Text colour of a known line: the same brightest-20% rule.
    const line = win!.lines.find((l) => /Select a Seal Whisper/i.test(l.text))!;
    const c = textColor(px, line.x, line.y, line.w, line.h);
    expect(c.map((v, k) => Math.abs(v - line.color![k]!)).every((v) => v <= 6)).toBe(true);
  }, 30_000);
});
