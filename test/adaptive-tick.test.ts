import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdaptiveTick } from "../src/ui/adaptive-tick.js";

describe("AdaptiveTick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("self-reschedules until stopped", () => {
    const onTick = vi.fn();
    const tick = new AdaptiveTick(() => true, onTick, 100);
    tick.ensure();

    vi.advanceTimersByTime(100);
    expect(onTick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(onTick).toHaveBeenCalledTimes(2);

    tick.stop();
    vi.advanceTimersByTime(500);
    expect(onTick).toHaveBeenCalledTimes(2);
  });

  it("honors interval changes applied during onTick", () => {
    let calls = 0;
    const tick = new AdaptiveTick(() => true, () => {
      calls += 1;
      if (calls === 1) tick.setIntervalMs(200);
    }, 50);
    tick.ensure();
    vi.advanceTimersByTime(50);
    expect(calls).toBe(1);
    // Next auto-schedule uses the updated 200ms cadence.
    vi.advanceTimersByTime(199);
    expect(calls).toBe(1);
    vi.advanceTimersByTime(1);
    expect(calls).toBe(2);
  });

  it("stops rescheduling when isAlive becomes false", () => {
    let alive = true;
    const onTick = vi.fn(() => {
      alive = false;
    });
    const tick = new AdaptiveTick(() => alive, onTick, 10);
    tick.ensure();
    vi.advanceTimersByTime(10);
    expect(onTick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(onTick).toHaveBeenCalledTimes(1);
  });

  it("honors stop() called during onTick", () => {
    const tick = new AdaptiveTick(() => true, () => {
      tick.stop();
    }, 10);
    tick.ensure();
    vi.advanceTimersByTime(10);
    vi.advanceTimersByTime(100);
    expect(tick.running).toBe(false);
  });
});
