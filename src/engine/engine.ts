// Wires lines -> events -> session tracker -> modules.
// Same engine is used for one-shot audits and (later) live tailing in the overlay.

import { extractEvent } from "./events.js";
import type { LogLine } from "./logLine.js";
import type { ToolModule } from "./module.js";
import { SessionTracker, type ZoneVisit } from "./session.js";

export class Engine {
  readonly session: SessionTracker;
  private lastTime: number | undefined;
  private lastLine = 0;

  constructor(
    readonly modules: ToolModule[],
    onZoneEnd?: (visit: ZoneVisit) => void,
  ) {
    this.session = new SessionTracker(
      (visit) => {
        onZoneEnd?.(visit);
        for (const m of modules) m.onZoneEnd?.(visit);
      },
      (batch) => {
        for (const m of modules) m.onBatch?.(batch);
      },
    );
  }

  feed(line: LogLine): void {
    this.lastLine = line.lineNo;
    if (line.time !== undefined) this.lastTime = line.time;
    for (const m of this.modules) m.onLine?.(line);

    const event = extractEvent(line);
    if (!event) return;
    this.session.handle(event);
    for (const m of this.modules) m.onEvent?.(event);
  }

  /** Older lines (log written before the tool started): stack sizes only, nothing reaches modules. */
  prime(line: LogLine): void {
    if (!line.text.includes("ItemChange@") && !line.text.includes("BagMgr@")) return; // cheap filter
    const event = extractEvent(line);
    if (event) this.session.prime(event);
  }

  finish(): void {
    this.session.finish(this.lastTime, this.lastLine);
  }
}
