// Windows built-in OCR (Windows.Media.Ocr), called through scripts/ocr/windows-ocr.ps1.
// Read-only: it only looks at image files. Windows-only; needs the English OCR language (installed here).

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const SCRIPT = resolve(import.meta.dirname, "../../scripts/ocr/windows-ocr.ps1");

export interface OcrLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Text colour [r, g, b]: average of the brightest pixels in the box. */
  color?: [number, number, number];
}

/** Pixel summary of a requested region (see -Regions in windows-ocr.ps1). */
export interface OcrRegion {
  /** 16x16 greyscale, row by row, 0-255. */
  gray: number[];
  /** Average colour of the brightest 20% of pixels. */
  color: [number, number, number];
  /** Share of pixels brighter than 160/255. */
  bright: number;
  /** Brightest pixel (0-255). */
  max?: number;
  /** Share of pixels brighter than 90/255 (thin bright outlines). */
  lit?: number;
}

export interface OcrPage {
  file: string;
  width: number;
  height: number;
  lines: OcrLine[];
  /** One entry per requested region, in order. */
  regions: OcrRegion[];
}

/** A region as [x, y, w, h] in 1920x1080 coordinates (scaled to each image by the script). */
export type Region = [number, number, number, number];

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** OCRs one or more images in a single PowerShell call (startup costs ~1 s, so batch when possible). */
export async function ocrImages(paths: string[], regions: Region[] = []): Promise<OcrPage[]> {
  const dir = await mkdtemp(join(tmpdir(), "tli-ocr-"));
  const out = join(dir, "ocr.json");
  try {
    const regionArg = regions.length ? ` -Regions ${quote(regions.map((r) => r.join(",")).join(";"))}` : "";
    const cmd = `& ${quote(SCRIPT)} -Paths @(${paths.map((p) => quote(resolve(p))).join(",")}) -Out ${quote(out)}${regionArg}`;
    await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", cmd], {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    const json = (await readFile(out, "utf8")).replace(/^﻿/, "");
    const parsed = JSON.parse(json) as OcrPage | OcrPage[];
    // ConvertTo-Json unwraps single-element arrays.
    const list = <T>(v: T | T[] | undefined): T[] => (Array.isArray(v) ? v : v ? [v] : []);
    return list(parsed).map((p) => ({ ...p, lines: list(p.lines), regions: list(p.regions) }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
