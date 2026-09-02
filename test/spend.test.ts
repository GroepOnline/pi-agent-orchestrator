import { describe, expect, it } from "vitest";
import {
  estimateCostUsd,
  formatSpend,
  sessionBudgetWarningMessage,
  spendBudgetWarningMessage,
  totalTokens,
  utilization,
  utilizationLabel,
} from "../src/spend.js";

describe("estimateCostUsd", () => {
  it("computes input+output at per-million rates", () => {
    const cost = { input: 1, output: 3 };
    // 100k input @ $1/Mtok = $0.10; 10k output @ $3/Mtok = $0.03
    expect(estimateCostUsd(cost, { input: 100_000, output: 10_000, cacheWrite: 0 })).toBeCloseTo(0.13);
  });

  it("includes cacheRead and cacheWrite when present", () => {
    const cost = { input: 0, output: 0, cacheRead: 0.5, cacheWrite: 2 };
    // 200k cacheRead @ $0.5/M = $0.10; 50k cacheWrite @ $2/M = $0.10
    expect(estimateCostUsd(cost, { input: 0, output: 0, cacheWrite: 50_000, cacheRead: 200_000 })).toBeCloseTo(0.20);
  });

  it("treats missing cost as free", () => {
    expect(estimateCostUsd(undefined, { input: 999, output: 999, cacheWrite: 999 })).toBe(0);
    expect(estimateCostUsd({}, { input: 999, output: 999, cacheWrite: 999 })).toBe(0);
  });
});

describe("formatSpend", () => {
  it("formats compact USD amounts", () => {
    expect(formatSpend(0)).toBe("$0.00");
    expect(formatSpend(-1)).toBe("$0.00");
    expect(formatSpend(0.004)).toBe("<$0.01");
    expect(formatSpend(1.234)).toBe("$1.23");
  });
});

describe("totalTokens", () => {
  it("sums input and output only", () => {
    expect(totalTokens({ input: 10, output: 5, cacheWrite: 100, cacheRead: 7 })).toBe(15);
  });
});

describe("utilization", () => {
  it("is never clamped above the cap: 30/25 is 120 (AE1)", () => {
    expect(utilization(30, 25)).toBe(120);
  });

  it("is exactly 100 at the cap", () => {
    expect(utilization(25, 25)).toBe(100);
  });

  it("equals floor(used / cap * 100) below the cap", () => {
    expect(utilization(20, 25)).toBe(80);
    expect(utilization(23, 25)).toBe(92);
    expect(utilization(1, 3)).toBe(33);
    expect(utilization(0, 25)).toBe(0);
  });

  it("renders spend thresholds (50/80/100% of a cap) through the same math", () => {
    expect(utilization(50, 100)).toBe(50);
    expect(utilization(80, 100)).toBe(80);
    expect(utilization(100, 100)).toBe(100);
  });

  it("degenerate caps yield 0 instead of Infinity/NaN", () => {
    expect(utilization(0, 0)).toBe(0);
    expect(utilization(30, 0)).toBe(0);
  });
});

describe("utilizationLabel", () => {
  it("renders the counter ratio from the same pair: 120% used (30/25), never 90%", () => {
    expect(utilizationLabel(30, 25)).toBe("120% used (30/25)");
  });

  it("renders 100% used at the cap", () => {
    expect(utilizationLabel(25, 25)).toBe("100% used (25/25)");
  });

  it("renders the floored ratio below the cap", () => {
    expect(utilizationLabel(20, 25)).toBe("80% used (20/25)");
  });
});

/**
 * Budget-warning message text (R3): EVERY threshold warning —
 * spend_50/spend_80/spend_100, agents_at_80/90, turns_at_80/90 — must name
 * an operator action: raise the limit, restart the session, or deny further
 * work. The percentage always comes from the same used/cap pair (R1).
 */
describe("budget warning messages (R3 action hints)", () => {
  it("every session warning names raise/restart/deny actions", () => {
    for (const critical of [false, true]) {
      for (const kind of ["agents", "turns"] as const) {
        const used = critical ? 18 : 8;
        const message = sessionBudgetWarningMessage({ kind, used, cap: 20, critical });
        expect(message).toMatch(/raise the limit/i);
        expect(message).toMatch(/restart/i);
        expect(message).toMatch(/deny further work/i);
      }
    }
  });

  it("renders the true counter ratio in the message (R1/AE1)", () => {
    expect(sessionBudgetWarningMessage({ kind: "turns", used: 30, cap: 25, critical: true }))
      .toContain("120% used (30/25)");
    expect(sessionBudgetWarningMessage({ kind: "agents", used: 25, cap: 25, critical: true }))
      .toContain("100% used (25/25)");
  });

  it("critical session warnings add the imminent-stop consequence", () => {
    expect(sessionBudgetWarningMessage({ kind: "agents", used: 9, cap: 10, critical: true }))
      .toContain("Spawns will stop soon");
    expect(sessionBudgetWarningMessage({ kind: "turns", used: 9, cap: 10, critical: true }))
      .toContain("Agents will stop soon");
  });

  it("every spend warning names raise/deny actions; at the cap it names the abort", () => {
    for (const thresholdPct of [50, 80, 100]) {
      const message = spendBudgetWarningMessage({
        thresholdPct,
        perAgentTokenLimit: 10_000,
        agentCount: 3,
      });
      expect(message).toMatch(/raise the per-agent token cap/i);
      expect(message).toMatch(/deny further/i);
    }
    expect(spendBudgetWarningMessage({ thresholdPct: 100, perAgentTokenLimit: 10_000, agentCount: 3 }))
      .toContain("aborts at the cap");
    expect(spendBudgetWarningMessage({ thresholdPct: 80, perAgentTokenLimit: 10_000, agentCount: 3 }))
      .toContain("80% used (3 agent(s) capped at 10000 tokens)");
  });
});
