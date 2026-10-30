import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEffectTable, type EffectEntry } from "../src/modules/black-sail/effects.js";
import { DIAMOND_REGIONS, diamondRarity, readOwnedPage, type OwnedRead } from "../src/modules/black-sail/ownedReader.js";
import { TesseractOcr } from "../src/ocr/tesseractOcr.js";
import { ocrImages } from "../src/ocr/windowsOcr.js";

const samples = resolve(import.meta.dirname, "../../mechanics/black-sail/samples/screens");
// Panel open with 3 Whispers (2026-10-28): white Wealth, blue Boss, orange Boss.
const OWNED_3 = resolve(samples, "seal-whisper-owned/voidport_owned-3_20261028202621.jpg");
// The card screen without the panel.
const CARDS = resolve(samples, "seal-whisper/voidport_normal-3-cards_20261025042627.jpg");

const summary = (r: OwnedRead) => r.whispers.map((w) => [w.rarity, w.match?.entry.group, w.match?.entry.text, w.match?.numbersMatch]);
const EXPECTED = [
  ["white", "Wealth", "Void Sea Treasures drop 10 additional Memory Scrap(s)", true],
  ["blue", "Boss Whisper", "10% chance for 1 additional Void Sea Invitation(s) to drop from Void Sea Treasures", true],
  ["orange", "Boss Whisper", "40% chance for 1 additional Void Sea Invitation(s) to drop from Void Sea Treasures", true],
];

describe("diamondRarity", () => {
  it("tells the measured diamond colours apart", () => {
    expect(diamondRarity([205, 220, 242])).toBe("white");
    expect(diamondRarity([175, 228, 254])).toBe("blue");
    expect(diamondRarity([252, 209, 52])).toBe("orange");
    expect(diamondRarity([40, 40, 45])).toBeNull();
  });
});

describe("readOwnedPage on the saved screenshots", () => {
  let table: EffectEntry[];
  const tesseract = new TesseractOcr();
  beforeAll(async () => {
    table = await loadEffectTable();
  });
  afterAll(() => tesseract.stop());

  it("reads every Whisper, its rarity and the count (Tesseract)", async () => {
    const [page] = await tesseract.ocrImages([OWNED_3], DIAMOND_REGIONS, "owned");
    const read = readOwnedPage(page!, table);
    expect(read.count).toBe(3);
    expect(summary(read)).toEqual(EXPECTED);
  });

  it("finds no panel on the plain card screen (Tesseract)", async () => {
    const [page] = await tesseract.ocrImages([CARDS], DIAMOND_REGIONS, "owned");
    expect(readOwnedPage(page!, table)).toEqual({ whispers: [], count: null });
  });

  it.runIf(process.platform === "win32")("reads the same with Windows OCR", async () => {
    const [page] = await ocrImages([OWNED_3], DIAMOND_REGIONS);
    const read = readOwnedPage(page!, table);
    expect(read.count).toBe(3);
    expect(summary(read)).toEqual(EXPECTED);
  });
});
