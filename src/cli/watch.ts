// Follows the live game log and reads the Black Sail choice screens when they open.
//
//   npm run watch            -> follow UE_game.log, grab one frame per trigger, print what's offered
//   npm run watch -- --keep  -> also keep each grabbed frame in reports/frames/ (for debugging)
//   npm run watch -- --once  -> grab the game window right now and read it (test the pipeline)
//
// Triggers: anchor screen (VoidBeacon) opening / a flame clicked, Seal Whisper screen (VoidPort)
// opening / Switch pressed. Nothing is captured at any other time.

import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CaptureWorker, warmOnScreens } from "../capture/worker.js";
import { KNOWN_ITEMS, LOG_DIR } from "../config.js";
import { chestReport } from "../modules/black-sail/calibrate.js";
import { reasonFor } from "../modules/black-sail/reasons.js";
import { parseModifier } from "../modules/black-sail/modifiers.js";
import { Engine } from "../engine/engine.js";
import { LogTailer } from "../engine/logReader.js";
import { loadAdvisorConfig, PICKS_PER_CYCLE, type AdvisorConfig } from "../modules/black-sail/advisor.js";
import { loadEffectTable } from "../modules/black-sail/effects.js";
import { PickTracker, type TrackerEvent } from "../modules/black-sail/pickTracker.js";
import { SalvageTracker, type SalvageRecord } from "../modules/black-sail/salvageTracker.js";
import { FLAME_REGIONS, loadFlameEffects, loadIconRefs, readFlamePage, type FlameEffect } from "../modules/black-sail/flameReader.js";
import { FlameWatcher, type FlameEvent, type FlameOffer } from "../modules/black-sail/flameWatcher.js";
import { readSealWhisperPage, type SealWhisperRead } from "../modules/black-sail/sealWhisperReader.js";
import { SealWhisperWatcher, type SealWhisperEvent } from "../modules/black-sail/sealWhisperWatcher.js";
import { ocrImages } from "../ocr/windowsOcr.js";
import { TesseractOcr, type ScreenKind } from "../ocr/tesseractOcr.js";
import { formatFlames } from "./read-flames.js";

const keep = process.argv.includes("--keep");
const once = process.argv.includes("--once");
const frameDir = keep ? resolve(import.meta.dirname, "../../reports/frames") : join(tmpdir(), "tli-overlay");
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const time = () => new Date().toLocaleTimeString();

function printRead(read: SealWhisperRead): void {
  if (read.view === "none") return console.log("  (no cards on screen)");
  for (const c of read.cards) {
    const m = c.match;
    const effect = m ? (c.doubled ? m.entry.doubledText : m.entry.text) : `? "${c.effectText}"`;
    const rarity = m ? m.entry.rarity : "?";
    console.log(`  ${c.slot.padEnd(6)} ${rarity.padEnd(6)} ${String(c.type ?? "?").padEnd(12)} ${effect}`);
  }
}

function printOffers(offers: FlameOffer[], effects: FlameEffect[]): void {
  for (const o of offers) {
    const options = effects.filter((e) => e.icon === o.icon).map((e) => e.id);
    const what = o.effect ? o.effect.text : `one of ${options.join(" / ")} (click it to read)`;
    const state = o.confirmed ? `read ${JSON.stringify(o.numbers)}` : o.effect ? "from icon" : "?";
    console.log(`  slot ${o.slot ?? "?"}  ${(o.icon ?? "?").padEnd(13)} ${what}  [${state}]`);
  }
}

const onTracker = (config: AdvisorConfig) => (e: TrackerEvent): void => {
  if (e.kind === "advice") {
    if (!e.ranked.length) return;
    console.log(`  Advice for pick ${e.pick}/${PICKS_PER_CYCLE} (expected final value, ${e.picked.length} picked so far, set ×${e.setScore.toFixed(2)}):`);
    const picked = e.picked.map((p) => parseModifier(p.effect)).filter((m) => m !== null);
    const focus = config.goals.list.find((g) => g.id === e.goal)?.focus;
    e.ranked.forEach((r, i) => {
      const combo = Math.abs(r.combo) >= 0.05 ? `, combo ${r.combo > 0 ? "+" : ""}${r.combo.toFixed(1)}` : "";
      console.log(`   ${i === 0 ? "->" : "  "} [${r.tier}] ${r.candidate.id.padEnd(6)} final ×${r.final.toFixed(2)}  (now ${r.nowPct >= 0 ? "+" : ""}${r.nowPct.toFixed(0)}% chest${combo})${r.tie ? "  ≈ tie" : ""}  ${reasonFor(r, picked, focus)}`);
    });
    if (e.switchOutlook) {
      const o = e.switchOutlook;
      console.log(o.chance > 0 ? `   Switch: worth a look (${Math.round(o.chance * 100)}% chance it beats the best, +${o.gain.toFixed(1)} expected)` : "   Switch: skip (no rarity beats the best)");
    }
  } else if (e.kind === "picked") {
    const p = e.record.picked;
    const note = e.record.assumed ? " (assumed: two cards had this rarity)" : "";
    const followed = p && p.id === e.record.recommended ? "followed advice" : `advice was ${e.record.recommended ?? "-"}`;
    console.log(`[${time()}] Picked ${e.record.pick}/${PICKS_PER_CYCLE}: ${p ? `${p.rarity} ${p.effect}` : "?"}${note}, ${followed}`);
  } else if (e.kind === "cycleDone") {
    console.log(`[${time()}] Cycle ${e.cycle} complete:`);
    for (const p of e.picks) console.log(`   ${p.rarity?.padEnd(6)} ${p.effect}`);
  } else {
    const items = Object.entries(e.record.loot).map(([id, n]) => `${KNOWN_ITEMS[+id] ?? `#${id}`} x${n}`).join(", ");
    if (e.kind === "chest") {
      console.log(`[${time()}] Void Sea Treasure (cycle ${e.record.cycle}${e.record.complete ? "" : ", picks incomplete"}): ${items}`);
      const r = chestReport(e.record, config);
      console.log(`   materials ≈ ${r.actualFe.toFixed(1)} FE, model said ${r.modelFe.toFixed(1)} (Scraps ${r.actual.scraps} vs ${r.model.scraps.toFixed(0)}, Threads ${r.actual.threads} vs ${r.model.threads.toFixed(1)}, Hero Mem ${r.actual.heroMemories} vs ${r.model.heroMemories.toFixed(1)}, Inv ${r.actual.invitations} vs ${r.model.invitations.toFixed(2)})`);
    } else console.log(`[${time()}] Invitation boss run: ${items}`);
  }
};

const onCards = (tracker: PickTracker) => (e: SealWhisperEvent): void => {
  if (e.kind === "read") {
    console.log(`[${time()}] Seal Whisper ${e.read.view === "switch" ? "Switch card" : "cards"} (${e.trigger}, ${e.ms} ms)`);
    printRead(e.read);
    tracker.onCards(e.read); // prints the advice
  } else if (e.kind === "selected") {
    tracker.onSelected(e.slot);
    console.log(`[${time()}] Card clicked: ${e.slot ?? "unclear"} (button outline ${e.outline.map((v) => (v * 100).toFixed(1) + "%").join(" / ")})`);
  } else if (e.kind === "skipped") {
    if (e.trigger === "select") tracker.onSelected(null); // no click frame is coming
    console.log(`[${time()}] Seal Whisper ${e.trigger}: skipped, ${e.reason}`);
  } else if (e.kind === "hidden") console.log(`[${time()}] Seal Whisper screen covered by the handbook`);
  else console.log(`[${time()}] Seal Whisper screen closed`);
};

const onFlames = (effects: FlameEffect[]) => (e: FlameEvent): void => {
  if (e.kind === "flames") {
    const sel = e.read.selected?.effect.id ?? `unknown flame "${e.read.selectedText}"`;
    console.log(`[${time()}] Flames (${e.trigger}, ${e.ms} ms), selected: ${sel}`);
    printOffers(e.offers, effects);
  } else if (e.kind === "chosen") {
    console.log(`[${time()}] Flame put in: ${e.effect?.id ?? `unknown "${e.selectedText}"`}${e.certain ? "" : " (uncertain)"}`);
  } else if (e.kind === "skipped") console.log(`[${time()}] Flames ${e.trigger}: skipped, ${e.reason}`);
  else console.log(`[${time()}] Flame screen closed`);
};

async function main() {
  await mkdir(frameDir, { recursive: true });
  const [table, icons, effects, config] = await Promise.all([
    loadEffectTable(),
    loadIconRefs(),
    loadFlameEffects(),
    loadAdvisorConfig(),
  ]);
  const tracker = new PickTracker({
    table,
    config,
    historyDir: resolve(import.meta.dirname, "../../data/history"),
    onEvent: onTracker(config),
  });
  await tracker.load();
  const worker = new CaptureWorker({ onLog: (m) => console.log(`[worker] ${m}`) });
  // Text is read by Tesseract.js (English model shipped with the tool, no Windows language pack
  // needed). TLI_OCR=windows uses Windows OCR through the worker instead (comparison, development).
  const tesseract = new TesseractOcr();
  const ocr = process.env.TLI_OCR === "windows"
    ? (paths: string[], regions?: Parameters<typeof ocrImages>[1]) => worker.ocr(paths, regions)
    : (paths: string[], regions?: Parameters<typeof ocrImages>[1], kind?: ScreenKind) => tesseract.ocrImages(paths, regions, kind);
  const grabAs = (screen: string) => () => worker.grab(join(frameDir, `${screen}_${stamp()}.png`));
  // Created here so Ctrl+C can wait for its pending history writes (with the tracker's).
  const salvage = new SalvageTracker({ historyDir: resolve(import.meta.dirname, "../../data/history"), onEvent: onSalvage });
  process.on("SIGINT", () => {
    worker.stop();
    void tesseract.stop();
    // The last pick / salvage line may still be on its way to disk: wait for it (at most 2 s).
    void Promise.race([Promise.all([tracker.flush(), salvage.flush()]), new Promise((r) => setTimeout(r, 2000))]).finally(() => process.exit(0));
  });
  const done = keep ? undefined : (file: string) => rm(file, { force: true });

  if (once) {
    const g = await grabAs("once")();
    if (!g.ok) return console.log(`Not captured: ${g.reason}`);
    const [page] = await ocrImages([g.file], FLAME_REGIONS);
    const cards = readSealWhisperPage(page!, table);
    const flames = readFlamePage(page!, icons, effects);
    if (cards.view !== "none") printRead(cards);
    else if (flames.slots.length) console.log(formatFlames(flames).join("\n"));
    else console.log("  (no Black Sail choice screen on the captured frame)");
    await done?.(g.file);
    return;
  }

  function onSalvage(r: SalvageRecord) {
    const n = Object.values(r.memories).reduce((a, b) => a + b, 0);
    const threads = Object.entries(r.threads).map(([id, k]) => `${k} ${KNOWN_ITEMS[+id] ?? `#${id}`}`).join(", ");
    console.log(`[${time()}] Salvaged ${n} Hero Memories -> ${threads || "nothing"}${r.scraps ? `, ${r.scraps} Scraps` : ""}${r.pure ? "" : " (mixed batch)"}`);
  }
  const engine = new Engine([
    warmOnScreens(worker, tesseract),
    new FlameWatcher({ grab: grabAs("voidbeacon"), ocr, done, icons, effects, onEvent: onFlames(effects) }),
    new SealWhisperWatcher({ grab: grabAs("voidport"), ocr, done, table, onEvent: onCards(tracker) }),
    tracker,
    salvage,
  ]);
  const log = join(LOG_DIR, "UE_game.log");
  const tailer = new LogTailer(log, (line) => engine.feed(line), { fromEnd: true, prime: (line) => engine.prime(line) });
  await tailer.start();
  console.log(tailer.hasFile ? `Watching ${log}` : `Waiting for ${log} (in game: Esc → Settings → Other → Enable Log, under Account Related; then log out and back in)`);
  console.log(`Seal Whisper cycle ${tracker.summary().cycle}: ${tracker.currentPicks.length}/${PICKS_PER_CYCLE} picked so far`);
  console.log("Open an anchor or Seal Whisper screen in game; one frame is grabbed per screen/click. Ctrl+C to stop.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
