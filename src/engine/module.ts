// Contract every mechanic module (Black Sail, later others) implements.
// The engine feeds modules; modules never read the log themselves.

import type { GameEvent } from "./events.js";
import type { LogLine } from "./logLine.js";
import type { ItemBatch, ZoneVisit } from "./session.js";

export interface ToolModule {
  /** Stable id, e.g. "black-sail". */
  readonly id: string;
  readonly name: string;
  /** Every raw line, for modules that look for patterns the engine doesn't type yet. */
  onLine?(line: LogLine): void;
  onEvent?(event: GameEvent): void;
  onZoneEnd?(visit: ZoneVisit): void;
  /** Every server item batch with its stack deltas (pickups, salvage, trade...). */
  onBatch?(batch: ItemBatch): void;
  /** Plain-JSON summary, used by the audit CLI now and the overlay later. */
  summary(): unknown;
}
