/**
 * Unit tests for src/ui/settings-snapshot.ts — `buildSettingsSnapshot(manager, getters)`.
 *
 * The function reads from three sources:
 *   1. `manager`            — maxConcurrent, session limits, session max spawns/turns
 *   2. `getters`            — default max turns, grace turns, join mode, scheduling, tracing
 *   3. `agent-registry`     — animation/ui/orchestration/refresh/compression (direct imports)
 *
 * The agent-registry reads are mocked at the module boundary so we can assert
 * the snapshot's values without polluting the global registry state.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DASHBOARD_KEYBINDINGS } from "../src/ui/dashboard-keybindings.js";
import { DEFAULT_FOOTER_STATUS_CONFIG } from "../src/ui/footer-status-config.js";

// Mock the agent-registry module BEFORE importing buildSettingsSnapshot so the
// module sees the mocked getters at evaluation time.
vi.mock("../src/agent-registry.js", () => ({
  getAnimationStyle: vi.fn(),
  getDashboardRefreshInterval: vi.fn(),
  getOrchestrationMode: vi.fn(),
  getPromptCompressionLevel: vi.fn(),
  getUiStyle: vi.fn(),
  isShowAgentTopWidget: vi.fn(() => true),
  getFooterStatusConfig: () => DEFAULT_FOOTER_STATUS_CONFIG,
  getDashboardKeybindings: () => DEFAULT_DASHBOARD_KEYBINDINGS,
}));

import type { AgentManager } from "../src/agent-manager.js";
import {
  getAnimationStyle,
  getDashboardRefreshInterval,
  getOrchestrationMode,
  getPromptCompressionLevel,
  getUiStyle,
} from "../src/agent-registry.js";
import type { SettingsGetters } from "../src/settings.js";
import { buildSettingsSnapshot } from "../src/ui/settings-snapshot.js";

/**
 * Minimal AgentManager surface that buildSettingsSnapshot exercises. Tests
 * pass objects of this type, then cast at the call site — the function only
 * calls these four methods, so the wider AgentManager surface is irrelevant.
 */
type SnapshotManager = Pick<
  AgentManager,
  "getMaxConcurrent" | "getSessionLimits" | "getSessionMaxSpawns" | "getSessionMaxTurns"
>;

/** Build a SettingsGetters object with all 5 fields controllable per test. */
function makeGetters(overrides: Partial<SettingsGetters> = {}): SettingsGetters {
  return {
    getDefaultMaxTurns: () => 25,
    getGraceTurns: () => 5,
    getMaxEndHookRevisions: () => 0,
    getDefaultJoinMode: () => "smart",
    isSchedulingEnabled: () => true,
    isTracingEnabled: () => true,
    ...overrides,
  };
}

/** Build a SnapshotManager with all 4 methods controllable per test. */
function makeManager(overrides: Partial<SnapshotManager> = {}): SnapshotManager {
  return {
    getMaxConcurrent: () => 4,
    getSessionLimits: () => ({}),
    getSessionMaxSpawns: () => 0,
    getSessionMaxTurns: () => 0,
    ...overrides,
  };
}

/** Cast helper: the function only calls the 4 methods on `SnapshotManager`. */
function asManager(m: SnapshotManager): AgentManager {
  return m as unknown as AgentManager;
}

const mockedGetAnimationStyle = vi.mocked(getAnimationStyle);
const mockedGetUiStyle = vi.mocked(getUiStyle);
const mockedGetOrchestrationMode = vi.mocked(getOrchestrationMode);
const mockedGetDashboardRefreshInterval = vi.mocked(getDashboardRefreshInterval);
const mockedGetPromptCompressionLevel = vi.mocked(getPromptCompressionLevel);

beforeEach(() => {
  mockedGetAnimationStyle.mockReturnValue("dots");
  mockedGetUiStyle.mockReturnValue("retro");
  mockedGetOrchestrationMode.mockReturnValue("swarm");
  mockedGetDashboardRefreshInterval.mockReturnValue(1500);
  mockedGetPromptCompressionLevel.mockReturnValue("aggressive");
});

// ── Manager-owned fields ────────────────────────────────────────────────

describe("buildSettingsSnapshot — manager-owned fields", () => {
  it("pulls maxConcurrent from the manager", () => {
    const snapshot = buildSettingsSnapshot(
      asManager(makeManager({ getMaxConcurrent: () => 8 })),
      makeGetters(),
    );
    expect(snapshot.maxConcurrent).toBe(8);
  });

  it("spreads getSessionLimits() into the snapshot (max agents + max turns)", () => {
    const snapshot = buildSettingsSnapshot(
      asManager(
        makeManager({
          getSessionLimits: () => ({ maxAgentsPerSession: 12, maxTotalTurnsPerSession: 80 }),
        }),
      ),
      makeGetters(),
    );
    expect(snapshot.maxAgentsPerSession).toBe(12);
    expect(snapshot.maxTotalTurnsPerSession).toBe(80);
  });

  it("propagates sessionMaxSpawns and sessionMaxTurns from the manager", () => {
    const snapshot = buildSettingsSnapshot(
      asManager(
        makeManager({
          getSessionMaxSpawns: () => 12,
          getSessionMaxTurns: () => 80,
        }),
      ),
      makeGetters(),
    );
    expect(snapshot.sessionMaxSpawns).toBe(12);
    expect(snapshot.sessionMaxTurns).toBe(80);
  });

  it("omits session-limit fields when getSessionLimits() returns {}", () => {
    const snapshot = buildSettingsSnapshot(asManager(makeManager()), makeGetters());
    expect(snapshot.maxAgentsPerSession).toBeUndefined();
    expect(snapshot.maxTotalTurnsPerSession).toBeUndefined();
  });

  it("propagates a partial session-limit object (only maxAgents)", () => {
    const snapshot = buildSettingsSnapshot(
      asManager(
        makeManager({
          getSessionLimits: () => ({ maxAgentsPerSession: 7 }),
        }),
      ),
      makeGetters(),
    );
    expect(snapshot.maxAgentsPerSession).toBe(7);
    expect(snapshot.maxTotalTurnsPerSession).toBeUndefined();
  });
});

// ── Getter-owned fields (the new SettingsGetters argument) ─────────────

describe("buildSettingsSnapshot — getter-owned fields", () => {
  it("pulls defaultMaxTurns, graceTurns, maxEndHookRevisions, and defaultJoinMode from the getters", () => {
    const snapshot = buildSettingsSnapshot(
      asManager(makeManager()),
      makeGetters({
        getDefaultMaxTurns: () => 50,
        getGraceTurns: () => 7,
        getMaxEndHookRevisions: () => 2,
        getDefaultJoinMode: () => "group",
      }),
    );
    expect(snapshot.defaultMaxTurns).toBe(50);
    expect(snapshot.graceTurns).toBe(7);
    expect(snapshot.maxEndHookRevisions).toBe(2);
    expect(snapshot.defaultJoinMode).toBe("group");
  });

  it("pulls schedulingEnabled and tracingEnabled from the getters (false case)", () => {
    const snapshot = buildSettingsSnapshot(
      asManager(makeManager()),
      makeGetters({
        isSchedulingEnabled: () => false,
        isTracingEnabled: () => false,
      }),
    );
    expect(snapshot.schedulingEnabled).toBe(false);
    expect(snapshot.tracingEnabled).toBe(false);
  });

  it("maps defaultMaxTurns: undefined to 0 (the unlimited marker)", () => {
    const snapshot = buildSettingsSnapshot(
      asManager(makeManager()),
      makeGetters({ getDefaultMaxTurns: () => undefined }),
    );
    expect(snapshot.defaultMaxTurns).toBe(0);
  });

  it("preserves defaultMaxTurns: 0 explicitly (0 means unlimited, not \"unset\")", () => {
    const snapshot = buildSettingsSnapshot(
      asManager(makeManager()),
      makeGetters({ getDefaultMaxTurns: () => 0 }),
    );
    expect(snapshot.defaultMaxTurns).toBe(0);
  });
});

// ── agent-registry fields (direct imports) ──────────────────────────────

describe("buildSettingsSnapshot — agent-registry fields", () => {
  it("pulls animationStyle, uiStyle, orchestrationMode from agent-registry", () => {
    mockedGetAnimationStyle.mockReturnValue("lines");
    mockedGetUiStyle.mockReturnValue("cinematic");
    mockedGetOrchestrationMode.mockReturnValue("crew");

    const snapshot = buildSettingsSnapshot(asManager(makeManager()), makeGetters());
    expect(snapshot.animationStyle).toBe("lines");
    expect(snapshot.uiStyle).toBe("cinematic");
    expect(snapshot.orchestrationMode).toBe("crew");
  });

  it("pulls dashboardRefreshInterval and promptCompressionLevel from agent-registry", () => {
    mockedGetDashboardRefreshInterval.mockReturnValue(2000);
    mockedGetPromptCompressionLevel.mockReturnValue("minimal");

    const snapshot = buildSettingsSnapshot(asManager(makeManager()), makeGetters());
    expect(snapshot.dashboardRefreshInterval).toBe(2000);
    expect(snapshot.promptCompressionLevel).toBe("minimal");
  });
});

// ── Call-count invariants ───────────────────────────────────────────────

describe("buildSettingsSnapshot — call-count invariants", () => {
  it("calls each manager method exactly once per snapshot (no double-reads)", () => {
    const spy: SnapshotManager = {
      getMaxConcurrent: vi.fn(() => 4),
      getSessionLimits: vi.fn(() => ({})),
      getSessionMaxSpawns: vi.fn(() => 0),
      getSessionMaxTurns: vi.fn(() => 0),
    };
    buildSettingsSnapshot(asManager(spy), makeGetters());
    expect(spy.getMaxConcurrent).toHaveBeenCalledTimes(1);
    expect(spy.getSessionLimits).toHaveBeenCalledTimes(1);
    expect(spy.getSessionMaxSpawns).toHaveBeenCalledTimes(1);
    expect(spy.getSessionMaxTurns).toHaveBeenCalledTimes(1);
  });

  it("calls each getter exactly once per snapshot (no double-reads)", () => {
    const spy: SettingsGetters = {
      getDefaultMaxTurns: vi.fn(() => 25),
      getGraceTurns: vi.fn(() => 5),
      getMaxEndHookRevisions: vi.fn(() => 0),
      getDefaultJoinMode: vi.fn(() => "smart"),
      isSchedulingEnabled: vi.fn(() => true),
      isTracingEnabled: vi.fn(() => true),
    };
    buildSettingsSnapshot(asManager(makeManager()), spy);
    expect(spy.getDefaultMaxTurns).toHaveBeenCalledTimes(1);
    expect(spy.getGraceTurns).toHaveBeenCalledTimes(1);
    expect(spy.getMaxEndHookRevisions).toHaveBeenCalledTimes(1);
    expect(spy.getDefaultJoinMode).toHaveBeenCalledTimes(1);
    expect(spy.isSchedulingEnabled).toHaveBeenCalledTimes(1);
    expect(spy.isTracingEnabled).toHaveBeenCalledTimes(1);
  });
});

// ── Shape ───────────────────────────────────────────────────────────────

describe("buildSettingsSnapshot — snapshot shape", () => {
  it("returns every key that the persistence layer reads from the snapshot", () => {
    const snapshot = buildSettingsSnapshot(asManager(makeManager()), makeGetters());
    // The keys that saveAndEmitChanged persists — anything missing here would
    // be silently dropped on save.
    const expectedKeys = [
      "maxConcurrent",
      "defaultMaxTurns",
      "graceTurns",
      "maxEndHookRevisions",
      "defaultJoinMode",
      "schedulingEnabled",
      "tracingEnabled",
      "animationStyle",
      "uiStyle",
      "orchestrationMode",
      "dashboardRefreshInterval",
      "sessionMaxSpawns",
      "sessionMaxTurns",
      "promptCompressionLevel",
      "showAgentTopWidget",
    ];
    for (const key of expectedKeys) {
      expect(snapshot).toHaveProperty(key);
    }
  });
});
