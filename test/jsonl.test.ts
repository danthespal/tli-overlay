import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { jsonl } from "../src/modules/black-sail/autoCalibrate.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tli-jsonl-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it("reads a history file line by line: a line cut off by a crash costs only that line", async () => {
  const file = join(dir, "black-sail-chests.jsonl");
  await writeFile(file, '{"cycle":1}\n{"cycle":2}\r\n{"cycle":3,"lo');
  expect(await jsonl(file)).toEqual([{ cycle: 1 }, { cycle: 2 }]);
  expect(await jsonl(join(dir, "missing.jsonl"))).toEqual([]);
});
