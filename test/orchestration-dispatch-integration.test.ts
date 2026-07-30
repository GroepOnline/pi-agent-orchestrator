import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mock pi packages ----

vi.mock("@earendil-works/pi-ai", () => ({}));

vi.mock("../src/ui/tui-shim.js", () => {
  class MockText {
    content: string;
    constructor(content: string, _x: unknown, _y: unknown) {
      this.content = content;
    }
  }
  return { Text: MockText };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  defineTool: <T>(spec: T): T => spec,
  getAgentDir: () => "/tmp/.pi/agents",
}));

// ---- Mock internal modules that have side effects or heavy dependencies ----

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
  // tools/agent.ts calls normalizeMaxTurns on the resolved config.
  // The real impl just clamps 0 → undefined; an identity is fine for the test.
  normalizeMaxTurns: (n: number | undefined): number | undefined => (n === 0 ? undefined : n),
  getDefaultMaxTurns: () => undefined,
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
}));

vi.mock("../src/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("../src/hooks.js", () => ({
  HookRegistry: class {
    dispatch = vi.fn(async () => "allow" as const);
  },
}));

// Custom-agents loader returns an empty Map so registerAgents() keeps defaults.
vi.mock("../src/custom-agents.js", () => ({
  loadCustomAgents: vi.fn(async () => new Map()),
  resolveBooleanOptional: vi.fn((v: unknown) => (typeof v === "string" ? v === "true" : Boolean(v))),
  resolveBooleanWithDefault: vi.fn((v: unknown, def: boolean) =>
    typeof v === "string" ? v === "true" : (v ?? def),
  ),
  parseFrontmatter: vi.fn(() => ({})),
}));

// Output-file paths: return predictable tmp paths so they don't collide.
vi.mock("../src/output-file.js", () => ({
  createOutputFilePath: vi.fn(() => "/tmp/orch-test-output.md"),
  streamToOutputFile: vi.fn(() => () => {}),
  writeInitialEntry: vi.fn(),
}));

// ---- Imports AFTER mocks ----

import { AgentManager } from "../src/agent-manager.js";
import {
  setDefaultJoinMode,
  setOrchestrationMode,
} from "../src/agent-registry.js";
import { runAgent } from "../src/agent-runner.js";
import { BatchOrchestrator } from "../src/batch-orchestrator.js";
import {
  clearDispatchHistory,
  computeDispatchHistogram,
} from "../src/dispatch-history.js";
import { type AgentToolParams, createAgentTool } from "../src/tools/agent.js";
import type { ToolContext } from "../src/tools/context.js";

// ---- Test harness ----

function makeSession() {
  return { dispose: vi.fn() } as any;
}

function makeResult(text: string, opts: { aborted?: boolean; steered?: boolean } = {}) {
  return {
    responseText: text,
    session: makeSession(),
    aborted: opts.aborted ?? false,
    steered: opts.steered ?? false,
  };
}

/**
 * Build a real `ToolContext` with a fresh AgentManager + BatchOrchestrator +
 * SwarmCoordinator + GroupJoinManager so the dispatcher → batchOrchestrator
 * → coordinator pipeline runs end-to-end. runAgent is mocked at module level
 * (see vi.mock above); the AgentManager wires the mock into the spawn chain.
 *
 * We spy on `groupJoin.registerGroup` and `swarmJoin.createSwarm` /
 * `addAgentToSwarm` so tests can assert the batch→coordinator wiring was
 * actually driven (vs. records carrying groupId/swarmId by coincidence).
 */
function buildToolContext() {
  const manager = new AgentManager();
  const groupJoin = {
    registerGroup: vi.fn(),
    onAgentComplete: vi.fn(() => "pass" as const),
  } as any;
  const swarmJoin = {
    createSwarm: vi.fn(() => "swarm-it-1"),
    addAgentToSwarm: vi.fn(() => true),
    onAgentComplete: vi.fn(() => "pass" as const),
    listSwarms: vi.fn(() => []),
  } as any;
  const liveWidgets = {
    ensureTimer: vi.fn(),
    debouncedUpdate: vi.fn(),
    markFinished: vi.fn(),
    setUICtx: vi.fn(),
    update: vi.fn(),
    onTurnStart: vi.fn(),
    bind: vi.fn(),
    dispose: vi.fn(),
  } as any;
  const agentActivity = new Map<string, any>();
  const batchOrchestrator = new BatchOrchestrator({
    manager,
    groupJoin,
    swarmJoin,
    onAgentHandled: vi.fn(),
    onWidgetUpdate: vi.fn(),
  });
  const scheduler = { isActive: () => false } as any;
  const pi = { events: { emit: vi.fn() } } as any;
  const piCtx = {
    cwd: "/tmp",
    model: undefined,
    ui: undefined,
    modelRegistry: {},
    sessionManager: { getSessionId: () => "integration-test-session" },
  } as any;

  const ctx: ToolContext = {
    pi,
    manager,
    liveWidgets,
    agentActivity,
    batchOrchestrator,
    scheduler,
    swarmJoin,
    hookRegistry: { dispatch: vi.fn(async () => "allow" as const) } as any,
    sendIndividualNudge: vi.fn(),
    cancelNudge: vi.fn(),
    scheduleNudge: vi.fn(),
  };

  return { ctx, manager, groupJoin, swarmJoin, batchOrchestrator, agentActivity, liveWidgets, piCtx, pi, scheduler };
}

/**
 * Install a runAgent mock that completes agents in lockstep. The mock:
 *   - honors `opts.onSessionCreated` so the spawn chain finalizes properly
 *   - returns the next entry from `responses` (or a single fixed text)
 *   - can throw at a chosen call index
 *   - returns a controllable deferred promise when `deferred` is set (used by
 *     the flush-ordering test to inspect coordinator state before the mock fires).
 */
function installRunAgentMock(
  responses: string[] | string,
  opts: { throwAt?: number; deferred?: { resolvers: Array<() => void> } } = {},
) {
  const list = Array.isArray(responses) ? responses : [responses];
  let callIdx = 0;
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, runOpts: any) => {
    const idx = callIdx++;
    const text = list[Math.min(idx, list.length - 1)];
    runOpts.onSessionCreated?.(makeSession());
    if (opts.throwAt === idx) {
      throw new Error(text);
    }
    if (opts.deferred) {
      await new Promise<void>((resolve) => {
        opts.deferred!.resolvers.push(resolve);
        const signal = runOpts.signal as AbortSignal | undefined;
        if (!signal) return;
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      if (runOpts.signal?.aborted) {
        return makeResult(text, { aborted: true });
      }
    }
    return makeResult(text);
  });
  return { countCalls: () => callIdx };
}

// ---- Tests ----

describe("orchestration-dispatch integration — Agent tool end-to-end", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setDefaultJoinMode("async"); // dispatcher sets the joinMode explicitly so the default doesn't matter
    clearDispatchHistory();
  });

  afterEach(() => {
    setOrchestrationMode("single"); // restore default
  });

  it("crew mode → 3 members spawned, joined as a group, results aggregated", async () => {
    setOrchestrationMode("crew");
    const tally = installRunAgentMock(["PLAN: do X then Y", "EXECUTED: everything done", "VERDICT: PASS — looks good"]);

    const beforeHist = computeDispatchHistogram();
    const { ctx, manager, groupJoin, piCtx } = buildToolContext();
    const tool = createAgentTool(ctx);

    const result: any = await tool.execute!(
      "call-id",
      {
        subagent_type: "general-purpose",
        prompt: "implement a thing",
        description: "do a thing",
      } as any,
      undefined,
      undefined,
      piCtx,
    );

    expect(tally.countCalls()).toBe(3);
    expect(manager.listAgents().length).toBe(3);

    // Coordinator was actually driven by batchOrchestrator.flush().
    expect(groupJoin.registerGroup).toHaveBeenCalledTimes(1);
    const [, memberIds] = groupJoin.registerGroup.mock.calls[0]!;
    expect(memberIds).toHaveLength(3);

    // Every record must end up in the same group.
    const groupIds = manager.listAgents().map((r) => r.groupId);
    expect(groupIds.every((g) => g?.startsWith("batch-"))).toBe(true);
    expect(new Set(groupIds).size).toBe(1);

    const text = result.content[0].text as string;
    expect(text).toContain("Crew completed");
    expect(text).toContain("(planner)");
    expect(text).toContain("(executor)");
    expect(text).toContain("(reviewer)");
    expect(text).toContain("PLAN: do X then Y");
    expect(text).toContain("EXECUTED: everything done");
    expect(text).toContain("VERDICT: PASS — looks good");
    // Wiring coverage for /agents → Health check dispatch histogram: record
    // fires once per execute(). A future refactor that drops the call would
    // // silently leave the histogram empty at runtime; this assertion locks
    // it down. We compare against a fresh `before` snapshot taken right
    // before the call so sibling tests don't poison the global buffer.
    expect(computeDispatchHistogram().byKind.crew - beforeHist.byKind.crew).toBe(1);
    expect(computeDispatchHistogram().bySource.explicit - beforeHist.bySource.explicit).toBe(1);
  });

  it("swarm mode → 2 members spawned, joined as a swarm, results aggregated", async () => {
    setOrchestrationMode("swarm");
    const beforeHist = computeDispatchHistogram();
    installRunAgentMock(["r1", "r2"]);

    const { ctx, manager, swarmJoin, piCtx } = buildToolContext();
    const tool = createAgentTool(ctx);

    const result: any = await tool.execute!(
      "call-id",
      {
        subagent_type: "general-purpose",
        prompt: "do benchmark",
        description: "benchmark",
      } as any,
      undefined,
      undefined,
      piCtx,
    );

    expect(manager.listAgents().length).toBe(2);

    // Coordinator was actually driven: 1 swarm created, 2 agents added.
    expect(swarmJoin.createSwarm).toHaveBeenCalledTimes(1);
    expect(swarmJoin.addAgentToSwarm).toHaveBeenCalledTimes(2);
    expect(swarmJoin.addAgentToSwarm).toHaveBeenNthCalledWith(1, "swarm-it-1", expect.any(String), 0);
    expect(swarmJoin.addAgentToSwarm).toHaveBeenNthCalledWith(2, "swarm-it-1", expect.any(String), 0);

    // Records carry the swarmId end-to-end.
    const records = manager.listAgents();
    const swarmIds = records.map((r) => r.swarmId);
    expect(new Set(swarmIds).size).toBe(1);

    const text = result.content[0].text as string;
    expect(text).toContain("Swarm completed");
    expect(text).toContain("(1/2)");
    expect(text).toContain("(2/2)");
    // Wiring coverage for /agents → Health check dispatch histogram.
    expect(computeDispatchHistogram().byKind.swarm - beforeHist.byKind.swarm).toBe(1);
    expect(computeDispatchHistogram().bySource.explicit - beforeHist.bySource.explicit).toBe(1);
  });

  it("single mode → 1 agent, dispatcher is bypassed entirely", async () => {
    setOrchestrationMode("single");
    const tally = installRunAgentMock("Single result");

    const beforeHist = computeDispatchHistogram();
    const { ctx, manager, groupJoin, swarmJoin, piCtx } = buildToolContext();
    const tool = createAgentTool(ctx);

    const result: any = await tool.execute!(
      "call-id",
      {
        subagent_type: "general-purpose",
        prompt: "fix typo",
        description: "fix typo",
      } as any,
      undefined,
      undefined,
      piCtx,
    );

    expect(tally.countCalls()).toBe(1);
    expect(manager.listAgents().length).toBe(1);

    // Dispatcher was NOT driven — no group/swarm registration calls.
    expect(groupJoin.registerGroup).not.toHaveBeenCalled();
    expect(swarmJoin.createSwarm).not.toHaveBeenCalled();
    expect(swarmJoin.addAgentToSwarm).not.toHaveBeenCalled();

    expect(manager.listAgents()[0]!.groupId).toBeUndefined();
    expect(manager.listAgents()[0]!.swarmId).toBeUndefined();
    expect(result.content[0].text).toContain("Single result");
    expect(result.content[0].text).not.toContain("Crew");
    expect(result.content[0].text).not.toContain("Swarm");
    // Wiring coverage: single is recorded too, so the histogram shows the
    // explicit-single vs auto-picked-single ratio.
    expect(computeDispatchHistogram().byKind.single - beforeHist.byKind.single).toBe(1);
    expect(computeDispatchHistogram().bySource.explicit - beforeHist.bySource.explicit).toBe(1);
  });

  it("auto mode routes a planner-style prompt to crew", async () => {
    setOrchestrationMode("auto");
    const tally = installRunAgentMock(["p", "e", "r"]);

    const beforeHist = computeDispatchHistogram();
    const { ctx, manager, groupJoin, piCtx } = buildToolContext();
    const tool = createAgentTool(ctx);

    const result: any = await tool.execute!(
      "call-id",
      {
        subagent_type: "general-purpose",
        prompt: "Plan the migration to a new database",
        description: "migration",
      } as any,
      undefined,
      undefined,
      piCtx,
    );

    expect(tally.countCalls()).toBe(3);
    expect(manager.listAgents().length).toBe(3);
    expect(groupJoin.registerGroup).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain("Crew completed");
    // Wiring coverage: auto→crew decision must be recorded as auto-heuristic,
    // not explicit — so the histogram separates user-pinned from heuristic.
    expect(computeDispatchHistogram().byKind.crew - beforeHist.byKind.crew).toBe(1);
    expect(computeDispatchHistogram().bySource.autoHeuristic - beforeHist.bySource.autoHeuristic).toBe(1);
  });

  it("auto mode routes a parallel-style prompt to swarm", async () => {
    setOrchestrationMode("auto");
    const tally = installRunAgentMock(["r1", "r2", "r3"]);

    const beforeHist = computeDispatchHistogram();
    const { ctx, swarmJoin, piCtx } = buildToolContext();
    const tool = createAgentTool(ctx);

    const result: any = await tool.execute!(
      "call-id",
      {
        subagent_type: "general-purpose",
        prompt: "Compare these three implementations",
        description: "comparison",
      } as any,
      undefined,
      undefined,
      piCtx,
    );

    expect(tally.countCalls()).toBe(2);
    expect(swarmJoin.createSwarm).toHaveBeenCalledTimes(1);
    expect(swarmJoin.addAgentToSwarm).toHaveBeenCalledTimes(2);
    expect(result.content[0].text).toContain("Swarm completed");
    // Wiring coverage: auto→swarm decision must be recorded as auto-heuristic.
    expect(computeDispatchHistogram().byKind.swarm - beforeHist.byKind.swarm).toBe(1);
    expect(computeDispatchHistogram().bySource.autoHeuristic - beforeHist.bySource.autoHeuristic).toBe(1);
  });

  it("auto mode routes a trivial prompt to single", async () => {
    setOrchestrationMode("auto");
    const tally = installRunAgentMock("done");

    const beforeHist = computeDispatchHistogram();
    const { ctx, manager, piCtx } = buildToolContext();
    const tool = createAgentTool(ctx);

    const result: any = await tool.execute!(
      "call-id",
      {
        subagent_type: "general-purpose",
        prompt: "Fix typo in README",
        description: "typo",
      } as any,
      undefined,
      undefined,
      piCtx,
    );

    expect(tally.countCalls()).toBe(1);
    expect(manager.listAgents().length).toBe(1);
    expect(result.content[0].text).toContain("done");
    expect(result.content[0].text).not.toContain("Crew");
    expect(result.content[0].text).not.toContain("Swarm");
    // Wiring coverage: auto→single decision must be recorded as auto-heuristic.
    expect(computeDispatchHistogram().byKind.single - beforeHist.byKind.single).toBe(1);
    expect(computeDispatchHistogram().bySource.autoHeuristic - beforeHist.bySource.autoHeuristic).toBe(1);
  });

  it("partial failure mid-crew surfaces as 'Error: …' in aggregate", async () => {
    setOrchestrationMode("crew");
    installRunAgentMock(["plan ok", "Executor crashed", "review ok"], { throwAt: 1 });

    const { ctx, piCtx } = buildToolContext();
    const tool = createAgentTool(ctx);

    const result: any = await tool.execute!(
      "call-id",
      {
        subagent_type: "general-purpose",
        prompt: "Plan X",
        description: "Plan X",
      } as any,
      undefined,
      undefined,
      piCtx,
    );

    const text = result.content[0].text as string;
    expect(text).toContain("Crew completed");
    expect(text).toContain("Executor crashed");
    // All three role tags are still present (the failing member's tag is preserved).
    expect(text).toContain("(planner)");
    expect(text).toContain("(executor)");
    expect(text).toContain("(reviewer)");
  });

  it("background crew returns agent IDs immediately without awaiting records", async () => {
    setOrchestrationMode("crew");

    // Use a never-resolving promise so execute must NOT await it.
    installRunAgentMock(["never resolves"], { deferred: { resolvers: [] } });

    const { ctx, manager, batchOrchestrator, piCtx } = buildToolContext();
    const tool = createAgentTool(ctx);

    const t0 = Date.now();
    const result: any = await tool.execute!(
      "call-id",
      {
        subagent_type: "general-purpose",
        prompt: "Plan X",
        description: "Plan X",
        run_in_background: true,
      } as any,
      undefined,
      undefined,
      piCtx,
    );
    const elapsed = Date.now() - t0;

    // Returns the summary rather than awaiting all members.
    expect(elapsed).toBeLessThan(500);
    const text = result.content[0].text as string;
    expect(text).toContain("crew dispatched in background");
    expect(text).toContain("(3 members)");
    expect(text).toContain("Join mode: group");

    // All records exist; statuses are running or queued — never "completed".
    expect(manager.listAgents().length).toBe(3);
    for (const r of manager.listAgents()) {
      expect(["running", "queued"]).toContain(r.status);
    }

    // Clean up dangling resolvers + batch timers.
    await batchOrchestrator.dispose();
  });

  it("swarm/group is finalized before record.promise resolves (no torn-read race)", async () => {
    // This is the ordering test the round-1 reviewer flagged as broken — the
    // tautological `memberOneCompleted || swarmExisted…` assertion proved
    // nothing. The real proof: pause runAgent via a deferred resolver, run
    // the dispatcher to completion (it awaits the flush + the records'
    // promises; neither can complete because runAgent is parked), and assert
    // that the swarm/group exists AT THE TIME the dispatcher would have
    // observed it. Then free the parked runAgent and verify the records
    // eventually resolve cleanly.
    setOrchestrationMode("swarm");
    const deferred = { resolvers: [] as Array<() => void> };
    installRunAgentMock(["member-1", "member-2"], { deferred });

    const { ctx, manager, swarmJoin, batchOrchestrator, piCtx } = buildToolContext();
    const tool = createAgentTool(ctx);

    // Catch the "tool.execute never returns because runAgent is parked" case
    // — race the execute against a 200ms safety timeout.
    const executePromise = tool.execute!(
      "call-id",
      {
        subagent_type: "general-purpose",
        prompt: "do benchmark",
        description: "benchmark",
      } as any,
      undefined,
      undefined,
      piCtx,
    );
    const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), 200));
    const winner = await Promise.race([executePromise, timeout]);
    expect(winner).toBe("timeout");

    // The dispatcher awaited `batchOrchestrator.flush()` BEFORE awaiting any
    // record.promise, so by now (records still parked) the swarm must exist
    // and must contain all default swarm members. This is the real ordering proof.
    expect(swarmJoin.createSwarm).toHaveBeenCalledTimes(1);
    expect(swarmJoin.addAgentToSwarm).toHaveBeenCalledTimes(2);
    expect(manager.listAgents().map((r) => r.swarmId)).toEqual([
      "swarm-it-1",
      "swarm-it-1",
    ]);
    // Records are still running because runAgent is parked.
    for (const r of manager.listAgents()) {
      expect(r.status).toBe("running");
    }

    // Free the parked agents and let execute resolve cleanly.
    for (const resolve of deferred.resolvers) resolve();
    await expect(executePromise).resolves.toBeDefined();

    await batchOrchestrator.dispose();
  });

  it("declares sequential executionMode so multi-Agent assistant batches stay ordered", () => {
    const { ctx } = buildToolContext();
    const tool = createAgentTool(ctx);
    expect((tool as { executionMode?: string }).executionMode).toBe("sequential");
  });

  it("Esc during foreground swarm aborts every member and rejects with AbortError", async () => {
    setOrchestrationMode("swarm");
    const deferred = { resolvers: [] as Array<() => void> };
    installRunAgentMock(["member-1", "member-2"], { deferred });

    const { ctx, manager, piCtx } = buildToolContext();
    manager.setMaxConcurrent(1);
    const tool = createAgentTool(ctx);
    const controller = new AbortController();

    const params: AgentToolParams = {
      subagent_type: "general-purpose",
      prompt: "do benchmark",
      description: "benchmark",
    };
    const executePromise = tool.execute!(
      "call-id",
      params,
      controller.signal,
      undefined,
      piCtx,
    );

    // Let fan-out + flush start and park on member promises.
    await new Promise((r) => setTimeout(r, 20));
    const records = manager.listAgents();
    expect(records.length).toBe(2);
    expect(records.some((r) => r.status === "queued")).toBe(true);

    controller.abort();
    await expect(executePromise).rejects.toMatchObject({ name: "AbortError" });

    for (const record of records) {
      await expect(record.promise).resolves.toBeDefined();
      expect(["stopped", "aborted", "completed", "error"]).toContain(record.status);
    }
  });
});
