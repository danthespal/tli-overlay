// The capture/OCR worker process: same results as the one-shot scripts, fast once warm, stops
// itself when idle, and comes back for the next request. Runs the real PowerShell (Windows only).
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CaptureWorker, warmOnScreens } from "../src/capture/worker.js";
import { parseLogLine } from "../src/engine/logLine.js";
import { FLAME_REGIONS } from "../src/modules/black-sail/flameReader.js";
import { ocrImages } from "../src/ocr/windowsOcr.js";

const dir = resolve(import.meta.dirname, "../../mechanics/black-sail/samples/screens/seal-whisper");
const worker = new CaptureWorker({ idleMs: 1500 });
let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tli-worker-"));
});
afterAll(async () => {
  worker.stop();
  await rm(scratch, { recursive: true, force: true });
});
/** A grab either works (the game happens to be running and in front) or says why not; it never throws. */
async function tryGrab(name: string) {
  const r = await worker.grab(join(scratch, name));
  if (!r.ok) expect(r.reason).toMatch(/game window/);
  else expect(r.width).toBeGreaterThan(0);
  return r;
}

describe("CaptureWorker", () => {
  it("reads an image exactly like the one-shot OCR script, and is fast once warm", async () => {
    const sample = join(dir, (await readdir(dir)).find((f) => /\.(jpe?g|png)$/i.test(f))!);
    const t0 = Date.now();
    const [viaWorker] = await worker.ocr([sample], FLAME_REGIONS);
    const cold = Date.now() - t0;
    const t1 = Date.now();
    const [again] = await worker.ocr([sample], FLAME_REGIONS);
    const warm = Date.now() - t1;
    const [oneShot] = await ocrImages([sample], FLAME_REGIONS);
    expect(viaWorker!.lines.map((l) => l.text)).toEqual(oneShot!.lines.map((l) => l.text));
    expect(viaWorker!.regions.map((r) => [r.bright, r.max, r.lit])).toEqual(oneShot!.regions.map((r) => [r.bright, r.max, r.lit]));
    expect(again!.lines.length).toBe(viaWorker!.lines.length);
    expect(warm).toBeLessThan(cold); // no process start-up the second time
  }, 30_000);

  it("answers a grab request (a result or the reason it was refused), never throws", async () => {
    await tryGrab("grab1.jpg");
  }, 20_000);

  it("stops when idle and starts again for the next request", async () => {
    expect(worker.running).toBe(true);
    await new Promise((r) => setTimeout(r, 2500));
    expect(worker.running).toBe(false);
    await tryGrab("grab2.jpg");
    expect(worker.running).toBe(true);
  }, 30_000);

  it("keeps a new process when the stopped one exits after it was started", async () => {
    const w = new CaptureWorker({ idleMs: 60_000 });
    try {
      await w.window(); // first process up
      w.stop(); // asks it to quit; it exits a moment later
      const next = w.window(); // a screen opens right away: a second process starts
      await new Promise((r) => setTimeout(r, 1500)); // the first one's exit has fired by now
      await expect(next).resolves.toBeDefined(); // its request wasn't failed by the old exit
      expect(w.running).toBe(true); // and it isn't forgotten (would run on, orphaned)
    } finally {
      w.stop();
    }
  }, 30_000);

  it("is warmed by the screen-open log lines only", () => {
    const w = new CaptureWorker();
    let warmed = 0;
    (w as unknown as { warm: () => void }).warm = () => warmed++;
    const m = warmOnScreens(w);
    m.onLine!(parseLogLine("[2026.10.25-02.26.22:551][ 25]TLLua: Display: [Game] TipMsgShowMgr@DispatchPageRunChange PageName = VoidPort , PageRunState = Run ", 1));
    m.onLine!(parseLogLine("[2026.10.25-02.26.22:551][ 25]TLLua: Display: [Game] TipMsgShowMgr@DispatchPageRunChange PageName = VoidPort , PageRunState = Destory ", 2));
    m.onLine!(parseLogLine("[2026.10.25-02.26.19:621][618]TLLua: Display: [Game] ItemChange@ ProtoName=PickItems start", 3));
    expect(warmed).toBe(1);
  });
});
