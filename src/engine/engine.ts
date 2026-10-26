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
    /** A module threw: told here, and the other modules still get the line (default: console.error). */
    private readonly onError: (module: ToolModule, err: unknown) => void = (m, err) => console.error(`[${m.id}] ${err instanceof Error ? err.stack : err}`),
  ) {
    this.session = new SessionTracker(
      (visit) => {
        onZoneEnd?.(visit);
        this.each((m) => m.onZoneEnd?.(visit));
      },
      (batch) => this.each((m) => m.onBatch?.(batch)),
    );
  }

  /** Calls every module; one that throws doesn't stop the others. */
  private each(call: (m: ToolModule) => void): void {
    for (const m of this.modules) {
      try {
        call(m);
      } catch (err) {
        this.onError(m, err);
      }
    }
  }

  feed(line: LogLine): void {
    this.lastLine = line.lineNo;
    if (line.time !== undefined) this.lastTime = line.time;
    this.each((m) => m.onLine?.(line));

    const event = extractEvent(line);
    if (!event) return;
    this.session.handle(event);
    this.each((m) => m.onEvent?.(event));
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
