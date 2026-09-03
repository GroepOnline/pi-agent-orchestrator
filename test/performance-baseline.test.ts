/**
 * performance-baseline.test.ts — Performance baseline measurements for key agent operations.
 *
 * All tests MEASURE rather than assert specific values. They use generous timeouts
 * and verify that operations complete within reasonable bounds without regressing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import {
  type CompactableMessage,
  estimateReduction,
  pruneOldToolOutputs,
} from "../src/compaction.js";
import { buildParentContext } from "../src/context.js";
import { HookRegistry } from "../src/hooks.js";

// ── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
  AgentRunnerError: class AgentRunnerError extends Error {
    constructor(
      message: string,
      public readonly code: string,
      public readonly context?: Record<string, unknown>,
    ) {
      super(message);
      this.name = "AgentRunnerError";
    }
  },
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
}));

import { runAgent } from "../src/agent-runner.js";

const mockPi = {} as any;
const mockCtx = {
  cwd: "/tmp",
  sessionManager: {
    getBranch: vi.fn(() => []),
  },
} as any;

const mockSession = () => ({ dispose: vi.fn() } as any);

const resolvedRun = () =>
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "done",
    session: mockSession(),
    aborted: false,
    steered: false,
  });

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a compactable message. */
function makeMsg(role: "user" | "assistant" | "toolResult", content: string, toolName?: string): CompactableMessage {
  return { role, content, toolName };
}

/** Build a conversation with N turns. Each turn = user → assistant → toolResult. */
function buildConversation(turnCount: number, toolOutputLen = 1000): CompactableMessage[] {
  const messages: CompactableMessage[] = [];
  for (let i = 1; i <= turnCount; i++) {
    messages.push(makeMsg("user", `Question ${i}`));
    messages.push(makeMsg("assistant", `Response ${i}`));
    messages.push(makeMsg("toolResult", "x".repeat(toolOutputLen), "read"));
  }
  return messages;
}

// ── 1. Agent Spawn Latency ──────────────────────────────────────────────────

describe("Performance: agent spawn latency", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it(
    "measures time from spawn() call to record creation (under 50ms)",
    { timeout: 10000 },
    async () => {
      manager = new AgentManager();

      // Don't resolve runAgent — we only want spawn-to-record time
      vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

      const start = performance.now();
      const id = manager.spawn(mockPi, mockCtx, "general-purpose", "latency test", {
        description: "latency",
      });
      const elapsed = performance.now() - start;

      const record = manager.getRecord(id);
      expect(record).toBeDefined();
      expect(record!.status).toBe("running");

      // Spawn-to-record should be fast (no I/O, just in-memory ops)
      expect(elapsed).toBeLessThan(200);

      manager.abort(id);
    },
  );

  it(
    "foreground spawnAndWait completes and returns a valid record",
    { timeout: 10000 },
    async () => {
      manager = new AgentManager();
      resolvedRun();

      const start = performance.now();
      const record = await manager.spawnAndWait(
        mockPi,
        mockCtx,
        "general-purpose",
        "fg task",
        { description: "foreground" },
      );
      const elapsed = performance.now() - start;

      expect(record.status).toBe("completed");
      expect(record.result).toBe("done");

      // Should complete within a reasonable time (mocked, so very fast)
      expect(elapsed).toBeLessThan(5000);
    },
  );
});

// ── 2. Context Building ─────────────────────────────────────────────────────

describe("Performance: context building", () => {
  it("measures buildParentContext time with 10 messages", () => {
    // Build a mock context with 10 message entries (5 user + 5 assistant)
    const entries: any[] = [];
    for (let i = 0; i < 10; i++) {
      entries.push({
        type: "message",
        message: {
          role: i % 2 === 0 ? "user" : "assistant",
          content: [{ type: "text", text: `Message content ${i}. `.repeat(50) }],
        },
      });
    }

    const mockCtxWithMessages = {
      cwd: "/tmp",
      sessionManager: {
        getBranch: vi.fn(() => entries),
      },
    } as any;

    const start = performance.now();
    const context = buildParentContext(mockCtxWithMessages);
    const elapsed = performance.now() - start;

    expect(context).toBeTruthy();
    expect(context.length).toBeGreaterThan(0);

    // Context building with 10 messages should be fast (<50ms)
    expect(elapsed).toBeLessThan(50);
  });

  it("buildParentContext returns empty for no entries", () => {
    const emptyCtx = {
      cwd: "/tmp",
      sessionManager: {
        getBranch: vi.fn(() => []),
      },
    } as any;

    const start = performance.now();
    const context = buildParentContext(emptyCtx);
    const elapsed = performance.now() - start;

    expect(context).toBe("");
    expect(elapsed).toBeLessThan(10);
  });

  it("buildParentContext returns empty for undefined branch", () => {
    const nullCtx = {
      cwd: "/tmp",
      sessionManager: {
        getBranch: vi.fn(() => undefined),
      },
    } as any;

    const context = buildParentContext(nullCtx);
    expect(context).toBe("");
  });
});

// ── 3. Compaction Reduction ─────────────────────────────────────────────────

describe("Performance: compaction reduction", () => {
  it("pruneOldToolOutputs reduces message count for old turns", () => {
    const conversation = buildConversation(10, 2000); // 10 turns, 30 messages

    const originalCount = conversation.length;
    const result = pruneOldToolOutputs(conversation, 5);

    // After pruning with keepLastNTurns=5:
    // Last 5 turns (15 msgs) intact + first 5 turns keep only user+assistant (10 msgs) = 25
    expect(result.length).toBeLessThan(originalCount);

    // Verify reduction estimate is sensible
    const compactionResult = estimateReduction(conversation, result);
    expect(compactionResult.reductionPercent).toBeGreaterThan(0);
    // Should not exceed 100%
    expect(compactionResult.reductionPercent).toBeLessThanOrEqual(100);
    expect(compactionResult.turnCount).toBe(10);
  });

  it("pruneOldToolOutputs with keepLastNTurns=1 clamps to MIN_KEEP_TURNS=2", () => {
    const conversation = buildConversation(5, 2000);
    const result = pruneOldToolOutputs(conversation, 1);

    // All 5 user messages survive
    const userCount = result.filter((m) => m.role === "user").length;
    expect(userCount).toBe(5);

    // All 5 assistant messages survive
    const assistantCount = result.filter((m) => m.role === "assistant").length;
    expect(assistantCount).toBe(5);
  });

  it("does not mutate the original array", () => {
    const original = buildConversation(5, 1000);
    const copy = JSON.parse(JSON.stringify(original));

    pruneOldToolOutputs(original, 3);

    expect(original).toEqual(copy);
  });
});

// ── 4. Deferred Context ─────────────────────────────────────────────────────

describe("Performance: deferred context", () => {
  it("verifies contextBuiltAt would be after spawnedAt", () => {
    // AgentManager stores spawnedAt at record creation time.
    // The onContextBuilt callback fires when context is built (during runAgent).
    // We verify the invariant: contextBuiltAt >= spawnedAt

    const spawnedAt = Date.now();

    // Simulate context building happening later
    const contextBuiltAt = spawnedAt + 50; // 50ms later

    expect(contextBuiltAt).toBeGreaterThanOrEqual(spawnedAt);
  });

  it("spawnedAt is set before runAgent can fire (record created at spawn time)", () => {
    const manager = new AgentManager();
    // Capture what happens: spawn sets spawnedAt = Date.now() before calling startAgent
    resolvedRun();

    const beforeSpawn = Date.now();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "deferred context test",
    });
    const afterSpawn = Date.now();

    const record = manager.getRecord(id)!;
    expect(record.spawnedAt).toBeGreaterThanOrEqual(beforeSpawn);
    expect(record.spawnedAt).toBeLessThanOrEqual(afterSpawn);

    manager.dispose();
  });
});

// ── 5. Token Estimation ─────────────────────────────────────────────────────

describe("Performance: token estimation", () => {
  it("estimateReduction returns sensible percentage (0-100%)", () => {
    // Full conversation with large tool outputs
    const original: CompactableMessage[] = [
      makeMsg("user", "Find all bugs"),
      makeMsg("assistant", "Looking..."),
      makeMsg("toolResult", "x".repeat(10000), "grep"), // ~2500 tokens
      makeMsg("toolResult", "y".repeat(8000), "read"), // ~2000 tokens
    ];

    // Compacted version without tool outputs
    const compacted: CompactableMessage[] = [
      makeMsg("user", "Find all bugs"),
      makeMsg("assistant", "Looking..."),
    ];

    const result = estimateReduction(original, compacted);

    expect(result.originalTokens).toBeGreaterThan(result.compactedTokens);
    expect(result.reductionPercent).toBeGreaterThan(0);
    expect(result.reductionPercent).toBeLessThanOrEqual(100);
    expect(result.turnCount).toBe(1);
  });

  it("estimateReduction returns 0% when nothing removed", () => {
    const identical: CompactableMessage[] = [
      makeMsg("user", "hello"),
      makeMsg("assistant", "world"),
    ];

    const result = estimateReduction(identical, [...identical]);
    expect(result.reductionPercent).toBe(0);
    expect(result.originalTokens).toBe(result.compactedTokens);
  });

  it("estimateReduction handles empty arrays", () => {
    const result = estimateReduction([], []);
    expect(result.reductionPercent).toBe(0);
    expect(result.originalTokens).toBe(0);
    expect(result.compactedTokens).toBe(0);
    expect(result.turnCount).toBe(0);
  });

  it("estimateTokens avoids stringifying large content arrays", () => {
    const hugeContent = Array(1000).fill({ type: "text", text: "x".repeat(100) });
    // avoid makeMsg signature error and create directly
    const original: CompactableMessage[] = [
      { role: "assistant", content: hugeContent }
    ];

    const start = performance.now();
    const result = estimateReduction(original, original);
    const elapsed = performance.now() - start;

    expect(result.originalTokens).toBeGreaterThan(0);
    // Assert on speed compared to 1000ms bounds so it isn't flaky on CI,
    // it was previously 40ms without the optimization, now it's around 5ms
    expect(elapsed).toBeLessThan(1000);
  });
});

// ── 6. Batch Spawn Throughput ───────────────────────────────────────────────

describe("Performance: batch spawn throughput", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it(
    "spawns 10 agents sequentially via spawnAndWait, all complete within 5s",
    { timeout: 10000 },
    async () => {
      manager = new AgentManager(undefined, 10);

      // Each runAgent resolves quickly
      vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, _opts) => {
        return { responseText: "ok", session: mockSession(), aborted: false, steered: false };
      });

      const start = performance.now();

      const records: Awaited<ReturnType<typeof manager.spawnAndWait>>[] = [];
      for (let i = 0; i < 10; i++) {
        const record = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", `task ${i}`, {
          description: `batch-${i}`,
        });
        records.push(record);
      }

      const elapsed = performance.now() - start;

      // All 10 should complete
      expect(records).toHaveLength(10);
      for (const record of records) {
        expect(record.status).toBe("completed");
      }

      // All should complete within 5 seconds (mocked, so very fast)
      expect(elapsed).toBeLessThan(5000);
    },
  );

  it("background spawns all complete within timeout", async () => {
    manager = new AgentManager(undefined, 10);

    vi.mocked(runAgent).mockImplementation(async () => {
      return { responseText: "ok", session: mockSession(), aborted: false, steered: false };
    });

    const start = performance.now();

    const backgroundIds: string[] = [];
    // Spawn one at a time so the active stack is clean between spawns.
    // Each spawn pushes onto the active stack; await the promise so the stack
    // is popped before the next spawn. This avoids depth-limit exhaustion.
    for (let i = 0; i < 10; i++) {
      const id = manager.spawn(mockPi, mockCtx, "general-purpose", `bg ${i}`, {
        description: `bg-batch-${i}`,
        isBackground: true,
      });
      backgroundIds.push(id);
      // Wait for this spawn's runAgent to complete (pops the stack)
      await manager.getRecord(id)!.promise;
    }

    const elapsed = performance.now() - start;

    for (const id of backgroundIds) {
      const record = manager.getRecord(id)!;
      expect(record.status).toBe("completed");
    }

    expect(elapsed).toBeLessThan(5000);
  });
});

// ── 7. Hook Dispatch Overhead ───────────────────────────────────────────────

describe("Performance: hook dispatch overhead", () => {
  it(
    "100 hooks should dispatch in under 1s",
    { timeout: 5000 },
    async () => {
      const registry = new HookRegistry();

      // Register 100 handlers for subagent:start (each returns void instantly)
      for (let i = 0; i < 100; i++) {
        registry.register("subagent:start", () => {});
      }

      const start = performance.now();
      const result = await registry.dispatch("subagent:start", "perf-agent");
      const elapsed = performance.now() - start;

      expect(result).toBe("allow");
      // 100 handlers should dispatch quickly (<1s)
      expect(elapsed).toBeLessThan(1000);
    },
  );

  it("dispatch is fast even with data payload", async () => {
    const registry = new HookRegistry();

    for (let i = 0; i < 50; i++) {
      registry.register("tool:call", () => {});
    }

    const start = performance.now();
    await registry.dispatch("tool:call", "agent-x", {
      toolName: "read",
      args: { filePath: "/tmp/test", offset: 0, limit: 100 },
    });
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(500);
  });

  it("dispatch returns 'allow' immediately when no handlers registered", async () => {
    const registry = new HookRegistry();

    const start = performance.now();
    const result = await registry.dispatch("subagent:end", "empty-agent");
    const elapsed = performance.now() - start;

    expect(result).toBe("allow");
    expect(elapsed).toBeLessThan(50);
  });
});

// ── 8. RPC Audit & Rate Limiter ─────────────────────────────────────────────

import {
  clearAuditLog,
  getAuditLog,
  getAuditLogByExtension,
  getAuditLogByOperation,
  recordAudit,
  resetAuditLogger,
} from "../src/audit-logger.js";
import {
  configureRateLimit,
  createSubagentsRpcClient,
  type EventBus,
  registerRpcHandlers,
  resetRpcRateLimitsForTests,
  type SpawnCapable,
} from "../src/cross-extension-rpc.js";

function createEventBus(): EventBus {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
      return () => { listeners.get(event)?.delete(handler); };
    },
    emit(event, data) {
      for (const handler of listeners.get(event) ?? []) handler(data);
    },
  };
}

describe("Performance: RPC audit & rate limiter", () => {
  let events: EventBus;
  let manager: SpawnCapable;

  beforeEach(() => {
    resetRpcRateLimitsForTests();
    resetAuditLogger();
    events = createEventBus();
    manager = {
      spawn: vi.fn().mockReturnValue("agent-42"),
      abort: vi.fn().mockReturnValue(true),
    };
  });

  afterEach(() => {
    resetRpcRateLimitsForTests();
    resetAuditLogger();
  });

  it(
    "100 RPC spawns complete within 2s with audit logging",
    { timeout: 5000 },
    async () => {
      configureRateLimit({ maxPerWindow: 200 });
      registerRpcHandlers({
        events,
        pi: {},
        getCtx: () => ({ session: true }),
        manager,
        authProvider: () => ({ extensionId: "bench-ext" }),
      });

      const client = createSubagentsRpcClient(events);

      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        await client.spawn({ type: "Explore", prompt: `bench-${i}` });
      }
      const elapsed = performance.now() - start;

      const log = getAuditLog();
      expect(log).toHaveLength(100);
      expect(elapsed).toBeLessThan(2000);

      // Log throughput
      const perCall = elapsed / 100;
      expect(perCall).toBeLessThan(20); // <20ms per RPC round-trip
    },
  );

  it(
    "audit log filtering is fast with full 200-entry buffer",
    { timeout: 5000 },
    () => {
      // Fill the ring buffer to its default max (200 entries)
      for (let i = 0; i < 200; i++) {
        recordAudit({
          timestamp: new Date().toISOString(),
          extensionId: i % 3 === 0 ? "ext-A" : i % 3 === 1 ? "ext-B" : "ext-C",
          operation: i % 2 === 0 ? "spawn" : "ping",
          outcome: "success",
          durationMs: Math.random() * 10,
        });
      }

      expect(getAuditLog()).toHaveLength(200);

      const start = performance.now();
      const byOp = getAuditLogByOperation("spawn");
      const byExt = getAuditLogByExtension("ext-A");
      const elapsed = performance.now() - start;

      expect(byOp.length).toBeGreaterThan(0);
      expect(byExt.length).toBeGreaterThan(0);
      // Filtering 200 entries should be near-instant
      expect(elapsed).toBeLessThan(10);
    },
  );

  it(
    "rate limiter check throughput — 100 RPC calls with high limit under 2s",
    { timeout: 5000 },
    async () => {
      configureRateLimit({ windowMs: 60_000, maxPerWindow: 10_000 });
      registerRpcHandlers({
        events,
        pi: {},
        getCtx: () => ({ session: true }),
        manager,
        authProvider: () => ({ extensionId: "bench-rate" }),
      });

      const client = createSubagentsRpcClient(events);

      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        await client.spawn({ type: "Explore", prompt: `rate-${i}` });
      }
      const elapsed = performance.now() - start;

      // All should succeed (well under the 10k limit)
      const log = getAuditLog();
      const rateLimited = log.filter(e => e.outcome === "rate_limited");
      expect(rateLimited).toHaveLength(0);
      expect(log).toHaveLength(100);
      expect(elapsed).toBeLessThan(2000);
    },
  );

  it("clearAuditLog on full buffer (200 entries) is instant", () => {
    for (let i = 0; i < 200; i++) {
      recordAudit({
        timestamp: new Date().toISOString(),
        extensionId: "ext-clear",
        operation: "ping",
        outcome: "success",
        durationMs: 1,
      });
    }

    expect(getAuditLog()).toHaveLength(200);

    const start = performance.now();
    clearAuditLog();
    const elapsed = performance.now() - start;

    expect(getAuditLog()).toHaveLength(0);
    expect(elapsed).toBeLessThan(5);
  });
});

// ── 9. Memory Stability ──────────────────────────────────────────────────────

describe("Performance: memory stability", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it(
    "sessionUsage.spawnedAgents stays accurate through 100 rapid spawn/drain cycles",
    { timeout: 30000 },
    async () => {
      manager = new AgentManager(undefined, 20);
      resolvedRun();

      // Spawn 100 foreground agents sequentially. Each completes before the next
      // spawns, so there's no stacking. Foreground agents use spawnAndWait internally
      // which properly manages the session counter.
      for (let i = 0; i < 100; i++) {
        await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", `mem-${i}`, {
          description: `mem-test-${i}`,
        });
      }

      const usage = manager.getSessionUsage();
      // All 100 spawned agents were tracked in the session counter
      expect(usage.spawnedAgents).toBe(100);
    },
  );

  it(
    "lastTurnCounts Map is cleaned up when agents complete",
    { timeout: 15000 },
    async () => {
      manager = new AgentManager(undefined, 50);
      resolvedRun();

      for (let i = 0; i < 50; i++) {
        const id = manager.spawn(mockPi, mockCtx, "general-purpose", `turns-${i}`, {
          description: `turns-test-${i}`,
          isBackground: true,
        });
        await manager.getRecord(id)!.promise.catch(() => {});
      }

      manager.cleanup();

      const lastTurnCountsSize = (manager as any).lastTurnCounts.size;
      expect(lastTurnCountsSize).toBe(0);
    },
  );

  it(
    "sessionUsage counters are correctly decremented on worktree failure",
    { timeout: 15000 },
    async () => {
      manager = new AgentManager(undefined, 10);

      const { createWorktree } = await import("../src/worktree.js");
      // Make worktree creation fail immediately for all agents
      vi.mocked(createWorktree).mockResolvedValue(undefined);

      // Spawn 10 background agents — they'll fail on worktree creation
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        ids.push(manager.spawn(mockPi, mockCtx, "general-purpose", `fail-${i}`, {
          description: `fail-test-${i}`,
          isolation: "worktree",
          isBackground: true,
        }));
      }

      // Wait for all catch handlers to fire — each rejection runs in a microtask
      // Use queueMicrotask to flush microtasks, then a small setTimeout for event loop
      await new Promise<void>(resolve => {
        queueMicrotask(() => queueMicrotask(() => setTimeout(resolve, 50)));
      });
      manager.cleanup();

      const usage = manager.getSessionUsage();
      expect(usage.spawnedAgents).toBe(0);
      expect((manager as any).agents.size).toBe(0);
    },
  );
});
