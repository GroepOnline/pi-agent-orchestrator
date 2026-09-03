import { describe, expect, it } from "vitest";
import {
  analyzePrompt,
  buildCrewPlan,
  buildSwarmPlan,
  formatMidFanoutFailureReport,
  formatPartialFinalizationLabel,
  heuristicPickMode,
  resolveOrchestrationMode,
} from "../src/orchestration-dispatch.js";

describe("analyzePrompt", () => {
  it("returns zeros for an empty prompt", () => {
    const a = analyzePrompt("");
    expect(a.length).toBe(0);
    expect(a.estimatedSteps).toBe(0);
    expect(a.hasMultipleFiles).toBe(false);
    expect(a.hasReviewKeyword).toBe(false);
    expect(a.hasParallelKeyword).toBe(false);
    expect(a.hasPlanKeyword).toBe(false);
    expect(a.hasImplementKeyword).toBe(false);
    expect(a.hasRefactorKeyword).toBe(false);
    expect(a.hasTestKeyword).toBe(false);
  });

  it("detects the review keyword family", () => {
    for (const word of ["review", "audit", "validate", "verify", "inspect", "critique"]) {
      const a = analyzePrompt(`Please ${word} the implementation`);
      expect(a.hasReviewKeyword).toBe(true);
    }
  });

  it("detects the parallel keyword family", () => {
    for (const word of ["compare", "benchmark", "in parallel", "simultaneously", "at the same time"]) {
      const a = analyzePrompt(`Run ${word} on the candidates`);
      expect(a.hasParallelKeyword).toBe(true);
    }
  });

  it("detects the plan keyword family", () => {
    for (const word of ["plan", "design", "architect", "propose", "outline"]) {
      const a = analyzePrompt(`Please ${word} the refactor`);
      expect(a.hasPlanKeyword).toBe(true);
    }
  });

  it("detects the implement keyword family", () => {
    for (const word of ["implement", "build", "create", "write", "add", "develop"]) {
      const a = analyzePrompt(`Please ${word} the feature`);
      expect(a.hasImplementKeyword).toBe(true);
    }
  });

  it("detects the refactor + test keyword families", () => {
    expect(analyzePrompt("refactor the auth module").hasRefactorKeyword).toBe(true);
    expect(analyzePrompt("migrate to v2").hasRefactorKeyword).toBe(true);
    expect(analyzePrompt("add unit tests").hasTestKeyword).toBe(true);
    expect(analyzePrompt("improve coverage").hasTestKeyword).toBe(true);
  });

  it("counts numbered and bulleted steps", () => {
    const a = analyzePrompt("Steps:\n1. First\n2. Second\n3. Third");
    expect(a.estimatedSteps).toBe(3);

    const b = analyzePrompt("Tasks:\n- Alpha\n- Beta\n* Gamma");
    expect(b.estimatedSteps).toBe(3);
  });

  it("flags multiple-file prompts (>= 2 distinct paths)", () => {
    expect(analyzePrompt("Update ./src/a.ts and ./src/b.ts").hasMultipleFiles).toBe(true);
    expect(analyzePrompt("Touch /home/jan/x.ts and /home/jan/y.ts").hasMultipleFiles).toBe(true);
    expect(analyzePrompt("Just one file: ./src/a.ts").hasMultipleFiles).toBe(false);
    expect(analyzePrompt("No paths at all").hasMultipleFiles).toBe(false);
  });

  it("tracks prompt length", () => {
    const a = analyzePrompt("hello world");
    expect(a.length).toBe(11);
  });
});

describe("heuristicPickMode", () => {
  it("returns 'single' for trivial prompts", () => {
    const a = analyzePrompt("Fix the typo in README.md");
    expect(heuristicPickMode(a)).toBe("single");
  });

  it("returns 'single' for long prompts with no signals", () => {
    // Sanity guard: a long prompt (well past the 800-char multi-step
    // threshold) that trips NONE of the keyword families must still
    // resolve to single. The individual `hasXxxKeyword` flags are
    // covered by the analyzePrompt describe block above; here we just
    // verify the heuristic does not route noise-y long text into
    // a crew or swarm by accident.
    //
    // The wording is deliberately neutral — no "architecture/migration/
    // implement/refactor/plan/review/compare" tokens — so the only way
    // the heuristic can return anything but "single" here is via a
    // genuine bug.
    const a = analyzePrompt(
      "Please draft a detailed passage about the history of the team, " +
      "exploring how it matured through several pivots over the years " +
      "and what each turning point meant for the people involved. " +
      "Summarize the original goals, the constraints that shaped the " +
      "early tooling, the move to a new runtime in 2023, the recent " +
      "reliability drive that brought tail latency under budget, and " +
      "the schedule for the next quarter. Close with a forecast and " +
      "the major risks the team is watching as the on-call rotation " +
      "changes to follow the new SRE rotation that came online last " +
      "month and how the org chart was reshuffled over the summer to " +
      "bring reliability closer to the product crews before the Q3 " +
      "launch window and the holiday traffic spike this December.",
    );
    expect(a.length).toBeGreaterThan(700);
    expect(heuristicPickMode(a)).toBe("single");
  });

  it("returns 'crew' when planning keyword is present", () => {
    const a = analyzePrompt("Plan the migration to a new database");
    expect(heuristicPickMode(a)).toBe("crew");
  });

  it("returns 'crew' when review keyword is present", () => {
    const a = analyzePrompt("Review the security of the auth module");
    expect(heuristicPickMode(a)).toBe("crew");
  });

  it("returns 'crew' when multiple files are mentioned with implementation keyword", () => {
    // Path-pattern requires `./` or absolute prefix to avoid matching noise
    // like coordinate pairs ("x/y"). Use `./` and `/` prefixes here so
    // analyzePrompt's PATH_PATTERN picks them up.
    // Note: hasMultipleFiles alone does NOT trigger crew — it requires an
    // implementation signal (implement, build, create, write, add, develop).
    const a = analyzePrompt("Implement feature in ./src/a.ts and ./src/b.ts");
    expect(a.hasMultipleFiles).toBe(true);
    expect(a.hasImplementKeyword).toBe(true);
    expect(heuristicPickMode(a)).toBe("crew");
  });

  it("returns 'crew' for refactor + test combination", () => {
    const a = analyzePrompt("Refactor src/auth.ts and add tests");
    expect(heuristicPickMode(a)).toBe("crew");
  });

  it("returns 'swarm' for parallel keyword without planning keyword", () => {
    const a = analyzePrompt("Compare the performance of these three algorithms");
    expect(heuristicPickMode(a)).toBe("swarm");
  });

  it("returns 'crew' for long multi-step implementation prompts", () => {
    const filler =
      " Ensure the design covers the long tail of edge cases and matches existing " +
      "patterns. Keep the implementation minimal and reversible so the reviewer can " +
      "audit against the original spec. Update the API documentation and the inline " +
      "JSDoc so the new surface is discoverable from the IDE. Take care to preserve " +
      "backwards compatibility with the v3 consumers in the legacy-code package and " +
      "the migration shim that still ships to two production deployments this " +
      "quarter. The schema must remain stable across the rolling-restart window. " +
      "Cross-region replication safety is non-negotiable. The on-call SRE team " +
      "added a new failure-mode detector last week and we must keep it green. Make " +
      "sure the new design lands cleanly behind a feature flag so we can roll back " +
      "without restarting any consumer services. The dashboards must keep emitting " +
      "the existing metric names so the SLA report keeps working untouched. Please " +
      "double-check the migration script against the staging snapshot before " +
      "opening the PR so the reviewer can rely on a green build from the start.";
    const longPrompt =
      "Implement the new feature. Steps:\n" +
      "1. Design schema\n" +
      "2. Add migrations\n" +
      "3. Update API\n" +
      "4. Add tests\n" +
      "5. Update docs\n" +
      filler;
    const a = analyzePrompt(longPrompt);
    expect(a.length).toBeGreaterThan(800);
    expect(a.estimatedSteps).toBeGreaterThanOrEqual(3);
    expect(a.hasImplementKeyword).toBe(true);
    expect(heuristicPickMode(a)).toBe("crew");
  });

  it("returns 'single' for lone refactor keyword (no test, single file)", () => {
    const a = analyzePrompt("Refactor the auth module");
    expect(a.hasRefactorKeyword).toBe(true);
    expect(a.hasTestKeyword).toBe(false);
    expect(a.hasMultipleFiles).toBe(false);
    expect(heuristicPickMode(a)).toBe("single");
  });

  it("returns 'single' for short implement directive (no steps)", () => {
    const a = analyzePrompt("implement X");
    expect(a.hasImplementKeyword).toBe(true);
    expect(a.length).toBeLessThan(800);
    expect(heuristicPickMode(a)).toBe("single");
  });
});

describe("buildSwarmPlan", () => {
  it("returns N agents (default 2) with distinct descriptions", () => {
    const plan = buildSwarmPlan("do the work", "Run benchmark");
    expect(plan).toHaveLength(2);
    expect(plan[0].description).toContain("Run benchmark");
    expect(plan[0].description).toContain("1/2");
    expect(plan[1].description).toContain("2/2");
    for (const a of plan) {
      expect(a.prompt).toBe("do the work");
    }
  });

  it("clamps N to [2, 5]", () => {
    expect(buildSwarmPlan("p", "d", 0)).toHaveLength(2);
    expect(buildSwarmPlan("p", "d", 1)).toHaveLength(2);
    expect(buildSwarmPlan("p", "d", 99)).toHaveLength(5);
  });

  it("falls back to a generic description when input is empty", () => {
    const plan = buildSwarmPlan("p", "");
    expect(plan[0].description).toMatch(/Swarm member/);
  });
});

describe("buildCrewPlan", () => {
  it("returns exactly 3 role-specialized plans", () => {
    const plan = buildCrewPlan("add user auth", "Add auth", "general-purpose");
    expect(plan).toHaveLength(3);
    expect(plan.map((p) => p.role)).toEqual(["planner", "executor", "reviewer"]);
  });

  it("passes the user prompt through to the executor", () => {
    const plan = buildCrewPlan("specific user request", "d", "general-purpose");
    const executor = plan.find((p) => p.role === "executor")!;
    expect(executor.prompt).toContain("specific user request");
  });

  it("planner + reviewer both reference the user request", () => {
    const plan = buildCrewPlan("user request XYZ", "d", "general-purpose");
    const planner = plan.find((p) => p.role === "planner")!;
    const reviewer = plan.find((p) => p.role === "reviewer")!;
    expect(planner.prompt).toContain("user request XYZ");
    expect(reviewer.prompt).toContain("user request XYZ");
  });

  it("planner prompt does NOT contain file-edit instructions (planners don't edit)", () => {
    const plan = buildCrewPlan("d", "d", "general-purpose");
    const planner = plan.find((p) => p.role === "planner")!;
    expect(planner.prompt).toMatch(/Do NOT edit/i);
  });

  it("reviewer prompt asks for a PASS/FAIL verdict", () => {
    const plan = buildCrewPlan("d", "d", "general-purpose");
    const reviewer = plan.find((p) => p.role === "reviewer")!;
    expect(reviewer.prompt).toMatch(/Verdict: (PASS|FAIL)/);
  });

  it("shortens the description in role labels", () => {
    const plan = buildCrewPlan("p", "Add authentication flow", "general-purpose");
    expect(plan[0].description).toBe("Add authentication flow — plan");
    expect(plan[1].description).toBe("Add authentication flow — execute");
    expect(plan[2].description).toBe("Add authentication flow — review");
  });
});

describe("resolveOrchestrationMode", () => {
  it("returns single for explicit 'single' mode", () => {
    const d = resolveOrchestrationMode({
      mode: "single",
      prompt: "any prompt",
      description: "d",
      subagentType: "general-purpose",
      runInBackground: false,
    });
    expect(d.kind).toBe("single");
  });

  it("returns a swarm plan for explicit 'swarm' mode", () => {
    const d = resolveOrchestrationMode({
      mode: "swarm",
      prompt: "do work",
      description: "Run benchmark",
      subagentType: "general-purpose",
      runInBackground: true,
    });
    expect(d.kind).toBe("swarm");
    if (d.kind === "swarm") {
      expect(d.agents).toHaveLength(2);
      expect(d.joinMode).toBe("swarm");
    }
  });

  it("returns a crew plan for explicit 'crew' mode", () => {
    const d = resolveOrchestrationMode({
      mode: "crew",
      prompt: "do work",
      description: "d",
      subagentType: "general-purpose",
      runInBackground: false,
    });
    expect(d.kind).toBe("crew");
    if (d.kind === "crew") {
      expect(d.roles).toHaveLength(3);
      expect(d.joinMode).toBe("group");
    }
  });

  it("'auto' mode routes a planner-style prompt to crew", () => {
    const d = resolveOrchestrationMode({
      mode: "auto",
      prompt: "Plan the refactor of the auth module",
      description: "Auth refactor",
      subagentType: "general-purpose",
      runInBackground: false,
    });
    expect(d.kind).toBe("crew");
  });

  it("'auto' mode routes a parallel-style prompt to swarm", () => {
    const d = resolveOrchestrationMode({
      mode: "auto",
      prompt: "Compare these three implementations",
      description: "Comparison",
      subagentType: "general-purpose",
      runInBackground: true,
    });
    expect(d.kind).toBe("swarm");
  });

  it("'auto' mode routes a trivial prompt to single", () => {
    const d = resolveOrchestrationMode({
      mode: "auto",
      prompt: "Fix typo in README",
      description: "Typo",
      subagentType: "general-purpose",
      runInBackground: false,
    });
    expect(d.kind).toBe("single");
  });

  it("'auto' mode respects swarmSize override", () => {
    const d = resolveOrchestrationMode({
      mode: "swarm",
      prompt: "p",
      description: "d",
      subagentType: "general-purpose",
      runInBackground: true,
      swarmSize: 5,
    });
    expect(d.kind).toBe("swarm");
    if (d.kind === "swarm") {
      expect(d.agents).toHaveLength(5);
    }
  });
});

describe("formatMidFanoutFailureReport", () => {
  it("names the error, the spawned IDs, the spawned/total count and the missing count", () => {
    const report = formatMidFanoutFailureReport({
      error: new Error("Session agent limit reached (2/2)"),
      spawnedIds: ["agent-aaa", "agent-bbb"],
      totalMembers: 3,
    });
    // Pre-existing report shape (characterization): error first, then the
    // spawned/total line listing the IDs that DID spawn.
    expect(report).toContain("Orchestration dispatch failed mid-fanout: Session agent limit reached (2/2)");
    expect(report).toContain("Spawned 2/3 before failure: agent-aaa, agent-bbb");
    // R5: the report names the missing count explicitly, not just spawned/total.
    expect(report).toContain("Missing 1 member(s)");
    expect(report).toContain("cancelled");
  });

  it("keeps the pre-existing shape when nothing spawned and claims no cancellation", () => {
    const report = formatMidFanoutFailureReport({
      error: "boom",
      spawnedIds: [],
      totalMembers: 2,
    });
    expect(report).toContain("Orchestration dispatch failed mid-fanout: boom");
    expect(report).toContain("Spawned 0/2 before failure: ");
    expect(report).toContain("Missing 2 member(s).");
    expect(report).not.toContain("cancelled");
  });
});

describe("formatPartialFinalizationLabel", () => {
  it("names finished, spawned and missing counts with an explicit partial status", () => {
    expect(formatPartialFinalizationLabel(2, 2, 1)).toBe(
      "2 agent(s) finished (partial — 2 spawned, 1 missing: spawn failed mid-fanout)",
    );
  });

  it("supports the swarm noun", () => {
    expect(formatPartialFinalizationLabel(1, 1, 1, "swarm agent(s)")).toBe(
      "1 swarm agent(s) finished (partial — 1 spawned, 1 missing: spawn failed mid-fanout)",
    );
  });
});
