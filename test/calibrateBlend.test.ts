import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ADVISOR_CONFIG, loadAdvisorConfig, type AdvisorConfig } from "../src/modules/black-sail/advisor.js";
import { autoCalibrate } from "../src/modules/black-sail/autoCalibrate.js";
import { calibrate, calibrateBase, type ChestLike, type FlameLike, type History } from "../src/modules/black-sail/calibrate.js";
import { MATERIALS } from "../src/modules/black-sail/modifiers.js";

let shipped: AdvisorConfig;
beforeAll(async () => {
  shipped = await loadAdvisorConfig(DEFAULT_ADVISOR_CONFIG);
});

// A complete chest with no picks: what it dropped is the base amount itself.
const chest = (scraps: number, threads: number): ChestLike => ({ picks: [], complete: true, loot: { "5140": scraps, "5143": threads } });
const history = (chests: ChestLike[], flames: FlameLike[] = []): History => ({ chests, screens: [], flames, salvages: [] });
const weighted = (v0: number, w: number, v: number, n: number) => (v0 * w + v * n) / (w + n);

describe("a player's calibration blended with the shipped fit", () => {
  it("one chest nudges the shipped numbers by its share of all the data", () => {
    const h = history([chest(500, 40)]);
    const own = calibrateBase(h.chests, shipped);
    const w = shipped.calibration!.chests;
    const next = calibrate(shipped, h, new Date(), true);
    for (const m of MATERIALS) {
      const n = own.counts[m] ?? 0;
      expect(next.baseAmount[m]).toBeCloseTo(weighted(shipped.baseAmount[m], w, own.baseAmount[m], n), m === "scraps" ? -1 : 0);
    }
    // Replacing would have jumped to that one chest's numbers; the blend stays near the shipped fit.
    const replaced = calibrate(shipped, h);
    expect(Math.abs(next.baseAmount.scraps - shipped.baseAmount.scraps)).toBeLessThan(Math.abs(replaced.baseAmount.scraps - shipped.baseAmount.scraps));
    expect(next.calibration).toMatchObject({ chests: w + 1, own: { chests: 1 } });
  });

  it("no data of the player's own: the shipped fit as it is", () => {
    const next = calibrate(shipped, history([]), new Date(), true);
    expect(next.baseAmount).toEqual(shipped.baseAmount);
    expect(next.lookahead.doubledRate).toBe(shipped.lookahead.doubledRate);
    expect(next.weights.heroMemories).toBe(shipped.weights.heroMemories);
    expect(next.lookahead.flames.map((g) => g.p)).toEqual(shipped.lookahead.flames.map((g) => g.p));
    expect(next.calibration?.own).toEqual({ chests: 0, screens: 0, flames: 0, salvaged: 0 });
  });

  it("flame shares blend per kind, weighted by the flames each side read", () => {
    const flames: FlameLike[] = Array.from({ length: 10 }, () => ({ effect: "wealth" }));
    const next = calibrate(shipped, history([], flames), new Date(), true);
    const w = shipped.calibration!.flames;
    const p0 = shipped.lookahead.flames.find((g) => g.group === "Wealth" && g.minRarity === "white")!.p;
    const got = next.lookahead.flames.find((g) => g.group === "Wealth" && g.minRarity === "white")!.p;
    expect(got).toBeCloseTo(weighted(p0, w, 1, 10), 3);
    const boss0 = shipped.lookahead.flames.find((g) => g.group === "Boss Whisper" && g.minRarity === "white")!.p;
    expect(next.lookahead.flames.find((g) => g.group === "Boss Whisper" && g.minRarity === "white")!.p).toBeCloseTo(weighted(boss0, w, 0, 10), 3);
  });

  describe("in the overlay (autoCalibrate)", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "tli-blend-"));
      await mkdir(join(dir, "history"));
      await writeFile(join(dir, "history", "black-sail-chests.jsonl"), [chest(500, 40), chest(60, 2)].map((c) => JSON.stringify(c)).join("\n") + "\n");
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("always starts from the shipped file: refitting again counts nothing twice", async () => {
      const copy = join(dir, "advisor-config.json");
      const config = structuredClone(shipped);
      const first = await autoCalibrate(config, join(dir, "history"), copy);
      const afterFirst = JSON.parse(await readFile(copy, "utf8")) as AdvisorConfig;
      const second = await autoCalibrate(config, join(dir, "history"), copy);
      const afterSecond = JSON.parse(await readFile(copy, "utf8")) as AdvisorConfig;
      expect(second.chests).toBe(first.chests);
      expect(afterSecond.baseAmount).toEqual(afterFirst.baseAmount);
      expect(first.own?.chests).toBe(2);
      // The running config object is updated in place.
      expect(config.baseAmount).toEqual(afterSecond.baseAmount);
    });
  });
});
