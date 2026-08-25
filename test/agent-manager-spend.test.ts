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
});
