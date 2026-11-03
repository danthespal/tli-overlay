import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gameViewport } from "../src/layout.js";
import { loadEffectTable, type EffectEntry } from "../src/modules/black-sail/effects.js";
import { readSealWhisperPage } from "../src/modules/black-sail/sealWhisperReader.js";
import { confirmSlot, hasCardText } from "../src/modules/black-sail/sealWhisperWatcher.js";
import { FLAME_REGIONS, loadFlameEffects, loadIconRefs, readFlamePage } from "../src/modules/black-sail/flameReader.js";
import { DIAMOND_REGIONS, readOwnedPage } from "../src/modules/black-sail/ownedReader.js";
import { readShopPage } from "../src/modules/blessings-from-gods/shopReader.js";
import { decodeImage, TesseractOcr, type Pixels, type ScreenKind } from "../src/ocr/tesseractOcr.js";
import type { OcrPage, Region } from "../src/ocr/windowsOcr.js";

// Explicit expected transforms: these fixtures model a centered game menu, not a live ultrawide UI.
const SIZES = [
  { width: 1920, height: 1080, x: 0, y: 0, scale: 1 },
  { width: 2560, height: 1440, x: 0, y: 0, scale: 4 / 3 },
  { width: 3840, height: 2160, x: 0, y: 0, scale: 2 },
  { width: 2560, height: 1080, x: 320, y: 0, scale: 1 },
  { width: 3440, height: 1440, x: 440, y: 0, scale: 4 / 3 },
  { width: 3840, height: 1600, x: 4480 / 9, y: 0, scale: 40 / 27 },
  { width: 5120, height: 1440, x: 1280, y: 0, scale: 4 / 3 },
  { width: 5120, height: 2160, x: 640, y: 0, scale: 2 },
  { width: 1920, height: 1200, x: 0, y: 60, scale: 1 },
];

describe("resolution and aspect ratio layout", () => {
  let table: EffectEntry[];
  beforeAll(async () => { table = await loadEffectTable(); });

  it.each(SIZES)("keeps centered cards and selection aligned at $width × $height", (size) => {
    const viewport = gameViewport(size.width, size.height);
    expect(viewport.x).toBeCloseTo(size.x);
    expect(viewport.y).toBeCloseTo(size.y);
    expect(viewport.scale).toBeCloseTo(size.scale);
    const page: OcrPage = {
      file: "layout.png", width: size.width, height: size.height, regions: [],
      lines: [
        { text: "Whisper of Wealth", x: 400, y: 655, w: 240, h: 20 },
        { text: "Void Sea Treasures drop 10 additional Memory Scrap(s)", x: 340, y: 740, w: 380, h: 20 },
        { text: "Boss Whisper", x: 1300, y: 655, w: 230, h: 20 },
        { text: "10% chance for 1 additional Void Sea Invitation(s) to drop from Void Sea Treasures", x: 1230, y: 740, w: 390, h: 20 },
        { text: "Confirm", x: 1345, y: 837, w: 146, h: 20 },
      ].map((l) => ({ ...l, x: size.x + l.x * size.scale, y: size.y + l.y * size.scale, w: l.w * size.scale, h: l.h * size.scale })),
    };
    const read = readSealWhisperPage(page, table);
    expect(read.cards.map((c) => [c.slot, c.type, c.match?.entry.group])).toEqual([
      ["left", "Wealth", "Wealth"], ["right", "Boss Whisper", "Boss Whisper"],
    ]);
    expect(confirmSlot(page)).toBe("right");
    expect(hasCardText(page)).toBe(true);
  });

  it("positions the actual renderer inside the game on a secondary monitor with DPI scaling", () => {
    const stage = { style: {} as Record<string, string>, innerHTML: "", addEventListener() {} };
    let onState: (state: unknown) => void = () => {};
    const html = readFileSync(resolve(import.meta.dirname, "../src/overlay/overlay.html"), "utf8");
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
    runInNewContext(script, {
      document: { getElementById: (id: string) => id === "stage" ? stage : null, activeElement: null },
      window: { addEventListener() {}, overlay: { onState: (f: typeof onState) => { onState = f; }, onBackground() {}, setPanelRect() {} } },
      localStorage: { getItem: () => null },
    });
    // 3440x1440 physical pixels at 150%, relative to an overlay on the game's monitor.
    onState({
      game: { x: 20, y: 30, width: 3440 / 1.5, height: 1440 / 1.5 },
      viewport: gameViewport(3440 / 1.5, 1440 / 1.5),
      screen: "none", health: { show: false }, share: { ask: false },
    });
    expect(parseFloat(stage.style.left!)).toBeCloseTo(20 + 440 / 1.5);
    expect(stage.style.top).toBe("30px");
    const scale = Number(/scale\((.*?)\)/.exec(stage.style.transform!)![1]);
    expect(scale * 1080).toBeCloseTo(960); // all badges remain within the client's height
    expect(parseFloat(stage.style.left!) + 960 * scale).toBeCloseTo(20 + 3440 / 3);
  });
});

/** Resize a saved 16:9 menu into an explicitly centered test frame, with no game capture. */
function fitSample(px: Pixels, width: number, height: number): Pixels {
  const scale = Math.min(width / px.width, height / px.height);
  const w = Math.round(px.width * scale), h = Math.round(px.height * scale);
  const ox = Math.round((width - w) / 2), oy = Math.round((height - h) / 2);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const from = (Math.min(px.height - 1, Math.floor((y + 0.5) / scale)) * px.width + Math.min(px.width - 1, Math.floor((x + 0.5) / scale))) * 4;
    const to = ((oy + y) * width + ox + x) * 4;
    data[to] = px.data[from]!; data[to + 1] = px.data[from + 1]!; data[to + 2] = px.data[from + 2]!; data[to + 3] = 255;
  }
  return { width, height, data };
}

describe("readers on resized real samples", () => {
  const tess = new TesseractOcr();
  afterAll(() => tess.stop());
  const samples = resolve(import.meta.dirname, "../../mechanics");
  const fixtures: { kind: ScreenKind; path: string; regions: Region[] }[] = [
    { kind: "cards", path: "black-sail/samples/screens/seal-whisper/voidport_normal-3-cards_20261025042627.jpg", regions: [] },
    { kind: "flames", path: "black-sail/samples/screens/anchor/voidbeacon_flame-wealth_20261025042332.jpg", regions: FLAME_REGIONS },
    { kind: "owned", path: "black-sail/samples/screens/seal-whisper-owned/voidport_owned-3_20261028202621.jpg", regions: DIAMOND_REGIONS },
    { kind: "shop", path: "blessings-from-gods/samples/screens/shop-8-offers.jpg", regions: [] },
  ];
  it.each(fixtures)("preserves $kind readings from 1080p to 4K and in centered ultrawide frames", async ({ kind, path, regions }) => {
    const [table, icons, effects, px] = await Promise.all([
      loadEffectTable(), loadIconRefs(), loadFlameEffects(), decodeImage(resolve(samples, path)),
    ]);
    const summary = (page: OcrPage) => {
      if (kind === "cards") return readSealWhisperPage(page, table).cards.map((c) => [c.slot, c.type, c.rarity, c.doubled, c.match?.entry.text]);
      if (kind === "flames") {
        const r = readFlamePage(page, icons, effects);
        return [r.slots.map((s) => [s.index, s.kind]), r.selected?.effect.id];
      }
      if (kind === "owned") {
        const r = readOwnedPage(page, table);
        return [r.count, r.whispers.map((w) => [w.rarity, w.doubled, w.match?.entry.text])];
      }
      return readShopPage(page).offers.map((o) => [o.item?.name, o.quantity, o.stones]);
    };
    const original = await tess.readPixels(px, path, regions, kind);
    if (kind === "cards") expect(readSealWhisperPage(original, table).cards).toHaveLength(3);
    else if (kind === "flames") expect(readFlamePage(original, icons, effects).selected).not.toBeNull();
    else if (kind === "owned") expect(readOwnedPage(original, table)).toMatchObject({ count: 3, whispers: [{}, {}, {}] });
    else expect(readShopPage(original).offers).toHaveLength(8);
    const baseline = summary(original);
    for (const [width, height] of [[2560, 1440], [3840, 2160], [2560, 1080], [3440, 1440], [3840, 1600], [5120, 1440], [5120, 2160]]) {
      const page = await tess.readPixels(fitSample(px, width!, height!), path, regions, kind);
      expect(summary(page), `${kind} at ${width}×${height}`).toEqual(baseline);
    }
  }, 60_000);
});
