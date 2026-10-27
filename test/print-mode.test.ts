import { afterEach, describe, expect, it, vi } from "vitest";

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
  steerAgent: vi.fn(),
  getAgentConversation: vi.fn(),
  getDefaultMaxTurns: vi.fn(),
  getGraceTurns: vi.fn(),
  getMaxEndHookRevisions: vi.fn(),
  normalizeMaxTurns: vi.fn((n: number | undefined) => n),
  setDefaultMaxTurns: vi.fn(),
  setGraceTurns: vi.fn(),
  setMaxEndHookRevisions: vi.fn(),
}));

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const eventHandlers = new Map<string, any>();

  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        handlers.set(event, handler);
      }),
      events: {
        emit: vi.fn(),
        on: vi.fn((event: string, handler: any) => {
          eventHandlers.set(event, handler);
          return vi.fn();
        }),
      },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(() => {
        throw new Error("stale extension context");
      }),
    } as any,
    tools,
    handlers,
  };
}

function makeHeadlessCtx() {
  return {
    hasUI: false,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: {
      find: vi.fn(),
      getAvailable: vi.fn(() => []),
    },
    sessionManager: {
      getSessionId: vi.fn(() => "session-1"),
      getBranch: vi.fn(() => []),
    },
    getSystemPrompt: vi.fn(() => "parent prompt"),
  } as any;
}

describe("print mode background notifications", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("ignores stale-context errors from delayed completion nudges", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });

    const { pi, tools, handlers } = makePi();
    await subagentsExtension(pi);
    vi.useFakeTimers();

    const agentTool = tools.get("Agent");
    
    // Execute should complete successfully even though sendMessage will throw
    const result = await agentTool.execute(
      "tool-call-1",
      {
        prompt: "reply done",
        description: "tiny child",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      undefined,
      undefined,
      makeHeadlessCtx(),
    );

    // The tool execution should succeed
    expect(result).toBeDefined();

    await vi.advanceTimersByTimeAsync(100); // smart-join batch debounce
    await vi.advanceTimersByTimeAsync(200); // notification hold window

    // Session shutdown should handle stale context gracefully without throwing
    await expect(
      handlers.get("session_shutdown")?.({}, makeHeadlessCtx())
    ).resolves.toBeUndefined();
  });
});
