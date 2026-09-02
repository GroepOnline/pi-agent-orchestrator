/**
 * task-budget.test.ts — Tests for task budget and depth limiting.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager, activeAgentStorage } from "../src/agent-manager.js";
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

function runAs<T>(agentId: string, fn: () => T): T {
  return activeAgentStorage.run(agentId, fn);
}

describe("Task Budget", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
    vi.mocked(runAgent).mockReset();
    vi.clearAllMocks();
  });

  it("taskBudget=1 allows first child, blocks second", async () => {
    manager = new AgentManager();
    resolvedRun();

    // Set up a parent agent with taskBudget=1
    const parentId = "parent-1";
    const parentRecord: AgentRecord = {
      id: parentId,
      type: "general-purpose",
      description: "test parent",
      status: "running",
      toolUses: 0,
      startedAt: Date.now(),
      invocation: { taskBudget: 1 },
      currentLevel: 0,
      totalSpawned: 0,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
    };
    (manager as any).agents.set(parentId, parentRecord);

    // First spawn: should succeed
    const id1 = runAs(parentId, () => manager.spawn(mockPi, mockCtx, "Explore", "child 1", {
      description: "child 1",
      isBackground: true,
    }));
    const record1 = manager.getRecord(id1)!;
    await record1.promise; // flush microtask so pop happens

    expect(parentRecord.totalSpawned).toBe(1);
    expect(record1.currentLevel).toBe(1);

    // Second spawn: should throw — budget exhausted
    expect(() => runAs(parentId, () =>
      manager.spawn(mockPi, mockCtx, "Explore", "child 2", {
        description: "child 2",
        isBackground: true,
      }),
    )).toThrow("Task budget exhausted (1/1)");

    // totalSpawned should not have been incremented for the failed spawn
    expect(parentRecord.totalSpawned).toBe(1);
  });

  it("levelLimit=2 allows root→child→grandchild, blocks great-grandchild", async () => {
    manager = new AgentManager();

    // Set up root agent
    const rootId = "root-1";
    const rootRecord: AgentRecord = {
      id: rootId,
      type: "general-purpose",
      description: "root",
      status: "running",
      toolUses: 0,
      startedAt: Date.now(),
      invocation: { levelLimit: 2 },
      currentLevel: 0,
      totalSpawned: 0,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
    };
    (manager as any).agents.set(rootId, rootRecord);
    // Spawn child (level 1) — should succeed
    resolvedRun();
    const childId = runAs(rootId, () => manager.spawn(mockPi, mockCtx, "Explore", "level 1", {
      description: "child",
      isBackground: true,
    }));
    const childRecord = manager.getRecord(childId)!;
    await childRecord.promise;

    expect(childRecord.currentLevel).toBe(1);

    // Spawn grandchild (level 2) — should succeed
    const gchildId = runAs(childId, () => manager.spawn(mockPi, mockCtx, "Explore", "level 2", {
      description: "grandchild",
      isBackground: true,
    }));
    const gchildRecord = manager.getRecord(gchildId)!;
    await gchildRecord.promise;

    expect(gchildRecord.currentLevel).toBe(2);

    // Try to spawn great-grandchild (level 3) — should throw
    expect(() => runAs(gchildId, () =>
      manager.spawn(mockPi, mockCtx, "Explore", "level 3", {
        description: "great-grandchild",
        isBackground: true,
      }),
    )).toThrow("Max agent depth reached (3/2)");
  });

  it("default levelLimit=5 allows 5 deep, blocks 6 deep", async () => {
    manager = new AgentManager();

    // Set up root agent with no explicit levelLimit (defaults to 5)
    const rootId = "root-default";
    const rootRecord: AgentRecord = {
      id: rootId,
      type: "general-purpose",
      description: "root",
      status: "running",
      toolUses: 0,
      startedAt: Date.now(),
      invocation: {}, // no levelLimit specified
      currentLevel: 0,
      totalSpawned: 0,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
    };
    (manager as any).agents.set(rootId, rootRecord);
    // Spawn 5 levels deep (levels 1 through 5)
    let parentId = rootId;
    for (let depth = 1; depth <= 5; depth++) {
      resolvedRun();
      const childId = runAs(parentId, () => manager.spawn(mockPi, mockCtx, "Explore", `level ${depth}`, {
        description: `level-${depth}`,
        isBackground: true,
      }));
      const childRecord = manager.getRecord(childId)!;
      await childRecord.promise;

      expect(childRecord.currentLevel).toBe(depth);
      parentId = childId;
    }

    // Now try level 6 — should throw (default limit 5)
    expect(() => runAs(parentId, () =>
      manager.spawn(mockPi, mockCtx, "Explore", "level 6", {
        description: "level-6",
        isBackground: true,
      }),
    )).toThrow("Max agent depth reached (6/5)");
  });

  it("taskBudget=0 blocks all child spawns", async () => {
    manager = new AgentManager();
    resolvedRun();

    const parentId = "parent-zero-budget";
    const parentRecord: AgentRecord = {
      id: parentId,
      type: "general-purpose",
      description: "zero budget parent",
      status: "running",
      toolUses: 0,
      startedAt: Date.now(),
      invocation: { taskBudget: 0 },
      currentLevel: 0,
      totalSpawned: 0,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
    };
    (manager as any).agents.set(parentId, parentRecord);
    expect(() => runAs(parentId, () =>
      manager.spawn(mockPi, mockCtx, "Explore", "should fail", {
        description: "should fail",
        isBackground: true,
      }),
    )).toThrow("Task budget exhausted (0/0)");
  });

  it("totalSpawned is not incremented for non-spawn operations", () => {
    manager = new AgentManager();

    const parentId = "parent-invariant";
    const parentRecord: AgentRecord = {
      id: parentId,
      type: "general-purpose",
      description: "parent",
      status: "running",
      toolUses: 0,
      startedAt: Date.now(),
      invocation: { taskBudget: 5 },
      currentLevel: 0,
      totalSpawned: 0,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
    };
    (manager as any).agents.set(parentId, parentRecord);

    // getRecord, listAgents, abort, hasRunning, clearCompleted — none should touch totalSpawned
    manager.getRecord(parentId);
    manager.listAgents();
    manager.hasRunning();
    manager.clearCompleted();

    expect(parentRecord.totalSpawned).toBe(0);

    // Abort should not affect totalSpawned
    manager.abort(parentId);
    expect(parentRecord.totalSpawned).toBe(0);
  });

  it("spawn during runAgent inherits parent from AsyncLocalStorage", async () => {
    manager = new AgentManager();
    let nestedChildId: string | undefined;

    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, prompt) => {
      // Only the parent run should nest-spawn. Background children also invoke
      // this mock under their own ALS id — ignore those to avoid overwriting.
      if (prompt === "parent task") {
        nestedChildId = manager.spawn(mockPi, mockCtx, "Explore", "nested", {
          description: "nested",
          isBackground: true,
        });
      }
      return {
        responseText: "done",
        session: mockSession(),
        aborted: false,
        steered: false,
      };
    });

    const parentId = manager.spawn(mockPi, mockCtx, "general-purpose", "parent task", {
      description: "parent",
      isBackground: false,
    });

    await manager.getRecord(parentId)!.promise;
    // Drain so the nested background child can finish without re-entering the parent mock path.
    await manager.waitForAll();

    expect(nestedChildId).toBeDefined();
    const child = manager.getRecord(nestedChildId!)!;
    expect(child.parentId).toBe(parentId);
    expect(child.currentLevel).toBe(1);
  });

  it("getActiveAgentId is scoped to the current async agent", () => {
    manager = new AgentManager();

    expect(manager.getActiveAgentId()).toBeUndefined();
    runAs("agent-abc", () => {
      expect(manager.getActiveAgentId()).toBe("agent-abc");
      runAs("agent-def", () => {
        expect(manager.getActiveAgentId()).toBe("agent-def");
      });
      expect(manager.getActiveAgentId()).toBe("agent-abc");
    });
    expect(manager.getActiveAgentId()).toBeUndefined();
  });

  it("tracks concurrent async agents independently", async () => {
    manager = new AgentManager();

    const seen = await Promise.all([
      activeAgentStorage.run("agent-1", async () => {
        await Promise.resolve();
        return manager.getActiveAgentId();
      }),
      activeAgentStorage.run("agent-2", async () => {
        await Promise.resolve();
        return manager.getActiveAgentId();
      }),
    ]);

    expect(seen).toEqual(["agent-1", "agent-2"]);
  });
});

/**
 * Live-limit characterization (R2/KTD2): the session-limit setters feed the
 * spawn and turn gates live — a mid-session raise applies at the NEXT
 * enforcement point with no rebuild or restart. These tests lock that
 * invariant; they pass on current code and must keep passing.
 */
describe("Live session-limit enforcement (characterization)", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
    vi.mocked(runAgent).mockReset();
    vi.clearAllMocks();
  });

  it("raising maxAgents mid-session admits the next dispatch at the spawn gate", async () => {
    manager = new AgentManager();
    manager.setMaxConcurrent(16); // keep every spawn off the concurrency queue
    resolvedRun();
    manager.setSessionMaxSpawns(5);

    const firstWave: string[] = [];
    for (let i = 0; i < 5; i++) {
      firstWave.push(manager.spawn(mockPi, mockCtx, "Explore", `crew ${i}`, {
        description: `crew-${i}`,
        isBackground: true,
      }));
    }
    for (const id of firstWave) await manager.getRecord(id)!.promise;
    // Completed agents still count against the session limit (issue #5 shape).
    expect(manager.getSessionUsage().spawnedAgents).toBe(5);

    // At 5/5 the spawn gate rejects the next dispatch...
    expect(() =>
      manager.spawn(mockPi, mockCtx, "Explore", "sixth", { description: "sixth", isBackground: true }),
    ).toThrow("Session agent limit reached (5/5)");

    // ...and the gate reads the limit live: raising it mid-session admits
    // three more dispatches without a restart.
    manager.setSessionMaxSpawns(8);
    const raisedWave: string[] = [];
    for (let i = 0; i < 3; i++) {
      raisedWave.push(manager.spawn(mockPi, mockCtx, "Explore", `raised ${i}`, {
        description: `raised-${i}`,
        isBackground: true,
      }));
    }
    for (const id of raisedWave) await manager.getRecord(id)!.promise;
    expect(manager.getSessionUsage().spawnedAgents).toBe(8);

    // The NEW limit is the enforced ceiling.
    expect(() =>
      manager.spawn(mockPi, mockCtx, "Explore", "ninth", { description: "ninth", isBackground: true }),
    ).toThrow("Session agent limit reached (8/8)");
  });

  it("raising maxTurns mid-session applies the new cap at the next turn-budget evaluation", () => {
    manager = new AgentManager();
    manager.setMaxConcurrent(4);

    // Capture the manager's onTurnEnd gate from the spawned run. spawn()
    // invokes the run synchronously (no worktree isolation, queue capacity
    // free), so the gate is available immediately after spawn returns.
    let turnGate: ((turnCount: number) => void) | undefined;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      turnGate = options.onTurnEnd;
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    manager.setSessionMaxTurns(5);
    const id = manager.spawn(mockPi, mockCtx, "Explore", "long task", {
      description: "long task",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    expect(turnGate).toBeDefined();

    // Four turns under the old cap of 5 — no session-turn abort yet.
    turnGate!(1);
    turnGate!(4);
    expect(manager.getSessionUsage().totalTurns).toBe(4);
    expect(record.error).toBeUndefined();

    // Raise 5 → 8 mid-session: the next evaluation reads the NEW cap, so
    // turn 5 (which the old cap would abort) passes cleanly.
    manager.setSessionMaxTurns(8);
    turnGate!(5);
    expect(record.error).toBeUndefined();

    // Turn 8 crosses the new cap — the gate fires with the new numbers.
    turnGate!(8);
    expect(record.error).toBe("Session turn limit reached (8/8)");
  });
});
