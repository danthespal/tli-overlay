// Turns parsed log lines into typed game events.
// Only lines we currently understand become events; everything else returns null.

import type { LogLine } from "./logLine.js";

interface Base {
  lineNo: number;
  time?: number;
}

/** Player entered a level (hideout, map, boss arena...). */
export interface MapEnterEvent extends Base {
  type: "mapEnter";
  path: string;
  /** Last path segment, e.g. "SD_GeBuLinShanZhai". */
  name: string;
}

/** A map modifier was applied. Logged just before the map it belongs to is entered. */
export interface MapModifierEvent extends Base {
  type: "mapModifier";
  id: number;
}

/** Start/end of a server item-change batch (PickItems, XchgBuy, OpenRewardBox, ...). */
export interface ItemBlockEvent extends Base {
  type: "itemBlockStart" | "itemBlockEnd";
  proto: string;
}

/** A stack was added, updated or deleted. `num` is the new stack size (absent for Delete). */
export interface ItemChangeEvent extends Base {
  type: "itemChange";
  op: "Add" | "Update" | "Delete";
  configBaseId: number;
  uuid: string;
  num?: number;
  pageId: number;
  slotId: number;
}

/** Bag slot snapshot (InitBagData) or change (Modfy BagItem). `num` is the stack size. */
export interface BagSlotEvent extends Base {
  type: "bagInit" | "bagModify";
  pageId: number;
  slotId: number;
  configBaseId: number;
  num: number;
}

export interface MonsterCreatedEvent extends Base {
  type: "monsterCreated";
  npcId: number;
  rarity: number;
}

export type GameEvent =
  | MapEnterEvent
  | MapModifierEvent
  | ItemBlockEvent
  | ItemChangeEvent
  | BagSlotEvent
  | MonsterCreatedEvent;

const MAP_ENTER = /^SceneLevelMgr@ OpenMainWorld END! InMainLevelPath = (\S+)/;
const MAP_MODIFIER = /^UCLevelSingleton::AddMapModifier\((\d+)\) success/;
const ITEM_BLOCK = /^ItemChange@ ProtoName=(\w+) (start|end)/;
const ITEM_CHANGE =
  /^ItemChange@ (Add|Update|Delete) Id=(\d+)_(\S+)(?: BagNum=(\d+))? in PageId=(-?\d+) SlotId=(\d+)/;
const BAG_SLOT =
  /^BagMgr@:(InitBagData|Modfy BagItem) PageId = (-?\d+) SlotId = (\d+) ConfigBaseId = (\d+) Num = (\d+)/;
const MONSTER = /^Monster Created: npc id (\d+) rarity (\d+)/;

export function extractEvent(line: LogLine): GameEvent | null {
  // Every event we know comes from a headed line; cheap filter first.
  if (line.time === undefined) return null;
  const { text, lineNo, time } = line;
  let m: RegExpExecArray | null;

  if ((m = MAP_ENTER.exec(text))) {
    const path = m[1]!;
    return { type: "mapEnter", path, name: path.split("/").pop()!, lineNo, time };
  }
  if ((m = MAP_MODIFIER.exec(text))) {
    return { type: "mapModifier", id: +m[1]!, lineNo, time };
  }
  if ((m = ITEM_BLOCK.exec(text))) {
    return { type: m[2] === "start" ? "itemBlockStart" : "itemBlockEnd", proto: m[1]!, lineNo, time };
  }
  if ((m = ITEM_CHANGE.exec(text))) {
    return {
      type: "itemChange",
      op: m[1] as ItemChangeEvent["op"],
      configBaseId: +m[2]!,
      uuid: m[3]!,
      num: m[4] === undefined ? undefined : +m[4],
      pageId: +m[5]!,
      slotId: +m[6]!,
      lineNo,
      time,
    };
  }
  if ((m = BAG_SLOT.exec(text))) {
    return {
      type: m[1] === "InitBagData" ? "bagInit" : "bagModify",
      pageId: +m[2]!,
      slotId: +m[3]!,
      configBaseId: +m[4]!,
      num: +m[5]!,
      lineNo,
      time,
    };
  }
  if ((m = MONSTER.exec(text))) {
    return { type: "monsterCreated", npcId: +m[1]!, rarity: +m[2]!, lineNo, time };
  }
  return null;
}
