import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gameFolderOf, parseCrashCount, parseManualState, readGameLogState } from "../src/engine/gameLogState.js";

describe("game log state files", () => {
  it("Crash.ini: one raw byte is the count (0x07 = 7); digit text too", () => {
    expect(parseCrashCount(Buffer.from([0x07]))).toBe(7);
    expect(parseCrashCount(Buffer.from([0x00]))).toBe(0);
    expect(parseCrashCount(Buffer.from("8"))).toBe(8);
    expect(parseCrashCount(Buffer.from(""))).toBeNull();
  });

  it("LogManuallyEnableState: the player's saved choice", () => {
    expect(parseManualState('{"LogManuallyStateModified":false,"LogManuallyEnableCount":0}')).toBe(false); // real file, 2026-10-26
    expect(parseManualState('{"LogManuallyStateModified":true,"LogManuallyEnableCount":0}')).toBe(true);
    expect(parseManualState('{"LogManuallyStateModified":false,"LogManuallyEnableCount":3}')).toBe(true);
    expect(parseManualState("not json")).toBeNull();
  });

  describe("read next to a game's log", () => {
    let root: string;
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "tli-gamelog-"));
    });
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it("finds both files from the log path, and says null when they're missing", async () => {
      const log = join(root, "UE_game/TorchLight/Saved/Logs/UE_game.log");
      expect(gameFolderOf(log)).toBe(join(root, "UE_game"));
      expect(await readGameLogState(log)).toEqual({ crashStarts: null, manual: null });
      await mkdir(join(root, "UE_game/TorchLight/Saved"), { recursive: true });
      await mkdir(join(root, "UE_game/Local/CommonCache"), { recursive: true });
      await writeFile(join(root, "UE_game/TorchLight/Saved/Crash.ini"), Buffer.from([7]));
      await writeFile(join(root, "UE_game/Local/CommonCache/LogManuallyEnableState"), '{"LogManuallyStateModified":false,"LogManuallyEnableCount":0}');
      expect(await readGameLogState(log)).toEqual({ crashStarts: 7, manual: false });
    });
  });
});
