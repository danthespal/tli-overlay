// Splits the event stream into zone visits and works out what was looted in each.
//
// Bag lines only give the NEW stack size, so the gain of a pickup is
// (new size - previous size). The previous size is known when we saw the stack
// before (InitBagData at login / Sort, or an earlier change). If not, the pickup is
// counted as "uncertain" instead of guessing.

import type { GameEvent } from "./events.js";

/** One server item batch (PickItems, ExchangeItem = salvage/convert, XchgBuy, ...), with its stack deltas. */
export interface ItemBatch {
  proto: string;
  time?: number;
  lineNo: number;
  /** ConfigBaseId -> stacks deleted. */
  deleted: Map<number, number>;
  /** ConfigBaseId -> amount gained (new stack size − previous). */
  gained: Map<number, number>;
  /** Changes whose previous stack size was unknown. */
  uncertain: number;
}

export interface ZoneVisit {
  index: number;
  name: string;
  path: string;
  start?: number;
  end?: number;
  startLine: number;
  endLine?: number;
  /** Map modifier ids applied when this zone was entered (e.g. 296208 = Plane Anchor). */
  modifiers: number[];
  /** Net gains from pickups, by ConfigBaseId. */
  loot: Map<number, number>;
  /** Pickups whose previous stack size was unknown, so their gain is not in `loot`. */
  uncertainPickups: number;
  monstersCreated: number;
}

const PICKUP_PROTOS = new Set(["PickItem", "PickItems"]);

export class SessionTracker {
  private current: ZoneVisit | undefined;
  private index = 0;
  private pendingModifiers: number[] = [];
  private block: string | undefined;
  private batch: ItemBatch | undefined;
  private readonly stacks = new Map<string, number>(); // uuid -> size
  private readonly slots = new Map<string, { id: number; num: number }>(); // "page:slot"

  constructor(
    private readonly onZoneEnd: (visit: ZoneVisit) => void,
    private readonly onBatch?: (batch: ItemBatch) => void,
  ) {}

  get currentZone(): ZoneVisit | undefined {
    return this.current;
  }

  handle(e: GameEvent): void {
    switch (e.type) {
      case "mapModifier":
        // Modifiers are logged right before the zone they belong to is entered.
        this.pendingModifiers.push(e.id);
        break;

      case "mapEnter":
        this.closeZone(e.time, e.lineNo);
        this.current = {
          index: this.index++,
          name: e.name,
          path: e.path,
          start: e.time,
          startLine: e.lineNo,
          modifiers: this.pendingModifiers,
          loot: new Map(),
          uncertainPickups: 0,
          monstersCreated: 0,
        };
        this.pendingModifiers = [];
        break;

      case "itemBlockStart":
        this.block = e.proto;
        this.batch = { proto: e.proto, time: e.time, lineNo: e.lineNo, deleted: new Map(), gained: new Map(), uncertain: 0 };
        break;

      case "itemBlockEnd":
        this.block = undefined;
        if (this.batch) this.onBatch?.(this.batch);
        this.batch = undefined;
        break;

      case "itemChange": {
        const key = `${e.pageId}:${e.slotId}`;
        if (e.op === "Delete") {
          this.batch?.deleted.set(e.configBaseId, (this.batch.deleted.get(e.configBaseId) ?? 0) + 1);
          this.stacks.delete(e.uuid);
          this.slots.delete(key);
          break;
        }
        const num = e.num ?? 0;
        let prev: number | undefined;
        if (e.op === "Add") prev = 0;
        else {
          prev = this.stacks.get(e.uuid);
          const slot = this.slots.get(key);
          if (prev === undefined && slot?.id === e.configBaseId) prev = slot.num;
        }
        if (this.batch) {
          if (prev === undefined) this.batch.uncertain++;
          else if (num > prev) this.batch.gained.set(e.configBaseId, (this.batch.gained.get(e.configBaseId) ?? 0) + (num - prev));
        }
        if (this.current && this.block && PICKUP_PROTOS.has(this.block)) {
          if (prev === undefined) this.current.uncertainPickups++;
          else if (num > prev) {
            const loot = this.current.loot;
            loot.set(e.configBaseId, (loot.get(e.configBaseId) ?? 0) + (num - prev));
          }
        }
        this.stacks.set(e.uuid, num);
        this.slots.set(key, { id: e.configBaseId, num });
        break;
      }

      case "bagInit":
      case "bagModify":
        this.slots.set(`${e.pageId}:${e.slotId}`, { id: e.configBaseId, num: e.num });
        break;

      case "monsterCreated":
        if (this.current) this.current.monstersCreated++;
        break;
    }
  }

  /**
   * Learns stack sizes from older log lines (no zones, no loot), so that after a restart the first
   * pickup of a stack already in the bag is counted instead of "uncertain".
   */
  prime(e: GameEvent): void {
    if (e.type === "itemChange") {
      const key = `${e.pageId}:${e.slotId}`;
      if (e.op === "Delete") {
        this.stacks.delete(e.uuid);
        this.slots.delete(key);
      } else {
        this.stacks.set(e.uuid, e.num ?? 0);
        this.slots.set(key, { id: e.configBaseId, num: e.num ?? 0 });
      }
    } else if (e.type === "bagInit" || e.type === "bagModify") {
      this.slots.set(`${e.pageId}:${e.slotId}`, { id: e.configBaseId, num: e.num });
    }
  }

  /** Call at end of input so the last zone is reported too. */
  finish(time?: number, lineNo?: number): void {
    this.closeZone(time, lineNo);
  }

  private closeZone(time?: number, lineNo?: number): void {
    if (!this.current) return;
    this.current.end = time;
    this.current.endLine = lineNo;
    this.onZoneEnd(this.current);
    this.current = undefined;
  }
}
