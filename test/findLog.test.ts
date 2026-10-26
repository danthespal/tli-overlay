import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { besideGame, findLog, STALE_MS } from "../src/engine/findLog.js";

let root: string;
const NOW = Date.parse("2026-10-26T12:00:00Z");

/** A game install under root: <name>/UE_game/TorchLight/Saved/Logs, and its program path. */
async function game(name: string) {
  const logs = join(root, name, "UE_game/TorchLight/Saved/Logs");
  await mkdir(logs, { recursive: true });
  return { logs, program: join(root, name, "UE_game/Binaries/Win64/torchlight_infinite.exe") };
}

/** A log file last written `ago` ms before NOW. */
async function log(dir: string, name: string, ago: number) {
  const p = join(dir, name);
  await writeFile(p, "x");
  const t = (NOW - ago) / 1000;
  await utimes(p, t, t);
  return p;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tli-findlog-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("findLog", () => {
  it("takes TLI_LOG_DIR as a folder or a file", () => {
    expect(findLog({ override: "D:/logs" })).toEqual({ path: join("D:/logs", "UE_game.log"), by: "given" });
    expect(findLog({ override: "D:/logs/UE_game_2.log" })?.path).toBe("D:/logs/UE_game_2.log");
  });

  it("picks the newest log of the installed games, UE_game_2.log included", async () => {
    const a = await game("steam");
    const b = await game("launcher");
    await log(a.logs, "UE_game.log", 60_000);
    const newest = await log(b.logs, "UE_game_2.log", 1000);
    await log(b.logs, "UE_game-backup-2026.10.25.log", 0); // a backup is never the live log
    expect(findLog({ dirs: [a.logs, b.logs], now: NOW })).toEqual({ path: newest, by: "in the game folders" });
  });

  it("prefers the log beside the running game", async () => {
    const a = await game("steam");
    const b = await game("other");
    await log(a.logs, "UE_game.log", 0);
    const own = await log(b.logs, "UE_game.log", 10 * 60_000);
    expect(findLog({ dirs: [a.logs], program: b.program, gameSince: NOW - 1000, now: NOW })).toEqual({ path: own, by: "beside the running game" });
  });

  it("keeps the chosen log, unless the game has written another one for a while", async () => {
    const a = await game("steam");
    const chosen = await log(a.logs, "UE_game.log", STALE_MS + 60_000);
    const other = await log(a.logs, "UE_game_2.log", 1000);
    // Game just started: give the chosen log time.
    expect(findLog({ chosen, gameSince: NOW - 1000, now: NOW })?.by).toBe("chosen by the player");
    // Game running for a while and the chosen log idle: the one being written wins.
    expect(findLog({ chosen, gameSince: NOW - 2 * STALE_MS, now: NOW })).toEqual({ path: other, by: "being written (the chosen one isn't)" });
    // Game not running: the choice stands.
    expect(findLog({ chosen, gameSince: 0, now: NOW })?.by).toBe("chosen by the player");
  });

  it("without any log, names the installed game's log so it is picked up once written", async () => {
    const a = await game("steam");
    const notInstalled = join(root, "nothing/UE_game/TorchLight/Saved/Logs");
    expect(findLog({ dirs: [notInstalled, a.logs], now: NOW })).toEqual({ path: join(a.logs, "UE_game.log"), by: "installed game, no log yet" });
    expect(findLog({ dirs: [notInstalled], now: NOW })).toBeNull();
  });

  it("ignores programs that aren't the game", () => {
    expect(besideGame("C:/Windows/notepad.exe")).toEqual([]);
    expect(besideGame(null)).toEqual([]);
  });
});
