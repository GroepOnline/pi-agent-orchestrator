import { describe, expect, it } from "vitest";
import {
  aggregateParallelOutcomes,
  buildParallelPlan,
  resolveExecutionStrategy,
} from "../src/execution-strategy.js";

describe("vNext execution strategy semantics", () => {
  it("keeps explicit Focused choice authoritative", () => {
    expect(resolveExecutionStrategy({
      requested: "focused",
      prompt: "compare and review everything",
    })).toEqual({
      requested: "focused",
      effective: "focused",
      reasons: [{ code: "explicit_strategy", detail: "focused" }],
      resolverVersion: 1,
    });
  });

  it("resolves Adaptive planning/review work to Workflow with reasons", () => {
    const decision = resolveExecutionStrategy({
      requested: "adaptive",
      prompt: "Design the architecture and review the migration plan",
    });

    expect(decision.effective).toBe("workflow");
    expect(decision.reasons.map((reason) => reason.code)).toEqual([
      "planning_required",
      "review_required",
    ]);
  });

  it("resolves Adaptive comparison to Parallel while preserving current same-task default", () => {
    const decision = resolveExecutionStrategy({
      requested: "adaptive",
      prompt: "Compare the two providers and benchmark latency",
    });

    expect(decision).toMatchObject({
      requested: "adaptive",
      effective: "parallel",
      reasons: [{ code: "comparison_requested" }],
      parallel: { variant: "same-task" },
      resolverVersion: 1,
    });
  });

  it("resolves narrow Adaptive work to Focused", () => {
    expect(resolveExecutionStrategy({
      requested: "adaptive",
      prompt: "Fix the typo in README.md",
    })).toMatchObject({
      effective: "focused",
      reasons: [{ code: "narrow_task" }],
    });
  });

  it("lets explicit Parallel select a variant", () => {
    expect(resolveExecutionStrategy({
      requested: "parallel",
      prompt: "Investigate incident",
      parallelVariant: "perspectives",
    })).toMatchObject({
      effective: "parallel",
      parallel: { variant: "perspectives" },
      reasons: [{ code: "explicit_strategy", detail: "parallel" }],
    });
  });
});

describe("Parallel plan variants", () => {
  it("same-task produces bounded independent attempts with identical prompts", () => {
    const members = buildParallelPlan({
      prompt: "Research the API",
      description: "API research",
      variant: "same-task",
      size: 3,
    });

    expect(members).toHaveLength(3);
    expect(members.map((member) => member.prompt)).toEqual([
      "Research the API",
      "Research the API",
      "Research the API",
    ]);
  });

  it("perspectives gives each worker explicit independent framing", () => {
    const members = buildParallelPlan({
      prompt: "Audit authentication",
      description: "Auth audit",
      variant: "perspectives",
      perspectives: ["security", "architecture", "testing"],
    });

    expect(members).toHaveLength(3);
    expect(members.map((member) => member.perspective)).toEqual([
      "security",
      "architecture",
      "testing",
    ]);
    expect(members[0]!.prompt).toContain("security perspective");
    expect(members[1]!.prompt).toContain("architecture perspective");
  });

  it("split requires explicit independent subtasks and assigns one per worker", () => {
    const members = buildParallelPlan({
      prompt: "Audit repository",
      description: "Repo audit",
      variant: "split",
      subtasks: ["Inspect CI", "Inspect runtime", "Inspect docs"],
    });

    expect(members).toHaveLength(3);
    expect(members[0]!.prompt).toContain("Inspect CI");
    expect(members[0]!.prompt).not.toContain("Inspect runtime");
    expect(members[2]!.prompt).toContain("Inspect docs");
  });

  it("rejects underspecified perspective/split plans", () => {
    expect(() => buildParallelPlan({
      prompt: "Audit",
      description: "Audit",
      variant: "perspectives",
      perspectives: ["security"],
    })).toThrow(/at least two/);

    expect(() => buildParallelPlan({
      prompt: "Audit",
      description: "Audit",
      variant: "split",
      subtasks: ["only one"],
    })).toThrow(/at least two/);
  });
});

describe("Parallel outcome aggregation", () => {
  it("preserves member order and surfaces partial success", () => {
    const outcome = aggregateParallelOutcomes([
      { id: "a", status: "completed", result: "A" },
      { id: "b", status: "failed", error: "boom" },
      { id: "c", status: "completed", result: "C" },
    ]);

    expect(outcome.status).toBe("partial");
    expect(outcome.members.map((member) => member.id)).toEqual(["a", "b", "c"]);
    expect(outcome).toMatchObject({
      completedCount: 2,
      failedCount: 1,
      cancelledCount: 0,
    });
  });

  it("distinguishes all-failed and all-cancelled outcomes", () => {
    expect(aggregateParallelOutcomes([
      { id: "a", status: "failed" },
      { id: "b", status: "failed" },
    ]).status).toBe("failed");

    expect(aggregateParallelOutcomes([
      { id: "a", status: "cancelled" },
      { id: "b", status: "cancelled" },
    ]).status).toBe("cancelled");
  });
});
