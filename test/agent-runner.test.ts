import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createAgentSession,
  defaultResourceLoaderCtor,
  getAgentDir,
  loadSettingsMock,
  sessionManagerInMemory,
  settingsManagerCreate,
} = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  defaultResourceLoaderCtor: vi.fn(),
  getAgentDir: vi.fn(() => "/mock/agent-dir"),
  // loadSettings reads from disk and (via globalPath) calls getAgentDir; mock
  // it so runAgent stays hermetic and the subagentModel override can be driven
  // per-test. Default {} preserves the prior behavior (no override).
  loadSettingsMock: vi.fn((): Record<string, unknown> => ({})),
  sessionManagerInMemory: vi.fn(() => ({ kind: "memory-session-manager" })),
  settingsManagerCreate: vi.fn(() => ({ kind: "settings-manager" })),
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

vi.mock("../src/settings.js", () => ({
  loadSettings: loadSettingsMock,
}));

vi.mock("../src/agent-types.js", () => ({
  getConfig: vi.fn(() => ({
    displayName: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    promptMode: "replace",
  })),
  getAgentConfig: vi.fn(() => ({
    name: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    systemPrompt: "You are Explore.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
  })),
  getMemoryToolNames: vi.fn(() => []),
  getReadOnlyMemoryToolNames: vi.fn(() => []),
  getToolNamesForType: vi.fn(() => ["read"]),
}));

vi.mock("../src/env.js", () => ({
  detectEnv: vi.fn(async () => ({ isGitRepo: false, branch: "", platform: "linux" })),
}));

vi.mock("../src/prompts.js", () => ({
  buildAgentPrompt: vi.fn(() => "system prompt"),
}));

vi.mock("../src/memory.js", () => ({
  buildMemoryBlock: vi.fn(() => ""),
  buildReadOnlyMemoryBlock: vi.fn(() => ""),
}));

vi.mock("../src/skill-loader.js", () => ({
  preloadSkills: vi.fn(() => []),
}));

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { AgentRunnerError, getGraceTurns, getMaxEndHookRevisions, globalCircuitBreaker, resolveConfiguredModel, resumeAgent, runAgent, setGraceTurns, setMaxEndHookRevisions } from "../src/agent-runner.js";
import { HookRegistry } from "../src/hooks.js";

function createSession(finalText: string): {
  session: AgentSession;
  listeners: Array<(event: AgentSessionEvent) => void>;
} {
  const listeners: Array<(event: AgentSessionEvent) => void> = [];
  // Typed fixture (no `as any`): only the AgentSession surface resumeAgent/runAgent touch.
  const session = {
    messages: [] as AgentSession["messages"],
    subscribe: vi.fn((listener: (event: AgentSessionEvent) => void) => {
      listeners.push(listener);
      return () => {};
    }),
    prompt: vi.fn(async () => {
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: finalText }],
      } as AgentSession["messages"][number]);
    }),
    abort: vi.fn(),
    steer: vi.fn(),
    getActiveToolNames: vi.fn(() => ["read"]),
    setActiveToolsByName: vi.fn(),
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
  } as unknown as AgentSession;
  return { session, listeners };
}

function createSessionWithError(errorMessage: string): {
  session: AgentSession;
  listeners: Array<(event: AgentSessionEvent) => void>;
} {
  const listeners: Array<(event: AgentSessionEvent) => void> = [];
  const session = {
    messages: [] as AgentSession["messages"],
    subscribe: vi.fn((listener: (event: AgentSessionEvent) => void) => {
      listeners.push(listener);
      return () => {};
    }),
    prompt: vi.fn(async () => {
      // Simulate a host-surfaced model/provider failure: an assistant turn
      // with stopReason "error", an errorMessage, and no text content. This is
      // exactly how a 401 "User not found" or "model unavailable" surfaces.
      session.messages.push({
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage,
      } as AgentSession["messages"][number]);
    }),
    abort: vi.fn(),
    steer: vi.fn(),
    getActiveToolNames: vi.fn(() => ["read"]),
    setActiveToolsByName: vi.fn(),
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
  } as unknown as AgentSession;
  return { session, listeners };
}

/**
 * Simulate a run that recovered from an earlier provider error: the first
 * turn errors, then a revision produces a later assistant turn that is
 * non-error (but empty). The stale error must not be surfaced as the final
 * outcome. See the "Recovered Run Reuses Stale Error" review thread.
 */
function createSessionWithRecoveredError(errorMessage: string): {
  session: AgentSession;
  listeners: Array<(event: AgentSessionEvent) => void>;
} {
  const listeners: Array<(event: AgentSessionEvent) => void> = [];
  let call = 0;
  const session = {
    messages: [] as AgentSession["messages"],
    subscribe: vi.fn((listener: (event: AgentSessionEvent) => void) => {
      listeners.push(listener);
      return () => {};
    }),
    prompt: vi.fn(async () => {
      call++;
      if (call === 1) {
        // First turn: provider error, no text.
        session.messages.push({
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage,
        } as AgentSession["messages"][number]);
        return;
      }
      // Later turn: non-error recovery that still produced no text. The stale
      // error from turn 1 must not be reported as the final outcome.
      session.messages.push({
        role: "assistant",
        content: [],
        stopReason: "end_turn",
      } as AgentSession["messages"][number]);
    }),
    abort: vi.fn(),
    steer: vi.fn(),
    getActiveToolNames: vi.fn(() => ["read"]),
    setActiveToolsByName: vi.fn(),
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
  } as unknown as AgentSession;
  return { session, listeners };
}

const ctx = {
  cwd: "/tmp",
  model: { provider: "test", id: "test-model" },
  modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
  getSystemPrompt: vi.fn(() => "parent prompt"),
  sessionManager: { getBranch: vi.fn(() => []) },
} as any;

const pi = {} as any;

beforeEach(() => {
  createAgentSession.mockReset();
  defaultResourceLoaderCtor.mockClear();
  getAgentDir.mockClear();
  loadSettingsMock.mockReset();
  loadSettingsMock.mockReturnValue({});
  sessionManagerInMemory.mockClear();
  settingsManagerCreate.mockClear();
});

describe("resolveConfiguredModel (subagentModel setting override)", () => {
  it("inherits the session-default model when set to 'inherit'", () => {
    // Regression: built-in read-only agents are pinned to a model that may be
    // unreachable in a given install (e.g. Explore's claude-haiku via a 401
    // provider). 'inherit' must bypass that pinned model and fall back to the
    // session-default (parent) model.
    expect(resolveConfiguredModel("inherit", "anthropic/claude-haiku-4-5")).toBeUndefined();
  });

  it("pins a specific provider/model when set", () => {
    expect(resolveConfiguredModel("zai-env/glm-5.2", "anthropic/claude-haiku-4-5")).toBe(
      "zai-env/glm-5.2",
    );
  });

  it("uses the agent's configured model when unset (default behavior)", () => {
    expect(resolveConfiguredModel(undefined, "anthropic/claude-haiku-4-5")).toBe(
      "anthropic/claude-haiku-4-5",
    );
  });

  it("returns undefined when neither setting nor agent model is set", () => {
    expect(resolveConfiguredModel(undefined, undefined)).toBeUndefined();
  });
});

describe("agent-runner final output capture", () => {
  it("returns the final assistant text even when no text_delta events were streamed", async () => {
    const { session } = createSession("LOCKED");
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "Say LOCKED", { pi });

    expect(result.responseText).toBe("LOCKED");
  });

  it("surfaces a model/provider error instead of returning empty output", async () => {
    // Regression: when the configured model errors on the only turn (e.g. 401
    // auth, unavailable model), the host ends the session with stopReason
    // "error" + errorMessage and no text. Previously runAgent returned an
    // empty "completed" result, hiding the failure from the caller.
    const { session } = createSessionWithError('401: {"message":"User not found.","code":401}');
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "audit the PRs", { pi });

    expect(result.responseText).not.toBe("");
    expect(result.responseText).toContain("model/provider error");
    expect(result.responseText).toContain("User not found");
    // The run must be recorded as a failure so the manager finalizes the agent
    // with status "error" rather than "completed".
    expect(result.error).toBe('401: {"message":"User not found.","code":401}');
  });

  it("publishes subagent:end with status error before recording a model/provider failure", async () => {
    // Regression (hook ordering): runAgent used to dispatch subagent:end with
    // status "completed" *before* detecting the model/provider error, so hooks
    // and observers saw a false success and only later a subagent:error. The
    // end payload must carry status "error" (and the error message) on the
    // first publication.
    const errorMessage = '401: {"message":"User not found.","code":401}';
    const { session } = createSessionWithError(errorMessage);
    createAgentSession.mockResolvedValue({ session });
    const hooks = new HookRegistry();
    const endPayloads: Array<Record<string, unknown>> = [];
    const errorPayloads: Array<Record<string, unknown>> = [];
    hooks.register("subagent:end", async (payload) => {
      endPayloads.push({ ...(payload.data ?? {}) });
      return "allow";
    });
    hooks.register("subagent:error", async (payload) => {
      errorPayloads.push({ ...(payload.data ?? {}) });
      return "allow";
    });

    const result = await runAgent(ctx, "Explore", "audit the PRs", {
      pi,
      hooks,
      agentId: "agent-hook-order",
    });

    expect(endPayloads).toHaveLength(1);
    expect(endPayloads[0]?.status).toBe("error");
    expect(endPayloads[0]?.error).toBe(errorMessage);
    expect(endPayloads.every((payload) => payload.status !== "completed")).toBe(true);
    expect(errorPayloads).toHaveLength(1);
    expect(errorPayloads[0]?.error).toBe(errorMessage);
    expect(result.error).toBe(errorMessage);
  });

  it("does not surface a stale provider error after a later non-error turn", async () => {
    // Regression ("Recovered Run Reuses Stale Error"): getLastAssistantError
    // previously scanned the full history, so an earlier failed turn stayed
    // eligible after a revision added a later non-error (but empty) assistant
    // turn. The final outcome must not be misreported as a provider error.
    const { session } = createSessionWithRecoveredError('401: {"message":"User not found.","code":401}');
    createAgentSession.mockResolvedValue({ session });
    const hooks = new HookRegistry();
    let endCalls = 0;
    hooks.register("subagent:end", async () => {
      endCalls++;
      if (endCalls === 1) return { action: "block" as const, feedback: "retry" };
      return "allow";
    });

    const result = await runAgent(ctx, "Explore", "go", {
      pi,
      hooks,
      agentId: "agent-recovered",
      maxEndHookRevisions: 1,
    });

    expect(session.prompt).toHaveBeenCalledTimes(2);
    expect(result.error).toBeUndefined();
    expect(result.responseText).not.toContain("model/provider error");
  });

  it("binds extensions before prompting", async () => {
    const { session } = createSession("BOUND");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say BOUND", { pi });

    expect(session.bindExtensions).toHaveBeenCalledTimes(1);
    expect(session.bindExtensions).toHaveBeenCalledWith(
      expect.objectContaining({ onError: expect.any(Function) }),
    );

    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0];
    const promptOrder = session.prompt.mock.invocationCallOrder[0];
    expect(bindOrder).toBeLessThan(promptOrder);
  });

  it("passes effective cwd and agentDir to the loader and settings manager", async () => {
    const { session } = createSession("CONFIGURED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say CONFIGURED", { pi, cwd: "/tmp/worktree" });

    expect(getAgentDir).toHaveBeenCalledTimes(1);
    expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/tmp/worktree",
      agentDir: "/mock/agent-dir",
    }));
    expect(settingsManagerCreate).toHaveBeenCalledWith("/tmp/worktree", "/mock/agent-dir");
    expect(sessionManagerInMemory).toHaveBeenCalledWith("/tmp/worktree");
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/tmp/worktree",
      agentDir: "/mock/agent-dir",
    }));
  });

  it("suppresses AGENTS.md/CLAUDE.md/APPEND_SYSTEM.md for subagents", async () => {
    const { session } = createSession("ISOLATED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say ISOLATED", { pi });

    // noContextFiles skips AGENTS.md/CLAUDE.md at the loader source;
    // appendSystemPromptOverride suppresses APPEND_SYSTEM.md (no flag equivalent).
    expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        noContextFiles: true,
        appendSystemPromptOverride: expect.any(Function),
      }),
    );
    // The override returns an empty list so any loaded sources are discarded.
    const ctorArgs = defaultResourceLoaderCtor.mock.calls[0][0];
    expect(ctorArgs.appendSystemPromptOverride(["would-be-loaded"])).toEqual([]);
  });

  it("resumeAgent also falls back to the final assistant message text", async () => {
    const { session } = createSession("RESUMED");

    const result = await resumeAgent(session, "Continue");

    expect(result).toBe("RESUMED");
  });

  it("sets the agent name as session name before binding extensions", async () => {
    const { session } = createSession("NAMED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(session.setSessionName).toHaveBeenCalledWith("Explore");
    const setOrder = session.setSessionName.mock.invocationCallOrder[0];
    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0];
    expect(setOrder).toBeLessThan(bindOrder);
  });

  it("suffixes the session name with a short agentId so parallel spawns are distinguishable", async () => {
    const { session } = createSession("NAMED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, agentId: "a1b2c3d4e5f6" });

    expect(session.setSessionName).toHaveBeenCalledWith("Explore#a1b2c3d4");
  });
});

// ─── message_end → onAssistantUsage wiring (issue #38) ─────────────────
// Both runAgent and resumeAgent dispatch usage to the caller via this
// callback. The callback feeds the AgentRecord lifetime accumulator, which
// is the source of truth for total tokens (survives compaction).
describe("agent-runner usage callback wiring", () => {
  function emitMessageEnd(listeners: Array<(e: any) => void>, usage: any) {
    const event = { type: "message_end", message: { role: "assistant", usage } };
    for (const l of listeners) l(event);
  }

  it("runAgent forwards full usage from message_end events", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const seen: Array<{ input: number; output: number; cacheWrite: number }> = [];
    session.prompt = vi.fn(async () => {
      // Two assistant messages over the run
      emitMessageEnd(listeners, { input: 100, output: 50, cacheWrite: 10 });
      emitMessageEnd(listeners, { input: 200, output: 80, cacheWrite: 20 });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", {
      pi,
      onAssistantUsage: (u) => seen.push(u),
    });

    expect(seen).toEqual([
      { input: 100, output: 50, cacheWrite: 10 },
      { input: 200, output: 80, cacheWrite: 20 },
    ]);
  });

  it("runAgent normalizes partial usage objects to 0 for missing fields", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const seen: any[] = [];
    session.prompt = vi.fn(async () => {
      emitMessageEnd(listeners, { input: 50 }); // output, cacheWrite missing
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", {
      pi,
      onAssistantUsage: (u) => seen.push(u),
    });

    expect(seen).toEqual([{ input: 50, output: 0, cacheWrite: 0 }]);
  });

  it("runAgent skips the callback when message_end has no usage field", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const cb = vi.fn();
    session.prompt = vi.fn(async () => {
      emitMessageEnd(listeners, undefined);
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", { pi, onAssistantUsage: cb });

    expect(cb).not.toHaveBeenCalled();
  });

  it("resumeAgent forwards usage on message_end the same way", async () => {
    const { session, listeners } = createSession("RESUMED");
    const seen: any[] = [];

    session.prompt = vi.fn(async () => {
      emitMessageEnd(listeners, { input: 10, output: 20, cacheWrite: 5 });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "RESUMED" }] });
    });

    await resumeAgent(session, "continue", {
      onAssistantUsage: (u) => seen.push(u),
    });

    expect(seen).toEqual([{ input: 10, output: 20, cacheWrite: 5 }]);
  });

  it("forwards every compaction_end to onCompaction (incl. aborted + after metrics)", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const seen: Array<Record<string, unknown>> = [];
    session.prompt = vi.fn(async () => {
      for (const l of listeners) l({
        type: "compaction_end",
        aborted: false,
        willRetry: false,
        reason: "threshold",
        result: {
          tokensBefore: 12345,
          estimatedTokensAfter: 4000,
          usage: { input: 10, output: 20, cacheWrite: 0 },
        },
      });
      for (const l of listeners) l({
        type: "compaction_end",
        aborted: true,
        willRetry: true,
        reason: "manual",
        errorMessage: "cancelled",
        result: { tokensBefore: 99999 },
      });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", {
      pi,
      onCompaction: (info) => seen.push(info),
    });

    expect(seen).toEqual([
      {
        reason: "threshold",
        tokensBefore: 12345,
        tokensAfter: 4000,
        reductionPercent: 68,
        usage: { input: 10, output: 20, cacheWrite: 0 },
        aborted: false,
        willRetry: false,
      },
      {
        reason: "manual",
        tokensBefore: 99999,
        aborted: true,
        willRetry: true,
        errorMessage: "cancelled",
      },
    ]);
  });

  it("dispatches compaction:start/{reason} and compaction:end/{reason,tokensBefore} hooks", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const hooks = new HookRegistry();
    const starts: unknown[] = [];
    const ends: unknown[] = [];
    hooks.register("compaction:start", async (payload) => {
      starts.push(payload.data);
      return "allow";
    });
    hooks.register("compaction:end", async (payload) => {
      ends.push(payload.data);
      return "allow";
    });

    session.prompt = vi.fn(async () => {
      for (const l of listeners) l({ type: "compaction_start", reason: "threshold" });
      for (const l of listeners) l({
        type: "compaction_end",
        aborted: false,
        reason: "threshold",
        result: { tokensBefore: 12345 },
      });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", {
      pi,
      agentId: "agent-compact",
      hooks,
    });

    await vi.waitFor(() => {
      expect(starts).toEqual([{ reason: "threshold" }]);
      expect(ends).toEqual([{
        reason: "threshold",
        tokensBefore: 12345,
        tokensAfter: undefined,
        reductionPercent: undefined,
        aborted: false,
        willRetry: undefined,
      }]);
    });
  });

  it("resumeAgent dispatches compaction hooks the same way as runAgent", async () => {
    const { session, listeners } = createSession("RESUMED");
    const hooks = new HookRegistry();
    const starts: unknown[] = [];
    const ends: unknown[] = [];
    hooks.register("compaction:start", async (payload) => {
      starts.push(payload.data);
      return "allow";
    });
    hooks.register("compaction:end", async (payload) => {
      ends.push(payload.data);
      return "allow";
    });

    session.prompt = vi.fn(async () => {
      for (const l of listeners) l({ type: "compaction_start", reason: "overflow" });
      for (const l of listeners) l({
        type: "compaction_end",
        aborted: false,
        reason: "overflow",
        result: { tokensBefore: 42 },
      });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "RESUMED" }] });
    });

    await resumeAgent(session, "continue", {
      agentId: "agent-resume",
      hooks,
    });

    await vi.waitFor(() => {
      expect(starts).toEqual([{ reason: "overflow" }]);
      expect(ends).toEqual([{
        reason: "overflow",
        tokensBefore: 42,
        tokensAfter: undefined,
        reductionPercent: undefined,
        aborted: false,
        willRetry: undefined,
      }]);
    });
  });
});


describe("getGraceTurns / setGraceTurns", () => {
  let originalTurns: number;
  beforeEach(() => {
    originalTurns = getGraceTurns();
  });
  afterEach(() => {
    setGraceTurns(originalTurns);
  });

  it("should get and set grace turns correctly", () => {
    setGraceTurns(10);
    expect(getGraceTurns()).toBe(10);

    setGraceTurns(2);
    expect(getGraceTurns()).toBe(2);
  });

  it("should enforce minimum of 1", () => {
    setGraceTurns(0);
    expect(getGraceTurns()).toBe(1);

    setGraceTurns(-5);
    expect(getGraceTurns()).toBe(1);
  });
});

describe("AgentRunnerError", () => {
  it("initializes correctly with message and code", () => {
    const error = new AgentRunnerError("test message", "timeout");
    expect(error.message).toBe("test message");
    expect(error.code).toBe("timeout");
    expect(error.name).toBe("AgentRunnerError");
    expect(error.context).toBeUndefined();
    expect(error).toBeInstanceOf(Error);
  });

  it("stores optional context", () => {
    const error = new AgentRunnerError("depth exceeded", "depth_exceeded", { level: 6 });
    expect(error.context).toEqual({ level: 6 });
  });
});

describe("duration quota (regression: must not crash the host)", () => {
  it("aborts gracefully with timedOut=true instead of throwing an uncaughtException", async () => {
    const { session, listeners } = createSession("partial");
    // Emit a turn_start event during prompt() so the duration subscriber runs.
    (session.prompt as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      for (const l of listeners) l({ type: "turn_start" } as AgentSessionEvent);
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "partial" }],
      } as AgentSession["messages"][number]);
    });
    createAgentSession.mockResolvedValue({ session });

    // maxDurationMs < 0 makes the quota always exceeded (any elapsedMs > -1),
    // so the very first event trips the check deterministically — no timers.
    const result = await runAgent(ctx, "Explore", "do work", {
      pi,
      quotas: { maxDurationMs: -1 },
    });

    // The critical regression assertion: no throw escapes runAgent. Instead the
    // run resolves with an explicit, inspectable abort outcome.
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(session.abort).toHaveBeenCalled();
  });

  it("does not abort when the duration quota has not been reached", async () => {
    const { session, listeners } = createSession("done");
    (session.prompt as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      for (const l of listeners) l({ type: "turn_start" } as AgentSessionEvent);
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      } as AgentSession["messages"][number]);
    });
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "do work", {
      pi,
      quotas: { maxDurationMs: 60_000 },
    });

    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(session.abort).not.toHaveBeenCalled();
    expect(result.responseText).toBe("done");
  });

  it("returns gracefully even when the quota abort makes session.prompt() reject", async () => {
    // Reproduces Greptile's finding: session.abort() rejects the active
    // prompt with an AbortError. runAgent must swallow that and still resolve
    // with { aborted, timedOut } instead of throwing.
    const { session, listeners } = createSession("");
    (session.prompt as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      for (const l of listeners) l({ type: "turn_start" } as AgentSessionEvent);
      // Simulate the host rejecting prompt() because we called abort().
      throw new DOMException("The user aborted a request", "AbortError");
    });
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "do work", {
      pi,
      quotas: { maxDurationMs: -1 },
    });

    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(session.abort).toHaveBeenCalled();
  });
});

describe("ModelCircuitBreaker", () => {
  it("resets consecutive failures to 0 on a successful call in closed state", async () => {
    // Reset/ensure closed state and 0 failures
    const state = globalCircuitBreaker.getState();
    if (state.state !== "closed" || state.failures !== 0) {
      await globalCircuitBreaker.call(() => Promise.resolve("setup"));
    }

    // Trigger one failure
    await expect(globalCircuitBreaker.call(() => Promise.reject(new Error("fail")))).rejects.toThrow("fail");
    expect(globalCircuitBreaker.getState().failures).toBe(1);

    // Trigger a success call
    const val = await globalCircuitBreaker.call(() => Promise.resolve("ok"));
    expect(val).toBe("ok");

    // Failures should be reset to 0
    expect(globalCircuitBreaker.getState().failures).toBe(0);
  });
});

describe("subagent:end revision gate", () => {
  afterEach(() => {
    setMaxEndHookRevisions(0);
  });

  it("awaits end hook and continues when allow", async () => {
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const hooks = new HookRegistry();
    const end = vi.fn(async () => "allow" as const);
    hooks.register("subagent:end", end);

    const result = await runAgent(ctx, "Explore", "go", { pi, hooks, agentId: "agent-end-1" });

    expect(end).toHaveBeenCalledTimes(1);
    expect(end.mock.calls[0][0].data).toEqual(
      expect.objectContaining({
        status: "completed",
        responseText: "OK",
        attempt: 1,
        maxAttempts: 1,
      }),
    );
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(result.responseText).toBe("OK");
  });

  it("fails closed on block when maxEndHookRevisions is 0", async () => {
    const { session } = createSession("DRAFT");
    createAgentSession.mockResolvedValue({ session });
    const hooks = new HookRegistry();
    hooks.register("subagent:end", async () => ({ action: "block", reason: "quality fail", feedback: "add tests" }));

    await expect(runAgent(ctx, "Explore", "go", { pi, hooks, agentId: "agent-end-2" })).rejects.toMatchObject({
      name: "AgentRunnerError",
      code: "aborted",
      message: "quality fail",
      context: expect.objectContaining({ hook: "subagent:end", feedback: "add tests" }),
    });
    expect(session.prompt).toHaveBeenCalledTimes(1);
  });

  it("treats NaN maxEndHookRevisions as fail-closed budget 0", async () => {
    const { session } = createSession("DRAFT");
    createAgentSession.mockResolvedValue({ session });
    const hooks = new HookRegistry();
    hooks.register("subagent:end", async () => "block");

    await expect(
      runAgent(ctx, "Explore", "go", {
        pi,
        hooks,
        agentId: "agent-end-nan",
        maxEndHookRevisions: Number.NaN,
      }),
    ).rejects.toMatchObject({
      name: "AgentRunnerError",
      code: "aborted",
      context: expect.objectContaining({ hook: "subagent:end", attempt: 1, maxAttempts: 1 }),
    });
    expect(session.prompt).toHaveBeenCalledTimes(1);
  });

  it("re-prompts once with feedback then allows", async () => {
    const { session } = createSession("DRAFT");
    createAgentSession.mockResolvedValue({ session });
    let call = 0;
    session.prompt = vi.fn(async (prompt: string) => {
      call++;
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: call === 1 ? "DRAFT" : "REVISED" }],
      });
      if (call === 2) expect(prompt).toContain("add tests");
    });

    const hooks = new HookRegistry();
    let endCalls = 0;
    hooks.register("subagent:end", async () => {
      endCalls++;
      if (endCalls === 1) return { action: "block" as const, feedback: "add tests" };
      return "allow";
    });

    const result = await runAgent(ctx, "Explore", "go", {
      pi,
      hooks,
      agentId: "agent-end-3",
      maxEndHookRevisions: 1,
    });

    expect(session.prompt).toHaveBeenCalledTimes(2);
    expect(endCalls).toBe(2);
    expect(result.responseText).toBe("REVISED");
  });

  it("stops after revision budget is exhausted", async () => {
    const { session } = createSession("DRAFT");
    createAgentSession.mockResolvedValue({ session });
    session.prompt = vi.fn(async () => {
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "still bad" }],
      });
    });

    const hooks = new HookRegistry();
    hooks.register("subagent:end", async () => "block");

    await expect(
      runAgent(ctx, "Explore", "go", { pi, hooks, agentId: "agent-end-4", maxEndHookRevisions: 1 }),
    ).rejects.toMatchObject({
      name: "AgentRunnerError",
      code: "aborted",
      context: expect.objectContaining({ hook: "subagent:end", attempt: 2, maxAttempts: 2 }),
    });
    expect(session.prompt).toHaveBeenCalledTimes(2);
  });

  it("get/setMaxEndHookRevisions clamps to 0..10", () => {
    setMaxEndHookRevisions(99);
    expect(getMaxEndHookRevisions()).toBe(10);
    setMaxEndHookRevisions(-3);
    expect(getMaxEndHookRevisions()).toBe(0);
    setMaxEndHookRevisions(2);
    expect(getMaxEndHookRevisions()).toBe(2);
    setMaxEndHookRevisions(0);
  });
});
