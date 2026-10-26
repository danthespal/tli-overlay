// Overlay main process: runs the Black Sail engine (log triggers, readers, advisor, tracker) and
// sends a small "what to draw" state to a transparent, click-through window over the game.
// Started by start.mjs (registers tsx so this TypeScript runs as-is).

import { app, BrowserWindow, ipcMain, screen } from "electron";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Dataset } from "../capture/dataset.js";
import type { GrabResult } from "../capture/windowCapture.js";
import { CaptureWorker, warmOnScreens } from "../capture/worker.js";
import { GameCapture } from "../capture/gameCapture.js";
import { LOG_DIR } from "../config.js";
import { USER_DIR } from "../paths.js";
import { Engine } from "../engine/engine.js";
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
}

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
  const scratch = join(tmpdir(), "tli-overlay");
  await mkdir(scratch, { recursive: true });
  const done = keepFrames ? undefined : (file: string) => rm(file, { force: true });
  const record = (kind: string, data: Record<string, unknown>) => dataset.record(kind, data);
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
    const path = keepFrames ? dataset.framePath(screenName, trigger) : join(scratch, `${screenName}_${Date.now()}.jpg`);
    let g = await capture.grab(path);
    if (!g.ok && g.reason.startsWith("no window share")) {
      if (!fallbackNoted) console.log(`[capture] ${g.reason}; using the screen copy (game must be in front)`);
      fallbackNoted = true;
      g = await worker.grab(path);
    }
    if (!g.ok) record("skipped", { screen: screenName, trigger, reason: g.reason });
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
    state.status = `Pick ${tracker.currentPicks.length + 1}/6`;
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

  const onFlames = (e: FlameEvent) => {
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
  process.on("SIGINT", () => {
    void Promise.race([Promise.all([tracker.flush(), salvage.flush(), dataset.flush()]), new Promise((r) => setTimeout(r, 2000))]).finally(() => app.quit());
  });

  const engine = new Engine([
    warmOnScreens(worker, capture, tesseract),
    new FlameWatcher({ grab: grabAs("voidbeacon"), ocr, done, icons, effects, onEvent: onFlames }),
    new SealWhisperWatcher({ grab: grabAs("voidport"), ocr, done, table, onEvent: onCards }),
    tracker,
    salvage,
  ]);

  // Salvages from before the tool ran (old logs, and this session's log so far), once per log.
  if (!demoMode) {
    state.notice = "Reading earlier game logs…";
    send();
    const t0 = Date.now();
    try {
      const r = await scanLogsForSalvage(LOG_DIR, historyDir);
      console.log(`log scan: ${r.added} new salvage batches (${r.memories} memories) in ${Date.now() - t0} ms`);
    } catch (err) {
      console.error(`log scan: ${err}`);
    }
    state.notice = null;
    await recalibrate();
  }
  let waitingForLog = false;
  const tailer = new LogTailer(
    join(LOG_DIR, "UE_game.log"),
    (line) => {
      if (waitingForLog) {
        waitingForLog = false;
        state.notice = null;
        send();
      }
      engine.feed(line);
    },
    // Read the log written so far this game session for stack sizes only, so the first pickup of
    // a stack already in the bag (Threads, Compasses) is counted after a restart.
    { fromEnd: true, prime: (line) => engine.prime(line) },
  );
  const t0 = Date.now();
  await tailer.start();
  console.log(`log read in ${Date.now() - t0} ms`);
  if (!tailer.hasFile) {
    // The game creates the log on start, and only with logging on; keep polling until it appears.
    waitingForLog = true;
    state.notice = "Waiting for UE_game.log (in game: Settings → Other → Enable Log)";
  }
  send();

  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    capture.dispose();
    worker.stop();
    void tesseract.stop();
  });
}

main().catch((err) => {
  console.error(err);
  app.quit();
});
