// Is the game's log on, so the triggers can be seen? From the log itself, two signs:
//
// - At login the game writes its log state, the last line deciding (real lines, 2026-10-26):
//     Log@ LogState off by DisableLogChannel
//     Log@ LogState Off by LogStateManuallyModified
//     Log@ LogState on by HaveCrashedCount 9        <- the game turns it on itself after crashes
// - The player pressing Esc → Settings → Other → Enable Log: the game shows a "Log Enabled" message
//   and logs it (MsgMgr@:Show MsgValue = Log Enabled, seen 2026-10-25/26). It only turns logging
//   on, and only for this game session: the game doesn't save it.
// - The gameplay lines the triggers come from (ItemChange@, BagMgr@, UIButton@, TipMsgShowMgr@,
//   SceneLevelMgr@). Seeing a few means on, whatever the state line said (turned on later).
//
// Not every TLLua / TLGame line counts: the game writes some whatever the setting ("TCP Ping
// Result", sound timestamps), so a share of those (tartarus-simulator's test) can say "on" when
// the triggers are missing. A new log starts again (reset).

import type { LogLine } from "./logLine.js";

const STATE = /^Log@ LogState (on|off) by (\w+)/i;
/** The Enable Log button's message (English client; other languages are caught by the gameplay lines). */
const PRESSED = /^MsgMgr@:Show MsgValue = Log Enabled\b/;
const GAMEPLAY = /^(ItemChange@|BagMgr@|UIButton@|TipMsgShowMgr@|SceneLevelMgr@)/;
/** Gameplay lines that make it "on" (one could be a stray). */
const ENOUGH = 3;

export type Detail = "on" | "off" | "";

export class LogDetail {
  /** "on" / "off", or "" while the log said neither. */
  verdict: Detail = "";
  /** Why, as the game says it ("HaveCrashedCount", "LogStateManuallyModified"), "pressed" or "gameplay lines". */
  reason: string | null = null;
  /** The player pressed Enable Log this session. */
  pressed = false;
  private gameplay = 0;

  note(line: LogLine): void {
    const state = STATE.exec(line.text);
    if (state) {
      this.verdict = state[1]!.toLowerCase() as Detail;
      this.reason = state[2]!;
      this.gameplay = 0; // count again from the state line on
      return;
    }
    if (PRESSED.test(line.text)) {
      this.pressed = true;
      [this.verdict, this.reason] = ["on", "pressed"];
      return;
    }
    if (this.verdict === "on" || !GAMEPLAY.test(line.text)) return;
    if (++this.gameplay >= ENOUGH) [this.verdict, this.reason] = ["on", "gameplay lines"];
  }

  /** A new log file: what was seen belongs to the old one. */
  reset(): void {
    this.verdict = "";
    this.reason = null;
    this.pressed = false;
    this.gameplay = 0;
  }
}
