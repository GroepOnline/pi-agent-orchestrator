/**
 * task-budget.test.ts — Tests for task budget and depth limiting.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager, activeAgentStorage, type BudgetWarningType } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";

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

import { AgentRunnerError, runAgent } from "../src/agent-runner.js";

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

/**
 * Budget threshold warnings (R3). The once-per-threshold dedup
 * (`firedBudgetThresholds` in agent-manager.ts) is pre-existing behavior —
 * these tests are characterization and must keep passing. The re-arm tests
 * below cover the U4 delta: a changed limit clears the fired state so a
 * later crossing warns again.
 */
describe("Budget threshold warnings (R3)", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
    vi.mocked(runAgent).mockReset();
    vi.clearAllMocks();
  });

  it("crossing 80% fires one agents warning; ten subsequent turns fire none (dedup characterization)", async () => {
    manager = new AgentManager();
    manager.setMaxConcurrent(16); // keep every spawn off the concurrency queue
    const warnings: BudgetWarningType[] = [];
    manager.setBudgetWarningHandler((type) => warnings.push(type));
    manager.setSessionMaxSpawns(5); // agent threshold only — no turn limit armed

    // Capture a turn gate (the warning check runs on every turn end).
    let turnGate: ((turnCount: number) => void) | undefined;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      turnGate = options.onTurnEnd;
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    // Four agents = exactly 80% of the agent cap.
    for (let i = 0; i < 4; i++) {
      manager.spawn(mockPi, mockCtx, "Explore", `crew ${i}`, {
        description: `crew-${i}`,
        isBackground: true,
      });
    }

    // First turn end observes 4/5 = 80% — fires once.
    turnGate!(1);
    expect(warnings).toEqual(["agents_at_80"]);

    // Ten further turn-ends stay above the 80% line — the dedup keeps quiet.
    for (let turn = 2; turn <= 11; turn++) turnGate!(turn);
    expect(warnings).toEqual(["agents_at_80"]);
  });

  it("raising a limit re-arms the threshold so a later crossing warns again (R3)", async () => {
    manager = new AgentManager();
    manager.setMaxConcurrent(16);
    const warnings: BudgetWarningType[] = [];
    manager.setBudgetWarningHandler((type) => warnings.push(type));
    manager.setSessionMaxSpawns(5);

    let turnGate: ((turnCount: number) => void) | undefined;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      turnGate = options.onTurnEnd;
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    for (let i = 0; i < 4; i++) {
      manager.spawn(mockPi, mockCtx, "Explore", `first ${i}`, {
        description: `first-${i}`,
        isBackground: true,
      });
    }
    turnGate!(1); // 4/5 = 80% — first fire
    expect(warnings).toEqual(["agents_at_80"]);

    // Raising the limit re-arms the threshold but fires nothing by itself.
    manager.setSessionMaxSpawns(10);
    expect(warnings).toEqual(["agents_at_80"]);

    // Re-cross 80% of the NEW cap (8/10): a fresh warning must fire.
    for (let i = 0; i < 4; i++) {
      manager.spawn(mockPi, mockCtx, "Explore", `second ${i}`, {
        description: `second-${i}`,
        isBackground: true,
      });
    }
    turnGate!(2);
    expect(warnings).toEqual(["agents_at_80", "agents_at_80"]);
  });
});

/**
 * Explicit outcome contract (R4 / AE2): the manager records the runner-derived
 * outcome on the AgentRecord so get_subagent_result and the task notifications
 * present budget cuts as `blocked_budget` — never as a completed empty result —
 * and a silent no-op completion (issue #40) as `not_executed`. The session
 * turn-limit gate aborts through the parent signal, which the runner can only
 * classify as an external stop, so the manager re-labels it with the
 * structured limit reason it recorded.
 */
describe("Explicit outcome contract (R4)", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
    vi.mocked(runAgent).mockReset();
    vi.clearAllMocks();
  });

  it("records outcome blocked_budget for a token-quota abort (AE2)", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "[pi-agent-orchestrator] Agent completed without producing output.\nStatus: aborted",
      session: mockSession(),
      aborted: true,
      steered: false,
      outcome: "blocked_budget",
      outcomeReason: "Token quota exceeded (600/500 tokens)",
    });

    const id = manager.spawn(mockPi, mockCtx, "Explore", "budget cut", {
      description: "budget cut",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.status).toBe("aborted");
    expect(record.outcome).toBe("blocked_budget");
    expect(record.outcomeReason).toContain("Token quota exceeded");
  });

  it("records outcome not_executed for a silent no-op completion (issue #40 shape)", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "[pi-agent-orchestrator] Agent completed without producing output.\nStatus: completed",
      session: mockSession(),
      aborted: false,
      steered: false,
      outcome: "not_executed",
      outcomeReason: "Agent completed without producing output or executing any tools.",
    });

    const id = manager.spawn(mockPi, mockCtx, "Explore", "no-op", {
      description: "no-op",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.status).toBe("completed");
    expect(record.outcome).toBe("not_executed");
    expect(record.outcomeReason).toBeTruthy();
  });

  it("records outcome executed with the partial-progress note for a cut after real work", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "partial findings so far",
      session: mockSession(),
      aborted: true,
      steered: false,
      outcome: "executed",
      outcomeReason: "Aborted mid-run (Token quota exceeded (600/500 tokens)) — output may be incomplete.",
    });

    const id = manager.spawn(mockPi, mockCtx, "Explore", "cut mid-work", {
      description: "cut mid-work",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.outcome).toBe("executed");
    expect(record.outcomeReason).toMatch(/incomplete/);
    expect(record.result).toContain("partial findings");
  });

  it("re-labels a session turn-limit abort as blocked_budget with the structured limit reason", async () => {
    manager = new AgentManager();
    manager.setSessionMaxTurns(2);
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      // The manager's session turn-budget gate aborts through the parent
      // signal; the runner sees a plain external stop with no structured
      // reason — exactly the gap the manager-side re-label closes.
      options?.onTurnEnd?.(2);
      return {
        responseText: "",
        session: mockSession(),
        aborted: true,
        steered: false,
        outcome: "not_executed",
        outcomeReason: "Stopped before executing any work.",
      };
    });

    const id = manager.spawn(mockPi, mockCtx, "Explore", "long run", {
      description: "long run",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.error).toBe("Session turn limit reached (2/2)");
    expect(record.outcome).toBe("blocked_budget");
    expect(record.outcomeReason).toContain("Session turn limit reached");
  });

  it("maps AgentRunnerError codes to the outcome on the catch path", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(
      new AgentRunnerError("Max agent depth reached (5/5)", "depth_exceeded"),
    );

    const id = manager.spawn(mockPi, mockCtx, "Explore", "nested", {
      description: "nested",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.status).toBe("error");
    expect(record.outcome).toBe("not_executed");
    expect(record.outcomeReason).toContain("Max agent depth reached");
  });

  it("leaves the outcome unset when the runner result carries none (backward compatibility)", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "Explore", "plain", {
      description: "plain",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.status).toBe("completed");
    expect(record.outcome).toBeUndefined();
    expect(record.outcomeReason).toBeUndefined();
  });
});
