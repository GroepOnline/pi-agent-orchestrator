/**
 * schedule-e2e.test.ts — End-to-end integration test for the scheduler.
 *
 * Unlike `schedule.test.ts` (which uses vi.useFakeTimers), this exercises
 * the full real-timer firing path: real `setTimeout` triggers `executeJob`,
 * a faithful `AgentManager` mock (promise resolves with the right semantics)
 * runs through to `finalize`, and the on-disk `ScheduleStore` reflects the
 * outcome. Catches integration bugs that fake-timer microtask scheduling
 * can hide.
 *
 * Uses very short timings (100–300ms) so the test stays fast.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubagentScheduler } from "../src/schedule.js";
import { ScheduleStore } from "../src/schedule-store.js";

type FakeRecord = { status: string; promise: Promise<string>; resolve: () => void };

/**
 * Faithful AgentManager mock: spawn returns an id, getRecord returns a
 * record whose promise can be resolved at test time, status is mutable so
 * the test can assert success vs error inference.
 */
function makeFaithfulManager(initialStatus = "completed") {
  const records = new Map<string, FakeRecord>();
  return {
    records,
    initialStatus,
    spawn: vi.fn(function (this: any) {
      const id = `agent-${Math.random().toString(36).slice(2, 10)}`;
      let resolve!: () => void;
      const promise = new Promise<string>(r => { resolve = () => r(""); });
      records.set(id, { status: initialStatus, promise, resolve });
      // Auto-resolve on next tick — mimics a fast-finishing real agent.
      queueMicrotask(() => records.get(id)?.resolve());
      return id;
    }),
    getRecord: vi.fn(function (this: any, id: string) {
      return records.get(id);
    }),
  } as any;
}

function makePi() {
  return { events: { emit: vi.fn() } } as any;
}

function makeCtx() {
  return {
    cwd: "/tmp",
    modelRegistry: { find: vi.fn(), getAll: () => [], getAvailable: () => [] },
    sessionManager: { getSessionId: () => "sess-e2e" },
  } as any;
}

/**
 * Wait for a predicate, polling at 5ms intervals, with a deadline. The default
 * deadline is generous because these are real-timer tests: a loaded Windows CI
 * runner can delay a scheduled setTimeout well past a second, so a tight
 * deadline flakes even though the firing path is correct.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise(r => setTimeout(r, 5));
  }
}

describe("SubagentScheduler — end-to-end with real timers", () => {
  let tmp: string;
  let store: ScheduleStore;
  let scheduler: SubagentScheduler;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "schedule-e2e-"));
    store = await ScheduleStore.create(join(tmp, "schedules.json"));
    scheduler = new SubagentScheduler();
  });

  afterEach(() => {
    scheduler.stop();
    // maxRetries + retryDelay handles Windows file-locking races where the
    // proper-lockfile lockfile directory is briefly held open after release.
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("one-shot job: real setTimeout fires, agent runs, store reflects success", async () => {
    const manager = makeFaithfulManager("completed");
    const pi = makePi();
    await scheduler.start(pi, makeCtx(), manager, store);

    // Fire ~100ms in the future. detectSchedule normalizes "+100ms" — but our
    // parser only accepts s/m/h/d, so use a near-future ISO timestamp instead.
    const future = new Date(Date.now() + 200).toISOString();
    const job = await scheduler.addJob({
      name: "e2e-once",
      description: "test",
      schedule: future,
      subagent_type: "general-purpose",
      prompt: "hello",
    });
    expect(job.scheduleType).toBe("once");

    // Wait for the spawn to occur (real timer fires) and the finalize promise
    // chain to settle. Polling, no fake timers.
    await waitFor(() => manager.spawn.mock.calls.length === 1);
    await waitFor(() => scheduler.list().find(j => j.id === job.id)?.lastStatus === "success");

    const final = scheduler.list().find(j => j.id === job.id)!;
    expect(final.lastStatus).toBe("success");
    expect(final.runCount).toBe(1);
    expect(final.enabled).toBe(false);  // one-shot auto-disabled
    expect(final.lastRun).toBeDefined();
  }, 20_000);

  it("one-shot job that errors: store records lastStatus error (regression — bug #1)", async () => {
    const manager = makeFaithfulManager("error");  // Agent terminates with error status
    const pi = makePi();
    await scheduler.start(pi, makeCtx(), manager, store);

    const future = new Date(Date.now() + 200).toISOString();
    const job = await scheduler.addJob({
      name: "e2e-fail",
      description: "test",
      schedule: future,
      subagent_type: "general-purpose",
      prompt: "fail",
    });

    await waitFor(() => manager.spawn.mock.calls.length === 1);
    await waitFor(() => scheduler.list().find(j => j.id === job.id)?.lastStatus !== "running");

    expect(scheduler.list().find(j => j.id === job.id)?.lastStatus).toBe("error");
    expect(scheduler.list().find(j => j.id === job.id)?.runCount).toBe(1);
  }, 20_000);

  it("interval job: fires repeatedly, runCount grows", async () => {
    const manager = makeFaithfulManager("completed");
    const pi = makePi();
    await scheduler.start(pi, makeCtx(), manager, store);

    // 300ms interval — wait for ~3 fires (bumped from 150ms for Windows timing)
    const job = await scheduler.addJob({
      name: "e2e-interval",
      description: "test",
      schedule: "100s",  // Will be too long; override below.
      subagent_type: "general-purpose",
      prompt: "tick",
    });
    // Replace with a literal 300ms interval — easier than crafting a parseable shorthand for ms.
    // (parseInterval doesn't accept "ms"; we patch the persisted job and re-arm.)
    await scheduler.updateJob(job.id, { intervalMs: 300, schedule: "300ms" });

    await waitFor(() => scheduler.list().find(j => j.id === job.id)?.runCount >= 3, 5000);

    const final = scheduler.list().find(j => j.id === job.id)!;
    expect(final.runCount).toBeGreaterThanOrEqual(3);
    expect(final.lastStatus).toBe("success");
    expect(final.enabled).toBe(true);  // intervals don't auto-disable

    await scheduler.removeJob(job.id);
  }, 20_000);

  it("persistence: schedules survive re-instantiating the store on the same file", async () => {
    const manager = makeFaithfulManager("completed");
    const pi = makePi();
    await scheduler.start(pi, makeCtx(), manager, store);

    const future = new Date(Date.now() + 60_000).toISOString();  // far enough not to fire
    const job = await scheduler.addJob({
      name: "persistent",
      description: "x",
      schedule: future,
      subagent_type: "general-purpose",
      prompt: "x",
    });

    // Tear down the live scheduler; re-load from disk
    scheduler.stop();
    const reloadedStore = await ScheduleStore.create(join(tmp, "schedules.json"));
    expect(reloadedStore.list()).toHaveLength(1);
    expect(reloadedStore.list()[0].id).toBe(job.id);
    expect(reloadedStore.list()[0].name).toBe("persistent");
  });

  it("on-disk file shape: version=1 plus jobs array", async () => {
    const manager = makeFaithfulManager("completed");
    const pi = makePi();
    await scheduler.start(pi, makeCtx(), manager, store);

    await scheduler.addJob({
      name: "shape-test",
      description: "x",
      schedule: "1h",
      subagent_type: "general-purpose",
      prompt: "x",
    });

    const onDisk = JSON.parse(readFileSync(join(tmp, "schedules.json"), "utf-8"));
    expect(onDisk.version).toBe(1);
    expect(onDisk.jobs).toHaveLength(1);
    expect(onDisk.jobs[0]).toMatchObject({
      name: "shape-test",
      schedule: "1h",
      scheduleType: "interval",
      enabled: true,
      runCount: 0,
    });
  });

  it("subagents:scheduled events fire across the lifecycle", async () => {
    const manager = makeFaithfulManager("completed");
    const pi = makePi();
    await scheduler.start(pi, makeCtx(), manager, store);

    const future = new Date(Date.now() + 200).toISOString();
    const job = await scheduler.addJob({
      name: "events", description: "x", schedule: future,
      subagent_type: "general-purpose", prompt: "x",
    });

    await waitFor(() => manager.spawn.mock.calls.length === 1);
    // Let the one-shot's finalize settle before removing. removeJob reads the
    // in-memory cache synchronously (store.get), and the concurrent
    // lock-protected finalize reload transiently clears that cache mid-read on
    // slower Windows I/O — which otherwise makes removeJob miss the job and skip
    // the "removed" event. Mirrors the settle-wait in the one-shot success test.
    await waitFor(() => scheduler.list().find(j => j.id === job.id)?.lastStatus === "success");

    const eventTypes = pi.events.emit.mock.calls
      .filter((c: any[]) => c[0] === "subagents:scheduled")
      .map((c: any[]) => c[1].type);

    expect(eventTypes).toContain("added");
    expect(eventTypes).toContain("fired");

    await scheduler.removeJob(job.id);
    const after = pi.events.emit.mock.calls
      .filter((c: any[]) => c[0] === "subagents:scheduled")
      .map((c: any[]) => c[1].type);
    expect(after).toContain("removed");
  }, 20_000);
});
