import { describe, expect, it, } from "vitest";
import type { BudgetWarningType } from "../src/agent-manager.js";
import { AgentManager } from "../src/agent-manager.js";

/**
 * Fire-once semantics for session budget warnings and the per-agent
 * spend thresholds (50/80/100% of the per-agent token cap).
 */

function makeRecord(id: string) {
  return {
    id,
    type: "Explore",
    description: "d",
    status: "running" as const,
    toolUses: 0,
    spawnedAt: Date.now(),
    startedAt: Date.now(),
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    currentLevel: 0,
    totalSpawned: 0,
    contextInputs: { inheritContext: false },
  };
}

describe("budget warning fire-once semantics", () => {
  it("fires a turn-budget warning exactly once even when called repeatedly", () => {
    const manager = new AgentManager();
    const seen: BudgetWarningType[] = [];
    manager.setBudgetWarningHandler((type) => seen.push(type));
    manager.setMaxConcurrent(4);
    manager.setSessionLimits({ maxTotalTurnsPerSession: 10 });

    // Simulate crossing the threshold by invoking the private path through
    // the public surface: resetSessionUsage clears flags (verified below).
    (manager as unknown as { sessionUsage: { totalTurns: number } }).sessionUsage.totalTurns = 9;
    (manager as unknown as { checkBudgetWarning: () => void }).checkBudgetWarning();
    (manager as unknown as { checkBudgetWarning: () => void }).checkBudgetWarning();
    (manager as unknown as { checkBudgetWarning: () => void }).checkBudgetWarning();

    expect(seen.filter((t) => t === "turns_at_90")).toHaveLength(1);

    // Reset clears the guard so a new session warns again.
    manager.resetSessionUsage();
    (manager as unknown as { sessionUsage: { totalTurns: number } }).sessionUsage.totalTurns = 9;
    (manager as unknown as { checkBudgetWarning: () => void }).checkBudgetWarning();
    expect(seen.filter((t) => t === "turns_at_90")).toHaveLength(2);
  });

  it("does not warn when limits are unset", () => {
    const manager = new AgentManager();
    const seen: BudgetWarningType[] = [];
    manager.setBudgetWarningHandler((type) => seen.push(type));
    (manager as unknown as { sessionUsage: { totalTurns: number } }).sessionUsage.totalTurns = 999_999;
    (manager as unknown as { checkBudgetWarning: () => void }).checkBudgetWarning();
    expect(seen).toEqual([]);
  });
});

describe("per-agent spend warnings", () => {
  it("fires once at each threshold (50/80/100) of the token cap", () => {
    const manager = new AgentManager();
    const seen: BudgetWarningType[] = [];
    manager.setBudgetWarningHandler((type) => seen.push(type));
    manager.setPerAgentTokenLimit(100);
    expect(manager.getPerAgentTokenLimit()).toBe(100);

    const record = makeRecord("a1");
    const check = (input: number, output: number) => {
      record.lifetimeUsage.input = input;
      record.lifetimeUsage.output = output;
      (manager as unknown as { checkAgentSpend: (r: typeof record) => void }).checkAgentSpend(record);
    };

    check(40, 10); // 50%
    expect(seen).toEqual(["spend_50"]);
    check(45, 34); // 79% — below next threshold, no new fire
    expect(seen).toEqual(["spend_50"]);
    check(60, 20); // 80%
    expect(seen).toEqual(["spend_50", "spend_80"]);
    check(70, 30); // 100%
    expect(seen).toEqual(["spend_50", "spend_80", "spend_100"]);
    check(90, 90); // beyond — no duplicates
    expect(seen).toEqual(["spend_50", "spend_80", "spend_100"]);
  });

  it("is inert without a cap (default off)", () => {
    const manager = new AgentManager();
    const seen: BudgetWarningType[] = [];
    manager.setBudgetWarningHandler((type) => seen.push(type));
    manager.setPerAgentTokenLimit(0);
    const record = makeRecord("a2");
    record.lifetimeUsage.input = 10_000_000;
    (manager as unknown as { checkAgentSpend: (r: typeof record) => void }).checkAgentSpend(record);
    expect(seen).toEqual([]);
  });

  it("clamps negative and fractional caps", () => {
    const manager = new AgentManager();
    manager.setPerAgentTokenLimit(-5);
    expect(manager.getPerAgentTokenLimit()).toBe(0);
    manager.setPerAgentTokenLimit(12.7);
    expect(manager.getPerAgentTokenLimit()).toBe(12);
  });

  it("applies a changed per-agent token cap at the next spend check (live-limit characterization)", () => {
    // R2: the per-agent spend cap is read live by every spend check
    // (agent-manager checkAgentSpend), so a mid-run change keeps applying to
    // the running agent at the next enforcement point — no notice needed.
    const manager = new AgentManager();
    const seen: BudgetWarningType[] = [];
    manager.setBudgetWarningHandler((type) => seen.push(type));
    manager.setPerAgentTokenLimit(100);
    const record = makeRecord("live-cap");
    const check = (input: number, output: number) => {
      record.lifetimeUsage.input = input;
      record.lifetimeUsage.output = output;
      (manager as unknown as { checkAgentSpend: (r: typeof record) => void }).checkAgentSpend(record);
    };

    check(45, 10); // 55% of 100 → spend_50
    expect(seen).toEqual(["spend_50"]);

    // Mid-run cap change: the NEXT check reads the new cap live. 55 of 60 is
    // ~92%, which crosses spend_80 only under the new cap — the old cap would
    // leave this usage at 55% (no new warning).
    manager.setPerAgentTokenLimit(60);
    check(50, 5);
    expect(seen).toEqual(["spend_50", "spend_80"]);
  });
});

/**
 * Threshold re-arm on limit change (R3): a changed session limit clears the
 * fired-threshold state for its own threshold family so a later crossing
 * warns again. Raising a limit never fires a warning by itself, and
 * re-applying an unchanged limit must not re-arm (the once-per-threshold
 * dedup stays intact).
 */
describe("threshold re-arm on limit change (R3)", () => {
  function makeCheckedManager() {
    const manager = new AgentManager();
    const seen: BudgetWarningType[] = [];
    manager.setBudgetWarningHandler((type) => seen.push(type));
    const usage = (manager as unknown as {
      sessionUsage: { spawnedAgents: number; totalTurns: number };
    }).sessionUsage;
    const check = () =>
      (manager as unknown as { checkBudgetWarning: () => void }).checkBudgetWarning();
    return { manager, seen, usage, check };
  }

  it("raising maxSpawns re-arms the agent thresholds and fires nothing by itself", () => {
    const { manager, seen, usage, check } = makeCheckedManager();
    manager.setSessionMaxSpawns(10);
    usage.spawnedAgents = 9; // 90% of 10
    check();
    expect(seen).toEqual(["agents_at_90"]);

    // The raise itself is silent even though the operator has not acted yet.
    manager.setSessionMaxSpawns(20);
    expect(seen).toEqual(["agents_at_90"]);

    // Re-cross 90% of the NEW cap (18/20): a fresh warning fires.
    usage.spawnedAgents = 18;
    check();
    expect(seen).toEqual(["agents_at_90", "agents_at_90"]);
  });

  it("raising maxTurns re-arms the turn thresholds and fires nothing by itself", () => {
    const { manager, seen, usage, check } = makeCheckedManager();
    manager.setSessionMaxTurns(10);
    usage.totalTurns = 9; // 90% of 10
    check();
    expect(seen).toEqual(["turns_at_90"]);

    manager.setSessionMaxTurns(20);
    expect(seen).toEqual(["turns_at_90"]);

    usage.totalTurns = 18; // 90% of the new cap
    check();
    expect(seen).toEqual(["turns_at_90", "turns_at_90"]);
  });

  it("raising one limit does not re-arm the other threshold family", () => {
    const { manager, seen, usage, check } = makeCheckedManager();
    manager.setSessionLimits({ maxAgentsPerSession: 10, maxTotalTurnsPerSession: 10 });
    usage.spawnedAgents = 9;
    usage.totalTurns = 9;
    check();
    expect(seen).toEqual(["agents_at_90", "turns_at_90"]);

    // Raise agents only: the turn threshold stays fired even though turn
    // usage remains above the line — no turn-limit change, no re-warn.
    manager.setSessionMaxSpawns(20);
    usage.spawnedAgents = 19; // re-cross 90% of the new agent cap
    check();
    expect(seen).toEqual(["agents_at_90", "turns_at_90", "agents_at_90"]);
  });

  it("setSessionLimits re-arms both threshold families when both limits change", () => {
    const { manager, seen, usage, check } = makeCheckedManager();
    manager.setSessionLimits({ maxAgentsPerSession: 10, maxTotalTurnsPerSession: 10 });
    usage.spawnedAgents = 9;
    usage.totalTurns = 9;
    check();
    expect(seen).toEqual(["agents_at_90", "turns_at_90"]);

    manager.setSessionLimits({ maxAgentsPerSession: 20, maxTotalTurnsPerSession: 20 });
    usage.spawnedAgents = 18;
    usage.totalTurns = 18;
    check();
    expect(seen).toEqual(["agents_at_90", "turns_at_90", "agents_at_90", "turns_at_90"]);
  });

  it("re-applying an unchanged limit does not re-arm (dedup stays intact)", () => {
    const { manager, seen, usage, check } = makeCheckedManager();
    manager.setSessionMaxSpawns(10);
    usage.spawnedAgents = 9;
    check();
    expect(seen).toEqual(["agents_at_90"]);

    // The settings menu resubmits both fields; an identical value must not
    // re-arm the threshold or the next turn-end would duplicate the warning.
    manager.setSessionLimits({ maxAgentsPerSession: 10, maxTotalTurnsPerSession: 10 });
    usage.totalTurns = 0;
    check();
    expect(seen).toEqual(["agents_at_90"]);
  });
});
