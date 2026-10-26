// OCR with Tesseract.js (WebAssembly, English model shipped in data/tessdata-fast): no Windows
// language pack needed, so it works on any player's PC. Produces the same OcrPage as windowsOcr.ts,
// so the readers don't care which engine read the frame. The pixel statistics the readers also need
// (text colour, region fingerprints) are computed here in JavaScript from the decoded image.
//
// Tesseract reads game text badly from a whole frame (30 of 42 cards on a test set) and well from
// small crops upscaled 2x (39 of 39), so each screen kind has its own crops:
//   cards  : one crop per card (title + effect text), read raw and binarised at once (6 jobs)
//   select : the three Confirm-label bands plus one card crop (to see the screen is still there)
//   flames : the selected flame's text under the ring
// Validated on 2026-10-25 against the recorded Windows OCR readings: 169/169 cards (0 wrong),
// flames 134/137 (the 3 were the old recordings' mistakes), selection frames all explained.

import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { createScheduler, createWorker, PSM, type Scheduler } from "tesseract.js";
import { CHECK_REGIONS, pillSlot } from "../modules/black-sail/pill.js";
import type { OcrLine, OcrPage, OcrRegion, Region } from "./windowsOcr.js";

export const TESSDATA = resolve(import.meta.dirname, "../../data/tessdata-fast");

/** Decoded RGBA pixels. */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** Which Black Sail screen the frame shows, so only its text is read. */
export type ScreenKind = "cards" | "select" | "flames";

/** Card text columns (1920x1080): centres of the three cards; the Switch view's one card is in the middle. */
const CARD_CX = [518, 960, 1415];
/** Per card: title (y ~655) through the effect's second line (~790). */
const CARD_CROP = (cx: number): Region => [cx - 215, 640, 430, 160];
/** Per card: the check button / Confirm label band. */
const CONFIRM_CROP = (cx: number): Region => [cx - 110, 815, 220, 50];
/** The selected flame's text, centred under the ring. */
const FLAME_CROP: Region = [640, 655, 650, 110];
/** Words further apart than this (1920-wide frame) belong to different pieces. */
const PIECE_GAP = 60;
/** Upscale for Tesseract (its models like ~30 px x-height; the game's text is ~20 px). */
const SCALE = 2;
const BINARIZE_AT = 90;

export async function decodeImage(path: string): Promise<Pixels> {
  const buf = await readFile(path);
  if (/\.png$/i.test(path)) {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: png.data };
  }
  const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  return { width: img.width, height: img.height, data: img.data };
}

const clampBox = (px: Pixels, x: number, y: number, w: number, h: number) => {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(px.width, Math.ceil(x + w));
  const y1 = Math.min(px.height, Math.ceil(y + h));
  return { x0, y0, x1, y1 };
};

/** Average RGB of the brightest 20% of the pixels in the box (the text, not the dark background). */
export function textColor(px: Pixels, x: number, y: number, w: number, h: number): [number, number, number] {
  const { x0, y0, x1, y1 } = clampBox(px, x, y, w, h);
  if (x1 <= x0 || y1 <= y0) return [0, 0, 0];
  const lum: number[] = [];
  for (let r = y0; r < y1; r++) for (let c = x0; c < x1; c++) {
    const i = (r * px.width + c) * 4;
    lum.push(px.data[i]! + px.data[i + 1]! + px.data[i + 2]!);
  }
  const sorted = [...lum].sort((a, b) => a - b);
  const cut = sorted[Math.floor(sorted.length * 0.8)]!;
  let sr = 0, sg = 0, sb = 0, n = 0, k = 0;
  for (let r = y0; r < y1; r++) for (let c = x0; c < x1; c++, k++) {
    if (lum[k]! < cut) continue;
    const i = (r * px.width + c) * 4;
    sr += px.data[i]!; sg += px.data[i + 1]!; sb += px.data[i + 2]!; n++;
  }
  return n ? [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)] : [0, 0, 0];
}

/** 16x16 box-averaged greyscale, bright share (> 160), brightest pixel, lit share (> 90): as windows-ocr.ps1. */
export function fingerprint(px: Pixels, x: number, y: number, w: number, h: number): OcrRegion {
  const G = 16;
  const { x0, y0, x1, y1 } = clampBox(px, x, y, w, h);
  const W = x1 - x0;
  const H = y1 - y0;
  const gray = new Array<number>(G * G).fill(0);
  if (W < G || H < G) return { gray, color: [0, 0, 0], bright: 0, max: 0, lit: 0 };
  const sum = new Float64Array(G * G);
  const cnt = new Uint32Array(G * G);
  let bright = 0, lit = 0, max = 0;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const i = ((y0 + r) * px.width + x0 + c) * 4;
    const v = (px.data[i]! + px.data[i + 1]! + px.data[i + 2]!) / 3;
    if (v > 160) bright++;
    if (v > 90) lit++;
    if (v > max) max = v;
    const cell = Math.floor((r * G) / H) * G + Math.floor((c * G) / W);
    sum[cell]! += v;
    cnt[cell]!++;
  }
  for (let k = 0; k < G * G; k++) gray[k] = cnt[k] ? Math.floor(sum[k]! / cnt[k]!) : 0;
  const n = W * H;
  return { gray, color: textColor(px, x0, y0, W, H), bright: +(bright / n).toFixed(4), max: Math.floor(max), lit: +(lit / n).toFixed(4) };
}

/** Region statistics for regions given in 1920x1080 coordinates. */
export function regionStats(px: Pixels, regions: Region[]): OcrRegion[] {
  const sx = px.width / 1920;
  const sy = px.height / 1080;
  return regions.map(([x, y, w, h]) => fingerprint(px, x * sx, y * sy, w * sx, h * sy));
}

/**
 * A crop as a 24-bit BMP for Tesseract: greyscale, inverted (dark text on light), upscaled with
 * bilinear sampling; with `threshold`, binarised at that luminance instead (the glow and the
 * highlighted words of some cards confuse the raw reading).
 */
export function cropBmp(px: Pixels, box: { x0: number; y0: number; x1: number; y1: number }, scale: number, threshold = 0): Buffer {
  const g = (x: number, y: number) => {
    const i = (Math.min(px.height - 1, Math.max(0, y)) * px.width + Math.min(px.width - 1, Math.max(0, x))) * 4;
    return (px.data[i]! * 299 + px.data[i + 1]! * 587 + px.data[i + 2]! * 114) / 1000;
  };
  const w = Math.round((box.x1 - box.x0) * scale);
  const h = Math.round((box.y1 - box.y0) * scale);
  const stride = (w * 3 + 3) & ~3;
  const buf = Buffer.alloc(54 + stride * h);
  buf.write("BM", 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(stride * h, 34);
  for (let r = 0; r < h; r++) {
    let o = 54 + (h - 1 - r) * stride;
    const sy = box.y0 + r / scale;
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    for (let c = 0; c < w; c++) {
      const sx = box.x0 + c / scale;
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      const v = g(x0, y0) * (1 - fx) * (1 - fy) + g(x0 + 1, y0) * fx * (1 - fy) + g(x0, y0 + 1) * (1 - fx) * fy + g(x0 + 1, y0 + 1) * fx * fy;
      const b = threshold ? (v >= threshold ? 0 : 255) : Math.max(0, Math.min(255, Math.round(255 - v)));
      buf[o++] = b;
      buf[o++] = b;
      buf[o++] = b;
    }
  }
  return buf;
}

interface TessWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/** Tesseract's lines, re-cut at wide gaps into pieces with their own boxes and text colour. */
export function piecesOf(lines: { words: TessWord[] }[], px: Pixels): OcrLine[] {
  const gap = (PIECE_GAP * px.width) / 1920;
  const out: OcrLine[] = [];
  for (const line of lines) {
    let piece: TessWord[] = [];
    const flush = () => {
      const words = piece.filter((w) => w.text.trim());
      if (!words.length) return;
      const x = Math.min(...words.map((w) => w.bbox.x0));
      const y = Math.min(...words.map((w) => w.bbox.y0));
      const x1 = Math.max(...words.map((w) => w.bbox.x1));
      const y1 = Math.max(...words.map((w) => w.bbox.y1));
      out.push({ text: words.map((w) => w.text).join(" "), x, y, w: x1 - x, h: y1 - y, color: textColor(px, x, y, x1 - x, y1 - y) });
    };
    for (const w of line.words) {
      const prev = piece.at(-1);
      if (prev && w.bbox.x0 - prev.bbox.x1 > gap) {
        flush();
        piece = [];
      }
      piece.push(w);
    }
    flush();
  }
  return out;
}

const letters = (lines: OcrLine[], fromY: number) => lines.filter((l) => l.y >= fromY).reduce((n, l) => n + (l.text.match(/[a-z]/gi) ?? []).length, 0);

export interface TesseractOptions {
  langPath?: string;
  lang?: string;
  /** Parallel engines (one crop each); 3 = the three cards at once. */
  workers?: number;
}

export class TesseractOcr {
  private scheduler: Promise<Scheduler> | undefined;

  constructor(private readonly opts: TesseractOptions = {}) {}

  /** Starts the engines now (~0.2 s each), so the first read doesn't pay for it. */
  warm(): void {
    void this.get().catch(() => undefined);
  }

  private get(): Promise<Scheduler> {
    this.scheduler ??= (async () => {
      const scheduler = createScheduler();
      const langPath = this.opts.langPath ?? TESSDATA;
      const make = async () => {
        const w = await createWorker(this.opts.lang ?? "eng", 1, { langPath, cachePath: langPath, cacheMethod: "readOnly", gzip: true, logger: () => undefined });
        await w.setParameters({ preserve_interword_spaces: "1" });
        return w;
      };
      for (const w of await Promise.all(Array.from({ length: this.opts.workers ?? 3 }, make))) scheduler.addWorker(w);
      return scheduler;
    })();
    // A failed start (model file locked, out of memory) must not stay cached: the next read retries.
    const started = this.scheduler;
    started.catch(() => {
      if (this.scheduler === started) this.scheduler = undefined;
    });
    return started;
  }

  /** OCR of one crop (1920x1080 coordinates); pieces come back in frame coordinates. */
  private async crop(px: Pixels, region: Region, psm: PSM, threshold = 0): Promise<OcrLine[]> {
    const scheduler = await this.get();
    const sx = px.width / 1920;
    const sy = px.height / 1080;
    const [x, y, w, h] = region;
    const box = clampBox(px, x * sx, y * sy, w * sx, h * sy);
    if (box.x1 <= box.x0 || box.y1 <= box.y0) return [];
    const { data } = (await scheduler.addJob("recognize", cropBmp(px, box, SCALE, threshold), {}, { blocks: true, text: false })) as Awaited<
      ReturnType<Awaited<ReturnType<typeof createWorker>>["recognize"]>
    >;
    const lines = (data.blocks ?? []).flatMap((b) =>
      b.paragraphs.flatMap((p) =>
        p.lines.map((l) => ({
          words: (l.words as TessWord[]).map((wd) => ({
            text: wd.text,
            bbox: { x0: wd.bbox.x0 / SCALE + box.x0, y0: wd.bbox.y0 / SCALE + box.y0, x1: wd.bbox.x1 / SCALE + box.x0, y1: wd.bbox.y1 / SCALE + box.y0 },
          })),
        })),
      ),
    );
    // Tesseract sets the page segmentation per job through the scheduler's parameters; the
    // crops are single blocks or lines, which the default (auto) handles as well on these sizes.
    void psm;
    return piecesOf(lines, px);
  }

  /**
   * One card's crop, read raw and binarised at once; the effect text with more letters wins (the
   * raw read drops highlighted words and dim text, the binarised one loses glowing text), with the
   * raw read's title pieces (their colour gives the rarity).
   */
  private async card(px: Pixels, cx: number): Promise<OcrLine[]> {
    const region = CARD_CROP(cx);
    const [raw, bin] = await Promise.all([this.crop(px, region, PSM.SINGLE_BLOCK), this.crop(px, region, PSM.SINGLE_BLOCK, BINARIZE_AT)]);
    const effectY = 700 * (px.height / 1080);
    const titles = raw.filter((l) => l.y < effectY);
    return letters(bin, effectY) > letters(raw, effectY) ? [...titles, ...bin.filter((l) => l.y >= effectY)] : raw;
  }

  /** Reads one decoded frame for a screen kind: text pieces plus the requested region statistics. */
  async readPixels(px: Pixels, file: string, regions: Region[] = [], kind: ScreenKind = "cards"): Promise<OcrPage> {
    let lines: OcrLine[];
    if (kind === "flames") lines = await this.crop(px, FLAME_CROP, PSM.SINGLE_BLOCK);
    else if (kind === "select") {
      // One raw card crop (the middle card is there in both views) so the watcher can tell the
      // screen is still open; the Confirm labels only when the pill test on the pixels is unclear.
      const stats = regionStats(px, regions);
      const jobs = [this.crop(px, CARD_CROP(CARD_CX[1]!), PSM.SINGLE_BLOCK)];
      const pillKnown = regions.length === CHECK_REGIONS.length && pillSlot(stats) !== null;
      if (!pillKnown) jobs.push(...CARD_CX.map((cx) => this.crop(px, CONFIRM_CROP(cx), PSM.SINGLE_LINE)));
      lines = (await Promise.all(jobs)).flat();
      return { file: basename(file), width: px.width, height: px.height, lines, regions: stats };
    } else lines = (await Promise.all(CARD_CX.map((cx) => this.card(px, cx)))).flat();
    return { file: basename(file), width: px.width, height: px.height, lines, regions: regionStats(px, regions) };
  }

  /** Same shape as windowsOcr.ocrImages, plus the screen kind. */
  async ocrImages(paths: string[], regions: Region[] = [], kind: ScreenKind = "cards"): Promise<OcrPage[]> {
    const out: OcrPage[] = [];
    for (const p of paths) out.push(await this.readPixels(await decodeImage(p), p, regions, kind));
    return out;
  }

  async stop(): Promise<void> {
    const s = this.scheduler;
    this.scheduler = undefined;
    // A start that failed has nothing to terminate.
    if (s) await s.then((x) => x.terminate(), () => undefined);
  }
}
