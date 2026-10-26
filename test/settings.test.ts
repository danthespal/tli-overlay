import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { loadSettings, saveSettings } from "../src/settings.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tli-settings-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it("saves of the same file at the same moment all succeed, and the last state wins", async () => {
  // A first "Share" click saves twice at once (new install id, then the answer): before the queue,
  // about 7 in 100 such pairs failed with ENOENT on the rename.
  const file = join(dir, "settings.json");
  const s: { share: boolean | null; install: string } = { share: null, install: "abc" };
  const saves: Promise<void>[] = [];
  for (let i = 0; i < 40; i++) {
    s.share = i % 2 === 0;
    saves.push(saveSettings({ ...s }, file));
  }
  const results = await Promise.allSettled(saves);
  expect(results.filter((r) => r.status === "rejected")).toEqual([]);
  expect(await loadSettings(file)).toEqual({ share: false, install: "abc" }); // the 40th save
  expect(JSON.parse(await readFile(file, "utf8")).install).toBe("abc");
});
