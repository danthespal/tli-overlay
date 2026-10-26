// Runs one delayed job at a time for log-triggered grabs. A new trigger or cancel() makes any
// pending or in-flight job stale, so a grab started before the screen closed is dropped.

export class TriggerScheduler {
  private timer: NodeJS.Timeout | undefined;
  private generation = 0;

  cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.generation++;
  }

  /**
   * Runs `job` after `delay` ms. `current()` turns false once cancel() or a replacing run() happens.
   * `replace: false` keeps the current generation (used for retries of the same trigger).
   */
  run(delay: number, job: (current: () => boolean) => Promise<void>, replace = true): void {
    if (replace) this.cancel();
    const gen = this.generation;
    this.timer = setTimeout(() => void job(() => gen === this.generation), delay);
  }
}
