// Tracks the Seal Whisper choices of each 6-pick cycle, asks the advisor on every screen, and
// writes every screen + pick to a history file (JSON lines) for later analysis.
//
// The pick comes from the log: confirming a card writes `UIButton@ normal-click Rarity{N}SelectedBtn`
// (N = 1 white, 2 blue, 3 purple, 4 orange), matched against the cards on screen. When two cards
// share that rarity the pick is ambiguous; the advisor's choice is assumed and flagged.

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LogLine } from "../../engine/logLine.js";
import type { ToolModule } from "../../engine/module.js";
import { configForGoal, DEFAULT_GOAL, PICKS_PER_CYCLE, recommend, setScore, switchOutlook, type AdvisorConfig, type Candidate, type Ranked, type SwitchOutlook } from "./advisor.js";
import type { EffectEntry, Rarity } from "./effects.js";
import { parseModifier } from "./modifiers.js";
import type { SealWhisperRead } from "./sealWhisperReader.js";
import type { ZoneVisit } from "../../engine/session.js";

const PICK = /^UIButton@ normal-click Rarity(\d)SelectedBtn/;
const CARD_CLICK = /^UIButton@ normal-click BtnSelect/;
/** The Void Sea Terminal zone: entering it ends the cycle; what's picked up inside is the chest. */
export const TERMINAL_ZONE = "XuHaiZhongGang";
/** How long a Confirm waits for the frame of a card click still being read (two grabs ~1 s apart). */
const SELECT_WAIT_MS = 4000;
const RARITY_BY_BUTTON: Record<string, Rarity> = { "1": "white", "2": "blue", "3": "purple", "4": "orange" };

/** A card as recorded: what was on screen plus the matched effect. */
export interface TrackedCard {
  id: string;
  type: string | null;
  rarity: Rarity | null;
  doubled: boolean;
  /** Effect as shown (doubled values if doubled); for an unread card, the raw OCR text. */
  effect: string;
  group: string;
  /**
   * The card's text couldn't be matched to a known effect. It is still a card the player can pick,
   * so it stays on the list (rarity from its colour); the advisor just can't value it.
   */
  unread?: boolean;
}

export interface PickRecord {
  time: string;
  cycle: number;
  /** 1..6 within the cycle. */
  pick: number;
  offered: TrackedCard[];
  switchCard: TrackedCard | null;
  picked: TrackedCard | null;
  /**
   * How the pick was determined: "frame" = the card selected on screen (grabbed on the card click)
   * with the logged rarity agreeing; "rarity" = the only card of the logged rarity; "assumed" =
   * several cards had that rarity and nothing else told them apart (the advised one is assumed).
   */
  method: "frame" | "rarity" | "assumed" | "none";
  /** True when method is "assumed". */
  assumed: boolean;
  recommended: string | null;
  /** The cycle's goal when this pick was made. */
  goal: string;
}

/** A Void Sea Treasure: everything picked up in the Terminal zone, with the cycle's picks. */
export interface ChestRecord {
  time: string;
  cycle: number;
  picks: TrackedCard[];
  /** False when the tracker didn't see all 6 picks (e.g. started mid-cycle). */
  complete: boolean;
  /** Picks whose card text couldn't be read (their effect is unknown to the model). */
  unread: number;
  /** ConfigBaseId -> amount picked up in the Terminal. */
  loot: Record<string, number>;
  seconds: number;
  /** The cycle's goal. */
  goal: string;
}

/** A Terminal visit with no cycle to close: a boss fight opened with a Void Sea Invitation. */
export interface BossRunRecord {
  time: string;
  /** The last finished cycle (for ordering only). */
  afterCycle: number;
  /** ConfigBaseId -> amount picked up. */
  loot: Record<string, number>;
  seconds: number;
}

export type TrackerEvent =
  /**
   * `switchOutlook`: whether Switch is worth pressing; null once the Switch card has been read.
   * `setScore`: the picks so far as a multiple of a chest with no Whispers.
   */
  | { kind: "advice"; pick: number; ranked: Ranked[]; picked: TrackedCard[]; goal: string; switchOutlook: SwitchOutlook | null; setScore: number }
  | { kind: "picked"; record: PickRecord }
  | { kind: "cycleDone"; cycle: number; picks: TrackedCard[] }
  | { kind: "chest"; record: ChestRecord }
  | { kind: "bossRun"; record: BossRunRecord };

interface State {
  cycle: number;
  picks: TrackedCard[];
  /** What the player farms this cycle (advisor goal id); carried over to the next cycle. */
  goal?: string;
  /** The last finished cycle, kept until its chest is opened in the Terminal. */
  finished?: { cycle: number; picks: TrackedCard[]; goal?: string };
}

/** What was on screen when Confirm was pressed (the screen closes right after). */
interface ConfirmSnapshot {
  rarity: Rarity;
  offered: TrackedCard[];
  switchCard: TrackedCard | null;
  view: "three" | "switch";
  recommended: string | null;
}

export interface TrackerDeps {
  table: EffectEntry[];
  config: AdvisorConfig;
  /** Folder for black-sail-whispers.jsonl and black-sail-state.json. */
  historyDir: string;
  onEvent: (e: TrackerEvent) => void;
}

export class PickTracker implements ToolModule {
  readonly id = "black-sail-picks";
  readonly name = "Black Sail: Seal Whisper picks";

  private state: State = { cycle: 1, picks: [] };
  private offered: TrackedCard[] = [];
  private switchCard: TrackedCard | null = null;
  private view: "three" | "switch" = "three";
  private ranked: Ranked[] = [];
  /** Card selected on screen at the last card click (null = unclear / none yet). */
  private selected: string | null = null;
  /** A card click whose frame is still being read. */
  private selectPending = false;
  /** A Confirm waiting for that frame. */
  private waiting: { snapshot: ConfirmSnapshot; timer: NodeJS.Timeout } | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly deps: TrackerDeps) {}

  private get statePath() {
    return join(this.deps.historyDir, "black-sail-state.json");
  }

  /** Restores the current cycle from disk (so a restart keeps earlier picks). */
  async load(): Promise<void> {
    await mkdir(this.deps.historyDir, { recursive: true });
    try {
      this.state = JSON.parse(await readFile(this.statePath, "utf8")) as State;
    } catch {
      /* first run */
    }
  }

  get currentPicks(): TrackedCard[] {
    return this.state.picks;
  }

  get goal(): string {
    return this.state.goal ?? DEFAULT_GOAL;
  }

  /** Sets this cycle's goal (from the overlay) and re-ranks the cards on screen. */
  setGoal(goal: string): void {
    this.state.goal = goal;
    const state = JSON.stringify(this.state, null, 2);
    this.queue(() => this.writeState(state));
    if (this.offered.length || this.switchCard) this.advise();
  }

  /** Feed every Seal Whisper reading from the watcher. */
  onCards(read: SealWhisperRead): void {
    const cards: TrackedCard[] = read.cards.map((c) =>
      c.match
        ? {
            id: c.slot,
            type: c.type,
            rarity: c.rarity ?? c.match.entry.rarity,
            doubled: c.doubled,
            effect: c.doubled ? c.match.entry.doubledText : c.match.entry.text,
            group: c.match.entry.group,
          }
        : { id: c.slot, type: c.type, rarity: c.rarity, doubled: c.doubled, effect: c.effectText || "(unread)", group: "unread", unread: true },
    );
    if (read.view === "switch") {
      this.view = "switch";
      this.switchCard = cards[0] ? { ...cards[0], id: "switch" } : null;
    } else if (read.view === "three") {
      this.view = "three";
      this.offered = cards;
    }
    this.advise();
  }

  /** Feed the watcher's card-click result. */
  onSelected(slot: string | null): void {
    this.selectPending = false;
    // An unclear frame (pill not drawn, screen blank) must not erase an earlier clear selection:
    // seen live 2026-10-25, a card clicked, a 5-minute pause, a click again with a blank frame.
    // The confirm still checks the selection against the logged rarity.
    const chosen = slot ?? this.selected;
    if (this.waiting) {
      const { snapshot, timer } = this.waiting;
      clearTimeout(timer);
      this.waiting = null;
      this.resolve(snapshot, snapshot.view === "switch" && chosen ? "switch" : chosen);
      return;
    }
    // A late result for a screen that already closed (Esc without Confirm) must not carry over.
    if (!this.offered.length && !this.switchCard) return;
    this.selected = this.view === "switch" && chosen ? "switch" : chosen;
  }

  /** The chest: everything picked up while in the Terminal zone. */
  onZoneEnd(visit: ZoneVisit): void {
    if (!visit.name.startsWith(TERMINAL_ZONE)) return;
    const loot = Object.fromEntries(visit.loot);
    const seconds = visit.start && visit.end ? Math.round((visit.end - visit.start) / 1000) : 0;
    // No cycle waiting for its chest and no picks in progress: a Void Sea Invitation opens a boss
    // fight in the same zone (seen 2026-10-25: 3 Craving invitations = 3 short visits right after a
    // chest). Kept apart, so chests stay clean and invitation value can be measured.
    if (!this.state.finished && !this.state.picks.length) {
      const run: BossRunRecord = { time: new Date(visit.start ?? Date.now()).toISOString(), afterCycle: this.state.cycle - 1, loot, seconds };
      // Queue the write before telling listeners, so a listener's flush() covers this record.
      this.save(join(this.deps.historyDir, "black-sail-boss-runs.jsonl"), run);
      this.deps.onEvent({ kind: "bossRun", record: run });
      return;
    }
    // Entering the Terminal ends the cycle even if the tracker missed picks (resync).
    if (this.state.picks.length) this.finishCycle();
    const cycle = this.state.finished ?? { cycle: this.state.cycle - 1, picks: [] };
    const record: ChestRecord = {
      time: new Date(visit.start ?? Date.now()).toISOString(),
      cycle: cycle.cycle,
      picks: cycle.picks,
      complete: cycle.picks.length === PICKS_PER_CYCLE,
      unread: cycle.picks.filter((p) => p.unread).length,
      loot,
      seconds,
      goal: cycle.goal ?? this.goal,
    };
    this.state.finished = undefined;
    this.save(join(this.deps.historyDir, "black-sail-chests.jsonl"), record);
    this.deps.onEvent({ kind: "chest", record });
  }

  onLine(line: LogLine): void {
    const m = PICK.exec(line.text);
    if (m) this.confirm(RARITY_BY_BUTTON[m[1]!]!);
    else if (CARD_CLICK.test(line.text) && (this.offered.length || this.switchCard)) this.selectPending = true;
    else if (/PageName = VoidPort , PageRunState = Destory/.test(line.text)) {
      this.offered = [];
      this.switchCard = null;
      this.view = "three";
      this.ranked = [];
      this.selected = null;
    }
  }

  summary() {
    return { cycle: this.state.cycle, picks: this.state.picks };
  }

  /** Resolves when pending file writes are done (for tests and shutdown). */
  flush(): Promise<void> {
    return this.writes;
  }

  private candidates(): Candidate[] {
    const cards = [...this.offered, ...(this.switchCard ? [this.switchCard] : [])].filter((c) => !c.unread);
    // Match on text AND doubling AND rarity: a purple "+28%" reads the same as a white "+14%"
    // doubled by the pet, so text alone picks the wrong row.
    const shown = (e: EffectEntry, doubled: boolean) => (doubled ? e.doubledText : e.text);
    const find = (c: TrackedCard) =>
      this.deps.table.find((e) => shown(e, c.doubled) === c.effect && e.rarity === c.rarity) ??
      this.deps.table.find((e) => shown(e, c.doubled) === c.effect);
    return cards
      .map((c) => ({ c, entry: find(c) }))
      .filter((x): x is { c: TrackedCard; entry: EffectEntry } => x.entry !== undefined)
      .map(({ c, entry }) => ({ id: c.id, entry, doubled: c.doubled }));
  }

  private advise(): void {
    const picked = this.state.picks.map((p) => parseModifier(p.effect)).filter((m) => m !== null);
    const cfg = configForGoal(this.deps.config, this.goal);
    this.ranked = recommend(picked, this.candidates(), this.deps.table, cfg);
    // Before Switch is pressed: is the unknown Switch card likely to beat the best of the 3?
    const outlook = this.switchCard || !this.offered.length
      ? null
      : switchOutlook(picked, this.ranked[0], this.offered.some((c) => c.doubled), this.deps.table, cfg);
    this.deps.onEvent({
      kind: "advice",
      pick: this.state.picks.length + 1,
      ranked: this.ranked,
      picked: this.state.picks,
      goal: this.goal,
      switchOutlook: outlook,
      setScore: setScore(picked, cfg),
    });
  }

  private confirm(rarity: Rarity): void {
    const snapshot: ConfirmSnapshot = {
      rarity,
      offered: this.offered,
      switchCard: this.switchCard,
      view: this.view,
      recommended: this.ranked[0]?.candidate.id ?? null,
    };
    if (this.selectPending) {
      // Confirmed before the click's frame was read: wait for it (the screen closes meanwhile).
      const timer = setTimeout(() => {
        this.waiting = null;
        this.resolve(snapshot, null);
      }, SELECT_WAIT_MS);
      this.waiting = { snapshot, timer };
      return;
    }
    this.resolve(snapshot, this.selected);
  }

  private resolve(snap: ConfirmSnapshot, selected: string | null): void {
    const { rarity } = snap;
    // The confirm button belongs to the view on screen: the Switch card, or one of the 3.
    const pool = snap.view === "switch" && snap.switchCard ? [snap.switchCard] : snap.offered;
    const all = [...snap.offered, ...(snap.switchCard ? [snap.switchCard] : [])];
    // If the view we think is on screen has no card of that rarity (e.g. a missed Switch-back),
    // look at every card read on this screen.
    let matching = pool.filter((c) => c.rarity === rarity);
    if (!matching.length) matching = all.filter((c) => c.rarity === rarity);
    const recommended = snap.recommended;
    const onScreen = matching.find((c) => c.id === selected);
    let picked: TrackedCard | null = null;
    let method: PickRecord["method"] = "none";
    if (onScreen) [picked, method] = [onScreen, "frame"];
    else if (matching.length === 1) [picked, method] = [matching[0]!, "rarity"];
    else if (matching.length > 1) [picked, method] = [matching.find((c) => c.id === recommended) ?? matching[0]!, "assumed"];
    const assumed = method === "assumed";

    const record: PickRecord = {
      time: new Date().toISOString(),
      cycle: this.state.cycle,
      pick: this.state.picks.length + 1,
      offered: snap.offered,
      switchCard: snap.switchCard,
      picked,
      method,
      assumed,
      recommended,
      goal: this.goal,
    };
    if (picked) this.state.picks.push(picked);
    this.selected = null;
    this.deps.onEvent({ kind: "picked", record });
    if (this.state.picks.length >= PICKS_PER_CYCLE) this.finishCycle();
    this.save(join(this.deps.historyDir, "black-sail-whispers.jsonl"), record);
  }

  private finishCycle(): void {
    this.deps.onEvent({ kind: "cycleDone", cycle: this.state.cycle, picks: this.state.picks });
    const { cycle, picks, goal } = this.state;
    this.state = { cycle: cycle + 1, picks: [], goal, finished: { cycle, picks, goal } };
  }

  /** Appends a record to a history file and saves the current cycle. */
  private save(file: string, record: object): void {
    const state = JSON.stringify(this.state, null, 2);
    this.queue(async () => {
      await appendFile(file, JSON.stringify(record) + "\n");
      await this.writeState(state);
    });
  }

  /** Write to a temp file, then rename: a crash mid-write can't leave a cut-off state file. */
  private async writeState(state: string): Promise<void> {
    const tmp = `${this.statePath}.tmp`;
    await writeFile(tmp, state);
    await rename(tmp, this.statePath);
  }

  /** Runs file writes in order; a failed write is logged and doesn't block the later ones. */
  private queue(write: () => Promise<void>): void {
    this.writes = this.writes.then(write).catch((err) => console.error(`black-sail history: ${err}`));
  }
}
