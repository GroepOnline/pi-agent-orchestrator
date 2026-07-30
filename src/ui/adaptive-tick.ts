/**
 * adaptive-tick.ts — Self-rescheduling setTimeout loop shared by live widgets.
 *
 * Prevents render pileup (unlike setInterval) and keeps active/idle cadence
 * in one place so AgentWidget and AgentTopWidget do not fork timer logic.
 */

export class AdaptiveTick {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private intervalMs: number;

  constructor(
    private readonly isAlive: () => boolean,
    private readonly onTick: () => void,
    initialIntervalMs: number,
  ) {
    this.intervalMs = initialIntervalMs;
  }

  get currentIntervalMs(): number {
    return this.intervalMs;
  }

  setIntervalMs(ms: number): void {
    this.intervalMs = ms;
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  ensure(intervalMs?: number): void {
    if (intervalMs !== undefined) this.intervalMs = intervalMs;
    if (!this.timer) this.schedule(this.intervalMs);
  }

  /** Restart the loop immediately with the given interval (or current). */
  reschedule(intervalMs?: number): void {
    if (intervalMs !== undefined) this.intervalMs = intervalMs;
    this.schedule(this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedule(intervalMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.isAlive()) return;
      this.onTick();
      // Continue only when stop() was not called during onTick.
      // (reschedule/ensure during onTick leaves a live handle — replace it.)
      if (this.timer !== undefined) {
        this.schedule(this.intervalMs);
      }
    }, intervalMs);
  }
}
