# tli-overlay (tool)

TypeScript tool that reads Torchlight: Infinite's `UE_game.log`. It will later run inside an Electron overlay.
It is read-only: it never touches game memory, files or input.

## Setup

In game: **Settings → Other → Enable Log**. Then:

```bash
npm install
npm test          # unit tests (real log lines)
npm run audit     # audit every UE_game*.log in the game's Logs folder
npm run audit -- "path/to/UE_game.log"
npm run read-cards                # read Seal Whisper cards from the saved sample screenshots
npm run read-cards -- shot.jpg    # ...or from any screenshot
npm run read-flames               # read the anchor (flame) screen from the saved samples
npm run build-flame-icons         # rebuild flame icon references from samples/screens/anchor/labels.json
npm run overlay                   # transparent click-through overlay over the game (advice badges, flame labels, cycle)
npm run overlay -- --demo shot.jpg out.png   # draw the overlay over a saved screenshot (no game needed)
npm run overlay -- --dataset      # development: keep every grabbed frame in data/dataset/<date>/frames/ (by default a frame is read and deleted; what was read always goes to data/dataset/<date>/events.jsonl)
npm run watch                     # same engine, text output in the terminal
npm run watch -- --keep           # ...and keep each grabbed frame in reports/frames/
npm run watch -- --once           # grab the game window now and read it (pipeline test)
npm run calibrate                 # development: refit the advisor from data/history/ (the overlay does this by itself at start and after every chest / salvage; -- --dry to preview)
npm run backfill-salvage          # development: read Hero Memory salvages out of old logs into data/history/ (the overlay does this by itself at start)
```

The watcher grabs **one frame only when the log says a choice screen opened, a flame was clicked, a card was clicked, or Switch was pressed**. Nothing is captured at any other time. Frames come from a **share of the game window** (Electron window capture, like tartarus-simulator): the game's own pixels, so nothing drawn on top is in the picture and the game needn't be in front. The share is started when a choice screen opens and stopped 20 s after the last frame (`src/capture/gameCapture.ts`, hidden page `src/overlay/capture.html`); a warm frame takes ~30 ms. When Windows won't share the window (e.g. the game runs elevated and the overlay doesn't), the fallback is a screen copy of the client area, which needs the game in front. Text is read by **Tesseract.js** (WebAssembly; the English model ships in `data/tessdata-fast`, so no Windows language pack is needed): per-card crops upscaled 2x, raw and binarised, three engines in parallel, ~0.8 s per card screen, ~0.4 s per flame screen (`src/ocr/tesseractOcr.ts`). `TLI_OCR=windows` switches back to Windows OCR for comparison. Window rectangles and the fallback copy run in one PowerShell helper (`scripts/worker.ps1`) with the same start/stop. `npm run overlay -- --hide-from-captures` content-protects the overlay window (out of screenshots and streams); off by default because on a transparent window it can leave the overlay undrawn. `npm run overlay -- --probe-capture <dir>` saves one frame of each kind with the game running.

Log folder default is in `src/config.ts`; override with `TLI_LOG_DIR`.
Audit reports go to `reports/` (JSON + Markdown).

## Layout

```
src/
  engine/
    logLine.ts     parse one line (time, category, text)
    logReader.ts   readLogLines() for whole files, LogTailer for live follow + rotation
    events.ts      typed events: mapEnter, mapModifier, itemChange, bag*, monsterCreated
    session.ts     zone visits + loot deltas per zone, item batches with stack deltas
    module.ts      ToolModule interface every mechanic implements
    engine.ts      lines -> events -> session -> modules
  capture/
    gameCapture.ts window share of the game (Electron desktopCapturer) with a hidden capture page
    worker.ts      client of scripts/worker.ps1: OCR, window rects and the screen-copy fallback
    windowCapture.ts one-shot grab (CLI tools)
  ocr/
    tesseractOcr.ts Tesseract.js reader: per-screen crops, pixel statistics in JS, same OcrPage as windowsOcr
    windowsOcr.ts  one-shot Windows OCR via scripts/ocr/windows-ocr.ps1 (comparison, CLI tools, tests)
  modules/
    black-sail/
      index.ts               Plane Anchor maps, anchor/seal screens, Whisper rarity picks (log)
      effects.ts             Seal Whisper effect table + matching OCR text to it
      sealWhisperReader.ts   reads the 3 cards / Switch card from an OCR'd screenshot
      flameReader.ts         reads the anchor (flame) screen: icons + selected flame text
      modifiers.ts           effect text -> structured modifier (8 kinds)
      advisor.ts             6-card combo value + ranked advice with look-ahead (flame prior, doubled rate, ties)
      calibrate.ts           fits base amounts / flame prior / doubled rate / Hero Memory value from the history files
      autoCalibrate.ts       runs that fit inside the overlay and saves the config (no user action)
      salvageTracker.ts      records Hero Memory salvages (ExchangeItem batches) and scans old logs for them
      pickTracker.ts         cycle picks, history file (data/history/)
  cli/audit.ts     log investigation report
  cli/read-cards.ts  Seal Whisper card reader on screenshots
test/              vitest
scripts/tli-lib.ps1  the grab and OCR code (C# pixel helpers, Windows.Media.Ocr), shared by:
scripts/worker.ps1   the warm helper (JSON lines over stdin/stdout)
scripts/capture/     capture-window.ps1, one grab per process
scripts/ocr/         windows-ocr.ps1, one OCR run per process; plus the scripts that turned the
                     Seal Whisper handbook screenshots into a table
```

## Adding a mechanic module

Implement `ToolModule` (`onLine` / `onEvent` / `onZoneEnd` / `summary`) in `src/modules/<name>/`, then pass it to `new Engine([...])`.
Patterns that only one mechanic cares about live in that module's `onLine`. Patterns several modules need get promoted to typed events in `engine/events.ts`.

## Not built yet

- Electron overlay window (next step)
- Item names (we only have `ConfigBaseId`s; FE = 100300)
- Prices
