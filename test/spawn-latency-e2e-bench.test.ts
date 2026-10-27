/**
 * spawn-latency-e2e-bench.test.ts — End-to-end spawn latency benchmark.
 *
 * Measures the full time from `runAgent()` start to first token (message_start).
 * Uses the same mock patterns as agent-runner.test.ts to create a realistic
 * agent pipeline without requiring a real model API call.
 *
 * Metrics captured:
 * - latencyToFirstTokenMs: time from runAgent() start to first message_start event
 * - totalDurationMs: time from runAgent() start to completion
 * - contextBuiltAt delta: time from spawnedAt to deferred context built
 *
 * The spawn pipeline includes:
 *   config resolution → tool setup → system prompt → model resolution →
 *   session creation → deferred context build → session.prompt() → first token
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { benchmarkLog } from "./helpers/benchmark-log.js";

// ============================================================================
// Hoisted mocks — must be before any vi.mock() calls
// ============================================================================

const {
  createAgentSession,
  defaultResourceLoaderCtor,
  getAgentDir,
  sessionManagerInMemory,
  settingsManagerCreate,
  mockCreateWorktree,
  mockCleanupWorktree,
  mockPruneWorktrees,
} = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  defaultResourceLoaderCtor: vi.fn(),
  getAgentDir: vi.fn(() => "/mock/agent-dir"),
  sessionManagerInMemory: vi.fn(() => ({ kind: "memory-session-manager" })),
  settingsManagerCreate: vi.fn(() => ({ kind: "settings-manager" })),
  mockCreateWorktree: vi.fn(async () => ({ path: "/tmp/pi-bench-worktree", branch: "bench-branch" })),
  mockCleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  mockPruneWorktrees: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession,
  DefaultResourceLoader: class {
    constructor(options: any) {
      defaultResourceLoaderCtor(options);
    }
    async reload() {}
  },
  getAgentDir,
  SessionManager: { inMemory: sessionManagerInMemory },
  SettingsManager: { create: settingsManagerCreate },
}));

vi.mock("../src/agent-types.js", () => ({
  getConfig: vi.fn(() => ({
    displayName: "Explore",
    description: "Explore",
    builtinToolNames: ["read", "write", "edit", "bash", "grep", "glob", "find"],
    extensions: false,
    skills: false,
    promptMode: "replace",
  })),
  getAgentConfig: vi.fn(() => ({
    name: "Explore",
    description: "Explore",
    builtinToolNames: ["read", "write", "edit", "bash", "grep", "glob", "find"],
    extensions: false,
    skills: false,
    systemPrompt: "You are a helpful agent.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
  })),
  getMemoryToolNames: vi.fn(() => []),
  getReadOnlyMemoryToolNames: vi.fn(() => []),
  getToolNamesForType: vi.fn(() => ["read", "write", "edit", "bash", "grep", "glob", "find"]),
}));

vi.mock("../src/prompts.js", () => ({
  buildAgentPrompt: vi.fn(() => "system prompt from mock"),
}));

vi.mock("../src/memory.js", () => ({
  buildMemoryBlock: vi.fn(() => ""),
  buildReadOnlyMemoryBlock: vi.fn(() => ""),
}));

vi.mock("../src/skill-loader.js", () => ({
  preloadSkills: vi.fn(() => []),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: mockCreateWorktree,
  cleanupWorktree: mockCleanupWorktree,
  pruneWorktrees: mockPruneWorktrees,
}));

// NOTE: context.js is intentionally NOT mocked so buildParentContext uses
// the real implementation. This correctly measures conversation serialization
// cost, which is the dominant part of deferred context build time.

// ============================================================================
// Helpers
// ============================================================================

function createSession() {
  const listeners: Array<(event: any) => void> = [];
  const session = {
    messages: [] as any[],
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.push(listener);
      return () => {};
    }),
    prompt: vi.fn(async () => {
      // Fire events synchronously — same pattern as agent-runner.test.ts
      for (const l of listeners) l({ type: "message_start" });
      for (const l of listeners) l({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello!" } });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "Hello!" }] });
      for (const l of listeners) l({ type: "turn_end" });
    }),
    abort: vi.fn(),
    steer: vi.fn(),
    getActiveToolNames: vi.fn(() => ["read", "write"]),
    setActiveToolsByName: vi.fn(),
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  return { session, listeners };
}

/** Build a mock ExtensionContext with optional parent conversation size. */
function buildCtx(parentContextSize = 0): any {
  const entries: any[] = [];
  for (let i = 0; i < parentContextSize; i++) {
    entries.push({
      type: "message",
      message: {
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `Message ${i}: some conversation content for the parent session.` }],
      },
    });
  }
  return {
    cwd: "/tmp",
    model: { provider: "test", id: "test-model" },
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent system prompt"),
    sessionManager: { getBranch: vi.fn(() => entries) },
  };
}

// ============================================================================
// Benchmark tests
// ============================================================================

describe("Benchmark: spawn latency — minimal (no inherit, no context)", () => {
  let runAgent: typeof import("../src/agent-runner.js").runAgent;

  beforeEach(async () => {
    vi.clearAllMocks();
    createAgentSession.mockReset();
    const mod = await import("../src/agent-runner.js");
    runAgent = mod.runAgent;
  });

  it("no-inherit spawn latency under 50ms (setup overhead only)", async () => {
    const { session } = createSession();
    createAgentSession.mockResolvedValue({ session });
    const ctx = buildCtx(0);
    const pi = {} as any;

    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const result = await runAgent(ctx, "Explore", "Hello!", { pi });
      const elapsed = performance.now() - start;
      runs.push(result.metrics.latencyToFirstTokenMs ?? elapsed);
    }
    const median = [...runs].sort((a, b) => a - b)[2];

    benchmarkLog("spawn-latency no-inherit", median, 50);
    expect(median).toBeLessThan(50);
  });

  it("records latencyToFirstTokenMs in RunMetrics and fires agent:spawned telemetry", async () => {
    const { onTelemetry } = await import("../src/telemetry.js");
    const { session } = createSession();
    createAgentSession.mockResolvedValue({ session });
    const ctx = buildCtx(0);
    const pi = {} as any;

    // Register telemetry handler to capture agent:spawned events
    let telemetryPayload: any = null;
    const unsubscribe = onTelemetry("agent:spawned", (payload) => {
      telemetryPayload = payload;
    });

    try {
      const result = await runAgent(ctx, "Explore", "Hello!", { pi });

      expect(result.metrics).toBeDefined();
      expect(result.metrics.latencyToFirstTokenMs).toBeGreaterThan(0);
      expect(result.metrics.durationMs).toBeGreaterThan(0);
      expect(result.metrics.turns).toBeGreaterThan(0);

      // Verify telemetry was emitted
      expect(telemetryPayload).not.toBeNull();
      expect(telemetryPayload.type).toBe("Explore");
      expect(telemetryPayload.depth).toBe(0);

      // Telemetry → first token latency should be near-instant with mocks
      const telemetryToFirstToken = result.metrics.latencyToFirstTokenMs!;
      benchmarkLog("telemetry-to-first-token", telemetryToFirstToken, 50);
    } finally {
      unsubscribe();
    }
  });
});

describe("Benchmark: spawn latency — with inheritContext", () => {
  let runAgent: typeof import("../src/agent-runner.js").runAgent;

  beforeEach(async () => {
    vi.clearAllMocks();
    createAgentSession.mockReset();
    const mod = await import("../src/agent-runner.js");
    runAgent = mod.runAgent;
  });

  it("inherit-context with 10 parent messages under 50ms", async () => {
    const { session } = createSession();
    createAgentSession.mockResolvedValue({ session });
    const ctx = buildCtx(10);
    const pi = {} as any;

    const result = await runAgent(ctx, "Explore", "Hello!", {
      pi,
      inheritContext: true,
    });

    const latency = result.metrics.latencyToFirstTokenMs!;
    benchmarkLog("spawn-latency inherit 10", latency, 50);
    expect(latency).toBeLessThan(50);
  });

  it("inherit-context with 50 parent messages under 60ms", async () => {
    const { session } = createSession();
    createAgentSession.mockResolvedValue({ session });
    const ctx = buildCtx(50);
    const pi = {} as any;

    const result = await runAgent(ctx, "Explore", "Hello!", {
      pi,
      inheritContext: true,
    });

    const latency = result.metrics.latencyToFirstTokenMs!;
    benchmarkLog("spawn-latency inherit 50", latency, 60);
    expect(latency).toBeLessThan(60);
  });
});

describe("Benchmark: spawn latency — agent-manager pipeline", () => {
  let AgentManager: typeof import("../src/agent-manager.js").AgentManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    createAgentSession.mockReset();
    const { session } = createSession();
    createAgentSession.mockResolvedValue({ session });
    const mod = await import("../src/agent-manager.js");
    AgentManager = mod.AgentManager;
  });

  /**
   * Simulate a foreground spawn via AgentManager, which includes the
   * overhead of: record creation → worktree check → permission inheritance
   * → runAgent() pipeline → first token.
   */
  it("full AgentManager foreground spawn under 100ms", async () => {
    const manager = new AgentManager();
    const ctx = buildCtx(0);
    const pi = {} as any;

    const start = performance.now();
    const _record = await manager.spawnAndWait(pi, ctx, "Explore", "Hello!", {
      description: "benchmark spawn",
      inheritContext: false,
    });
    const elapsed = performance.now() - start;

    benchmarkLog("spawn-manager foreground", elapsed, 100);
    expect(elapsed).toBeLessThan(100);
  });
});

// ============================================================================
// Setup pipeline breakdown — measures each phase of the pre-model overhead
// Uses performance.now() timestamps from inside mocked createAgentSession and
// session.prompt so we get sub-ms precision for the setup phases.
// ============================================================================

describe("Benchmark: setup pipeline breakdown (performance.now() precision)", () => {
  let runAgent: typeof import("../src/agent-runner.js").runAgent;

  beforeEach(async () => {
    vi.clearAllMocks();
    createAgentSession.mockReset();
    const mod = await import("../src/agent-runner.js");
    runAgent = mod.runAgent;
  });

  it("measures setup→session and session→prompt breakdown", async () => {
    let sessionCreatedAt = 0;
    let promptCalledAt = 0;

    createAgentSession.mockImplementation(async () => {
      sessionCreatedAt = performance.now();
      const { session, listeners } = createRawSession();
      session.prompt = vi.fn(async () => {
        promptCalledAt = performance.now();
        for (const l of listeners) l({ type: "message_start" });
        for (const l of listeners) l({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello!" } });
        session.messages.push({ role: "assistant", content: [{ type: "text", text: "Hello!" }] });
        for (const l of listeners) l({ type: "turn_end" });
      });
      return { session };
    });
    const ctx = buildCtx(0);
    const pi = {} as any;

    const setupTimes: number[] = [];
    const wireupTimes: number[] = [];
    const totalTimes: number[] = [];

    for (let i = 0; i < 3; i++) {
      sessionCreatedAt = 0;
      promptCalledAt = 0;
      const start = performance.now();
      await runAgent(ctx, "Explore", "Hello!", { pi });
      const total = performance.now() - start;
      const toSession = sessionCreatedAt - start;
      const sessionToPrompt = promptCalledAt - sessionCreatedAt;
      setupTimes.push(toSession);
      wireupTimes.push(sessionToPrompt);
      totalTimes.push(total);
    }

    const medianSetup = [...setupTimes].sort((a, b) => a - b)[1];
    const medianWireup = [...wireupTimes].sort((a, b) => a - b)[1];
    const medianTotal = [...totalTimes].sort((a, b) => a - b)[1];

    benchmarkLog("setup→session-creation", medianSetup, 20);
    benchmarkLog("session→prompt (wireup)", medianWireup, 10);
    benchmarkLog("total setup overhead", medianTotal, 20);

    expect(medianSetup).toBeLessThan(20);
    expect(medianWireup).toBeLessThan(10);
    expect(medianTotal).toBeLessThan(20);
  });

  it("inherit-context 200 adds overhead to setup→session", async () => {
    let sessionCreatedAt = 0;

    createAgentSession.mockImplementation(async () => {
      sessionCreatedAt = performance.now();
      const { session, listeners } = createRawSession();
      session.prompt = vi.fn(async () => {
        for (const l of listeners) l({ type: "message_start" });
        for (const l of listeners) l({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello!" } });
        session.messages.push({ role: "assistant", content: [{ type: "text", text: "Hello!" }] });
        for (const l of listeners) l({ type: "turn_end" });
      });
      return { session };
    });

    const ctx = buildCtx(200);
    const pi = {} as any;

    const start = performance.now();
    await runAgent(ctx, "Explore", "Hello!", { pi, inheritContext: true });
    const total = performance.now() - start;
    const toSession = sessionCreatedAt - start;

    benchmarkLog("setup→session w/ inherit 200", toSession, 40);
    benchmarkLog("total setup w/ inherit 200", total, 25);

    expect(toSession).toBeLessThan(40);
    expect(total).toBeLessThan(25);
  });
});

// ============================================================================
// Benchmark: AgentManager queueing pipeline
// ============================================================================

describe("Benchmark: AgentManager queueing pipeline", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    createAgentSession.mockReset();
  });

  it("queues background agents when maxConcurrent=1 and drains on completion", async () => {
    // Create sessions with a small delay on the first so queue timing is observable
    let sessionCount = 0;
    createAgentSession.mockImplementation(async () => {
      sessionCount++;
      const current = sessionCount;
      const { session, listeners } = createRawSession();
      session.prompt = vi.fn(async () => {
        // First agent's prompt takes ~5ms so queue fills up before it completes
        if (current === 1) {
          await new Promise((r) => setTimeout(r, 5));
        }
        for (const l of listeners) l({ type: "message_start" });
        for (const l of listeners)
          l({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } });
        session.messages.push({ role: "assistant", content: [{ type: "text", text: "done" }] });
        for (const l of listeners) l({ type: "turn_end" });
      });
      return { session };
    });

    const { AgentManager } = await import("../src/agent-manager.js");
    const manager = new AgentManager(() => {}, 1); // maxConcurrent = 1
    const ctx = buildCtx(0);
    const pi = {} as any;

    const t0 = performance.now();

    // Spawn 3 background agents — only 1 runs, the rest are queued
    const id1 = manager.spawn(pi, ctx, "Explore", "task1", {
      description: "queue test 1",
      isBackground: true,
    });
    const id2 = manager.spawn(pi, ctx, "Explore", "task2", {
      description: "queue test 2",
      isBackground: true,
    });
    const id3 = manager.spawn(pi, ctx, "Explore", "task3", {
      description: "queue test 3",
      isBackground: true,
    });

    const t1 = performance.now();
    const spawnOverhead = t1 - t0;

    // Synchronous spawns — queued agents should have status "queued" immediately
    expect(manager.getRecord(id1)!.status).toBe("running");
    expect(manager.getRecord(id2)!.status).toBe("queued");
    expect(manager.getRecord(id3)!.status).toBe("queued");

    // Wait for all to complete (drainQueue fires after each completion)
    await manager.waitForAll();
    const t2 = performance.now();
    const drainTotal = t2 - t0;

    // All should now be completed
    expect(manager.getRecord(id1)!.status).toBe("completed");
    expect(manager.getRecord(id2)!.status).toBe("completed");
    expect(manager.getRecord(id3)!.status).toBe("completed");

    benchmarkLog("queue-spawn overhead (3 bg, maxConcurrent=1)", spawnOverhead, 10);
    benchmarkLog("queue-drain total (3 bg, maxConcurrent=1)", drainTotal, 150);

    expect(spawnOverhead).toBeLessThan(10);
    expect(drainTotal).toBeLessThan(150);

    manager.dispose();
  });
});

// ============================================================================
// Benchmark: AgentManager worktree isolation
// ============================================================================

describe("Benchmark: AgentManager worktree isolation", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    createAgentSession.mockReset();
    mockCreateWorktree.mockReset();
    mockCreateWorktree.mockResolvedValue({ path: "/tmp/pi-bench-worktree", branch: "bench-branch" });
    const { session } = createSession();
    createAgentSession.mockResolvedValue({ session });
  });

  it("foreground spawn with isolation:worktree adds worktree creation overhead", async () => {
    const { AgentManager } = await import("../src/agent-manager.js");
    const manager = new AgentManager();
    const ctx = buildCtx(0);
    const pi = {} as any;

    const start = performance.now();
    // Use spawn() + manual await because spawnAndWait() expects record.promise
    // to be set synchronously, but worktree creation is async inside startAgent.
    const id = manager.spawn(pi, ctx, "Explore", "Hello!", {
      description: "worktree benchmark",
      isolation: "worktree",
    });
    const record = manager.getRecord(id)!;
    // Flush microtasks so the mock createWorktree resolve sets record.promise
    await new Promise((r) => setTimeout(r, 0));
    await record.promise;
    const elapsed = performance.now() - start;

    benchmarkLog("spawn-manager worktree isolation", elapsed, 150);
    expect(elapsed).toBeLessThan(150);
    expect(mockCreateWorktree).toHaveBeenCalled();
    expect(record.status).toBe("completed");

    manager.dispose();
  });

  it("normal spawn (no isolation) is faster than worktree spawn", async () => {
    const { AgentManager } = await import("../src/agent-manager.js");
    const manager = new AgentManager();
    const ctx = buildCtx(0);
    const pi = {} as any;

    const start = performance.now();
    await manager.spawnAndWait(pi, ctx, "Explore", "Hello!", {
      description: "normal benchmark",
    });
    const elapsed = performance.now() - start;

    benchmarkLog("spawn-manager normal (vs worktree)", elapsed, 100);
    expect(elapsed).toBeLessThan(100);

    // worktree should NOT be called for non-isolation spawns
    expect(mockCreateWorktree).not.toHaveBeenCalled();

    manager.dispose();
  });
});

// ============================================================================
// Benchmark: AgentManager permission inheritance
// ============================================================================

describe("Benchmark: AgentManager permission inheritance", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    createAgentSession.mockReset();
    const { session } = createSession();
    createAgentSession.mockResolvedValue({ session });
  });

  it("full pipeline with parent on active stack triggers parentConfig lookup", async () => {
    const { activeAgentStorage, AgentManager } = await import("../src/agent-manager.js");
    const manager = new AgentManager();
    const ctx = buildCtx(0);
    const pi = {} as any;

    // Install a synthetic parent record and run the child spawn in its async
    // context so permission inheritance resolves the correct parent.
    const parentId = "parent-bench";
    (manager as any).agents.set(parentId, {
      id: parentId,
      type: "Explore",
      status: "running",
    });

    const start = performance.now();
    const _record = await activeAgentStorage.run(parentId, () =>
      manager.spawnAndWait(pi, ctx, "general-purpose", "Hello!", {
        description: "child with permission inheritance",
        inheritContext: false,
      })
    );
    const elapsed = performance.now() - start;

    benchmarkLog("spawn-manager permission inheritance", elapsed, 100);
    expect(elapsed).toBeLessThan(100);

    // Clean up synthetic parent
    (manager as any).agents.delete(parentId);

    manager.dispose();
  });

  it("permission intersection cost (getConfig with parentConfig applied)", async () => {
    const { getConfig } = await import("../src/agent-types.js");

    // Parent is Explore (RO) — this config will be used to restrict the child
    const parentConfig = getConfig("Explore");

    const runs: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const start = performance.now();
      getConfig("general-purpose", {
        builtinToolNames: [...parentConfig.builtinToolNames],
        extensions: parentConfig.extensions as any,
        skills: parentConfig.skills as any,
      });
      runs.push(performance.now() - start);
    }
    const median = [...runs].sort((a, b) => a - b)[500];
    const medianUs = median * 1000; // convert ms → µs

    benchmarkLog("mocked-getConfig call (1000×)", medianUs, 10, "\u00b5s");
    expect(medianUs).toBeLessThan(10);
  });
});

/** Create a raw session (same as createSession) without instrumented prompt. */
function createRawSession() {
  const listeners: Array<(event: any) => void> = [];
  const session = {
    messages: [] as any[],
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.push(listener);
      return () => {};
    }),
    prompt: vi.fn(async () => {}),
    abort: vi.fn(),
    steer: vi.fn(),
    getActiveToolNames: vi.fn(() => ["read", "write"]),
    setActiveToolsByName: vi.fn(),
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  return { session, listeners };
}
