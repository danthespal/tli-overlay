import type { OcrLine, OcrPage } from "./ocr/windowsOcr.js";

/** Centered 1920x1080 UI, fitted without stretching to the game client area. */
export function gameViewport(width: number, height: number) {
  const scale = Math.min(width / 1920, height / 1080);
  return { x: (width - 1920 * scale) / 2, y: (height - 1080 * scale) / 2, scale };
}

/** OCR boxes in reference UI coordinates, using the same viewport as crops and badges. */
export function referenceLines(page: Pick<OcrPage, "width" | "height" | "lines">, anchor: "center" | "left" = "center"): OcrLine[] {
  const { x, y, scale } = gameViewport(page.width, page.height);
  return page.lines.map((l) => ({ ...l, x: (l.x - (anchor === "left" ? 0 : x)) / scale, y: (l.y - y) / scale, w: l.w / scale, h: l.h / scale }));
}
