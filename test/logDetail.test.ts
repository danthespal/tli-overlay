import { describe, expect, it } from "vitest";
import { LogDetail } from "../src/engine/logDetail.js";
import { parseLogLine } from "../src/engine/logLine.js";

// Real lines (UE_game.log, 2026-10-26 login): the game's log state, in the order it writes them.
const STATE_OFF_DEFAULT = "[2026.10.26-09.57.03:273][950]TLShipping: Display: [Game] Log@ LogState off by DisableLogChannel";
const STATE_OFF_MANUAL = "[2026.10.26-09.57.03:273][950]TLShipping: Display: [Game] Log@ LogState Off by LogStateManuallyModified";
const STATE_ON_CRASHES = "[2026.10.26-09.57.03:277][950]TLShipping: Display: [Game] Log@ LogState on by HaveCrashedCount 9";
// Written whatever the setting: must not count.
const PING = "[2026.10.26-09.59.06:132][ 90]TLLua: Display: [Game] TCP Ping Result: 41";
const SOUND = "[2026.10.26-09.59.06:752][179]TLGame: Display: [Game] SoundTriggerTimestamps RawCount: 1, SmoothedCount: 1, CurrentTime: 100.743607";
// A gameplay line the triggers come from.
const PICK = "[2026.10.25-02.26.19:621][618]TLLua: Display: [Game] ItemChange@ ProtoName=PickItems start";

const feed = (d: LogDetail, ...raws: string[]) => raws.forEach((r, i) => d.note(parseLogLine(r, i + 1)));

describe("LogDetail (is the game's log on?)", () => {
  it("takes the last state line of the login: on, turned on by the game after crashes", () => {
    const d = new LogDetail();
    feed(d, STATE_OFF_DEFAULT, STATE_OFF_MANUAL, STATE_ON_CRASHES);
    expect([d.verdict, d.reason]).toEqual(["on", "HaveCrashedCount"]);
  });

  it("off at once when the login says off, however many ping or sound lines follow", () => {
    const d = new LogDetail();
    feed(d, STATE_OFF_DEFAULT, STATE_OFF_MANUAL);
    for (let i = 0; i < 5000; i++) feed(d, i % 2 ? PING : SOUND);
    expect([d.verdict, d.reason]).toEqual(["off", "LogStateManuallyModified"]);
  });

  it("on once gameplay lines show up, even after an off state line (turned on later)", () => {
    const d = new LogDetail();
    feed(d, STATE_OFF_MANUAL, PICK, PICK);
    expect(d.verdict).toBe("off"); // two could be strays
    feed(d, PICK);
    expect([d.verdict, d.reason]).toEqual(["on", "gameplay lines"]);
  });

  it("says nothing from lines the game writes either way", () => {
    const d = new LogDetail();
    for (let i = 0; i < 5000; i++) feed(d, i % 2 ? PING : SOUND);
    expect(d.verdict).toBe("");
  });

  it("the Enable Log button's message means on, pressed this session", () => {
    // Real line, 2026-10-26 12:16 (the button shows "Log Enabled").
    const PRESS = "[2026.10.26-10.16.31:455][259]TLLua: Display: [Game] MsgMgr@:Show MsgValue = Log Enabled";
    const d = new LogDetail();
    feed(d, STATE_OFF_MANUAL, PRESS);
    expect([d.verdict, d.reason, d.pressed]).toEqual(["on", "pressed", true]);
    d.reset();
    expect(d.pressed).toBe(false);
  });

  it("a new log starts again", () => {
    const d = new LogDetail();
    feed(d, STATE_ON_CRASHES);
    d.reset();
    expect([d.verdict, d.reason]).toEqual(["", null]);
  });
});
