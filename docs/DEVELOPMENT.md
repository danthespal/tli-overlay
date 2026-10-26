# Development

TypeScript (Node 22, Electron) tool that reads Torchlight: Infinite's `UE_game.log` and draws an overlay over the game. It is read-only: it never touches game memory, input or the game's files (it only reads the log and two small state files, see [Finding the log](#finding-the-log-and-enable-log)).

## Setup

In game: press **Esc → Settings → Other → Enable Log** (under Account Related), then log out and back in (the game writes the lines the tool needs only after the next login). Then:

```bash
npm install
npm test          # unit tests (real log lines)
npm run overlay   # the overlay over the game, from source
```

All commands:

```bash
npm run audit     # audit every UE_game*.log in the game's Logs folder
npm run audit -- "path/to/UE_game.log"
npm run read-cards                # read Seal Whisper cards from the saved sample screenshots
npm run read-cards -- shot.jpg    # ...or from any screenshot
npm run read-flames               # read the anchor (flame) screen from the saved samples
npm run build-flame-icons         # rebuild flame icon references from samples/screens/anchor/labels.json
npm run overlay                   # transparent click-through overlay over the game (advice badges, flame labels, cycle)
npm run overlay -- --demo shot.jpg out.png   # draw the overlay over a saved screenshot (no game needed)
npm run overlay -- --dataset      # keep every grabbed frame in data/dataset/<date>/frames/ (by default a frame is read and deleted; what was read always goes to data/dataset/<date>/events.jsonl)
npm run watch                     # same engine, text output in the terminal
npm run watch -- --keep           # ...and keep each grabbed frame in reports/frames/
npm run watch -- --once           # grab the game window now and read it (pipeline test)
npm run calibrate                 # refit the advisor from data/history/ (the overlay does this by itself at start and after every chest / salvage; -- --dry to preview)
npm run backfill-salvage          # read Hero Memory salvages out of old logs into data/history/ (the overlay does this by itself at start)
npm run pull                      # pull shared records from the collector and refit on them (COLLECT_URL, COLLECT_TOKEN)
npm run reports                   # download "wrong read" reports into data/reports/
npm run dist                      # build release/TLI-Overlay-<version>-win-x64.zip
```

## Capture and reading

The watcher grabs **one frame only when the log says a choice screen opened, a flame was clicked, a card was clicked, or Switch was pressed**. Nothing is captured at any other time. Frames come from a **share of the game window** (Electron window capture, like tartarus-simulator): the game's own pixels, so nothing drawn on top is in the picture and the game needn't be in front. The share is started when a choice screen opens and stopped 20 s after the last frame (`src/capture/gameCapture.ts`, hidden page `src/overlay/capture.html`); a warm frame takes ~30 ms. When Windows won't share the window (e.g. the game runs elevated and the overlay doesn't), the fallback is a screen copy of the client area, which needs the game in front.

Text is read by **Tesseract.js** (WebAssembly; the English model ships in `data/tessdata-fast`, so no Windows language pack is needed): per-card crops upscaled 2x, raw and binarised, three engines in parallel, ~0.8 s per card screen, ~0.4 s per flame screen (`src/ocr/tesseractOcr.ts`). `TLI_OCR=windows` switches back to Windows OCR for comparison. Window rectangles and the fallback copy run in one PowerShell helper (`scripts/worker.ps1`) with the same start/stop.

`npm run overlay -- --hide-from-captures` content-protects the overlay window (out of screenshots and streams); off by default because on a transparent window it can leave the overlay undrawn. `npm run overlay -- --probe-capture <dir>` saves one frame of each kind with the game running.

## Finding the log and Enable Log

The overlay finds `UE_game.log` itself (`src/engine/findLog.ts`): beside the running game, else the newest log in every Steam library that has the game, the standalone launcher's folder and their VirtualStore copies. It looks again every 5 s (a log picked in the tray applies at once) and moves to another log when the game stops writing the current one. `TLI_LOG_DIR` overrides everything.

Whether the game logs what the triggers need (`src/engine/logDetail.ts`) comes from the log itself:

- At login the game writes its log state; the last `Log@ LogState on|off by …` line decides.
- Pressing Enable Log logs `MsgMgr@:Show MsgValue = Log Enabled`.
- The gameplay lines the triggers use (`ItemChange@`, `BagMgr@`, `UIButton@`, `TipMsgShowMgr@`, `SceneLevelMgr@`) confirm it.

It also reads (never writes) two of the game's own files (`src/engine/gameLogState.ts`):

- `UE_game/TorchLight/Saved/Crash.ini`: one byte, the game starts left during which the game turns logging on by itself after recent crashes (`HaveCrashedCount`). It drops by one per start.
- `UE_game/Local/CommonCache/LogManuallyEnableState`: the player's saved choice. Pressing Enable Log doesn't change it, so a press lasts one game session.

The status card (Game and Log lights, "Ready to play") shows at start and after a change, and stays only while the game runs and something is wrong. It warns while logging is only on because of crashes.

Audit reports go to `reports/` (JSON + Markdown).

## Data sharing

At first start the panel asks once whether to share anonymous Black Sail data. Nothing is sent before the player says yes. What is sent: the cards offered, picks, flames, chest drops, what was read, why frames weren't read, the game's size and how frames were taken, with a random install id and the app version (`src/share/`). Never the game log, screenshots, the Steam id or names. The tray icon turns it off, shows what was shared, or deletes it from the collector.

**Report a wrong read** (Ctrl+Shift+R, or the panel's link) is separate: it shows the last frame and what was read, and sends them with the player's note only when they press Send.

The collector is a Cloudflare Worker (`worker/`, setup in its README). `.github/workflows/collect.yml` pulls the records every 6 hours, refits the advisor on them and commits only the totals (`data/collected/summary.md`, `advisor-config.json`; raw records never go into the public repo); `npm run reports` downloads the reports locally.

## Release

`npm run dist` builds `release/TLI-Overlay-<version>-win-x64.zip`: the app folder, unzipped once by the player, then `TLI Overlay.exe` starts at once (a single-file exe would unpack ~400 MB on every launch). Pushing a tag such as `v0.2.0` (same as `version` in `package.json`) makes the GitHub Action build it and publish it as a Release.

The exe keeps the player's files (history, dataset, calibrated advisor config, settings) in a `data` folder next to itself. Dataset days older than 14 days are removed at start.

## Layout

```
src/
  engine/
    logLine.ts     parse one line (time, category, text)
    logReader.ts   readLogLines() for whole files, LogTailer for live follow + rotation
    findLog.ts     where UE_game.log is (running game, Steam libraries, launcher, VirtualStore)
    logDetail.ts   is the game's log on (login state line, Enable Log press, gameplay lines)
    gameLogState.ts the game's crash count and saved Enable Log choice
    events.ts      typed events: mapEnter, mapModifier, itemChange, bag*, monsterCreated
    session.ts     zone visits + loot deltas per zone, item batches with stack deltas
    module.ts      ToolModule interface every mechanic implements
    engine.ts      lines -> events -> session -> modules (a module that throws doesn't stop the others)
  capture/
    gameCapture.ts window share of the game (Electron desktopCapturer) with a hidden capture page
    worker.ts      client of scripts/worker.ps1: OCR, window rects and the screen-copy fallback
    windowCapture.ts one-shot grab (CLI tools)
    dataset.ts     what was read, per day (pruned after 14 days in the app)
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
  overlay/         Electron main process, the overlay page, the report window
  share/           anonymous sharing: record format, queue, collector address
  cli/             audit, read-cards, read-flames, calibrate, watch, pull, reports
test/              vitest
worker/            the collector (Cloudflare Worker + D1)
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

- Item names (only `ConfigBaseId`s are known; FE = 100300)
- Prices
