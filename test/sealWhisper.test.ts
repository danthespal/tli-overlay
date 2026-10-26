import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadEffectTable, matchEffect, numbers, template, type EffectEntry } from "../src/modules/black-sail/effects.js";
import { rarityFromColor, readSealWhisperPage } from "../src/modules/black-sail/sealWhisperReader.js";
import { ocrImages, type OcrPage } from "../src/ocr/windowsOcr.js";

let table: EffectEntry[];
beforeAll(async () => {
  table = await loadEffectTable();
});

describe("effect matching", () => {
  it("ignores where OCR put the big numbers and reads a bold 1 as I", () => {
    expect(template("+ % additional Hero Memory Drop 42 Quantity")).toBe(template("+42% additional Hero Memory Drop Quantity"));
    expect(numbers("80 % chance for I additional Void Sea")).toEqual([80, 1]);
  });

  it("uses the doubled values when the card says (Effect has doubled)", () => {
    const text = "+ % additional Hero Memory Drop 42 Quantity in base Void Sea Treasure drops";
    // 42% doubled = white 21%; 42% not doubled = purple 42%.
    expect(matchEffect(text, true, table)?.entry.rarity).toBe("white");
    expect(matchEffect(text, false, table)?.entry.rarity).toBe("purple");
  });

  it("matches rows that only the wiki knows", () => {
    const m = matchEffect("Void Sea Treasures drop 39 additional Memory Scrap(s)", false, table);
    expect(m).toMatchObject({ numbersMatch: true, entry: { rarity: "orange", group: "Wealth", source: "wiki" } });
  });

  it("returns null for text that is not a Seal Whisper", () => {
    expect(matchEffect("Select a Seal Whisper", false, table)).toBeNull();
  });
});

describe("card colour", () => {
  it("maps measured title colours to rarities", () => {
    expect(rarityFromColor([133, 148, 163])).toBe("white");
    expect(rarityFromColor([67, 114, 186])).toBe("blue");
    expect(rarityFromColor([165, 78, 197])).toBe("purple");
    expect(rarityFromColor([201, 181, 88])).toBe("orange");
  });

  it("decides the rarity when the text is the same across rarities", () => {
    const text = "Void Sea Treasures drop additional Memory Thread(s)"; // OCR lost the bold number
    expect(matchEffect(text, false, table, "purple")?.entry.rarity).toBe("purple");
    expect(matchEffect(text, false, table, "orange")?.entry.text).toBe("Void Sea Treasures drop 2 additional Memory Thread(s)");
  });
});

describe("page layout", () => {
  // OCR pieces from the real 3-card screenshot, scaled to 2560x1440 to check resolution handling.
  const k = 2560 / 1920;
  const at = (text: string, x: number, y: number, w: number) => ({ text, x: x * k, y: y * k, w: w * k, h: 16 * k });
  const page: OcrPage = {
    file: "scaled.png",
    width: 2560,
    height: 1440,
    regions: [],
    lines: [
      at("Switch", 927, 178, 65),
      at("hisper ofAhnamen", 413, 654, 225),
      at("Bogs Whisper", 1334, 660, 164),
      at("(Effect has doubled)", 430, 719, 177),
      at("(Effect has doubled)", 1327, 719, 177),
      at("42", 372, 742, 28),
      at("+ % additional Hero Memory Drop", 359, 746, 319),
      at("Quantity in base Void Sea Treasure drops", 341, 770, 355),
      at("80", 1255, 742, 27),
      at("% chance for I additional Void Sea", 1284, 742, 294),
      at("Invitation(s) to drop from Void Sea Treasures", 1220, 768, 393),
      at("Select a Seal Whisper", 855, 916, 210),
    ],
  };

  it("splits cards by column and reads type, doubling and effect", () => {
    const read = readSealWhisperPage(page, table);
    expect(read.view).toBe("three");
    expect(read.cards.map((c) => [c.slot, c.type, c.doubled, c.match?.entry.rarity])).toEqual([
      ["left", "Armament", true, "white"],
      ["right", "Boss Whisper", true, "orange"],
    ]);
  });
});

// End-to-end on the saved screenshots. Needs Windows OCR, so only on Windows.
describe.runIf(process.platform === "win32")("saved screenshots (Windows OCR)", () => {
  const dir = resolve(import.meta.dirname, "../../mechanics/black-sail/samples/screens/seal-whisper");

  const flames = resolve(dir, "../anchor");

  it("reads every card of the samples (type / colour / matched rarity / doubled)", async () => {
    const pages = await ocrImages([
      resolve(dir, "voidport_normal-3-cards_20261025042627.jpg"),
      resolve(dir, "voidport_after-switch-1-card_20261025042633.jpg"),
      resolve(dir, "voidport_wealth-white_wonder-purple_boss-orange_20261025045204.jpg"),
      resolve(dir, "voidport_wealth-orange_wonder-white_wonder-orange_20261025045432.jpg"),
    ]);
    const summary = pages.map((p) => {
      const r = readSealWhisperPage(p, table);
      return [r.view, r.cards.map((c) => `${c.type}/${c.rarity}/${c.match?.entry.rarity}/${c.doubled ? "x2" : "x1"}`)];
    });
    expect(summary).toEqual([
      ["three", ["Armament/white/white/x2", "Armament/blue/blue/x2", "Boss Whisper/orange/orange/x2"]],
      ["switch", ["Wonder/white/white/x2"]],
      ["three", ["Wealth/white/white/x1", "Wonder/purple/purple/x1", "Boss Whisper/orange/orange/x1"]],
      ["three", ["Wealth/orange/orange/x1", "Wonder/white/white/x1", "Wonder/orange/orange/x1"]],
    ]);
  }, 30_000);

  it("finds no cards on the flame (anchor) screens", async () => {
    const pages = await ocrImages([
      resolve(flames, "voidbeacon_flame-boss-whisper_20261025042326.jpg"),
      resolve(flames, "voidbeacon_20261025045409.jpg"),
      resolve(flames, "voidbeacon_20261025045144.jpg"),
    ]);
    expect(pages.map((p) => readSealWhisperPage(p, table).view)).toEqual(["none", "none", "none"]);
  }, 30_000);
});
