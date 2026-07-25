import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DASHBOARD_KEYBINDINGS } from "../src/ui/dashboard-keybindings.js";
import { DEFAULT_FOOTER_STATUS_CONFIG } from "../src/ui/footer-status-config.js";

// Mock logger
vi.mock("../src/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// Mock agent-runner
vi.mock("../src/agent-runner.js", () => ({
  setDefaultMaxTurns: vi.fn(),
  setGraceTurns: vi.fn(),
  setMaxEndHookRevisions: vi.fn(),
  getDefaultMaxTurns: vi.fn(),
  getGraceTurns: vi.fn(() => 5),
  getMaxEndHookRevisions: vi.fn(() => 0),
}));

// Mock agent-registry
vi.mock("../src/agent-registry.js", () => ({
  isSchedulingEnabled: vi.fn(() => false),
  isTracingEnabled: vi.fn(() => true),
  isDebugCaptureEnabled: vi.fn(() => false),
  getDebugCapturePaths: vi.fn(() => ({ project: undefined, personal: undefined })),
  reloadCustomAgents: vi.fn(async () => {}),
  setAnimationStyle: vi.fn(),
  setDashboardRefreshInterval: vi.fn(),
  setDefaultJoinMode: vi.fn(),
  setOrchestrationMode: vi.fn(),
  setPromptCompressionLevel: vi.fn(),
  setSchedulingEnabled: vi.fn(),
  setShowActivityStream: vi.fn(),
  setShowTokenUsage: vi.fn(),
  setShowTurnProgress: vi.fn(),
  setTracingEnabled: vi.fn(),
  setUiStyle: vi.fn(),
  setDebugCapture: vi.fn(),
  setDebugCapturePaths: vi.fn(),
  getFooterStatusConfig: () => DEFAULT_FOOTER_STATUS_CONFIG,
  getDashboardKeybindings: () => DEFAULT_DASHBOARD_KEYBINDINGS,
  setDashboardKeybindings: vi.fn(),
  setFooterStatusConfig: vi.fn(),
}));

// Mock batch-orchestrator
vi.mock("../src/batch-orchestrator.js", () => ({
  BatchOrchestrator: vi.fn(function (this: any) {
    this.isPendingBatchFinalization = vi.fn(() => false);
    this.dispose = vi.fn(async () => {});
  }),
}));

// Mock schedule
vi.mock("../src/schedule.js", () => ({
  SubagentScheduler: vi.fn(function (this: any) {
    this.isActive = vi.fn(() => false);
    this.start = vi.fn(async () => {});
    this.stop = vi.fn();
    this.list = vi.fn(() => []);
  }),
}));

// Mock schedule-store
vi.mock("../src/schedule-store.js", () => ({
  resolveStorePath: vi.fn(() => "/tmp/test-schedules"),
  ScheduleStore: vi.fn(function (this: any) {
    this.list = vi.fn(() => []);
  }),
}));

// Mock swarm-join
vi.mock("../src/swarm-join.js", () => ({
  SwarmCoordinator: vi.fn(function (this: any) {
    this.onAgentComplete = vi.fn(() => "pass");
  }),
  setActiveSwarmCoordinator: vi.fn(),
}));

// Mock group-join
vi.mock("../src/group-join.js", () => ({
  GroupJoinManager: vi.fn(function (this: any) {
    this.onAgentComplete = vi.fn(() => "pass");
  }),
}));

// Mock commands
vi.mock("../src/commands/agents.js", () => ({ registerAgentsCommand: vi.fn() }));
vi.mock("../src/commands/hooks.js", () => ({ registerHooksCommand: vi.fn() }));

// Mock cross-extension-rpc
vi.mock("../src/cross-extension-rpc.js", () => ({
  PROTOCOL_VERSION: 2,
  createSubagentsRpcClient: vi.fn(() => ({
    ping: vi.fn(async () => ({ version: 2 })),
    spawn: vi.fn(async () => ({ id: "mock-agent" })),
    stop: vi.fn(async () => undefined),
    sessionUsage: vi.fn(async () => ({
      usage: { spawnedAgents: 0, totalTurns: 0 },
      limits: { maxAgents: 0, maxTurns: 0 },
    })),
  })),
  registerRpcHandlers: vi.fn(() => ({
    unsubPing: vi.fn(),
    unsubSpawn: vi.fn(),
    unsubStop: vi.fn(),
    unsubSessionUsage: vi.fn(),
    unsubSwarmHealth: vi.fn(),
  })),
}));

// Mock hook registry
vi.mock("../src/hooks.js", () => ({
  HookRegistry: vi.fn(function (this: any) {
    this.getHandlers = vi.fn(() => []);
    // Always-on hook handlers in src/index.ts (debug-capture wiring) call
    // `hookRegistry.register(event, fn, opts)`. The mock returns undefined,
    // matching the production HookRegistry contract.
    this.register = vi.fn();
  }),
}));

// Mock telemetry
// Defensive: src/index.ts's debug-capture wiring calls
// `onTelemetry(event, callback)` at extensionInit time and pushes the
// returned unsub function into `debugTelemetryUnsubs`. The wiring on
// session_shutdown iterates that array and invokes each unsub. Mirroring
// the false-positive safety of the agent-registry + HookRegistry mocks
// above so an analogous import-shape regression in a future commit can't
// trip the same `TypeError: onTelemetry is not a function` pattern during
// extension-init tests.
vi.mock("../src/telemetry.js", () => ({
  onTelemetry: vi.fn(() => () => {}),
}));

// Mock settings
vi.mock("../src/settings.js", () => ({ applyAndEmitLoaded: vi.fn(), loadSettings: vi.fn(() => ({})) }));

// Mock output-file
vi.mock("../src/output-file.js", () => ({}));

// Mock usage
vi.mock("../src/usage.js", () => ({ getLifetimeTotal: vi.fn(() => 150) }));

// Mock validators
vi.mock("../src/validators.js", () => ({}));

// Mock tool-result-helpers
vi.mock("../src/tool-result-helpers.js", () => ({
  buildNotificationDetails: vi.fn(() => ({})),
  formatTaskNotification: vi.fn(() => "Task completed"),
}));

// Mock tools
vi.mock("../src/tools/agent.js", () => ({ createAgentTool: vi.fn(() => ({ name: "Agent" })) }));
vi.mock("../src/tools/get-result.js", () => ({
  createGetResultTool: vi.fn(() => ({ name: "get_subagent_result" })),
}));
vi.mock("../src/tools/steer.js", () => ({
  createSteerTool: vi.fn(() => ({ name: "steer_subagent" })),
}));

// Mock UI modules
vi.mock("../src/ui/agent-widget.js", () => ({
  AgentWidget: vi.fn(function (this: any) {
    this.update = vi.fn();
    this.markFinished = vi.fn();
    this.setUICtx = vi.fn();
    this.ensureTimer = vi.fn();
    this.onTurnStart = vi.fn();
    this.getRenderMetrics = vi.fn(() => ({}));
    this.dispose = vi.fn();
  }),
}));

vi.mock("../src/ui/animation.js", () => ({ setSpinnerStyle: vi.fn() }));
vi.mock("../src/ui/notification-renderer.js", () => ({
  createNotificationRenderer: vi.fn(() => vi.fn()),
}));

const extensionInit = (await import("../src/index.js")).default;
const { AgentWidget } = await import("../src/ui/agent-widget.js");

function buildPiMock() {
  return {
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerCommand: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
    on: vi.fn(),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  };
}

function cleanupGlobals() {
  for (const k of [
    Symbol.for("pi-subagents:manager"),
    Symbol.for("pi-subagents:hooks"),
    Symbol.for("pi-subagents:widget-metrics"),
  ]) {
    if ((globalThis as any)[k] !== undefined) delete (globalThis as any)[k];
  }
}

describe("extension entry point", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    cleanupGlobals();
  });

  it("exports a default async function", () => {
    expect(typeof extensionInit).toBe("function");
  });

  it("registers 3 tools on init", async () => {
    const pi = buildPiMock();
    await extensionInit(pi);
    expect(pi.registerTool).toHaveBeenCalledTimes(3);
  });

  it("registers tool names Agent, get_subagent_result, steer_subagent", async () => {
    const pi = buildPiMock();
    await extensionInit(pi);
    const names = pi.registerTool.mock.calls.map((c: any[]) => c[0]?.name);
    expect(names).toContain("Agent");
    expect(names).toContain("get_subagent_result");
    expect(names).toContain("steer_subagent");
  });

  it("emits subagents:ready after init", async () => {
    const pi = buildPiMock();
    await extensionInit(pi);
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:ready", {});
  });

  it("registers message renderer for subagent-notification", async () => {
    const pi = buildPiMock();
    await extensionInit(pi);
    expect(pi.registerMessageRenderer).toHaveBeenCalledWith(
      "subagent-notification",
      expect.any(Function),
    );
  });

  it("exposes manager via Symbol.for with readonly API", async () => {
    const pi = buildPiMock();
    await extensionInit(pi);

    const key = Symbol.for("pi-subagents:manager");
    const exposed = (globalThis as any)[key];
    expect(exposed).toBeDefined();
    expect(typeof exposed.waitForAll).toBe("function");
    expect(typeof exposed.hasRunning).toBe("function");
    expect(typeof exposed.getRecord).toBe("function");
    expect(typeof exposed.listAgentIds).toBe("function");
  });

  it("exposes hooks via Symbol.for with readonly API", async () => {
    const pi = buildPiMock();
    await extensionInit(pi);

    const key = Symbol.for("pi-subagents:hooks");
    const exposed = (globalThis as any)[key];
    expect(exposed).toBeDefined();
    expect(typeof exposed.getHandlers).toBe("function");
  });

  it("exposes widget-metrics via Symbol.for", async () => {
    const pi = buildPiMock();
    await extensionInit(pi);

    const key = Symbol.for("pi-subagents:widget-metrics");
    const exposed = (globalThis as any)[key];
    expect(exposed).toBeDefined();
    expect(typeof exposed.getSnapshot).toBe("function");
  });

  it("cleanup on session_shutdown removes global registries", async () => {
    const pi = buildPiMock();
    await extensionInit(pi);
    const widget = vi.mocked(AgentWidget).mock.results.at(-1)?.value as {
      dispose: ReturnType<typeof vi.fn>;
    };

    const shutdownHandler = (pi.on as any).mock.calls.find(
      (c: any[]) => c[0] === "session_shutdown",
    )?.[1];
    expect(shutdownHandler).toBeDefined();

    await shutdownHandler();

    expect((globalThis as any)[Symbol.for("pi-subagents:manager")]).toBeUndefined();
    expect((globalThis as any)[Symbol.for("pi-subagents:hooks")]).toBeUndefined();
    expect(widget.dispose).toHaveBeenCalledOnce();
  });

  it("registers session_start handler", async () => {
    const pi = buildPiMock();
    await extensionInit(pi);
    const calls = (pi.on as any).mock.calls.filter((c: any[]) => c[0] === "session_start");
    expect(calls.length).toBe(2);
  });

  it("binds widget UI context on session_start", async () => {
    const pi = buildPiMock();
    await extensionInit(pi);
    const widget = vi.mocked(AgentWidget).mock.results.at(-1)?.value as {
      setUICtx: ReturnType<typeof vi.fn>;
      ensureTimer: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    const uiCtx = { setWidget: vi.fn(), setStatus: vi.fn() };
    const ctx = { ui: uiCtx };

    const widgetSessionStart = (pi.on as any).mock.calls
      .filter((c: any[]) => c[0] === "session_start")
      .at(-1)?.[1];
    expect(widgetSessionStart).toBeDefined();

    await widgetSessionStart({}, ctx);

    expect(widget.setUICtx).toHaveBeenCalledWith(uiCtx);
    expect(widget.ensureTimer).toHaveBeenCalledOnce();
    expect(widget.update).toHaveBeenCalled();
  });

  it("registers session_before_switch handler", async () => {
    const pi = buildPiMock();
    await extensionInit(pi);
    const calls = (pi.on as any).mock.calls.filter((c: any[]) => c[0] === "session_before_switch");
    expect(calls.length).toBe(1);
  });

  it("registers session_shutdown handler", async () => {
    const pi = buildPiMock();
    await extensionInit(pi);
    const calls = (pi.on as any).mock.calls.filter((c: any[]) => c[0] === "session_shutdown");
    expect(calls.length).toBe(1);
  });

  it("registers tool_execution_start handler", async () => {
    const pi = buildPiMock();
    await extensionInit(pi);
    const calls = (pi.on as any).mock.calls.filter((c: any[]) => c[0] === "tool_execution_start");
    expect(calls.length).toBe(1);
  });

  it("registers turn_end handler", async () => {
    const pi = buildPiMock();
    await extensionInit(pi);
    const calls = (pi.on as any).mock.calls.filter((c: any[]) => c[0] === "turn_end");
    expect(calls.length).toBe(1);
  });
});
