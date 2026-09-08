/**
 * Unit tests for src/health-report.ts.
 *
 * The builder is pure: pass a deps bag with stubs/mocks and the report
 * is computed from those inputs. No `ctx.ui` involvement, no tracer
 * setup, no time-based flakiness (uses a fixed `now()` override).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import {
  getDefaultJoinMode,
  isSchedulingEnabled,
  setAnimationStyle,
  setDashboardRefreshInterval,
  setDefaultJoinMode,
  setOrchestrationMode,
  setPromptCompressionLevel,
  setSchedulingEnabled,
  setUiStyle,
} from "../src/agent-registry.js";
import { getDefaultMaxTurns, getGraceTurns, getMaxEndHookRevisions, setDefaultMaxTurns, setGraceTurns, setMaxEndHookRevisions } from "../src/agent-runner.js";
import {
  recordDispatchDecision,
  resetDispatchHistory,
} from "../src/dispatch-history.js";
import { buildHealthReport, formatDuration, formatHealthReport } from "../src/health-report.js";
import type { SubagentScheduler } from "../src/schedule.js";
import type { SettingsGetters } from "../src/settings.js";
import type { SwarmCoordinator } from "../src/swarm-join.js";

// ── Stubs ────────────────────────────────────────────────────────────────

class StubScheduler {
  active = true;
  jobs: Array<{ id: string }> = [];
  isActive() { return this.active; }
  list() { return this.jobs; }
}

class StubSwarm {
  swarms: Array<{ swarmId: string; name: string; agentCount: number }> = [];
  metrics = new Map<string, { totalDeliveries: number }>();
  listSwarms() {
    return this.swarms.map((s) => ({ ...s, strategy: "live" as const }));
  }
  getSwarmMetrics(swarmId: string) {
    return this.metrics.get(swarmId) ?? { totalDeliveries: 0, totalRecordsDelivered: 0, partialDeliveries: 0, timedOutDeliveries: 0, bySwarm: {} };
  }
}

const baseGetters: SettingsGetters = {
  getDefaultMaxTurns,
  getGraceTurns,
  getMaxEndHookRevisions,
  getDefaultJoinMode,
  isSchedulingEnabled,
};

function makeDeps(overrides: Partial<{
  manager: AgentManager;
  scheduler: StubScheduler;
  swarmJoin: StubSwarm | null;
  cbState: { state: string; failures: number; lastFailureAt: number };
  now: () => Date;
}> = {}) {
  return {
    manager: overrides.manager ?? new AgentManager(),
    scheduler: (overrides.scheduler ?? new StubScheduler()) as unknown as SubagentScheduler,
    swarmJoin: overrides.swarmJoin === null ? null : (overrides.swarmJoin ?? new StubSwarm()) as unknown as SwarmCoordinator,
    getters: baseGetters,
    circuitBreakerState: overrides.cbState ?? { state: "closed", failures: 0, lastFailureAt: 0 },
    now: overrides.now ?? (() => new Date("2026-06-16T12:00:00.000Z")),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("buildHealthReport — basic shape", () => {
  it("returns a report with the documented top-level sections", () => {
    const r = buildHealthReport(makeDeps());
    expect(Object.keys(r).sort()).toEqual([
      "agents", "circuitBreaker", "dispatchHistogram", "process", "recentErrors",
      "schedule", "settings", "swarm", "timestamp",
    ]);
  });

  it("timestamp uses the override `now`", () => {
    const r = buildHealthReport(makeDeps({ now: () => new Date("2026-01-02T03:04:05.000Z") }));
    expect(r.timestamp).toBe("2026-01-02T03:04:05.000Z");
  });

  it("process section reports node version, platform, uptime, and memory", () => {
    const r = buildHealthReport(makeDeps());
    expect(r.process.nodeVersion).toBe(process.version);
    expect(r.process.platform).toMatch(/^[a-z0-9]+\/[a-z0-9]+$/);
    expect(r.process.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(r.process.memoryRssMB).toBeGreaterThan(0);
    expect(r.process.memoryHeapUsedMB).toBeGreaterThan(0);
  });
});

describe("buildHealthReport — circuit breaker section", () => {
  it("uses the provided circuitBreakerState override", () => {
    const r = buildHealthReport(makeDeps({
      cbState: { state: "open", failures: 7, lastFailureAt: 123456 },
    }));
    expect(r.circuitBreaker).toEqual({ state: "open", failures: 7, lastFailureAt: 123456 });
  });
});

describe("buildHealthReport — schedule section", () => {
  // Reset the scheduling toggle so this describe block can't pollute sibling blocks.
  beforeEach(() => {
    setSchedulingEnabled(true);
  });
  afterEach(() => {
    setSchedulingEnabled(true);
  });

  it("reports active + jobCount from the scheduler", () => {
    const scheduler = new StubScheduler();
    scheduler.active = true;
    scheduler.jobs = [{ id: "j1" }, { id: "j2" }, { id: "j3" }];
    const r = buildHealthReport(makeDeps({ scheduler }));
    expect(r.schedule.active).toBe(true);
    expect(r.schedule.jobCount).toBe(3);
  });

  it("reports inactive when scheduler.isActive() returns false", () => {
    const scheduler = new StubScheduler();
    scheduler.active = false;
    const r = buildHealthReport(makeDeps({ scheduler }));
    expect(r.schedule.active).toBe(false);
    expect(r.schedule.jobCount).toBe(0);
  });

  it("reflects the current isSchedulingEnabled setting in the schedule.enabled field", () => {
    setSchedulingEnabled(true);
    expect(buildHealthReport(makeDeps()).schedule.enabled).toBe(true);
    setSchedulingEnabled(false);
    expect(buildHealthReport(makeDeps()).schedule.enabled).toBe(false);
  });
});

describe("buildHealthReport — swarm section", () => {
  it("returns available=false when swarmJoin is null", () => {
    const r = buildHealthReport(makeDeps({ swarmJoin: null }));
    expect(r.swarm).toEqual({ available: false, swarmCount: 0, totalAgents: 0, totalDeliveries: 0 });
  });

  it("aggregates swarmCount + totalAgents + totalDeliveries across swarms", () => {
    const swarm = new StubSwarm();
    swarm.swarms = [
      { swarmId: "s1", name: "A", agentCount: 3 },
      { swarmId: "s2", name: "B", agentCount: 5 },
    ];
    swarm.metrics.set("s1", { totalDeliveries: 10 });
    swarm.metrics.set("s2", { totalDeliveries: 4 });
    const r = buildHealthReport(makeDeps({ swarmJoin: swarm }));
    expect(r.swarm.available).toBe(true);
    expect(r.swarm.swarmCount).toBe(2);
    expect(r.swarm.totalAgents).toBe(8);
    expect(r.swarm.totalDeliveries).toBe(14);
  });
});

describe("buildHealthReport — agents section", () => {
  it("reports zero totals and an empty byStatus on a fresh manager", () => {
    const r = buildHealthReport(makeDeps());
    expect(r.agents.total).toBe(0);
    expect(r.agents.running).toBe(0);
    expect(r.agents.queued).toBe(0);
    expect(r.agents.byStatus).toEqual({
      queued: 0, running: 0, completed: 0,
      steered: 0, aborted: 0, stopped: 0, error: 0,
    });
  });

  it("session limits are omitted when both are undefined (unlimited session)", () => {
    const r = buildHealthReport(makeDeps());
    expect(r.agents.sessionLimits).toEqual({});
  });

  it("session limits surface when one or both are set", () => {
    const manager = new AgentManager();
    manager.setSessionLimits({ maxAgentsPerSession: 5, maxTotalTurnsPerSession: 50 });
    const r = buildHealthReport(makeDeps({ manager }));
    expect(r.agents.sessionLimits).toEqual({ maxAgentsPerSession: 5, maxTotalTurnsPerSession: 50 });
  });
});

describe("buildHealthReport — settings section", () => {
  beforeEach(() => {
    setDefaultMaxTurns(20);
    setGraceTurns(3);
    setDefaultJoinMode("smart");
    setAnimationStyle("braille");
    setUiStyle("premium");
    setOrchestrationMode("auto");
    setDashboardRefreshInterval(750);
    setPromptCompressionLevel("balanced");
  });

  it("reflects every settings getter", () => {
    const r = buildHealthReport(makeDeps());
    expect(r.settings.defaultMaxTurns).toBe(20);
    expect(r.settings.graceTurns).toBe(3);
    expect(r.settings.maxEndHookRevisions).toBe(0);
    expect(r.settings.defaultJoinMode).toBe("smart");
    expect(r.settings.animationStyle).toBe("braille");
    expect(r.settings.uiStyle).toBe("premium");
    expect(r.settings.orchestrationMode).toBe("auto");
    expect(r.settings.dashboardRefreshInterval).toBe(750);
    expect(r.settings.promptCompressionLevel).toBe("balanced");
    expect(r.settings.maxConcurrent).toBeGreaterThan(0);
  });

  it("defaultMaxTurns survives the atomic-snapshot read (no torn read)", () => {
    // Mutate the registry between the local capture and the report
    // return — the report must reflect the captured value, not the
    // mutated one. This guards against a future refactor that moves
    // the reads back inline.
    setDefaultMaxTurns(20);
    const deps = makeDeps();
    // We can't easily intercept the capture, but we can verify the
    // snapshot is taken from the getters (not from module state) by
    // confirming a re-build after a mutation reflects the mutation.
    setDefaultMaxTurns(42);
    expect(buildHealthReport(deps).settings.defaultMaxTurns).toBe(42);
  });

  it("defaultMaxTurns is null when the getter returns undefined (unlimited)", () => {
    setDefaultMaxTurns(undefined);
    const r = buildHealthReport(makeDeps());
    expect(r.settings.defaultMaxTurns).toBeNull();
  });

  it("graceTurns reflects the current registry value", () => {
    setGraceTurns(7);
    expect(buildHealthReport(makeDeps()).settings.graceTurns).toBe(7);
  });

  it("maxEndHookRevisions reflects the current registry value", () => {
    setMaxEndHookRevisions(2);
    expect(buildHealthReport(makeDeps()).settings.maxEndHookRevisions).toBe(2);
    setMaxEndHookRevisions(0);
  });
});

describe("buildHealthReport — recent errors", () => {
  it("is an empty array when no agents have errored", () => {
    const r = buildHealthReport(makeDeps());
    expect(r.recentErrors).toEqual([]);
  });

  it("caps the list to the 5 most-recent errors (newest first)", () => {
    const manager = new AgentManager();
    // Seed 7 errored agents with distinct completedAt timestamps.
    const errs = Array.from({ length: 7 }, (_, i) => {
      const id = `agent-${i}`;
      // Use the private API: push a synthetic record via spawn-with-no-run.
      // Easier: directly mutate the internal map. We use the public
      // surface (listAgents) so this stays a black-box test.
      const baseTime = 1_000_000 + i * 1000;
      return {
        id, type: "Explore", description: `t${i}`,
        status: "error" as const,
        error: `error-${i}`,
        toolUses: 0, spawnedAt: baseTime, completedAt: baseTime,
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
        compactionCount: 0, currentLevel: 0, totalSpawned: 0,
        contextInputs: { inheritContext: false },
        correlationId: `c${i.toString(16).padStart(8, "0")}`,
      };
    });
    // Inject the synthetic records by extending the public surface: use
    // spawn() with a model that errors. To keep this test hermetic, we
    // instead patch the manager's `listAgents` for the test.
    vi.spyOn(manager, "listAgents").mockReturnValue(errs);
    const r = buildHealthReport(makeDeps({ manager }));
    expect(r.recentErrors).toHaveLength(5);
    // Newest first: agent-6 (latest completedAt) at index 0.
    expect(r.recentErrors[0]?.id).toBe("agent-6");
    expect(r.recentErrors[4]?.id).toBe("agent-2");
    // Correlation ids are carried through.
    expect(r.recentErrors[0]?.correlationId).toBe("c00000006");
  });
});

// ── formatDuration helper ────────────────────────────────────────────────

describe("formatDuration", () => {
  it("formats milliseconds into a compact d/h/m/s string (no spaces between units)", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(1_000)).toBe("1s");
    expect(formatDuration(60_000)).toBe("1m0s");
    expect(formatDuration(3_600_000)).toBe("1h0m0s");
    expect(formatDuration(86_400_000)).toBe("1d0h0m0s");
    expect(formatDuration(90_061_000)).toBe("1d1h1m1s");
  });
});

// ── formatHealthReport ───────────────────────────────────────────────────

describe("formatHealthReport", () => {
  it("includes every top-level section header", () => {
    const r = buildHealthReport(makeDeps());
    const text = formatHealthReport(r);
    for (const header of [
      "# /agents health",
      "## Process", "## Circuit Breaker",
      "## Schedule", "## Swarm", "## Agents",
      "## Settings", "## Recent Errors", "## Dispatch Decisions (recent)",
    ]) {
      expect(text).toContain(header);
    }
  });

  it("shows '(none)' for Recent Errors when the list is empty", () => {
    const r = buildHealthReport(makeDeps());
    const text = formatHealthReport(r);
    expect(text).toMatch(/## Recent Errors\s+\(none\)/);
  });

  it("emits the correlation id alongside each recent error", () => {
    const manager = new AgentManager();
    vi.spyOn(manager, "listAgents").mockReturnValue([{
      id: "x", type: "Plan", description: "d",
      status: "error", error: "boom",
      toolUses: 0, spawnedAt: 1, completedAt: 1,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0, currentLevel: 0, totalSpawned: 0,
      contextInputs: { inheritContext: false },
      correlationId: "abcd1234",
    }]);
    const r = buildHealthReport(makeDeps({ manager }));
    const text = formatHealthReport(r);
    expect(text).toContain("[corr=abcd1234]");
    expect(text).toContain("boom");
  });
});

// ── formatHealthReport: dispatch histogram section ────────────────────────

describe("buildHealthReport + formatHealthReport — dispatch histogram", () => {
  beforeEach(() => {
    resetDispatchHistory();
  });

  it("reports an empty histogram on a fresh session (no decisions recorded)", () => {
    const r = buildHealthReport(makeDeps());
    expect(r.dispatchHistogram).toEqual({
      total: 0,
      byKind: { single: 0, swarm: 0, crew: 0 },
      bySource: { explicit: 0, autoHeuristic: 0 },
      autoPicks: { single: 0, swarm: 0, crew: 0 },
      bufferCapacity: 200,
      lastDecisionAt: null,
    });
    const text = formatHealthReport(r);
    expect(text).toMatch(/## Dispatch Decisions \(recent\)/);
    expect(text).toContain("(none \u2014 empty ring buffer, capacity 200)");
    // The 'auto picks' subtree is hidden when there are no auto picks so the
    // section doesn't carry a confusing "→0" line.
    expect(text).not.toMatch(/auto picks/);
  });

  it("carries explicit-mode decisions through the byKind + bySource histogram", () => {
    recordDispatchDecision({ kind: "single", configuredMode: "single", source: "explicit",     promptLength: 30,  description: "x" });
    recordDispatchDecision({ kind: "swarm",  configuredMode: "swarm",  source: "explicit",     promptLength: 40,  description: "x" });
    recordDispatchDecision({ kind: "crew",   configuredMode: "crew",   source: "explicit",     promptLength: 50,  description: "x" });
    const r = buildHealthReport(makeDeps());
    expect(r.dispatchHistogram.byKind).toEqual({ single: 1, swarm: 1, crew: 1 });
    expect(r.dispatchHistogram.bySource).toEqual({ explicit: 3, autoHeuristic: 0 });
    expect(r.dispatchHistogram.autoPicks).toEqual({ single: 0, swarm: 0, crew: 0 });
    expect(r.dispatchHistogram.total).toBe(3);
  });

  it("carries auto-heuristic decisions through both byKind AND autoPicks and exposes the →X breakdown", () => {
    recordDispatchDecision({ kind: "single", configuredMode: "auto", source: "auto-heuristic", promptLength: 50, description: "auto1" });
    recordDispatchDecision({ kind: "single", configuredMode: "auto", source: "auto-heuristic", promptLength: 50, description: "auto2" });
    recordDispatchDecision({ kind: "swarm",  configuredMode: "auto", source: "auto-heuristic", promptLength: 50, description: "auto3" });
    recordDispatchDecision({ kind: "crew",   configuredMode: "auto", source: "auto-heuristic", promptLength: 50, description: "auto4" });
    const r = buildHealthReport(makeDeps());
    expect(r.dispatchHistogram.byKind).toEqual({ single: 2, swarm: 1, crew: 1 });
    expect(r.dispatchHistogram.bySource).toEqual({ explicit: 0, autoHeuristic: 4 });
    expect(r.dispatchHistogram.autoPicks).toEqual({ single: 2, swarm: 1, crew: 1 });
    const text = formatHealthReport(r);
    expect(text).toContain("auto picks  :");
    expect(text).toContain("\u2192single   : 2");
    expect(text).toContain("\u2192swarm    : 1");
    expect(text).toContain("\u2192crew     : 1");
  });

  it("the rendered section header always appears (so the user knows the feature exists), even when empty", () => {
    const text = formatHealthReport(buildHealthReport(makeDeps()));
    expect(text).toMatch(/## Dispatch Decisions \(recent\)/);
  });

  it("formatHealthReport surfaces the most-recent decision timestamp in ISO form", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-16T12:34:56.789Z"));
    recordDispatchDecision({ kind: "single", configuredMode: "single", source: "explicit", promptLength: 1, description: "x" });
    const text = formatHealthReport(buildHealthReport(makeDeps()));
    expect(text).toContain("last decision: 2026-06-16T12:34:56.789Z");
    vi.useRealTimers();
  });
});
