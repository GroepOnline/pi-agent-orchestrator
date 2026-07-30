import { describe, expect, it, vi } from "vitest";

// Mock external dependencies
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
  steerAgent: vi.fn(),
}));

vi.mock("../src/logger.js", () => ({
  logger: { debug: vi.fn() },
}));

vi.mock("../src/tool-result-helpers.js", () => ({
  formatLifetimeTokens: vi.fn().mockReturnValue("1.2k tokens"),
  textResult: (msg: string) => ({ content: [{ type: "text", text: msg }] }),
}));

vi.mock("../src/usage.js", () => ({
  getSessionContextPercent: vi.fn().mockReturnValue(45),
}));

import { createSteerTool } from "../src/tools/steer.js";

describe("createSteerTool", () => {
  const makeCtx = (overrides: any = {}) => ({
    pi: { events: { emit: vi.fn() } },
    manager: {
      getRecord: vi.fn(),
      getMaxConcurrent: vi.fn().mockReturnValue(4),
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
    const tool = createSteerTool(makeCtx());
    expect(tool.name).toBe("steer_subagent");
    expect(tool.label).toBe("Steer Agent");
    expect(tool.description).toBeTruthy();
  });

  it("has correct parameter schema", () => {
    const tool = createSteerTool(makeCtx());
    expect(tool.parameters.agent_id).toBeDefined();
    expect(tool.parameters.agent_id.type).toBe("string");
    expect(tool.parameters.message.type).toBe("string");
  });

  it("execute returns error for missing agent", async () => {
    const ctx = makeCtx();
    ctx.manager.getRecord.mockReturnValue(undefined);
    const tool = createSteerTool(ctx);
    const result = await tool.execute("call-1", { agent_id: "missing", message: "hi" }, undefined as any, undefined as any, ctx);
    expect(result.content[0].text).toMatch(/Agent not found/);
  });

  it("execute returns error for non-running agent", async () => {
    const ctx = makeCtx();
    ctx.manager.getRecord.mockReturnValue({ id: "agent-1", status: "completed" });
    const tool = createSteerTool(ctx);
    const result = await tool.execute("call-1", { agent_id: "agent-1", message: "hi" }, undefined as any, undefined as any, ctx);
    expect(result.content[0].text).toMatch(/not running/);
  });

  it("execute queues message when agent has no session yet", async () => {
    const ctx = makeCtx();
    ctx.manager.getRecord.mockReturnValue({ id: "agent-1", status: "running", session: undefined, compactionCount: 0, toolUses: 0, lifetimeUsage: { input: 0, output: 0 } });
    const tool = createSteerTool(ctx);
    const result = await tool.execute("call-1", { agent_id: "agent-1", message: "turn around!" }, undefined as any, undefined as any, ctx);
    expect(result.content[0].text).toMatch(/queued/);
  });

  it("execute steers agent successfully", async () => {
    const steerAgent = await import("../src/agent-runner.js");
    (steerAgent.steerAgent as any).mockResolvedValue(undefined);

    const ctx = makeCtx();
    const session = { id: "sess-1" };
    ctx.manager.getRecord.mockReturnValue({
      id: "agent-1",
      status: "running",
      session,
      toolUses: 3,
      compactionCount: 0,
      lifetimeUsage: { input: 1000, output: 500, cacheWrite: 0 },
    });
    const tool = createSteerTool(ctx);
    const result = await tool.execute("call-1", { agent_id: "agent-1", message: "check that" }, undefined as any, undefined as any, ctx);
    expect(result.content[0].text).toMatch(/Steering message sent/);
  });

  it("execute handles steer failure gracefully", async () => {
    const steerAgent = await import("../src/agent-runner.js");
    (steerAgent.steerAgent as any).mockRejectedValue(new Error("Session closed"));

    const ctx = makeCtx();
    ctx.manager.getRecord.mockReturnValue({
      id: "agent-1",
      status: "running",
      session: { id: "sess-1" },
      compactionCount: 0,
      toolUses: 0,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    });
    const tool = createSteerTool(ctx);
    const result = await tool.execute("call-1", { agent_id: "agent-1", message: "hi" }, undefined as any, undefined as any, ctx);
    expect(result.content[0].text).toMatch(/Failed to steer/);
  });
});
