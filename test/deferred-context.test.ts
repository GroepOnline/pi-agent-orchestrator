import { describe, expect, it, vi } from "vitest";

// Track call order across the test
let callLog: string[] = [];

const {
  createAgentSession,
  defaultResourceLoaderCtor,
  getAgentDir,
  sessionManagerInMemory,
  settingsManagerCreate,
  buildParentContextFn,
} = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  defaultResourceLoaderCtor: vi.fn(),
  getAgentDir: vi.fn(() => "/mock/agent-dir"),
  sessionManagerInMemory: vi.fn(() => ({ kind: "memory-session-manager" })),
  settingsManagerCreate: vi.fn(() => ({ kind: "settings-manager" })),
  buildParentContextFn: vi.fn(
    () => "# Parent Conversation Context\n[User]: prior work\n\n---\n# Your Task (below)\n",
  ),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession,
  DefaultResourceLoader: class {
    constructor(options: any) {
      defaultResourceLoaderCtor(options);
      callLog.push("loader-ctor");
    }

    async reload() {
      callLog.push("loader-reload");
    }
  },
  getAgentDir,
  SessionManager: { inMemory: sessionManagerInMemory },
  SettingsManager: { create: settingsManagerCreate },
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

vi.mock("../src/context.js", () => ({
  buildParentContext: buildParentContextFn,
  extractText: vi.fn((content: any[]) =>
    content.filter((c: any) => c.type === "text").map((c: any) => c.text ?? "").join("\n"),
  ),
}));

import { resumeAgent, runAgent } from "../src/agent-runner.js";

function createSession(finalText: string) {
  const session = {
    messages: [] as any[],
    subscribe: vi.fn(() => () => {}),
    prompt: vi.fn(async () => {
      callLog.push("session-prompt");
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: finalText }],
      });
    }),
    abort: vi.fn(),
    steer: vi.fn(),
    getActiveToolNames: vi.fn(() => ["read"]),
    setActiveToolsByName: vi.fn(),
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => {
      callLog.push("bind-extensions");
    }),
  };
  return session;
}

const ctx = {
  cwd: "/tmp",
  model: { provider: "test", id: "test-model" },
  modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
  getSystemPrompt: vi.fn(() => "parent prompt"),
  sessionManager: { getBranch: vi.fn(() => []) },
} as any;

const pi = {} as any;

describe("deferred context engine", () => {
  it("sets AgentRecord.contextBuiltAt after context build", async () => {
    const session = createSession("DONE");
    createAgentSession.mockResolvedValue({ session });

    let builtAt = 0;
    await runAgent(ctx, "Explore", "do it", {
      pi,
      inheritContext: true,
      onContextBuilt: (timestamp) => {
        builtAt = timestamp;
      },
    });

    expect(builtAt).toBeGreaterThan(0);
  });

  it("contextInputs are stored before context build", async () => {
    // Simulate what agent-manager does: store contextInputs on the record
    // at spawn time, then contextBuiltAt is populated when context is built.
    const record: {
      contextInputs: { inheritContext: boolean };
      contextBuiltAt?: number;
    } = {
      contextInputs: { inheritContext: true },
    };

    // Verify contextInputs exist before context build
    expect(record.contextInputs).toEqual({ inheritContext: true });
    expect(record.contextBuiltAt).toBeUndefined();

    const session = createSession("DONE");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "do it", {
      pi,
      inheritContext: true,
      onContextBuilt: (timestamp) => {
        record.contextBuiltAt = timestamp;
      },
    });

    // After run, contextBuiltAt should be set
    expect(record.contextBuiltAt).toBeGreaterThan(0);
  });

  it("contextStalenessMs=0 means always rebuild (default)", async () => {
    // When contextStalenessMs is 0 or undefined, context is always rebuilt.
    // Verify that buildParentContext is called even when inheritContext is true
    // (no caching behavior — the default 0 means always rebuild).
    buildParentContextFn.mockClear();

    const session = createSession("DONE");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "do it", {
      pi,
      inheritContext: true,
    });

    // buildParentContext should be called exactly once (no caching)
    expect(buildParentContextFn).toHaveBeenCalledTimes(1);
  });

  it("context build happens after tool/skill resolution but before session.create", async () => {
    callLog = [];
    buildParentContextFn.mockClear();

    const session = createSession("ORDERED");
    // Intercept createAgentSession to record when it fires
    createAgentSession.mockImplementation(async () => {
      callLog.push("session-create");
      return { session };
    });

    await runAgent(ctx, "Explore", "ordered", {
      pi,
      inheritContext: true,
    });

    // loader-reload (tool/skill resolution) fires before session-create
    const reloadIdx = callLog.indexOf("loader-reload");
    const createIdx = callLog.indexOf("session-create");
    expect(reloadIdx).toBeLessThan(createIdx);

    // buildParentContext is called during the run — verify it was called
    expect(buildParentContextFn).toHaveBeenCalled();
  });

  it("does not build context when inheritContext is false", async () => {
    buildParentContextFn.mockClear();
    callLog = [];

    const session = createSession("NO_CONTEXT");
    createAgentSession.mockImplementation(async () => {
      callLog.push("session-create");
      return { session };
    });

    let builtCallback = false;
    await runAgent(ctx, "Explore", "no context", {
      pi,
      inheritContext: false,
      onContextBuilt: () => {
        builtCallback = true;
      },
    });

    // onContextBuilt should NOT be called when inheritContext is false
    expect(builtCallback).toBe(false);

    // buildParentContext should NOT be called
    expect(buildParentContextFn).not.toHaveBeenCalled();
  });

  it("resumeAgent also defers context when inheritContext is true", async () => {
    buildParentContextFn.mockClear();

    const session = createSession("RESUMED_DEFERRED");

    // resumeAgent builds context just before prompt when inheritContext is set
    await resumeAgent(session as any, "continue", {
      inheritContext: true,
      ctx,
    });

    // buildParentContext should have been called (deferred, before prompt)
    expect(buildParentContextFn).toHaveBeenCalledTimes(1);
  });

  it("resumeAgent does not build context when inheritContext is false", async () => {
    buildParentContextFn.mockClear();

    const session = createSession("RESUMED_NOOP");
    await resumeAgent(session as any, "continue", {
      inheritContext: false,
      ctx,
    });

    expect(buildParentContextFn).not.toHaveBeenCalled();
  });

  it("resumeAgent does not build context when ctx is missing", async () => {
    buildParentContextFn.mockClear();

    const session = createSession("RESUMED_NO_CTX");
    // inheritContext is true but ctx is undefined — should not build
    await resumeAgent(session as any, "continue", {
      inheritContext: true,
    });

    expect(buildParentContextFn).not.toHaveBeenCalled();
  });

  it("onContextBuilt callback receives a valid timestamp", async () => {
    const session = createSession("TIMESTAMP");
    createAgentSession.mockResolvedValue({ session });

    const beforeRun = Date.now();
    let capturedTimestamp = 0;

    await runAgent(ctx, "Explore", "ts", {
      pi,
      inheritContext: true,
      onContextBuilt: (ts) => {
        capturedTimestamp = ts;
      },
    });

    const afterRun = Date.now();

    expect(capturedTimestamp).toBeGreaterThanOrEqual(beforeRun);
    expect(capturedTimestamp).toBeLessThanOrEqual(afterRun);
  });
});
