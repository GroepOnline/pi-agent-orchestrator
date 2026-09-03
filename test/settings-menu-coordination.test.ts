/**
 * Unit tests for the inline Coordination submenu.
 *
 * Exercises `showCoordinationMenu` (and its `notifyApplied` companion) end-to-end:
 *
 *   • Both pickers (JOIN + ORCH) are surfaced in a single `ctx.ui.select` call
 *     and every option carries the live `◀ current` marker.
 *   • Selecting a JOIN entry calls `setDefaultJoinMode` exactly once and routes
 *     the snapshot through `saveAndEmitChanged` (writes the project file +
 *     emits the `subagents:settings_changed` event).
 *   • Selecting an ORCH entry calls `setOrchestrationMode` exactly once and
 *     routes the snapshot through `saveAndEmitChanged` the same way.
 *   • Picking the same mode the user already had on triggers an info notification
 *     and does NOT call the setter or the persist path.
 *   • The picker re-reads the active modes after every accepted change so the
 *     `◀ current` marker reflects the most recent acceptance (proves the while
 *     loop isn't stuck on stale state).
 *   • Cancelling (returning an empty selection) exits the submenu without
 *     mutating field state or persisting anything.
 *
 * Mocks at the boundary (`@earendil-works/pi-coding-agent`, `agent-runner.js`,
 * `worktree.js`, `logger.js`, `hooks.js`, `custom-agents.js`, `output-file.js`)
 * keep the real `AgentManager`, `buildSettingsSnapshot`, `saveAndEmitChanged`,
 * `setDefaultJoinMode` and `getOrchestrationMode`/`setOrchestrationMode`
 * semantics — we want to verify the exact production path, not a mock of it.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai", () => ({}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: vi.fn(() => "/tmp/pi-coordination-test-agent-dir"),
  defineTool: <T>(tool: { name: string } & T) => tool,
}));
vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(async () => ""),
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
  normalizeMaxTurns: (n: number | undefined) => (n === 0 ? undefined : n),
  getDefaultMaxTurns: () => undefined,
}));
vi.mock("../src/worktree.js", () => ({}));
vi.mock("../src/logger.js", () => ({ logger: { warn: vi.fn() } }));
vi.mock("../src/hooks.js", () => ({ hookRegistry: { register: vi.fn() } }));
vi.mock("../src/custom-agents.js", () => ({ customAgents: new Map() }));
vi.mock("../src/output-file.js", () => ({}));

import type { AgentManager } from "../src/agent-manager.js";
import { getDefaultJoinMode, getOrchestrationMode, setDefaultJoinMode, setOrchestrationMode } from "../src/agent-registry.js";
import type { SettingsGetters, SettingsSetters } from "../src/settings.js";
import { showCoordinationMenu } from "../src/ui/settings-menu.js";

/**
 * Minimal AgentManager stub. `buildSettingsSnapshot` touches
 * getMaxConcurrent / getPerAgentTokenLimit / getSessionLimits / getSessionMaxSpawns / getSessionMaxTurns
 * so we stub the full snapshot-facing surface with neutral constants. Everything else the menu
 * reads from the manager is irrelevant to the coordination submenu.
 */
function fakeManager(): AgentManager {
  return {
    getMaxConcurrent: () => 8,
    getPerAgentTokenLimit: () => 0,
    getSessionLimits: () => ({ maxAgentsPerSession: undefined, maxTotalTurnsPerSession: undefined }),
    getSessionMaxSpawns: () => 100,
    getSessionMaxTurns: () => 1000,
    getGroupJoinMode: () => "smart",
  } as unknown as AgentManager;
}

/**
 * SettingsGetters/Setters pair: both sides read/write through the live registry
 * so the loop's `◀ current` re-render reflects the just-accepted change. The
 * fixture is intentionally a thin shim, not a static snapshot: a captured
 * `getDefaultJoinMode: () => "smart"` would silently disagree with the
 * setter-forwarded registry once any pick fires the `setDefaultJoinMode`
 * path, and the inner loop would skip the setter because `mode === curJoin`.
 */
function fakeAccessors(): {
  getters: SettingsGetters;
  setters: SettingsSetters;
} {
  return {
    getters: {
      getDefaultMaxTurns: () => 50,
      getGraceTurns: () => 3,
      getMaxEndHookRevisions: () => 0,
      getDefaultJoinMode: () => getDefaultJoinMode(),
      isSchedulingEnabled: () => true,
      isTracingEnabled: () => true,
    },
    setters: {
      setDefaultMaxTurns: vi.fn(),
      setGraceTurns: vi.fn(),
      setMaxEndHookRevisions: vi.fn(),
      setDefaultJoinMode: vi.fn((m) => setDefaultJoinMode(m)),
      setSchedulingEnabled: vi.fn(),
      setTracingEnabled: vi.fn(),
    },
  };
}

interface FakeCtx {
  ui: {
    select: ReturnType<typeof vi.fn>;
    input: ReturnType<typeof vi.fn>;
    notify: ReturnType<typeof vi.fn>;
    editor: ReturnType<typeof vi.fn>;
  };
}

function fakeCtx(plannedSelections: Array<string | undefined>): FakeCtx {
  const select = vi.fn(async () => plannedSelections.shift());
  const notify = vi.fn();
  return {
    ui: {
      select,
      // not used by coordination menu but referenced by other settings branches
      input: vi.fn(async () => undefined),
      notify,
      editor: vi.fn(async () => undefined),
    },
  };
}

interface FakePi {
  events: { emit: ReturnType<typeof vi.fn> };
}

function fakePi(): FakePi {
  return { events: { emit: vi.fn() } };
}

describe("showCoordinationMenu", () => {
  let projectDir: string;
  let originalAgentDirEnv: string | undefined;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "pi-coord-menu-"));
    originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = projectDir;
    // `saveSettings` / `saveAndEmitChanged` default `cwd` to `process.cwd()`,
    // and `notifyApplied` doesn't pass one through. Spy on process.cwd so the
    // leftover `.pi/subagents.json` ends up under our `projectDir` instead of
    // the developer's pwd.
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    setOrchestrationMode("auto");
    setDefaultJoinMode("smart");
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    if (originalAgentDirEnv == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("surfaces JOIN + ORCH pickers in one select with ◀ current markers on the initial state", async () => {
    const ctx = fakeCtx([]);
    const pi = fakePi();
    const { getters, setters } = fakeAccessors();

    await showCoordinationMenu(ctx as any, pi as any, fakeManager(), getters, setters);

    // First (and only) call is the combined picker — the user immediately
    // cancels with `undefined`, so the helper returns before re-rendering.
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
    const [firstPrompt, firstOptions] = ctx.ui.select.mock.calls[0];
    expect(firstPrompt).toBe("Coordination (join + orchestration mode)");
    expect(firstOptions).toContain(`JOIN: smart — auto-group 2+ agents in same turn (default) ◀ current`);
    expect(firstOptions).toContain(`ORCH: auto — heuristic fan-out; some prompts create 3 agents ◀ current`);
    // Non-current entries must NOT carry the marker.
    expect(firstOptions).toContain(`JOIN: async — always notify individually`);
    expect(firstOptions).not.toContain(`JOIN: async — always notify individually ◀ current`);
    expect(firstOptions).toContain(`ORCH: swarm — every tool call creates a collaborative multi-agent group`);
    expect(firstOptions).not.toContain(`ORCH: swarm — every tool call creates a collaborative multi-agent group ◀ current`);
    // No setter runs when the user cancels immediately.
    expect(setters.setDefaultJoinMode).not.toHaveBeenCalled();
  });

  it("calls setDefaultJoinMode once and persists when the user picks a different JOIN mode", async () => {
    setDefaultJoinMode("smart"); // ensure join snapshot defaultJoinMode picks up the change below
    const ctx = fakeCtx(["JOIN: group — always group background agents", undefined]);
    const pi = fakePi();
    const { getters, setters } = fakeAccessors();

    await showCoordinationMenu(ctx as any, pi as any, fakeManager(), getters, setters);

    expect(setters.setDefaultJoinMode).toHaveBeenCalledTimes(1);
    expect(setters.setDefaultJoinMode).toHaveBeenCalledWith("group");
    // setDefaultJoinMode is a registry setter — verify the registry actually flipped
    expect(getDefaultJoinMode()).toBe("group");
    // Persistence: saveAndEmitChanged runs buildSettingsSnapshot + writes the
    // project settings file. Verify via emit + on-disk file content.
    expect(pi.events.emit).toHaveBeenCalledWith(
      "subagents:settings_changed",
      expect.objectContaining({ persisted: true }),
    );
    const written = JSON.parse(readFileSync(join(projectDir, ".pi", "subagents.json"), "utf-8"));
    expect(written.defaultJoinMode).toBe("group");
    // User-facing toast confirms "Join mode set to group"
    expect(ctx.ui.notify).toHaveBeenCalledWith("Join mode set to group", "info");
  });

  it("calls setOrchestrationMode once and persists when the user picks a different ORCH mode", async () => {
    const ctx = fakeCtx(["ORCH: crew — every tool call creates planner/executor/reviewer agents", undefined]);
    const pi = fakePi();
    const { getters, setters } = fakeAccessors();

    await showCoordinationMenu(ctx as any, pi as any, fakeManager(), getters, setters);

    expect(getOrchestrationMode()).toBe("crew");
    expect(pi.events.emit).toHaveBeenCalledWith(
      "subagents:settings_changed",
      expect.objectContaining({ persisted: true }),
    );
    const written = JSON.parse(readFileSync(join(projectDir, ".pi", "subagents.json"), "utf-8"));
    expect(written.orchestrationMode).toBe("crew");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Orchestration mode set to crew", "info");
  });

  it("emits an info notification and skips the setter when the user picks the current JOIN mode", async () => {
    setDefaultJoinMode("smart");
    const ctx = fakeCtx(["JOIN: smart — auto-group 2+ agents in same turn (default) ◀ current", undefined]);
    const pi = fakePi();
    const { getters, setters } = fakeAccessors();

    await showCoordinationMenu(ctx as any, pi as any, fakeManager(), getters, setters);

    // No setter call, no persist, just an info toast — the loop continues and
    // the user can pick something else immediately.
    expect(setters.setDefaultJoinMode).not.toHaveBeenCalled();
    expect(pi.events.emit).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Join mode already smart.", "info");
  });

  it("emits an info notification and skips the setter when the user picks the current ORCH mode", async () => {
    setOrchestrationMode("auto");
    const ctx = fakeCtx(["ORCH: auto — heuristic fan-out; some prompts create 3 agents ◀ current", undefined]);
    const pi = fakePi();
    const { getters, setters } = fakeAccessors();

    await showCoordinationMenu(ctx as any, pi as any, fakeManager(), getters, setters);

    expect(getOrchestrationMode()).toBe("auto"); // unchanged
    expect(pi.events.emit).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Orchestration mode already auto.", "info");
  });

  it("re-reads the active modes on each loop iteration so ◀ current follows the latest accepted change", async () => {
    setDefaultJoinMode("smart");
    setOrchestrationMode("auto");
    // 1. user changes join: smart → group
    // 2. user re-renders → picks orch: auto → crew
    // 3. user cancels
    const ctx = fakeCtx([
      "JOIN: group — always group background agents",
      "ORCH: crew — every tool call creates planner/executor/reviewer agents",
      undefined,
    ]);
    const pi = fakePi();
    const { getters, setters } = fakeAccessors();

    await showCoordinationMenu(ctx as any, pi as any, fakeManager(), getters, setters);

    expect(ctx.ui.select).toHaveBeenCalledTimes(3);
    // The first picker render reflects initial state (smart+auto carry ◀ current).
    const firstOptions = ctx.ui.select.mock.calls[0][1] as string[];
    expect(firstOptions).toContain(`JOIN: smart — auto-group 2+ agents in same turn (default) ◀ current`);
    expect(firstOptions).toContain(`ORCH: auto — heuristic fan-out; some prompts create 3 agents ◀ current`);

    // The second picker render reflects post-join state: group is now current.
    const secondOptions = ctx.ui.select.mock.calls[1][1] as string[];
    expect(secondOptions).toContain(`JOIN: group — always group background agents ◀ current`);
    expect(secondOptions).not.toContain(`JOIN: smart — auto-group 2+ agents in same turn (default) ◀ current`);
    // ORCH still untouched on second render (auto is still ◀ current).
    expect(secondOptions).toContain(`ORCH: auto — heuristic fan-out; some prompts create 3 agents ◀ current`);

    expect(getDefaultJoinMode()).toBe("group");
    expect(getOrchestrationMode()).toBe("crew");
    // Two accepted changes → two emit + two persist calls + two info toasts.
    expect(pi.events.emit).toHaveBeenCalledTimes(2);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Join mode set to group", "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Orchestration mode set to crew", "info");
  });

  it("handles a cancel (no selection) on first pick without mutating state or persisting", async () => {
    setDefaultJoinMode("smart");
    setOrchestrationMode("auto");
    const ctx = fakeCtx([undefined]);
    const pi = fakePi();
    const { getters, setters } = fakeAccessors();

    await showCoordinationMenu(ctx as any, pi as any, fakeManager(), getters, setters);

    // Only one select call — the initial render was cancelled before any
    // option could be picked.
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
    expect(setters.setDefaultJoinMode).not.toHaveBeenCalled();
    expect(getOrchestrationMode()).toBe("auto");
    expect(pi.events.emit).not.toHaveBeenCalled();
  });

  it("accepts every documented JOIN mode (smart/async/group/swarm) and persists each", async () => {
    const pi = fakePi();
    const { getters, setters } = fakeAccessors();
    for (const mode of ["async", "group", "swarm", "smart"] as const) {
      // Reset to a non-target mode so the pick actually triggers the setter.
      setDefaultJoinMode(mode === "smart" ? "group" : "smart");
      const ctx = fakeCtx([`JOIN: ${mode} — (marker tests only)`, undefined]);
      await showCoordinationMenu(ctx as any, pi as any, fakeManager(), getters, setters);
      // The setter receives the picked mode.
      expect(setters.setDefaultJoinMode).toHaveBeenLastCalledWith(mode);
    }
  });

  it("accepts every documented ORCH mode (auto/single/swarm/crew) and persists each", async () => {
    const pi = fakePi();
    const { getters, setters } = fakeAccessors();
    for (const mode of ["auto", "single", "swarm", "crew"] as const) {
      setOrchestrationMode(mode === "auto" ? "crew" : "auto");
      const ctx = fakeCtx([`ORCH: ${mode} — (marker tests only)`, undefined]);
      await showCoordinationMenu(ctx as any, pi as any, fakeManager(), getters, setters);
      expect(getOrchestrationMode()).toBe(mode);
    }
  });
});
