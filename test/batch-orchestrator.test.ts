import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRecord } from "../src/types.js";

// Mock logger
vi.mock("../src/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// Mock swarm-join
vi.mock("../src/swarm-join.js", () => ({
  SwarmCoordinator: vi.fn(function (this: any) {
    this.createSwarm = vi.fn(() => "swarm-test-1");
    this.addAgentToSwarm = vi.fn();
    this.onAgentComplete = vi.fn(() => "pass");
  }),
  setActiveSwarmCoordinator: vi.fn(),
}));

// Mock group-join
vi.mock("../src/group-join.js", () => ({
  GroupJoinManager: vi.fn(function (this: any) {
    this.registerGroup = vi.fn();
    this.onAgentComplete = vi.fn(() => "pass");
  }),
}));

const { BatchOrchestrator } = await import("../src/batch-orchestrator.js");

function makeRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-1",
    type: "Explore",
    status: "running",
    description: "Searching...",
    spawnedAt: Date.now(),
    swarmId: undefined,
    handoff: undefined,
    invocation: undefined,
    compactionCount: 0,
    toolUses: 0,
    lifetimeUsage: { input: 100, output: 50, cacheWrite: 0 },
    ...overrides,
  } as AgentRecord;
}

describe("BatchOrchestrator", () => {
  let deps: {
    manager: { getRecord: ReturnType<typeof vi.fn> };
    groupJoin: { registerGroup: ReturnType<typeof vi.fn>; onAgentComplete: ReturnType<typeof vi.fn> };
    swarmJoin: { createSwarm: ReturnType<typeof vi.fn>; addAgentToSwarm: ReturnType<typeof vi.fn>; onAgentComplete: ReturnType<typeof vi.fn> };
    onAgentHandled: ReturnType<typeof vi.fn>;
    onWidgetUpdate: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    deps = {
      manager: { getRecord: vi.fn() },
      groupJoin: { registerGroup: vi.fn(), onAgentComplete: vi.fn(() => "pass") },
      swarmJoin: { createSwarm: vi.fn(() => "swarm-test-1"), addAgentToSwarm: vi.fn(), onAgentComplete: vi.fn(() => "pass") },
      onAgentHandled: vi.fn(),
      onWidgetUpdate: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("addToBatch", () => {
    it("adds an agent to the pending batch", () => {
      const orch = new BatchOrchestrator(deps as any);
      orch.addToBatch("agent-1", "smart");
      const pending = orch.getPendingBatch();
      expect(pending).not.toBeNull();
      expect(pending!.agents.length).toBe(1);
      expect(pending!.agents[0].id).toBe("agent-1");
      expect(pending!.agents[0].joinMode).toBe("smart");
    });

    it("updates existing agent instead of duplicating", () => {
      const orch = new BatchOrchestrator(deps as any);
      orch.addToBatch("agent-1", "smart");
      orch.addToBatch("agent-1", "swarm");
      const pending = orch.getPendingBatch();
      expect(pending!.agents.length).toBe(1);
      expect(pending!.agents[0].joinMode).toBe("swarm");
    });

    it("preserves swarmStrategy on update", () => {
      const orch = new BatchOrchestrator(deps as any);
      orch.addToBatch("agent-1", "swarm", { strategy: "live" });
      orch.addToBatch("agent-1", "swarm", { strategy: "chain" });
      const pending = orch.getPendingBatch();
      expect(pending!.agents[0].swarmStrategy).toBe("chain");
    });

    it("sets addedAt timestamp", () => {
      const orch = new BatchOrchestrator(deps as any);
      const before = Date.now();
      orch.addToBatch("agent-1", "smart");
      const pending = orch.getPendingBatch();
      expect(pending!.agents[0].addedAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe("isPendingBatchFinalization", () => {
    it("returns true for agents in the batch", () => {
      const orch = new BatchOrchestrator(deps as any);
      orch.addToBatch("agent-1", "smart");
      expect(orch.isPendingBatchFinalization("agent-1")).toBe(true);
    });

    it("returns false for agents not in the batch", () => {
      const orch = new BatchOrchestrator(deps as any);
      orch.addToBatch("agent-1", "smart");
      expect(orch.isPendingBatchFinalization("agent-2")).toBe(false);
    });

    it("returns false for empty batch", () => {
      const orch = new BatchOrchestrator(deps as any);
      expect(orch.isPendingBatchFinalization("agent-1")).toBe(false);
    });
  });

  describe("getPendingBatch", () => {
    it("returns null for empty batch", () => {
      const orch = new BatchOrchestrator(deps as any);
      expect(orch.getPendingBatch()).toBeNull();
    });

    it("includes timeUntilFlushMs in result", () => {
      const orch = new BatchOrchestrator(deps as any, { debounceMs: 200 });
      orch.addToBatch("agent-1", "smart");
      const pending = orch.getPendingBatch();
      expect(pending!.timeUntilFlushMs).toBeGreaterThan(0);
      expect(pending!.timeUntilFlushMs).toBeLessThanOrEqual(200);
    });
  });

  describe("dispose", () => {
    it("flushes pending batch on dispose", async () => {
      const orch = new BatchOrchestrator(deps as any, { debounceMs: 50 });
      orch.addToBatch("agent-1", "none");
      await orch.dispose();
      // After dispose, batch should be empty
      expect(orch.getPendingBatch()).toBeNull();
    });

    it("clears pending batch after dispose", async () => {
      const orch = new BatchOrchestrator(deps as any);
      orch.addToBatch("agent-1", "smart");
      await orch.dispose();
      expect(orch.isPendingBatchFinalization("agent-1")).toBe(false);
    });
  });

  describe("finalizeBatch", () => {
    it("finalizes batch after debounce timeout", async () => {
      const orch = new BatchOrchestrator(deps as any, { debounceMs: 50 });
      deps.manager.getRecord.mockReturnValue(
        makeRecord({ id: "agent-1", status: "completed", completedAt: Date.now() }),
      );
      orch.addToBatch("agent-1", "none");

      // Before timeout, agent is still pending
      expect(orch.isPendingBatchFinalization("agent-1")).toBe(true);

      // Advance timers
      await vi.advanceTimersByTimeAsync(60);

      // After timeout, should have called onAgentHandled
      expect(deps.onAgentHandled).toHaveBeenCalled();
    });

    it("groups smart agents together", async () => {
      const orch = new BatchOrchestrator(deps as any, { debounceMs: 50 });
      deps.manager.getRecord.mockReturnValue(
        makeRecord({ id: "agent-1", status: "completed", completedAt: Date.now() }),
      );
      orch.addToBatch("agent-1", "smart");
      orch.addToBatch("agent-2", "smart");

      await vi.advanceTimersByTimeAsync(60);

      expect(deps.groupJoin.registerGroup).toHaveBeenCalled();
    });

    it("creates swarm for swarm agents", async () => {
      const orch = new BatchOrchestrator(deps as any, { debounceMs: 50 });
      deps.manager.getRecord.mockReturnValue(
        makeRecord({ id: "agent-1", status: "completed", completedAt: Date.now() }),
      );
      orch.addToBatch("agent-1", "swarm");

      await vi.advanceTimersByTimeAsync(60);

      expect(deps.swarmJoin.createSwarm).toHaveBeenCalled();
      expect(deps.swarmJoin.addAgentToSwarm).toHaveBeenCalledWith(
        expect.any(String),
        "agent-1",
      );
    });

    it("handles agents with completedAt before finalization", async () => {
      const orch = new BatchOrchestrator(deps as any, { debounceMs: 50 });
      const rec = makeRecord({ id: "agent-1", status: "completed", completedAt: Date.now() });
      deps.manager.getRecord.mockReturnValue(rec);
      orch.addToBatch("agent-1", "none");

      await vi.advanceTimersByTimeAsync(60);

      // Should have called onAgentHandled for the completed agent
      expect(deps.onAgentHandled).toHaveBeenCalledWith(rec);
    });

    it("skips agents already consumed before finalization", async () => {
      const orch = new BatchOrchestrator(deps as any, { debounceMs: 50 });
      const rec = makeRecord({
        id: "agent-1",
        status: "completed",
        completedAt: Date.now(),
        resultConsumed: true,
      });
      deps.manager.getRecord.mockReturnValue(rec);
      orch.addToBatch("agent-1", "none");

      await vi.advanceTimersByTimeAsync(60);

      expect(deps.onAgentHandled).not.toHaveBeenCalled();
    });

    it("calls onWidgetUpdate after batch finalization", async () => {
      const orch = new BatchOrchestrator(deps as any, { debounceMs: 50 });
      deps.manager.getRecord.mockReturnValue(
        makeRecord({ id: "agent-1", status: "completed", completedAt: Date.now() }),
      );
      orch.addToBatch("agent-1", "none");

      await vi.advanceTimersByTimeAsync(60);

      expect(deps.onWidgetUpdate).toHaveBeenCalled();
    });

    it("tracks batch counter across batches", async () => {
      const onBatchFinalized = vi.fn();
      const orch = new BatchOrchestrator(deps as any, {
        debounceMs: 50,
        onBatchFinalized,
      });
      deps.manager.getRecord.mockReturnValue(
        makeRecord({ id: "agent-1", status: "completed", completedAt: Date.now() }),
      );
      orch.addToBatch("agent-1", "none");

      await vi.advanceTimersByTimeAsync(60);

      expect(onBatchFinalized).toHaveBeenCalledWith(
        expect.any(Number),
        expect.objectContaining({
          totalAgents: 1,
          batchId: expect.any(Number),
        }),
      );
    });
  });

  describe("partial finalization (markBatchPartial)", () => {
    it("passes missingMembers to registerGroup when the marked batch finalizes", async () => {
      const orch = new BatchOrchestrator(deps as any, { debounceMs: 50 });
      orch.addToBatch("agent-1", "group");
      orch.addToBatch("agent-2", "group");
      orch.markBatchPartial(1);

      await vi.advanceTimersByTimeAsync(60);

      expect(deps.groupJoin.registerGroup).toHaveBeenCalledWith(
        expect.any(String),
        ["agent-1", "agent-2"],
        { missingMembers: 1 },
      );
    });

    it("forces a group below the smart-group threshold when marked partial", async () => {
      const orch = new BatchOrchestrator(deps as any, {
        debounceMs: 50,
        smartGroupThreshold: 2,
      });
      // Single survivor of a 3-member fan-out — without the partial mark this
      // would fall through to an individual nudge and hide the missing members.
      orch.addToBatch("agent-1", "group");
      orch.markBatchPartial(2);

      await vi.advanceTimersByTimeAsync(60);

      expect(deps.groupJoin.registerGroup).toHaveBeenCalledWith(
        expect.any(String),
        ["agent-1"],
        { missingMembers: 2 },
      );
    });

    it("passes missingMembers to createSwarm for marked swarm batches", async () => {
      const orch = new BatchOrchestrator(deps as any, { debounceMs: 50 });
      orch.addToBatch("agent-1", "swarm");
      orch.markBatchPartial(1);

      await vi.advanceTimersByTimeAsync(60);

      expect(deps.swarmJoin.createSwarm).toHaveBeenCalledWith(
        expect.objectContaining({ missingMembers: 1 }),
      );
    });

    it("does not pass missingMembers when the batch was not marked (characterization)", async () => {
      const orch = new BatchOrchestrator(deps as any, { debounceMs: 50 });
      orch.addToBatch("agent-1", "group");
      orch.addToBatch("agent-2", "group");

      await vi.advanceTimersByTimeAsync(60);

      expect(deps.groupJoin.registerGroup).toHaveBeenCalledTimes(1);
      expect(deps.groupJoin.registerGroup.mock.calls[0]).toHaveLength(2);
    });

    it("consumes the partial mark on finalization (no leak into the next batch)", async () => {
      const orch = new BatchOrchestrator(deps as any, { debounceMs: 50 });
      orch.addToBatch("agent-1", "group");
      orch.markBatchPartial(1);

      await vi.advanceTimersByTimeAsync(60);

      orch.addToBatch("agent-2", "group");
      orch.addToBatch("agent-3", "group");

      await vi.advanceTimersByTimeAsync(60);

      expect(deps.groupJoin.registerGroup).toHaveBeenCalledTimes(2);
      expect(deps.groupJoin.registerGroup.mock.calls[1]).toHaveLength(2);
    });

    it("accumulates marks from multiple failed fan-outs in one batch window", async () => {
      const orch = new BatchOrchestrator(deps as any, { debounceMs: 50 });
      orch.addToBatch("agent-1", "group");
      orch.addToBatch("agent-2", "group");
      orch.markBatchPartial(1);
      orch.markBatchPartial(1);

      await vi.advanceTimersByTimeAsync(60);

      expect(deps.groupJoin.registerGroup).toHaveBeenCalledWith(
        expect.any(String),
        ["agent-1", "agent-2"],
        { missingMembers: 2 },
      );
    });

    it("ignores non-positive missing counts", async () => {
      const orch = new BatchOrchestrator(deps as any, { debounceMs: 50 });
      orch.addToBatch("agent-1", "group");
      orch.addToBatch("agent-2", "group");
      orch.markBatchPartial(0);

      await vi.advanceTimersByTimeAsync(60);

      expect(deps.groupJoin.registerGroup).toHaveBeenCalledTimes(1);
      expect(deps.groupJoin.registerGroup.mock.calls[0]).toHaveLength(2);
    });
  });

  describe("configuration", () => {
    it("uses custom debounceMs", () => {
      const orch = new BatchOrchestrator(deps as any, { debounceMs: 500 });
      orch.addToBatch("agent-1", "smart");
      const pending = orch.getPendingBatch();
      expect(pending!.timeUntilFlushMs).toBeGreaterThan(300);
    });

    it("uses custom smartGroupThreshold", async () => {
      const orch = new BatchOrchestrator(deps as any, {
        debounceMs: 50,
        smartGroupThreshold: 5,
      });
      deps.manager.getRecord.mockReturnValue(
        makeRecord({ id: "agent-1", status: "completed", completedAt: Date.now() }),
      );
      // Add only 3 smart agents — below threshold of 5
      orch.addToBatch("agent-1", "smart");
      orch.addToBatch("agent-2", "smart");
      orch.addToBatch("agent-3", "smart");

      await vi.advanceTimersByTimeAsync(60);

      // Should NOT create a group since below threshold
      expect(deps.groupJoin.registerGroup).not.toHaveBeenCalled();
    });
  });
});
