import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
}));

import { runAgent } from "../src/agent-runner.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

const mockSession = () => ({ dispose: vi.fn() } as any);

const resolvedRun = () =>
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "done",
    session: mockSession(),
    aborted: false,
    steered: false,
  });

describe("AgentManager — Bug 1 race condition (resultConsumed vs onComplete)", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("reproduces bug: onComplete fires with resultConsumed=false when set after await", async () => {
    let seenConsumed: boolean | undefined;
    manager = new AgentManager((r) => {
      seenConsumed = r.resultConsumed;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    // Simulate the buggy get_subagent_result: await THEN mark consumed
    await record.promise;
    record.resultConsumed = true; // too late — onComplete already fired

    // onComplete saw resultConsumed as falsy (undefined) — would queue a notification (the bug)
    expect(seenConsumed).toBeFalsy();
  });

  it("fix: onComplete sees resultConsumed=true when pre-marked before await", async () => {
    let seenConsumed: boolean | undefined;
    manager = new AgentManager((r) => {
      seenConsumed = r.resultConsumed;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    // The fix: pre-mark BEFORE awaiting
    record.resultConsumed = true;
    await record.promise;

    expect(seenConsumed).toBe(true);
  });

  it("normal case: onComplete fires with resultConsumed falsy when no explicit polling", async () => {
    let completedRecord: AgentRecord | undefined;
    manager = new AgentManager((r) => {
      completedRecord = r;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(completedRecord).toBeDefined();
    expect(completedRecord!.resultConsumed).toBeFalsy();
  });

  it("onComplete is not called for foreground agents", async () => {
    let onCompleteCalled = false;
    manager = new AgentManager(() => {
      onCompleteCalled = true;
    });
    resolvedRun();

    await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });

    expect(onCompleteCalled).toBe(false);
  });

  it("onComplete fires when a queued background agent is aborted", async () => {
    const completed: string[] = [];
    manager = new AgentManager((r) => {
      completed.push(r.id);
    });
    manager.setMaxConcurrent(1);
    // Never resolve the first runner so the second stays queued.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const runningId = manager.spawn(mockPi, mockCtx, "general-purpose", "run", {
      description: "running",
      isBackground: true,
    });
    const queuedId = manager.spawn(mockPi, mockCtx, "general-purpose", "queued", {
      description: "queued",
      isBackground: true,
    });
    expect(manager.getRecord(queuedId)!.status).toBe("queued");

    expect(manager.abort(queuedId)).toBe(true);
    expect(manager.getRecord(queuedId)!.status).toBe("stopped");
    expect(completed).toEqual([queuedId]);

    manager.abort(runningId);
  });
});

describe("AgentManager — completion callbacks", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("does not let onComplete errors turn a completed agent into a failed run", async () => {
    manager = new AgentManager(() => {
      throw new Error("stale extension context");
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await expect(manager.getRecord(id)!.promise).resolves.toBe("done");

    expect(manager.getRecord(id)!.status).toBe("completed");
  });
});

describe("AgentManager — cleanup timer", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("does not keep the process alive on its own", () => {
    manager = new AgentManager();

    expect((manager as any).cleanupInterval.hasRef()).toBe(false);
  });
});

describe("AgentManager — session limits and usage accounting", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
    vi.clearAllMocks();
  });

  it("setSessionLimits normalizes invalid values and getSessionUsage returns snapshots", async () => {
    manager = new AgentManager();
    manager.setSessionLimits({
      maxAgentsPerSession: 2,
      maxTotalTurnsPerSession: 2.5,
    });

    expect(manager.getSessionLimits()).toEqual({
      maxAgentsPerSession: 2,
      maxTotalTurnsPerSession: undefined,
    });

    const limitsSnapshot = manager.getSessionLimits();
    limitsSnapshot.maxAgentsPerSession = 999;
    expect(manager.getSessionLimits()).toEqual({
      maxAgentsPerSession: 2,
      maxTotalTurnsPerSession: undefined,
    });

    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onTurnEnd?.(1);
      opts.onTurnEnd?.(3);
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(manager.getSessionUsage()).toEqual({ spawnedAgents: 1, totalTurns: 3 });

    const usageSnapshot = manager.getSessionUsage();
    usageSnapshot.spawnedAgents = 999;
    usageSnapshot.totalTurns = 999;
    expect(manager.getSessionUsage()).toEqual({ spawnedAgents: 1, totalTurns: 3 });
  });

  it("enforces maxAgentsPerSession and resetSessionUsage re-allows spawns", async () => {
    manager = new AgentManager();
    manager.setSessionLimits({ maxAgentsPerSession: 1 });
    resolvedRun();

    const firstId = manager.spawn(mockPi, mockCtx, "general-purpose", "first", {
      description: "first",
      isBackground: true,
    });
    await manager.getRecord(firstId)!.promise;

    expect(() =>
      manager.spawn(mockPi, mockCtx, "general-purpose", "second", {
        description: "second",
        isBackground: true,
      }),
    ).toThrow("Session agent limit reached (1/1)");

    expect(manager.getSessionUsage()).toEqual({ spawnedAgents: 1, totalTurns: 0 });

    manager.resetSessionUsage();
    expect(manager.getSessionUsage()).toEqual({ spawnedAgents: 0, totalTurns: 0 });

    resolvedRun();
    const nextId = manager.spawn(mockPi, mockCtx, "general-purpose", "after reset", {
      description: "after reset",
      isBackground: true,
    });
    await manager.getRecord(nextId)!.promise;
    expect(manager.getSessionUsage()).toEqual({ spawnedAgents: 1, totalTurns: 0 });
  });

  it("aborts the run when maxTotalTurnsPerSession is reached and tracks totalTurns", async () => {
    manager = new AgentManager();
    manager.setSessionLimits({ maxTotalTurnsPerSession: 2 });

    let seenSignal: AbortSignal | undefined;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      seenSignal = opts.signal;
      opts.onTurnEnd?.(1);
      opts.onTurnEnd?.(2);
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "limit test", {
      description: "limit test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(seenSignal?.aborted).toBe(true);
    expect(manager.getSessionUsage()).toEqual({ spawnedAgents: 1, totalTurns: 2 });
    expect(manager.getRecord(id)!.error).toBe("Session turn limit reached (2/2)");
  });
});

describe("AgentManager — Bug 3 clearCompleted", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("clearCompleted removes completed records", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(manager.listAgents()).toHaveLength(1);
    manager.clearCompleted();
    expect(manager.listAgents()).toHaveLength(0);
  });

  it("clearCompleted does not remove running or queued agents", async () => {
    // Use maxConcurrent=0 to keep agents queued, then spawn one running via foreground
    manager = new AgentManager(undefined, 1);

    // Mock runAgent to never resolve (keeps agent "running")
    vi.mocked(runAgent).mockImplementation(
      () => new Promise(() => {}), // hangs forever
    );

    const id1 = manager.spawn(mockPi, mockCtx, "general-purpose", "test1", {
      description: "running agent",
      isBackground: true,
    });
    // Second agent should be queued (limit=1)
    const id2 = manager.spawn(mockPi, mockCtx, "general-purpose", "test2", {
      description: "queued agent",
      isBackground: true,
    });

    expect(manager.getRecord(id1)!.status).toBe("running");
    expect(manager.getRecord(id2)!.status).toBe("queued");

    manager.clearCompleted();

    // Both should still be present
    expect(manager.getRecord(id1)).toBeDefined();
    expect(manager.getRecord(id2)).toBeDefined();

    // Abort to allow cleanup
    manager.abort(id1);
    manager.abort(id2);
  });

  it("clearCompleted calls dispose on sessions of removed records", async () => {
    manager = new AgentManager();
    const disposeSpy = vi.fn();
    const sess = { dispose: disposeSpy };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: sess as any,
      aborted: false,
      steered: false,
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    manager.clearCompleted();

    expect(disposeSpy).toHaveBeenCalledOnce();
  });

  it("clearCompleted removes error and stopped records", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("error");

    manager.clearCompleted();
    expect(manager.getRecord(id)).toBeUndefined();
  });
});

// Eager init removes the optional/required asymmetry that previously required
// `??=` defaults at the callback sites and `?? 0` / `?? 1` at the read sites.
describe("AgentManager — lifetime usage + compaction count are eagerly initialized", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("spawn initializes lifetimeUsage to zeros and compactionCount to 0", () => {
    manager = new AgentManager();
    // Don't resolve the run — we just want to inspect the record at spawn time.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    expect(record.compactionCount).toBe(0);

    manager.abort(id);
  });

  it("onAssistantUsage from runAgent accumulates into record.lifetimeUsage", async () => {
    manager = new AgentManager();

    // Capture the options passed to runAgent so we can drive callbacks
    let captured: any;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      captured = opts;
      // Two assistant messages with usage
      opts.onAssistantUsage?.({ input: 100, output: 50, cacheWrite: 10 });
      opts.onAssistantUsage?.({ input: 200, output: 80, cacheWrite: 20 });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(captured).toBeDefined();
    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({
      input: 300, output: 130, cacheWrite: 30,
    });
  });

  it("onCompaction from runAgent increments record.compactionCount and stores lastCompaction", async () => {
    manager = new AgentManager();
    const compactSeen: Array<{ count: number; reason: string }> = [];

    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts) => {
      // Compaction fires while the agent is still running — the record passed to
      // onCompact should reflect the just-incremented count.
      opts?.onCompaction?.({
        reason: "threshold",
        tokensBefore: 12345,
        tokensAfter: 4000,
        usage: { input: 11, output: 7, cacheWrite: 2 },
        aborted: false,
      });
      opts?.onCompaction?.({ reason: "manual", tokensBefore: 22222, aborted: true, willRetry: true });
      opts?.onCompaction?.({ reason: "manual", tokensBefore: 22222, aborted: false });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    manager = new AgentManager(undefined, undefined, undefined, (record, info) => {
      compactSeen.push({ count: record.compactionCount, reason: info.reason });
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    // Successful, aborted (no count bump), then successful again.
    expect(compactSeen).toEqual([
      { count: 1, reason: "threshold" },
      { count: 1, reason: "manual" },
      { count: 2, reason: "manual" },
    ]);
    const record = manager.getRecord(id)!;
    expect(record.compactionCount).toBe(2);
    expect(record.lastCompaction).toMatchObject({ reason: "manual", tokensBefore: 22222, aborted: false });
    // Summarization usage from the first successful compaction is folded in.
    expect(record.lifetimeUsage).toEqual({ input: 11, output: 7, cacheWrite: 2 });
  });

  it("resume() also accumulates usage and increments compactions on the same record", async () => {
    manager = new AgentManager();

    // First, spawn with a session that resume can latch onto
    const session = { ...mockSession() };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "first",
      session: session as any,
      aborted: false,
      steered: false,
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    // Pre-resume: lifetimeUsage from spawn was zero (mock didn't call onAssistantUsage)
    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    expect(manager.getRecord(id)!.compactionCount).toBe(0);

    // Now resume — drive callbacks via the mocked resumeAgent
    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    vi.mocked(resumeMock).mockImplementation(async (_session, _prompt, opts: any) => {
      opts.onAssistantUsage?.({ input: 70, output: 30, cacheWrite: 5 });
      opts.onCompaction?.({ reason: "overflow", tokensBefore: 999 });
      return "second";
    });

    await manager.resume(id, "more");

    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 70, output: 30, cacheWrite: 5 });
    expect(manager.getRecord(id)!.compactionCount).toBe(1);
  });
});

// Regression: `isolation: "worktree"` MUST fail loud when the cwd can't host
// a worktree. The previous behavior silently fell back to the main tree and
// injected a warning into the LLM's prompt — invisible to the caller.
describe("AgentManager — isolation: worktree fails loud, no silent fallback", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("spawn() handles async worktree failure and cleans up record", async () => {
    const { createWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockResolvedValueOnce(undefined);
    vi.mocked(runAgent).mockClear();

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
    });
    const promise = manager.getRecord(id)!.promise!;

    await expect(promise).rejects.toThrow(/isolation: "worktree"/);

    // Cleaned up — no orphan in listAgents()
    expect(manager.listAgents()).toEqual([]);
    // runAgent never invoked — strict, no silent fallback
    expect(runAgent).not.toHaveBeenCalled();
  });
});

describe("AgentManager — stable spawn-time completion promises (#327)", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("exposes a completion promise immediately for queued background agents", async () => {
    manager = new AgentManager();
    manager.setMaxConcurrent(1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const runningId = manager.spawn(mockPi, mockCtx, "general-purpose", "run", {
      description: "running",
      isBackground: true,
    });
    const queuedId = manager.spawn(mockPi, mockCtx, "general-purpose", "queued", {
      description: "queued",
      isBackground: true,
    });

    const queued = manager.getRecord(queuedId)!;
    expect(queued.status).toBe("queued");
    expect(queued.promise).toBeInstanceOf(Promise);

    let settled = false;
    void queued.promise!.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    expect(manager.abort(queuedId)).toBe(true);
    await expect(queued.promise).resolves.toBe("");
    expect(settled).toBe(true);

    manager.abort(runningId);
  });

  it("settles the spawn-time promise exactly once when a queued agent is aborted", async () => {
    manager = new AgentManager();
    manager.setMaxConcurrent(1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const runningId = manager.spawn(mockPi, mockCtx, "general-purpose", "run", {
      description: "running",
      isBackground: true,
    });
    const queuedId = manager.spawn(mockPi, mockCtx, "general-purpose", "queued", {
      description: "queued",
      isBackground: true,
    });
    const promise = manager.getRecord(queuedId)!.promise!;

    manager.abort(queuedId);
    manager.abort(queuedId); // second abort is a no-op
    await expect(promise).resolves.toBe("");

    manager.abort(runningId);
  });

  it("abandons worktree startup when the parent signal aborts during setup", async () => {
    const { createWorktree } = await import("../src/worktree.js");
    let resolveWorktree!: (value: { path: string; branch: string }) => void;
    vi.mocked(createWorktree).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWorktree = resolve;
        }),
    );
    vi.mocked(runAgent).mockClear();

    manager = new AgentManager();
    const controller = new AbortController();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
      signal: controller.signal,
    });
    const record = manager.getRecord(id)!;
    const promise = record.promise!;

    controller.abort();
    resolveWorktree({ path: "/tmp/wt", branch: "agent-test" });

    await expect(promise).resolves.toBe("");
    expect(record.status).toBe("stopped");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("dispose settles queued completion gates so waitForAll does not hang", async () => {
    manager = new AgentManager();
    manager.setMaxConcurrent(1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const _runningId = manager.spawn(mockPi, mockCtx, "general-purpose", "run", {
      description: "running",
      isBackground: true,
    });
    const queuedId = manager.spawn(mockPi, mockCtx, "general-purpose", "queued", {
      description: "queued",
      isBackground: true,
    });
    const queuedPromise = manager.getRecord(queuedId)!.promise!;

    const waitForAll = manager.waitForAll();
    manager.dispose();

    await expect(queuedPromise).resolves.toBe("");
    await expect(waitForAll).resolves.toBeUndefined();
    expect((manager as any).completionGates.size).toBe(0);
  });

  it("abortAll settles dequeued-but-not-running agents stuck in startAgent setup", async () => {
    const { createWorktree } = await import("../src/worktree.js");
    let resolveWorktree!: (value: { path: string; branch: string }) => void;
    vi.mocked(createWorktree).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWorktree = resolve;
        }),
    );
    vi.mocked(runAgent).mockClear();

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "mid-setup",
      isolation: "worktree",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    const promise = record.promise!;

    // Dequeued into startAgent, still status "queued", no longer in this.queue.
    expect(record.status).toBe("queued");
    expect((manager as any).queue).toEqual([]);

    expect(manager.abortAll()).toBe(1);
    expect(record.status).toBe("stopped");
    await expect(promise).resolves.toBe("");

    resolveWorktree({ path: "/tmp/wt", branch: "agent-test" });
    await Promise.resolve();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("dispose settles dequeued-but-not-running agents stuck in startAgent setup", async () => {
    const { createWorktree } = await import("../src/worktree.js");
    let resolveWorktree!: (value: { path: string; branch: string }) => void;
    vi.mocked(createWorktree).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWorktree = resolve;
        }),
    );
    vi.mocked(runAgent).mockClear();

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "mid-setup",
      isolation: "worktree",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    const promise = record.promise!;

    expect(record.status).toBe("queued");
    expect((manager as any).queue).toEqual([]);

    manager.dispose();
    await expect(promise).resolves.toBe("");

    resolveWorktree({ path: "/tmp/wt", branch: "agent-test" });
    await Promise.resolve();
    expect(runAgent).not.toHaveBeenCalled();
  });
});
