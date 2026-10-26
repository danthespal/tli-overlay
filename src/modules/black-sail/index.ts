// Black Sail module, v0: investigation only.
// - Flags zones marked by a Plane Anchor (map modifier 296208, seen in the log as
//   "This stage has been marked by a Plane Anchor").
// - Compares loot in anchor maps vs other maps.
// - Collects log line shapes that mention Black Sail words, to find more signals
//   (anchor start, pirate waves, whisper choice...) the engine could type later.

import type { LogLine } from "../../engine/logLine.js";
import type { ToolModule } from "../../engine/module.js";
import type { ZoneVisit } from "../../engine/session.js";

export const PLANE_ANCHOR_MODIFIER = 296208;

const SIGNAL = /blacksail|black ?sail|haidao|plane anchor|void ?sea|anchor|whisper|bride|seal whisper/i;
// Black Sail UI pages (Season 2 blueprints): VoidBeacon = anchor option screen,
// VoidPort = Void Sea Seal / Seal Whisper screen. The game spells "Destroy" as "Destory".
const PAGE_STATE = /^TipMsgShowMgr@DispatchPageRunChange PageName = (VoidBeacon|VoidPort) , PageRunState = (Run|Destory)/;
// Seal Whisper pick on the VoidPort screen; N is the rarity tier of the chosen Whisper.
const SEAL_PICK = /^UIButton@ normal-click Rarity(\d)SelectedBtn/;

interface MapStats {
  maps: number;
  seconds: number;
  loot: Map<number, number>;
  uncertainPickups: number;
}

const emptyStats = (): MapStats => ({ maps: 0, seconds: 0, loot: new Map(), uncertainPickups: 0 });

export class BlackSailModule implements ToolModule {
  readonly id = "black-sail";
  readonly name = "Black Sail";

  private readonly anchor = emptyStats();
  private readonly other = emptyStats();
  private readonly anchorMaps: {
    name: string; startLine: number; seconds: number; items: number; signals: number;
    anchorScreens: number; sealScreens: number; sealPicks: number[];
  }[] = [];
  private readonly signalShapes = new Map<string, { count: number; example: string }>();
  private zoneSignals = 0;
  private zoneAnchorScreens = 0;
  private zoneSealScreens = 0;
  private zoneSealPicks: number[] = [];
  private onSealScreen = false;
  /** Seconds spent with each screen open, to see how long decisions take. */
  private readonly screenSeconds = { VoidBeacon: [] as number[], VoidPort: [] as number[] };
  private screenOpenedAt: number | undefined;
  private readonly sealRarityPicks = new Map<number, number>();

  onLine(line: LogLine): void {
    const page = PAGE_STATE.exec(line.text);
    if (page) {
      const name = page[1] as "VoidBeacon" | "VoidPort";
      if (page[2] === "Run") {
        this.screenOpenedAt = line.time;
        if (name === "VoidBeacon") this.zoneAnchorScreens++;
        else {
          this.zoneSealScreens++;
          this.onSealScreen = true;
        }
      } else {
        if (this.screenOpenedAt !== undefined && line.time !== undefined) {
          this.screenSeconds[name].push((line.time - this.screenOpenedAt) / 1000);
        }
        this.screenOpenedAt = undefined;
        if (name === "VoidPort") this.onSealScreen = false;
      }
    }
    const pick = this.onSealScreen ? SEAL_PICK.exec(line.text) : null;
    if (pick) {
      const rarity = +pick[1]!;
      this.zoneSealPicks.push(rarity);
      this.sealRarityPicks.set(rarity, (this.sealRarityPicks.get(rarity) ?? 0) + 1);
    }

    if (!SIGNAL.test(line.text)) return;
    this.zoneSignals++;
    // Normalise numbers so repeated lines group together.
    const shape = `${line.category ?? "-"} ${line.text.replace(/\d+/g, "N")}`.slice(0, 200);
    const s = this.signalShapes.get(shape);
    if (s) s.count++;
    else this.signalShapes.set(shape, { count: 1, example: `#${line.lineNo} ${line.raw.slice(0, 300)}` });
  }

  onZoneEnd(v: ZoneVisit): void {
    const signals = this.zoneSignals;
    const anchorScreens = this.zoneAnchorScreens;
    const sealScreens = this.zoneSealScreens;
    const sealPicks = this.zoneSealPicks;
    this.zoneSignals = this.zoneAnchorScreens = this.zoneSealScreens = 0;
    this.zoneSealPicks = [];
    // Zones without any modifier are hideout / towns / UI levels; skip them.
    if (v.modifiers.length === 0) return;

    const isAnchor = v.modifiers.includes(PLANE_ANCHOR_MODIFIER);
    const stats = isAnchor ? this.anchor : this.other;
    const seconds = v.start !== undefined && v.end !== undefined ? (v.end - v.start) / 1000 : 0;
    stats.maps++;
    stats.seconds += seconds;
    stats.uncertainPickups += v.uncertainPickups;
    let items = 0;
    for (const [id, n] of v.loot) {
      stats.loot.set(id, (stats.loot.get(id) ?? 0) + n);
      items += n;
    }
    if (isAnchor) {
      this.anchorMaps.push({
        name: v.name, startLine: v.startLine, seconds: Math.round(seconds), items, signals,
        anchorScreens, sealScreens, sealPicks,
      });
    }
  }

  summary() {
    const describe = (s: MapStats) => ({
      maps: s.maps,
      avgSeconds: s.maps ? Math.round(s.seconds / s.maps) : 0,
      uncertainPickups: s.uncertainPickups,
      // Average gain per map for each ConfigBaseId, biggest first.
      lootPerMap: [...s.loot.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([id, n]) => ({ configBaseId: id, total: n, perMap: s.maps ? +(n / s.maps).toFixed(2) : 0 })),
    });
    const avg = (xs: number[]) => (xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : 0);
    return {
      planeAnchorModifier: PLANE_ANCHOR_MODIFIER,
      screens: {
        anchor: { opened: this.screenSeconds.VoidBeacon.length, avgSecondsOpen: avg(this.screenSeconds.VoidBeacon) },
        seal: { opened: this.screenSeconds.VoidPort.length, avgSecondsOpen: avg(this.screenSeconds.VoidPort) },
        sealRarityPicks: Object.fromEntries([...this.sealRarityPicks.entries()].sort((a, b) => a[0] - b[0])),
      },
      anchorMaps: describe(this.anchor),
      otherMaps: describe(this.other),
      anchorMapList: this.anchorMaps,
      signalShapes: [...this.signalShapes.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .map(([shape, s]) => ({ shape, ...s })),
    };
  }
}
