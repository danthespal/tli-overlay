// Overlay main process: runs the Black Sail engine (log triggers, readers, advisor, tracker) and
// sends a small "what to draw" state to a transparent, click-through window over the game.
// Started by start.mjs (registers tsx so this TypeScript runs as-is).

import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Dataset, KEEP_DAYS } from "../capture/dataset.js";
import type { GrabResult } from "../capture/windowCapture.js";
import { CaptureWorker, warmOnScreens } from "../capture/worker.js";
import { GameCapture } from "../capture/gameCapture.js";
import { APP_DIR, PACKAGED, USER_DIR } from "../paths.js";
import { loadSettings, saveSettings } from "../settings.js";
import { COLLECTOR } from "../share/endpoint.js";
import { MAX_IMAGE, type Kind } from "../share/schema.js";
import { Sharer } from "../share/sharer.js";
import { Engine } from "../engine/engine.js";
import { findLog, gameLogDirs, gameProgram, gameRunning, STALE_MS } from "../engine/findLog.js";
import { LogDetail } from "../engine/logDetail.js";
import { readGameLogState, type GameLogState } from "../engine/gameLogState.js";
import { LogTailer } from "../engine/logReader.js";
import { configForGoal, DEFAULT_GOAL, loadAdvisorConfig, setScore, type Tier } from "../modules/black-sail/advisor.js";
import { chestReport } from "../modules/black-sail/calibrate.js";
import { reasonFor } from "../modules/black-sail/reasons.js";
import { loadEffectTable, type Rarity } from "../modules/black-sail/effects.js";
import {
  FLAME_REGIONS,
  FLAME_SLOTS,
  flameScore,
  flameTier,
  loadFlameEffects,
  loadIconRefs,
  readFlamePage,
  type FlameEffect,
} from "../modules/black-sail/flameReader.js";
import { FlameWatcher, type FlameEvent } from "../modules/black-sail/flameWatcher.js";
import { describeModifier, parseModifier } from "../modules/black-sail/modifiers.js";
import { PickTracker, type TrackedCard, type TrackerEvent } from "../modules/black-sail/pickTracker.js";
import { readSealWhisperPage, type SealWhisperRead } from "../modules/black-sail/sealWhisperReader.js";
import { SealWhisperWatcher, type SealWhisperEvent } from "../modules/black-sail/sealWhisperWatcher.js";
import { SalvageTracker, scanLogsForSalvage } from "../modules/black-sail/salvageTracker.js";
import { autoCalibrate } from "../modules/black-sail/autoCalibrate.js";
import { CycleScanner, cycleFromLogs } from "../modules/black-sail/cycleScan.js";
import { ocrImages } from "../ocr/windowsOcr.js";
import { TesseractOcr, type ScreenKind } from "../ocr/tesseractOcr.js";

/** Everything the window draws. Positions are in 1920x1080 game coordinates; the window scales them. */
export interface OverlayState {
  /** Game client area inside the overlay window (window pixels). */
  game: { x: number; y: number; width: number; height: number };
  screen: "none" | "cards" | "flames";
  view: "three" | "switch";
  /**
   * One line per card: badge (rank / tie), tier (S-D, the card on its own), effect label, the reason
   * in words, `final` (expected final chest as a multiple of a chest with no Whispers: what ★ BEST
   * is based on) and `nowPct` (how much it raises the current chest right now, %).
   */
  cards: { slot: string; rarity: Rarity | null; label: string; rank: number; tie: boolean; reason: string; tier: Tier; final: number; nowPct: number }[];
  /** `diff` = value vs the best of the 3 cards; null when the 3 cards weren't read. `tie` = within the tie margin of it. */
  switchCard: { rarity: Rarity | null; label: string; diff: number | null; tie: boolean; tier: Tier; final: number; nowPct: number } | null;
  /** The picks so far as a multiple of a chest with no Whispers (null before the first advice). */
  setScore: number | null;
  /** Before Switch is pressed: chance (0-1) that the unknown Switch card beats the best card. */
  switchHint: { chance: number } | null;
  /** The last Void Sea Treasure against the model, shown in the panel. */
  lastChest: { cycle: number; scraps: number; threads: number; heroMemories: number; invitations: number; fe: number; modelFe: number } | null;
  /** Draw the panel even with no Black Sail screen open (for a while after a chest). */
  showPanel: boolean;
  flames: { x: number; y: number; side: "left" | "right"; label: string; confirmed: boolean; kind: string | null; best: boolean; tier: Tier | null }[];
  cycle: number;
  picks: { rarity: Rarity | null; label: string }[];
  status: string;
  /** This cycle's goal, the choices, and whether to ask for it (start of a cycle). */
  goal: string;
  goals: { id: string; label: string }[];
  askGoal: boolean;
  /** Shown even when no Black Sail screen is open (e.g. the log file is missing). */
  notice: string | null;
  /** Anonymous data sharing: available in this build, still to be asked (first start), on. */
  share: { available: boolean; ask: boolean; on: boolean };
  /** Game and log lights (status card, panel header): the player sees both are OK before playing. */
  health: { game: Light; gameText: string; log: Light; logText: string; ready: boolean; problem: string | null; note: string | null; show: boolean };
  version: string;
}

type Light = "ok" | "wait" | "bad" | "off";

const FLAME_LABEL: Record<string, string> = {
  boss_whisper: "Boss Whisper",
  boss_whisper_magic: "Boss Whisper (Magic+)",
  boss_whisper_rare: "Boss Whisper (Rare+)",
  wealth: "Wealth Whisper",
  wealth_magic: "Wealth (Magic+)",
  wealth_rare: "Wealth (Rare+)",
  legendary_gear: "Legendary gear 20%",
  rare_armor: "6 Rare armor",
  rare_trinkets: "6 Rare trinkets",
  rare_weapons: "6 Rare weapons",
  hero_memories: "+1 Hero Memory",
  energy_cores: "+2 Energy Cores",
  flame_fuel: "Flame Fuel 50%",
  embers: "Embers 50%",
  fluorescent_memories: "Fluorescent Mem 50%",
};

const label = (effect: string) => {
  const m = parseModifier(effect);
  return m ? describeModifier(m) : effect;
};

async function main() {
  // (--demo and --probe-capture are one-shot checks that may run next to a live overlay.)
  const oneShot = process.argv.includes("--demo") || process.argv.includes("--probe-capture");
  if (!oneShot && !app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  await app.whenReady();
  const display = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    ...display.bounds,
    transparent: true,
    frame: false,
    resizable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: { preload: resolve(import.meta.dirname, "preload.cjs") },
  });
  // Clicks go through to the game, except while the cursor is over the panel (see "panelRect" below).
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, "screen-saver");
  // --hide-from-captures: keep the overlay out of the player's screenshots and streams. Off by
  // default: on a transparent window Windows' content protection can leave the whole overlay
  // undrawn (seen 2026-10-25), and the game frames come from a window share that never contains
  // the overlay anyway.
  if (process.argv.includes("--hide-from-captures")) win.setContentProtection(true);
  await win.loadFile(resolve(import.meta.dirname, "overlay.html"));

  const state: OverlayState = {
    game: { x: 0, y: 0, width: display.bounds.width, height: display.bounds.height },
    screen: "none",
    view: "three",
    cards: [],
    switchCard: null,
    setScore: null,
    switchHint: null,
    lastChest: null,
    showPanel: false,
    flames: [],
    cycle: 1,
    picks: [],
    status: "Waiting for a Black Sail screen…",
    goal: DEFAULT_GOAL,
    goals: [],
    askGoal: false,
    notice: null,
    share: { available: false, ask: false, on: false },
    health: { game: "off", gameText: "Checking…", log: "wait", logText: "Looking for the game log…", ready: false, problem: null, note: null, show: true },
    version: "",
  };
  // Timers and late events can fire while the app quits, after the window is gone.
  const send = () => {
    if (!win.isDestroyed()) win.webContents.send("state", state);
  };

  const [table, icons, effects, config] = await Promise.all([loadEffectTable(), loadIconRefs(), loadFlameEffects(), loadAdvisorConfig()]);
  // A frame is grabbed, read, used for the advice and deleted: nothing piles up on the player's
  // disk. What was read (small JSON lines) is always kept in data/dataset/<date>/events.jsonl.
  // --dataset (development): keep the frames too, so readers can be checked against them.
  const keepFrames = process.argv.includes("--dataset");
  const dataset = new Dataset(join(USER_DIR, "dataset"));
  await dataset.init();
  // Players only: a development dataset (frames kept with --dataset) is the developer's to keep.
  const pruned = PACKAGED ? await dataset.prune().catch(() => [] as string[]) : [];
  if (pruned.length) console.log(`dataset: removed ${pruned.length} day(s) older than ${KEEP_DAYS} days`);
  const scratch = join(tmpdir(), "tli-overlay");
  await rm(scratch, { recursive: true, force: true }); // frames left by a crash
  await mkdir(scratch, { recursive: true });
  // The last frame and what was read from it are kept (one file, in the temp folder) for a
  // report ("that was wrong"); every other frame is deleted once read.
  let lastFrame: { screen: string; path: string; read: Record<string, unknown> | null; used: boolean } | null = null;
  // Frames of the "Seal Whispers Owned" panel are kept in the dataset (rare, one per panel opening):
  // samples for its reader, which has seen few layouts yet.
  const keepOwned = (trigger: string) => trigger === "owned";
  const drop = (file: string) => (file.includes("_owned.jpg") ? Promise.resolve() : rm(file, { force: true }));
  const done = keepFrames
    ? undefined
    : async (file: string) => {
        if (lastFrame?.path === file) lastFrame.used = true;
        else await drop(file);
      };

  // Anonymous sharing (src/share/): asked once, then the dataset lines below go to the collector
  // too. Development runs and --demo never share (no collector address).
  const settings = await loadSettings();
  const APP_VERSION = PACKAGED ? app.getVersion() : (JSON.parse(readFileSync(join(APP_DIR, "package.json"), "utf8")) as { version: string }).version;
  const sharer = new Sharer({
    dir: USER_DIR,
    endpoint: process.argv.includes("--demo") ? "" : COLLECTOR,
    app: APP_VERSION,
    settings,
    saveSettings,
    onLog: (m) => console.log(`[share] ${m}`),
  });
  await sharer.load();
  state.version = `v${APP_VERSION}`;
  const refreshShare = () => (state.share = { available: sharer.available, ask: sharer.asking, on: sharer.on });
  refreshShare();
  const SHARED = new Set<Kind>(["capture", "cards", "flames", "skipped", "picked", "flameChosen", "chest", "bossRun", "salvage", "goal"]);
  const record = (kind: string, data: Record<string, unknown>) => {
    dataset.record(kind, data);
    if ((kind === "cards" || kind === "flames") && lastFrame) lastFrame.read = data;
    if (SHARED.has(kind as Kind)) {
      const { frame: _frame, ...shared } = data; // a file name on this PC, means nothing elsewhere
      sharer.add(kind as Kind, shared);
    }
  };
  // Which UE_game.log to follow, looked for again every 5 s (see engine/findLog.ts): the game may
  // start after the overlay, from another install, or write UE_game_2.log.
  const logDirs = gameLogDirs(); // registry and Steam files: read once
  let program: string | null = null;
  let gameSince = 0;
  const search = () => findLog({ override: process.env.TLI_LOG_DIR, chosen: settings.logPath, program, gameSince, dirs: logDirs });
  let found = search();
  let logBy = "not found"; // how the log was found, for the session record

  // Game and log lights. The status card shows at start and for a while after a light changes,
  // and stays while the game runs and something is wrong (or no log can be found at all).
  let tray: Tray | null = null;
  let windowSeen = false;
  let logWritten = 0; // last change of the followed log (ms), 0 = no file
  const logDetail = new LogDetail(); // Enable Log on or off, from the lines read
  // The game's own files about its logging (crash count, saved choice): see engine/gameLogState.ts.
  let gameLog: GameLogState = { crashStarts: null, manual: null };
  const readGameLog = async () => {
    gameLog = found ? await readGameLogState(found.path) : { crashStarts: null, manual: null };
  };
  let showUntil = Date.now() + 10_000;
  let healthKey = "";
  let tooltip = "TLI Overlay";
  let hideTimer: NodeJS.Timeout | undefined;
  function refreshHealth(): boolean {
    const now = Date.now();
    const running = gameSince > 0;
    const game: Light = !running ? "off" : windowSeen ? "ok" : "wait";
    const gameText = !running ? "Not running" : windowSeen ? "Window found" : "Looking for the game window…";
    let log: Light;
    let logText: string;
    let problem: string | null = null;
    if (!found) {
      [log, logText] = ["bad", "Not found"];
      problem = "Game log not found. Tray icon → Choose UE_game.log";
    } else if (!running) [log, logText] = logWritten ? ["ok", "Found"] : ["wait", "Appears when the game starts"];
    else {
      // The game says at login whether its log is on and why, and the gameplay lines the triggers
      // come from confirm it (engine/logDetail.ts); with neither seen yet, 2 minutes of play decide.
      const fresh = logWritten > 0 && now - logWritten < STALE_MS;
      const { verdict, reason } = logDetail;
      if (verdict === "on" && fresh) [log, logText] = ["ok", reason === "HaveCrashedCount" ? "On (turned on by the game)" : reason === "pressed" ? "Enable Log on (pressed)" : "Enable Log on"];
      else if (verdict !== "off" && now - gameSince < STALE_MS) [log, logText] = ["wait", fresh ? "Checking Enable Log…" : "Waiting for the game…"];
      else {
        [log, logText] = verdict === "on" ? ["bad", "Not being written"] : ["bad", "Enable Log is off"];
        problem = "In game: Esc → Settings → Other → Enable Log (under Account Related), then log out and back in";
      }
    }
    // What the player should know about Enable Log beyond the light: it isn't saved by the game.
    const left = gameLog.crashStarts;
    const ENABLE = "Esc → Settings → Other → Enable Log";
    let note: string | null = null;
    if (gameLog.manual !== true) {
      if (logDetail.pressed) note = "Enable Log lasts until you close the game: press it again next time.";
      else if (logDetail.reason === "HaveCrashedCount" && left !== null)
        note = left > 0
          ? `Logging is on only because of recent game crashes, for ${left} more game start${left === 1 ? "" : "s"}. After that, press ${ENABLE} each time you start the game, then log out and back in.`
          : `Logging is on only because of recent game crashes, and this is the last game start it does that. Next time, press ${ENABLE}, then log out and back in.`;
      else if (log === "bad" && left === 0) note = "The game doesn't remember Enable Log: press it each time you start the game.";
    }
    const ready = game === "ok" && log === "ok";
    const key = `${game}|${log}`;
    if (key !== healthKey) {
      healthKey = key;
      showUntil = now + 8000;
    }
    // Updated whenever its text changes (a note can change while the lights don't).
    const tip = `TLI Overlay · ${ready ? "Ready to play" : problem ?? (running ? "Starting…" : "Game not running")}${note ? `\n${note}` : ""}`;
    if (tip !== tooltip) {
      tooltip = tip;
      tray?.setToolTip(tooltip);
    }
    // Few forced starts left: the warning stays up for the first minute of play.
    const lastStarts = note !== null && left !== null && left <= 2 && running && now - gameSince < 60_000;
    const show = now < showUntil || (running && !ready) || lastStarts;
    clearTimeout(hideTimer);
    if (now < showUntil) hideTimer = setTimeout(() => refreshHealth() && send(), showUntil - now + 50);
    const next = { game, gameText, log, logText, ready, problem, note, show };
    const changed = JSON.stringify(next) !== JSON.stringify(state.health);
    state.health = next;
    return changed;
  }
  const shareSession = () => {
    const d = screen.getPrimaryDisplay();
    sharer.add("session", {
      os: release(),
      displays: screen.getAllDisplays().length,
      display: { width: d.size.width, height: d.size.height, scale: d.scaleFactor },
      ocr: process.env.TLI_OCR === "windows" ? "windows" : "tesseract",
      log: logBy,
      calibratedChests: config.calibration?.chests ?? 0,
    });
  };
  let captureShared = false;
  const frameName = (file?: string) => (file && keepFrames ? basename(file) : undefined);
  // Grabs and reads go through one PowerShell process that is started when a choice screen opens
  // and stopped 20 s after its last request, so a click frame lands in ~0.1 s instead of ~0.5 s.
  const worker = new CaptureWorker({ onLog: (m) => console.log(`[worker] ${m}`) });
  // Text is read by Tesseract.js (English model shipped with the tool, no Windows language pack
  // needed). TLI_OCR=windows uses Windows OCR through the worker instead (comparison, development).
  const tesseract = new TesseractOcr();
  const ocr = process.env.TLI_OCR === "windows"
    ? (paths: string[], regions?: Parameters<typeof ocrImages>[1]) => worker.ocr(paths, regions)
    : (paths: string[], regions?: Parameters<typeof ocrImages>[1], kind?: ScreenKind) => tesseract.ocrImages(paths, regions, kind);
  // Frames come from a share of the game window (its own pixels, nothing on top, game needn't be
  // in front); the worker's screen copy is the fallback when Windows won't share the window.
  const capture = new GameCapture({
    worker,
    page: resolve(import.meta.dirname, "capture.html"),
    preload: resolve(import.meta.dirname, "capture-preload.cjs"),
    onLog: (m) => console.log(`[capture] ${m}`),
  });
  let fallbackNoted = false;

  /** Grabs a frame and remembers where the game window is, so drawings line up with it. */
  const grabAs = (screenName: string) => async (trigger: string): Promise<GrabResult> => {
    const path = keepFrames || keepOwned(trigger) ? dataset.framePath(screenName, trigger) : join(scratch, `${screenName}_${Date.now()}.jpg`);
    if (lastFrame?.used && !keepFrames) void drop(lastFrame.path);
    lastFrame = { screen: screenName, path, read: null, used: false };
    let g = await capture.grab(path);
    let via = "share";
    if (!g.ok && g.reason.startsWith("no window share")) {
      if (!fallbackNoted) console.log(`[capture] ${g.reason}; using the screen copy (game must be in front)`);
      fallbackNoted = true;
      g = await worker.grab(path);
      via = "copy";
    }
    if (g.ok && !captureShared) {
      // Once a session: the game's size and how frames are taken on this PC.
      captureShared = true;
      record("capture", { width: g.width, height: g.height, via });
    }
    if (!g.ok) record("skipped", { screen: screenName, trigger, reason: g.reason });
    if (g.ok !== windowSeen && (g.ok || g.reason === "game window not found")) {
      windowSeen = g.ok;
      refreshHealth();
    }
    if (g.ok && g.x !== undefined && g.y !== undefined && !win.isDestroyed()) {
      const dip = screen.screenToDipRect(null, { x: g.x, y: g.y, width: g.width, height: g.height });
      // Follow the game to whichever monitor it is on (the window starts on the primary one).
      const target = screen.getDisplayMatching(dip).bounds;
      const b = win.getBounds();
      if (b.x !== target.x || b.y !== target.y || b.width !== target.width || b.height !== target.height) win.setBounds(target);
      state.game = { x: dip.x - target.x, y: dip.y - target.y, width: dip.width, height: dip.height };
    }
    return g;
  };

  const demoMode = process.argv.includes("--demo");
  // The demo must not touch the real cycle state, so it gets a throwaway history folder.
  const historyDir = demoMode ? join(tmpdir(), "tli-overlay-demo-history") : join(USER_DIR, "history");
  const pickLabel = (c: TrackedCard) => ({ rarity: c.rarity, label: c.unread ? "unread card" : label(c.effect) });
  let lastRead: SealWhisperRead | null = null;

  const tracker = new PickTracker({
    table,
    config,
    historyDir,
    onEvent: (e: TrackerEvent) => {
      if (e.kind === "advice") {
        showAdvice(e);
        record("advice", {
          pick: e.pick,
          ranked: e.ranked.map((r) => ({ id: r.candidate.id, effect: r.candidate.entry.text, rarity: r.candidate.entry.rarity, expected: r.expected, final: r.final, now: r.now, nowPct: r.nowPct, combo: r.combo, tier: r.tier, tie: r.tie })),
          switchOutlook: e.switchOutlook,
        });
      } else if (e.kind === "picked") {
        record("picked", { ...e.record });
        state.picks = tracker.currentPicks.map(pickLabel);
        refreshSetScore();
        state.askGoal = false; // a pick was made: the shown goal stays for this cycle
        const p = e.record.picked;
        state.status = p ? `Picked ${label(p.effect)}${e.record.assumed ? " (assumed)" : ""}` : "Pick not recognised";
      } else if (e.kind === "cycleDone") {
        record("cycleDone", { cycle: e.cycle, picks: e.picks });
        state.status = `Cycle ${e.cycle} complete`;
        state.cycle = e.cycle + 1;
        state.picks = [];
        state.setScore = null;
        state.askGoal = true; // new cycle: ask what to farm (last goal stays selected)
      } else if (e.kind === "chest") {
        record("chest", { ...e.record });
        // The feedback loop: what the chest held against what the model expected for these picks.
        const r = chestReport(e.record, config);
        state.lastChest = { cycle: e.record.cycle, ...r.actual, fe: r.actualFe, modelFe: r.modelFe };
        state.status = `Chest of cycle ${e.record.cycle} recorded`;
        showPanelFor(20_000);
        recalibrate(); // one more chest: refit the base amounts
      } else {
        record("bossRun", { ...e.record });
        state.status = "Invitation boss run recorded";
      }
      send();
    },
  });
  /** The picks so far as a multiple of a chest with no Whispers, for the panel. */
  function refreshSetScore() {
    const mods = tracker.currentPicks.map((p) => parseModifier(p.effect)).filter((m) => m !== null);
    state.setScore = mods.length ? setScore(mods, configForGoal(config, tracker.goal)) : null;
  }
  await tracker.load();
  state.cycle = tracker.summary().cycle;
  state.picks = tracker.currentPicks.map(pickLabel);
  state.goal = tracker.goal;
  refreshSetScore();
  state.goals = config.goals.list.map(({ id, label }) => ({ id, label }));
  state.askGoal = tracker.currentPicks.length === 0;

  // The game keeps mouse events to itself (forwarded mouse moves barely arrive), so poll the
  // cursor position and make the window clickable only while it is inside the panel.
  let panelRect: { x: number; y: number; width: number; height: number } | null = null;
  let interactive = false;
  ipcMain.on("panelRect", (_e, rect: typeof panelRect) => (panelRect = rect));
  const cursorPoll = setInterval(() => {
    // The window closes when the app quits (or a --demo ends): stop polling instead of touching it.
    if (win.isDestroyed()) return clearInterval(cursorPoll);
    const c = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const [x, y] = [c.x - b.x, c.y - b.y];
    const r = panelRect;
    const inside = r !== null && x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
    if (inside === interactive) return;
    interactive = inside;
    win.setIgnoreMouseEvents(!inside);
  }, 100);
  ipcMain.on("goal", (_e, goal: string) => {
    tracker.setGoal(goal); // re-ranks the cards on screen
    state.goal = goal;
    refreshSetScore();
    state.askGoal = false;
    record("goal", { goal, cycle: tracker.summary().cycle, picks: tracker.currentPicks.length });
    send();
  });

  /** Refits the advisor from the history files; the config object is updated in place and saved. */
  let calibrating: Promise<void> = Promise.resolve();
  function recalibrate(): Promise<void> {
    if (demoMode) return Promise.resolve();
    calibrating = calibrating
      .then(async () => {
        // The history lines that triggered this are still being appended: wait for them.
        await Promise.all([tracker.flush(), salvage.flush()]);
        const c = await autoCalibrate(config, historyDir);
        console.log(`calibrated: ${c.chests} chests, ${c.screens} screens, ${c.flames} flames, ${c.salvaged ?? 0} memories salvaged`);
      })
      .catch((err) => console.error(`calibration: ${err}`));
    return calibrating;
  }

  let panelTimer: NodeJS.Timeout | undefined;
  /** Keeps the panel on screen for a while (e.g. to read the chest result in the Terminal). */
  function showPanelFor(ms: number) {
    state.showPanel = true;
    clearTimeout(panelTimer);
    panelTimer = setTimeout(() => {
      state.showPanel = false;
      send();
    }, ms);
  }

  function showAdvice(e: Extract<TrackerEvent, { kind: "advice" }>) {
    if (!lastRead) return;
    const { ranked } = e;
    const picked = e.picked.map((p) => parseModifier(p.effect)).filter((m) => m !== null);
    const focus = config.goals.list.find((g) => g.id === e.goal)?.focus;
    const three = ranked.filter((r) => r.candidate.id !== "switch");
    state.cards = three.map((r, i) => ({
      slot: r.candidate.id,
      rarity: lastRead!.cards.find((c) => c.slot === r.candidate.id)?.rarity ?? r.candidate.entry.rarity,
      label: describeModifier(r.modifier),
      rank: i + 1,
      tie: r.tie,
      reason: reasonFor(r, picked, focus),
      tier: r.tier,
      final: r.final,
      nowPct: r.nowPct,
    }));
    const sw = ranked.find((r) => r.candidate.id === "switch");
    // diff null = the 3 cards weren't read (e.g. started on the Switch view): nothing to compare with.
    state.switchCard = sw
      ? {
          rarity: sw.candidate.entry.rarity,
          label: describeModifier(sw.modifier),
          diff: three[0] ? sw.expected - three[0].expected : null,
          tie: sw.tie,
          tier: sw.tier,
          final: sw.final,
          nowPct: sw.nowPct,
        }
      : null;
    state.setScore = e.setScore;
    state.switchHint = e.switchOutlook ? { chance: e.switchOutlook.chance } : null;
    state.screen = "cards";
    const unread = tracker.currentPicks.filter((p) => p.id === "log").length;
    state.status = `Pick ${tracker.currentPicks.length + 1}/6${unread ? ` · open "Seal Whispers Owned" to read ${unread} earlier pick${unread > 1 ? "s" : ""}` : ""}`;
  }

  const onCards = (e: SealWhisperEvent) => {
    if (e.kind === "read") {
      record("cards", {
        trigger: e.trigger,
        frame: frameName(e.file),
        view: e.read.view,
        cards: e.read.cards.map((c) => ({ slot: c.slot, type: c.type, rarity: c.rarity, doubled: c.doubled, ocr: c.effectText, effect: c.match?.entry.text ?? null })),
      });
      lastRead = e.read;
      state.view = e.read.view === "switch" ? "switch" : "three";
      tracker.onCards(e.read); // -> advice -> send
      return;
    }
    if (e.kind === "owned") {
      record("owned", {
        frame: e.file ? basename(e.file) : undefined, // kept in the dataset either way
        count: e.read.count,
        whispers: e.read.whispers.map((w) => ({ rarity: w.rarity, doubled: w.doubled, ocr: w.text, effect: w.match?.entry.text ?? null })),
      });
      // -> advice (when cards are on screen) -> send
      if (tracker.onOwned(e.read)) {
        state.picks = tracker.currentPicks.map(pickLabel);
        refreshSetScore();
        state.status = `Read ${e.read.whispers.length} Seal Whispers from the panel`;
        send();
      }
      return;
    }
    if (e.kind === "selected") {
      tracker.onSelected(e.slot);
      record("selected", { slot: e.slot, brightness: e.brightness, outline: e.outline, frame: frameName(e.file) });
      return;
    }
    if (e.kind === "skipped") {
      // No click frame is coming: a Confirm waiting for it can resolve now.
      if (e.trigger === "select") tracker.onSelected(null);
      state.status = `Not read: ${e.reason}`;
    } else if (e.kind === "hidden") {
      // Handbook open over the cards: draw nothing; closing it re-reads the screen.
      state.screen = "none";
    } else {
      state.screen = "none";
      state.cards = [];
      state.switchCard = null;
      lastRead = null;
    }
    send();
  };

  const flameText = (effect: FlameEffect | null, icon: string | null) =>
    effect ? FLAME_LABEL[effect.id] ?? effect.id : `${effects.filter((x) => x.icon === icon).map((x) => FLAME_LABEL[x.id] ?? x.id).join(" / ") || "unknown"} ?`;

  // The flame put in, until the game logs its round's altar id (selectAltarId) ~15 s later: the
  // pairs, in black-sail-altar-ids.jsonl, show which flame each id stands for.
  let lastChosen: { at: number; entry: { effect: string | null; text: string; certain: boolean } } | null = null;
  const onFlames = (e: FlameEvent) => {
    if (e.kind === "altar") {
      const chosen = lastChosen && Date.now() - lastChosen.at < 60_000 ? lastChosen.entry : null;
      lastChosen = null; // one id per flame
      const pair = { time: new Date().toISOString(), altarId: e.id, effect: chosen?.effect ?? null, text: chosen?.text ?? null, certain: chosen?.certain ?? false };
      record("altarId", pair);
      appendFile(join(historyDir, "black-sail-altar-ids.jsonl"), JSON.stringify(pair) + "\n").catch((err) => console.error(`altar history: ${err}`));
      return;
    }
    if (e.kind === "flames") {
      record("flames", {
        trigger: e.trigger,
        frame: frameName(e.file),
        slots: e.read.slots,
        selectedText: e.read.selectedText,
        selected: e.read.selected?.effect.id ?? null,
        offers: e.offers.map((o) => ({ slot: o.slot, icon: o.icon, effect: o.effect?.id ?? null, confirmed: o.confirmed })),
      });
      state.screen = "flames";
      // Which flame to put in: the best known effect (flameScore, research-based priority).
      const goal = tracker.goal;
      const known = e.offers.filter((o) => o.effect);
      const bestScore = Math.max(-1, ...known.map((o) => flameScore(o.effect!.id, goal)));
      const best = known.find((o) => flameScore(o.effect!.id, goal) === bestScore);
      // An unread shared icon ("S", crystal) might hide something better: say so.
      const maybeBetter = e.offers.find((o) => !o.effect && effects.some((x) => x.icon === o.icon && flameScore(x.id, goal) > bestScore));
      state.flames = e.offers
        .filter((o) => o.slot !== null)
        .map((o) => {
          const [x, y] = FLAME_SLOTS[o.slot!]!;
          const tier = o.effect ? flameTier(o.effect.id, goal) : null;
          return { x, y, side: o.slot! < 5 ? "left" : "right", label: flameText(o.effect, o.icon), confirmed: o.confirmed, kind: o.effect?.kind ?? null, best: o === best, tier };
        });
      const unplaced = e.offers.filter((o) => o.slot === null && o.effect).map((o) => flameText(o.effect, null));
      state.status = maybeBetter
        ? `Click the slot ${maybeBetter.slot} flame: it might beat ${best ? flameText(best.effect, null) : "the others"}`
        : best
          ? `Put in: ${flameText(best.effect, null)}${unplaced.length ? ` · also read: ${unplaced.join(", ")}` : ""}`
          : "Click flames to confirm their effect";
    } else if (e.kind === "chosen") {
      const what = e.effect ? FLAME_LABEL[e.effect.id] ?? e.effect.id : `unknown flame "${e.selectedText}"`;
      state.status = `Put in: ${what}${e.certain ? "" : " (uncertain)"}`;
      const entry = { time: new Date().toISOString(), effect: e.effect?.id ?? null, text: e.selectedText, numbers: e.numbers, certain: e.certain };
      record("flameChosen", entry);
      lastChosen = { at: Date.now(), entry };
      appendFile(join(historyDir, "black-sail-flames.jsonl"), JSON.stringify(entry) + "\n").catch((err) => console.error(`flame history: ${err}`));
    } else if (e.kind === "skipped") state.status = `Not read: ${e.reason}`;
    else {
      state.screen = "none";
      state.flames = [];
    }
    send();
  };

  // --demo <screenshot> [out.png]: read a saved screenshot through the real readers + advisor,
  // draw the overlay over it, save a picture and quit (to check the drawing without the game).
  const demo = process.argv.indexOf("--demo");
  if (demo >= 0) {
    const image = resolve(process.argv[demo + 1]!);
    const out = resolve(process.argv[demo + 2] ?? join(import.meta.dirname, "../../reports/overlay-demo.png"));
    win.setBounds({ x: 0, y: 0, width: 1920, height: 1080 });
    state.game = { x: 0, y: 0, width: 1920, height: 1080 };
    // The picture shows the advice with green lights, as when playing (no status card).
    state.health = { ...state.health, game: "ok", gameText: "Window found", log: "ok", logText: "Enable Log on", ready: true, show: false };
    win.webContents.send("background", pathToFileURL(image).href);
    const [page] = await ocrImages([image], FLAME_REGIONS);
    const cards = readSealWhisperPage(page!, table);
    const flames = readFlamePage(page!, icons, effects);
    const goalArg = process.argv.indexOf("--goal");
    if (goalArg >= 0) {
      tracker.setGoal(process.argv[goalArg + 1]!);
      state.goal = tracker.goal;
      state.askGoal = false;
    }
    if (cards.view !== "none") onCards({ kind: "read", trigger: "open", read: cards, ms: 0 });
    else if (flames.slots.length) {
      const fw = new FlameWatcher({ grab: async () => ({ ok: false, reason: "demo" }), ocr: ocrImages, icons, effects, onEvent: onFlames });
      fw.learn(flames);
      onFlames({ kind: "flames", trigger: "open", read: flames, offers: fw.summary().offers, ms: 0 });
    }
    await new Promise((r) => setTimeout(r, 500));
    await writeFile(out, (await win.webContents.capturePage()).toPNG());
    console.log(`demo: ${out}`);
    app.quit();
    return;
  }

  // Hero Memory salvages go to the history, so the automatic calibration keeps the memory value current.
  const salvage = new SalvageTracker({
    historyDir,
    onEvent: (r) => {
      record("salvage", { ...r });
      const n = Object.values(r.memories).reduce((a, b) => a + b, 0);
      state.status = `Salvaged ${n} Hero Memories (recorded)`;
      showPanelFor(8_000);
      send();
      recalibrate(); // more salvages: refit the Hero Memory value
    },
  });
  // --probe-capture <dir>: with the game running, save one frame from the window share and one
  // screen copy while the overlay shows a notice, print both results and quit (checks the two
  // capture paths and the content protection without playing).
  const probe = process.argv.indexOf("--probe-capture");
  if (probe >= 0) {
    const dir = resolve(process.argv[probe + 1] ?? join(import.meta.dirname, "../../reports"));
    await mkdir(dir, { recursive: true });
    state.notice = "CONTENT PROTECTION PROBE: this box must not appear in screen-copy.jpg";
    send();
    await new Promise((r) => setTimeout(r, 800));
    const t0 = Date.now();
    const a = await capture.grab(join(dir, "window-share.jpg"));
    console.log(`probe window share: ${JSON.stringify(a)} in ${Date.now() - t0} ms`);
    const t1 = Date.now();
    const b = await capture.grab(join(dir, "window-share-2.jpg"));
    console.log(`probe window share again: ${b.ok ? "ok" : b.reason} in ${Date.now() - t1} ms`);
    const t2 = Date.now();
    const c = await worker.grab(join(dir, "screen-copy.jpg"));
    console.log(`probe screen copy: ${JSON.stringify(c)} in ${Date.now() - t2} ms`);
    capture.dispose();
    worker.stop();
    app.quit();
    return;
  }

  // Ctrl+C in the terminal: let the last history / dataset lines reach the disk (at most 2 s), then
  // quit normally so the window share, the worker and Tesseract are shut down too.
  // The tray menu's Quit does the same.
  const quit = () => {
    void Promise.race([Promise.all([tracker.flush(), salvage.flush(), dataset.flush(), sharer.flush()]), new Promise((r) => setTimeout(r, 2000))]).finally(() => app.quit());
  };
  process.on("SIGINT", quit);
  process.on("unhandledRejection", (err) => console.error(`unhandled: ${err instanceof Error ? err.stack : err}`));

  const engine = new Engine([
    warmOnScreens(worker, capture, tesseract),
    new FlameWatcher({ grab: grabAs("voidbeacon"), ocr, done, icons, effects, onEvent: onFlames }),
    new SealWhisperWatcher({ grab: grabAs("voidport"), ocr, done, table, onEvent: onCards }),
    tracker,
    salvage,
  ]);

  console.log(`log file (${found?.by ?? "not found"}): ${found?.path ?? "-"}`);
  logBy = found?.by ?? "not found";
  shareSession();
  // Lights right away (the first scan of old logs below can take seconds).
  logWritten = found ? await stat(found.path).then((s) => s.mtimeMs, () => 0) : 0;
  await readGameLog();
  refreshHealth();
  send();

  // Salvages from before the tool ran (old logs, and this session's log so far), once per log.
  if (!demoMode && found) {
    state.notice = "Reading earlier game logs…";
    send();
    const t0 = Date.now();
    try {
      const r = await scanLogsForSalvage(dirname(found.path), historyDir);
      console.log(`log scan: ${r.added} new salvage batches (${r.memories} memories) in ${Date.now() - t0} ms`);
    } catch (err) {
      console.error(`log scan: ${err}`);
    }
    state.notice = null;
    await recalibrate();
  }
  // Read the log written so far this game session for stack sizes only, so the first pickup of
  // a stack already in the bag (Threads, Compasses) is counted after a restart.
  const follow = async (path: string) => {
    logDetail.reset();
    const scan = new CycleScanner();
    const t = new LogTailer(
      path,
      (line) => {
        logDetail.note(line);
        engine.feed(line);
      },
      {
        fromEnd: true,
        // This session's lines from before the overlay started: the login's log state is among them.
        prime: (line) => {
          logDetail.note(line);
          engine.prime(line);
          scan.line(line);
        },
        // Started mid-cycle: catch up on picks and chests from the logs, and read a screen already open.
        primed: async () => {
          try {
            const cycle = await cycleFromLogs(scan, path, tracker.lastSaved);
            if (!cycle) console.log("cycle: no Terminal visit in the logs, saved cycle kept");
            else if (tracker.reconcile(cycle)) {
              console.log(`cycle: caught up from the logs, ${cycle.picks.length} picks since the last Terminal visit`);
              state.cycle = tracker.summary().cycle;
              state.picks = tracker.currentPicks.map(pickLabel);
              refreshSetScore();
              state.askGoal = tracker.currentPicks.length === 0;
              state.status = `Caught up from the game log: pick ${tracker.currentPicks.length + 1}/6`;
              send();
            }
            if (scan.openScreen && (await gameRunning())) engine.feed(scan.openScreen);
          } catch (err) {
            console.error(`cycle catch-up: ${err instanceof Error ? err.stack : err}`);
          }
        },
        onRotate: () => logDetail.reset(),
      },
    );
    const t0 = Date.now();
    await t.start();
    console.log(`log read in ${Date.now() - t0} ms`);
    return t;
  };
  let tailer = found ? await follow(found.path) : null;
  logWritten = found ? await stat(found.path).then((s) => s.mtimeMs, () => 0) : 0;
  refreshHealth();
  send();

  // Every 5 s: is the game running, is its window there, which log, is it being written. The game
  // creates UE_game.log on start, and only with logging on; a log unchanged for 2 minutes of play
  // is an old one left from before logging was turned off.
  let looking = false;
  let lookPending = false;
  const lookAgain = async (): Promise<void> => {
    if (win.isDestroyed()) return;
    if (looking) {
      lookPending = true;
      return;
    }
    looking = true;
    try {
      const running = await gameRunning();
      if (running && !gameSince) {
        gameSince = Date.now();
        program = await gameProgram(); // once per game start
        console.log(`game started: ${program ?? "program not readable"}`);
      } else if (!running) [gameSince, program, windowSeen] = [0, null, false];
      // The window appears a while after the process: asked until seen (one PowerShell helper,
      // kept warm between asks, stopped 20 s after the last).
      if (running && !windowSeen) windowSeen = await worker.window().then((w) => w.ok, () => false);
      const next = search();
      if (next?.path !== found?.path) {
        console.log(`log file (${next?.by ?? "not found"}): ${next?.path ?? "-"}`);
        tailer?.stop();
        found = next;
        tailer = found ? await follow(found.path) : null;
      }
      logWritten = found ? await stat(found.path).then((s) => s.mtimeMs, () => 0) : 0;
      await readGameLog(); // two tiny files; the game rewrites them at each start
      if (refreshHealth()) send();
      refreshTray();
    } finally {
      looking = false;
    }
    if (lookPending) {
      lookPending = false;
      await lookAgain();
    }
  };
  const gamePoll = setInterval(() => void lookAgain(), 5000);

  // The first-start question (panel), and the tray's switch.
  const setSharing = async (on: boolean) => {
    await sharer.setShare(on);
    if (on) shareSession(); // this session's details, now that they may be sent
    refreshShare();
    state.status = on ? "Sharing anonymous data: thank you!" : "Not sharing data";
    refreshTray();
    send();
  };
  ipcMain.on("share", (_e, on: boolean) => void setSharing(!!on));

  // Report a wrong read: the last frame (shrunk to fit the collector) and what was read from it,
  // with the player's note. Sent only when the player presses Send, sharing on or off.
  let reportWin: BrowserWindow | null = null;
  let pending: { screen: string; read: Record<string, unknown> | null; image: Buffer } | null = null;
  async function openReport() {
    if (!sharer.available) return;
    if (reportWin) return reportWin.focus();
    const f = lastFrame;
    if (!f || !existsSync(f.path)) {
      state.status = "Nothing to report yet: the report takes the last Black Sail screen read";
      showPanelFor(6000);
      return send();
    }
    const full = nativeImage.createFromPath(f.path);
    if (full.isEmpty()) {
      // Unreadable (deleted or still being written): nothing to show or send.
      state.status = "The last screen could not be read for a report, try again on the next one";
      showPanelFor(6000);
      return send();
    }
    const img = full.getSize().width > 1600 ? full.resize({ width: 1600, quality: "good" }) : full;
    let quality = 85;
    let jpeg = img.toJPEG(quality);
    while (jpeg.length > MAX_IMAGE && quality > 25) jpeg = img.toJPEG((quality -= 10));
    if (jpeg.length > MAX_IMAGE) jpeg = img.resize({ width: 1000, quality: "good" }).toJPEG(60);
    pending = { screen: f.screen, read: f.read, image: jpeg };
    const w = (reportWin = new BrowserWindow({
      width: 600,
      height: 760,
      title: "Report a wrong read",
      autoHideMenuBar: true,
      icon: resolve(import.meta.dirname, "icon.png"),
      webPreferences: { preload: resolve(import.meta.dirname, "report-preload.cjs") },
    }));
    w.setAlwaysOnTop(true, "screen-saver"); // above the game and the overlay
    w.on("closed", () => {
      reportWin = null;
      pending = null;
    });
    await w.loadFile(resolve(import.meta.dirname, "report.html")).catch(() => undefined);
    // Closed while it loaded: nothing to fill in.
    if (w.isDestroyed()) return;
    w.webContents.send("report:init", {
      image: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
      read: f.read ? JSON.stringify(f.read, null, 1) : "(nothing was read from this screen)",
    });
  }
  ipcMain.on("report", () => void openReport());
  ipcMain.handle("report:send", async (_e, text: string) => {
    // Kept here: closing the window while it sends clears `pending`.
    const report = pending;
    if (!report) return "Nothing to send";
    const err = await sharer.report({ ...report, text: String(text ?? "").slice(0, 2000) });
    if (!err) record("reported", { screen: report.screen });
    return err;
  });
  if (sharer.available && !globalShortcut.register("CommandOrControl+Shift+R", () => void openReport())) console.log("Ctrl+Shift+R is taken by another program");

  // Tray icon: the overlay has no window of its own to close, so this is where it is controlled.
  tray = new Tray(nativeImage.createFromPath(resolve(import.meta.dirname, "icon.png")));
  tray.setToolTip(tooltip);
  let trayKey = "";
  function refreshTray() {
    const key = JSON.stringify([found?.by, found?.path, settings.logPath, sharer.on]);
    if (!tray || key === trayKey) return;
    trayKey = key;
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: found ? `Log: ${found.by}` : "Log: not found", enabled: false },
        {
          label: "Choose UE_game.log…",
          click: async () => {
            const res = await dialog.showOpenDialog({
              title: "Choose UE_game.log",
              defaultPath: found?.path,
              properties: ["openFile"],
              filters: [{ name: "Torchlight: Infinite log", extensions: ["log"] }],
            });
            if (res.canceled || !res.filePaths[0]) return;
            settings.logPath = res.filePaths[0];
            await saveSettings(settings);
            await lookAgain();
          },
        },
        ...(settings.logPath
          ? [{ label: "Find the log automatically", click: async () => { settings.logPath = null; await saveSettings(settings); await lookAgain(); } }]
          : []),
        { type: "separator" },
        ...(sharer.available
          ? [
              { label: "Share anonymous data", type: "checkbox" as const, checked: sharer.on, click: () => void setSharing(!sharer.on) },
              { label: "Report a wrong read (Ctrl+Shift+R)", click: () => void openReport() },
              {
                label: "Show what was shared",
                click: async () => {
                  const out = join(USER_DIR, "shared-export.json");
                  await sharer.exportShared(out);
                  await shell.openPath(out);
                },
              },
              {
                label: "Delete my shared data",
                click: async () => {
                  const { response } = await dialog.showMessageBox({
                    type: "question",
                    buttons: ["Delete", "Cancel"],
                    defaultId: 1,
                    message: "Delete everything this PC shared (records and reports) from the collector?",
                  });
                  if (response !== 0) return;
                  await dialog.showMessageBox({ message: await sharer.forget() });
                },
              },
              { type: "separator" as const },
            ]
          : []),
        { label: "Quit", click: quit },
      ]),
    );
  }
  refreshTray();

  app.on("second-instance", () => {
    showUntil = Date.now() + 8000;
    refreshHealth();
    send();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    // No more polls while quitting: one could start the PowerShell helper again after its stop.
    clearInterval(gamePoll);
    clearInterval(cursorPoll);
    clearTimeout(hideTimer);
    globalShortcut.unregisterAll();
    capture.dispose();
    worker.stop();
    void tesseract.stop();
  });
}

main().catch((err) => {
  console.error(err);
  app.quit();
});
