import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  defineTool: (def: any) => def,
}));

vi.mock("@sinclair/typebox", () => ({
  Type: {
    Object: (schema: any) => schema,
    String: (opts?: any) => ({ type: "string", ...opts }),
    Boolean: (opts?: any) => ({ type: "boolean", ...opts }),
    Optional: (type: any) => ({ ...type, optional: true }),
  },
}));

vi.mock("../src/agent-runner.js", () => ({
  getAgentConversation: vi.fn(),
}));

vi.mock("../src/tool-result-helpers.js", () => ({
  formatLifetimeTokens: vi.fn().mockReturnValue("500 tokens"),
  textResult: (msg: string) => ({ content: [{ type: "text", text: msg }] }),
}));

vi.mock("../src/ui/agent-format.js", () => ({
  formatDuration: vi.fn().mockReturnValue("5.0s"),
  getDisplayName: vi.fn().mockReturnValue("Explore"),
}));

vi.mock("../src/usage.js", () => ({
  getSessionContextPercent: vi.fn().mockReturnValue(30),
}));

import { createGetResultTool } from "../src/tools/get-result.js";

function makeRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-1",
    type: "Explore",
    description: "Test",
    status: "running",
    toolUses: 0,
    spawnedAt: Date.now() - 5000,
    startedAt: Date.now() - 5000,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    currentLevel: 0,
    totalSpawned: 0,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createGetResultTool", () => {
  const makeCtx = (overrides: any = {}) => ({
    pi: { events: { emit: vi.fn() } },
    manager: {
      getRecord: vi.fn(),
      getMaxConcurrent: vi.fn().mockReturnValue(4),
      getSessionUsage: vi.fn().mockReturnValue({ spawnedAgents: 0, totalTurns: 0 }),
      getSessionMaxSpawns: vi.fn().mockReturnValue(0),
      getSessionMaxTurns: vi.fn().mockReturnValue(0),
    },
    liveWidgets: {
      setUICtx: vi.fn(),
      ensureTimer: vi.fn(),
      debouncedUpdate: vi.fn(),
      update: vi.fn(),
      markFinished: vi.fn(),
      onTurnStart: vi.fn(),
      bind: vi.fn(),
      dispose: vi.fn(),
    },
    agentActivity: new Map(),
    batchOrchestrator: {} as any,
    scheduler: {} as any,
    swarmJoin: {} as any,
    hookRegistry: { dispatch: vi.fn().mockResolvedValue(undefined) },
    sendIndividualNudge: vi.fn(),
    cancelNudge: vi.fn(),
    scheduleNudge: vi.fn(),
    ...overrides,
  });

  it("creates a tool with correct name", () => {
    const tool = createGetResultTool(makeCtx());
    expect(tool.name).toBe("get_subagent_result");
    expect(tool.label).toBe("Get Agent Result");
  });

  it("has wait, verbose, and agent_id params", () => {
    const tool = createGetResultTool(makeCtx());
    expect(tool.parameters.agent_id).toBeDefined();
    expect(tool.parameters.wait).toBeDefined();
    expect(tool.parameters.verbose).toBeDefined();
  });

  it("execute returns not found for missing agent", async () => {
    const ctx = makeCtx();
    ctx.manager.getRecord.mockReturnValue(undefined);
    const tool = createGetResultTool(ctx);
    const result = await tool.execute("call-1", { agent_id: "missing" }, undefined, undefined, ctx);
    expect(result.content[0].text).toMatch(/Agent not found/);
  });

  it("execute returns running status for active agent", async () => {
    const ctx = makeCtx();
    ctx.manager.getRecord.mockReturnValue(makeRecord({ toolUses: 2 }));
    const tool = createGetResultTool(ctx);
    const result = await tool.execute("call-1", { agent_id: "agent-1" }, undefined, undefined, ctx);
    expect(result.content[0].text).toMatch(/Agent is still running/);
  });

  it("execute returns result for completed agent", async () => {
    const ctx = makeCtx();
    ctx.manager.getRecord.mockReturnValue(
      makeRecord({
        status: "completed",
        toolUses: 3,
        completedAt: Date.now(),
        result: "Task finished successfully",
        lifetimeUsage: { input: 1000, output: 500, cacheWrite: 0 },
      }),
    );
    const tool = createGetResultTool(ctx);
    const result = await tool.execute("call-1", { agent_id: "agent-1" }, undefined, undefined, ctx);
    expect(result.content[0].text).toMatch(/Task finished successfully/);
  });

  it("treats a whitespace-only completed result as no output", async () => {
    const ctx = makeCtx();
    ctx.manager.getRecord.mockReturnValue(
      makeRecord({
        status: "completed",
        completedAt: Date.now(),
        result: " \n\t ",
      }),
    );
    const tool = createGetResultTool(ctx);
    const result = await tool.execute("call-1", { agent_id: "agent-1" }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("No output.");
    expect(result.content[0].text).toContain("finished without producing text");
  });

  it("renders a blocked_budget outcome and structured reason instead of No output.", async () => {
    const ctx = makeCtx();
    ctx.manager.getRecord.mockReturnValue(
      makeRecord({
        status: "aborted",
        completedAt: Date.now(),
        result: "[pi-agent-orchestrator] Agent completed without producing output.\nStatus: aborted",
        outcome: "blocked_budget",
        outcomeReason: "Token quota exceeded (600/500 tokens)",
      }),
    );
    const tool = createGetResultTool(ctx);
    const result = await tool.execute("call-1", { agent_id: "agent-1" }, undefined, undefined, ctx);
    const text = result.content[0].text;
    expect(text).toContain("Outcome: blocked_budget — Token quota exceeded (600/500 tokens)");
    expect(text).not.toContain("No output.");
  });

  it("renders the not_executed outcome for a genuinely empty completed run", async () => {
    const ctx = makeCtx();
    ctx.manager.getRecord.mockReturnValue(
      makeRecord({
        status: "completed",
        completedAt: Date.now(),
        result: " \n\t ",
        outcome: "not_executed",
        outcomeReason: "Agent completed without producing output or executing any tools.",
      }),
    );
    const tool = createGetResultTool(ctx);
    const result = await tool.execute("call-1", { agent_id: "agent-1" }, undefined, undefined, ctx);
    const text = result.content[0].text;
    expect(text).toContain(
      "Outcome: not_executed — Agent completed without producing output or executing any tools.",
    );
    expect(text).not.toContain("No output.");
  });

  it("renders the partial-progress note for an executed outcome with a reason", async () => {
    const ctx = makeCtx();
    ctx.manager.getRecord.mockReturnValue(
      makeRecord({
        status: "aborted",
        completedAt: Date.now(),
        result: "partial findings",
        outcome: "executed",
        outcomeReason: "Aborted mid-run (Token quota exceeded) — output may be incomplete.",
      }),
    );
    const tool = createGetResultTool(ctx);
    const result = await tool.execute("call-1", { agent_id: "agent-1" }, undefined, undefined, ctx);
    const text = result.content[0].text;
    expect(text).toContain("Outcome: executed — Aborted mid-run (Token quota exceeded)");
    expect(text).toContain("partial findings");
  });

  it("does not add an outcome line for a normal executed completion without a reason", async () => {
    const ctx = makeCtx();
    ctx.manager.getRecord.mockReturnValue(
      makeRecord({
        status: "completed",
        completedAt: Date.now(),
        result: "Task finished successfully",
        outcome: "executed",
      }),
    );
    const tool = createGetResultTool(ctx);
    const result = await tool.execute("call-1", { agent_id: "agent-1" }, undefined, undefined, ctx);
    const text = result.content[0].text;
    expect(text).toMatch(/Task finished successfully/);
    expect(text).not.toContain("Outcome:");
  });

  it("execute returns error for errored agent", async () => {
    const ctx = makeCtx();
    ctx.manager.getRecord.mockReturnValue(
      makeRecord({
        status: "error",
        error: "Something crashed",
        toolUses: 1,
        completedAt: Date.now(),
      }),
    );
    const tool = createGetResultTool(ctx);
    const result = await tool.execute("call-1", { agent_id: "agent-1" }, undefined, undefined, ctx);
    expect(result.content[0].text).toMatch(/Something crashed/);
  });

  it("execute handles wait for running agent (sets resultConsumed and awaits promise)", async () => {
    const ctx = makeCtx();
    const record = makeRecord({
      toolUses: 1,
      completedAt: Date.now(),
      result: "done",
      promise: Promise.resolve("done"),
      lifetimeUsage: { input: 100, output: 50, cacheWrite: 0 },
      resultConsumed: false,
    });
    ctx.manager.getRecord.mockReturnValue(record);
    const tool = createGetResultTool(ctx);
    const result = await tool.execute("call-1", { agent_id: "agent-1", wait: true }, undefined, undefined, ctx);
    expect(record.resultConsumed).toBe(true);
    expect(ctx.cancelNudge).toHaveBeenCalled();
    expect(result.content[0].text).toMatch(/Agent is still running/);
  });

  it("allows Esc/tool abort to interrupt wait without consuming the future result", async () => {
    const ctx = makeCtx();
    const agent = deferred<string>();
    const record: AgentRecord = makeRecord({
      description: "Long research",
      toolUses: 1,
      promise: agent.promise,
      lifetimeUsage: { input: 100, output: 50, cacheWrite: 0 },
      resultConsumed: false,
    });
    ctx.manager.getRecord.mockReturnValue(record);
    const tool = createGetResultTool(ctx);
    const controller = new AbortController();

    const pending = tool.execute(
      "call-1",
      { agent_id: "agent-1", wait: true },
      controller.signal,
      undefined,
      ctx,
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(record.resultConsumed).toBe(false);
    expect(ctx.cancelNudge).toHaveBeenCalledWith("agent-1");
    expect(ctx.sendIndividualNudge).not.toHaveBeenCalled();

    agent.resolve("done");
  });

  it("restores the completion notification when abort wins a terminal-state race", async () => {
    const ctx = makeCtx();
    const agent = deferred<string>();
    const record: AgentRecord = makeRecord({
      description: "Long research",
      toolUses: 1,
      promise: agent.promise,
      lifetimeUsage: { input: 100, output: 50, cacheWrite: 0 },
      resultConsumed: false,
    });
    ctx.manager.getRecord.mockReturnValue(record);
    const tool = createGetResultTool(ctx);
    const controller = new AbortController();

    const pending = tool.execute(
      "call-1",
      { agent_id: "agent-1", wait: true },
      controller.signal,
      undefined,
      ctx,
    );
    record.status = "completed";
    record.result = "done";
    record.completedAt = Date.now();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(record.resultConsumed).toBe(false);
    expect(ctx.sendIndividualNudge).toHaveBeenCalledWith(record);

    agent.resolve("done");
  });

  it("keeps notifications suppressed while another concurrent waiter remains active", async () => {
    const ctx = makeCtx();
    const agent = deferred<string>();
    const record: AgentRecord = makeRecord({
      description: "Concurrent wait",
      toolUses: 1,
      promise: agent.promise,
      lifetimeUsage: { input: 100, output: 50, cacheWrite: 0 },
      resultConsumed: false,
    });
    ctx.manager.getRecord.mockReturnValue(record);
    const tool = createGetResultTool(ctx);
    const firstController = new AbortController();
    const secondController = new AbortController();

    const firstWait = tool.execute(
      "call-1",
      { agent_id: "agent-1", wait: true },
      firstController.signal,
      undefined,
      ctx,
    );
    const secondWait = tool.execute(
      "call-2",
      { agent_id: "agent-1", wait: true },
      secondController.signal,
      undefined,
      ctx,
    );

    firstController.abort();
    await expect(firstWait).rejects.toMatchObject({ name: "AbortError" });
    expect(record.resultConsumed).toBe(true);
    expect(ctx.sendIndividualNudge).not.toHaveBeenCalled();

    record.status = "completed";
    record.result = "done";
    record.completedAt = Date.now();
    agent.resolve("done");

    const result = await secondWait;
    expect(result.content[0].text).toMatch(/done/);
    expect(record.resultConsumed).toBe(true);
    expect(ctx.sendIndividualNudge).not.toHaveBeenCalled();
  });

  it("recovers exactly one terminal nudge when every concurrent waiter aborts", async () => {
    const ctx = makeCtx();
    const agent = deferred<string>();
    const record: AgentRecord = makeRecord({
      description: "Concurrent terminal race",
      toolUses: 1,
      promise: agent.promise,
      lifetimeUsage: { input: 100, output: 50, cacheWrite: 0 },
      resultConsumed: false,
    });
    ctx.manager.getRecord.mockReturnValue(record);
    const tool = createGetResultTool(ctx);
    const firstController = new AbortController();
    const secondController = new AbortController();

    const firstWait = tool.execute(
      "call-1",
      { agent_id: "agent-1", wait: true },
      firstController.signal,
      undefined,
      ctx,
    );
    const secondWait = tool.execute(
      "call-2",
      { agent_id: "agent-1", wait: true },
      secondController.signal,
      undefined,
      ctx,
    );

    record.status = "completed";
    record.result = "done";
    record.completedAt = Date.now();
    firstController.abort();
    secondController.abort();

    await Promise.all([
      expect(firstWait).rejects.toMatchObject({ name: "AbortError" }),
      expect(secondWait).rejects.toMatchObject({ name: "AbortError" }),
    ]);
    expect(record.resultConsumed).toBe(false);
    expect(ctx.sendIndividualNudge).toHaveBeenCalledTimes(1);
    expect(ctx.sendIndividualNudge).toHaveBeenCalledWith(record);

    agent.resolve("done");
  });

  it("execute includes verbose conversation when requested", async () => {
    const agentRunner = await import("../src/agent-runner.js");
    vi.mocked(agentRunner.getAgentConversation).mockReturnValue("turn1\nturn2");

    const ctx = makeCtx();
    ctx.manager.getRecord.mockReturnValue(
      makeRecord({
        status: "completed",
        toolUses: 1,
        completedAt: Date.now(),
        result: "done",
        session: { id: "sess-1" } as AgentRecord["session"],
      }),
    );
    const tool = createGetResultTool(ctx);
    const result = await tool.execute("call-1", { agent_id: "agent-1", verbose: true }, undefined, undefined, ctx);
    expect(result.content[0].text).toMatch(/turn1/);
  });

  it("wait:true stays pending for a queued agent until its completion promise settles", async () => {
    const ctx = makeCtx();
    const agent = deferred<string>();
    const record = makeRecord({
      status: "queued",
      toolUses: 0,
      promise: agent.promise,
      resultConsumed: false,
    });
    ctx.manager.getRecord.mockReturnValue(record);
    const tool = createGetResultTool(ctx);

    const pending = tool.execute("call-1", { agent_id: "agent-1", wait: true }, undefined, undefined, ctx);

    let done = false;
    void pending.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);

    record.status = "completed";
    record.result = "queued-done";
    record.completedAt = Date.now();
    agent.resolve("queued-done");

    const result = await pending;
    expect(result.content[0].text).toMatch(/queued-done/);
    expect(record.resultConsumed).toBe(true);
  });
});
