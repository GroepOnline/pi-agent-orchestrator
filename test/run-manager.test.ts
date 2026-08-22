import { describe, expect, it, vi } from "vitest";
import { buildMissionExecutionCorrelation } from "../src/orchestra-execution-contract.js";
import { RunManager } from "../src/run-manager.js";

describe("RunManager", () => {
  it("creates a focused run as a first-class execution object", () => {
    const manager = new RunManager({ idFactory: () => "run-1", now: () => 100 });
    const run = manager.create({ task: "Fix auth bug" });

    expect(run).toMatchObject({
      id: "run-1",
      task: "Fix auth bug",
      requestedStrategy: "focused",
      delivery: "automatic",
      status: "created",
      agentIds: [],
      steps: [],
      createdAt: 100,
    });
    expect(manager.history("run-1").map((event) => event.type)).toEqual(["run:created"]);
  });

  it("deduplicates the same mission execution attempt in-process by idempotency key", () => {
    let ids = 0;
    const manager = new RunManager({ idFactory: () => `run-${++ids}` });
    const correlation = buildMissionExecutionCorrelation({
      missionId: "m1",
      taskId: "feature-1",
      attemptId: "attempt-1",
    });

    const first = manager.create({ task: "Implement feature", correlation });
    const duplicateTransportDelivery = manager.create({ task: "Implement feature", correlation });

    expect(first.id).toBe("run-1");
    expect(duplicateTransportDelivery.id).toBe(first.id);
    expect(manager.list()).toHaveLength(1);
  });

  it("allows a deliberate new mission attempt to create a new run", () => {
    let ids = 0;
    const manager = new RunManager({ idFactory: () => `run-${++ids}` });

    const first = manager.create({
      task: "Implement feature",
      correlation: buildMissionExecutionCorrelation({ missionId: "m1", taskId: "f1", attemptId: "1" }),
    });
    const retry = manager.create({
      task: "Implement feature",
      correlation: buildMissionExecutionCorrelation({ missionId: "m1", taskId: "f1", attemptId: "2" }),
    });

    expect(retry.id).not.toBe(first.id);
    expect(manager.list()).toHaveLength(2);
  });

  it("requires Adaptive strategy resolution before start", () => {
    const manager = new RunManager({ idFactory: () => "run-adaptive" });
    const run = manager.create({ task: "Complex task", requestedStrategy: "adaptive" });

    expect(() => manager.start(run.id)).toThrow(/before strategy resolution/);

    manager.resolveStrategy(run.id, "workflow", [
      { code: "planning_required" },
      { code: "review_required" },
    ]);
    const started = manager.start(run.id);

    expect(started.status).toBe("running");
    expect(started.effectiveStrategy).toBe("workflow");
    expect(started.decisionReasons.map((reason) => reason.code)).toEqual([
      "planning_required",
      "review_required",
    ]);
  });

  it("enforces dependency ordering and unlocks downstream steps", () => {
    const manager = new RunManager({ idFactory: () => "run-workflow" });
    const run = manager.create({ task: "Plan build review", requestedStrategy: "workflow" });
    manager.start(run.id);

    manager.addStep(run.id, { id: "plan", title: "Plan", role: "planner" });
    manager.addStep(run.id, { id: "build", title: "Implement", role: "executor", dependsOn: ["plan"] });
    manager.addStep(run.id, { id: "review", title: "Review", role: "reviewer", dependsOn: ["build"] });

    expect(manager.get(run.id)!.steps.map((step) => [step.id, step.status])).toEqual([
      ["plan", "ready"],
      ["build", "waiting_dependency"],
      ["review", "waiting_dependency"],
    ]);
    expect(() => manager.startStep(run.id, "build")).toThrow(/dependencies complete/);

    manager.startStep(run.id, "plan");
    manager.completeStep(run.id, "plan", {
      result: "Plan ready",
      artifacts: [{ type: "note", title: "Plan", uri: "memory://plan" }],
    });

    expect(manager.get(run.id)!.steps.find((step) => step.id === "build")!.status).toBe("ready");
    manager.startStep(run.id, "build");
    manager.completeStep(run.id, "build", {
      result: "Implemented",
      artifacts: [{ type: "branch", title: "Implementation", uri: "git://feature/auth" }],
    });

    expect(manager.get(run.id)!.steps.find((step) => step.id === "review")!.status).toBe("ready");
  });

  it("tracks worker membership at run and step level without changing AgentManager", () => {
    const manager = new RunManager({ idFactory: () => "run-workers" });
    const run = manager.create({ task: "Research", requestedStrategy: "parallel" });
    manager.addStep(run.id, { id: "research", title: "Research" });

    manager.attachAgent(run.id, "agent-a", "research");
    manager.attachAgent(run.id, "agent-b", "research");
    manager.attachAgent(run.id, "agent-a", "research");

    const snapshot = manager.get(run.id)!;
    expect(snapshot.agentIds).toEqual(["agent-a", "agent-b"]);
    expect(snapshot.steps[0]!.agentIds).toEqual(["agent-a", "agent-b"]);
  });

  it("aggregates artifacts and usage on the run", () => {
    const manager = new RunManager({ idFactory: () => "run-usage" });
    const run = manager.create({ task: "Build" });
    manager.addStep(run.id, { id: "build", title: "Build" });
    manager.startStep(run.id, "build");
    manager.completeStep(run.id, "build", {
      artifacts: [{ type: "file", path: "src/auth.ts", title: "Auth" }],
    });
    manager.addUsage(run.id, { inputTokens: 100, outputTokens: 20, toolUses: 3, turns: 2 });
    manager.addUsage(run.id, { inputTokens: 50, outputTokens: 10 });
    const completed = manager.complete(run.id, { result: "done" });

    expect(completed.status).toBe("completed");
    expect(completed.artifacts).toEqual([
      expect.objectContaining({ type: "file", path: "src/auth.ts" }),
    ]);
    expect(completed.usage).toMatchObject({
      inputTokens: 150,
      outputTokens: 30,
      toolUses: 3,
      turns: 2,
    });
  });

  it("cancellation is idempotent, cancels active workers, and prevents waiting steps from starting", () => {
    const cancel = vi.fn();
    const manager = new RunManager({
      idFactory: () => "run-cancel",
      workerController: { cancel },
      now: (() => {
        let n = 1;
        return () => n++;
      })(),
    });
    const run = manager.create({ task: "Workflow", requestedStrategy: "workflow" });
    manager.addStep(run.id, { id: "plan", title: "Plan" });
    manager.addStep(run.id, { id: "build", title: "Build", dependsOn: ["plan"] });
    manager.attachAgent(run.id, "agent-plan", "plan");
    manager.startStep(run.id, "plan");

    const first = manager.cancel(run.id);
    const second = manager.cancel(run.id);

    expect(first.status).toBe("cancelled");
    expect(second.status).toBe("cancelled");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith("agent-plan");
    expect(manager.get(run.id)!.steps.map((step) => step.status)).toEqual(["cancelled", "cancelled"]);
    expect(() => manager.startStep(run.id, "build")).toThrow(/already terminal/);
    expect(manager.history(run.id).filter((event) => event.type === "run:cancelled")).toHaveLength(1);
  });

  it("returns snapshots so callers cannot mutate manager-owned state", () => {
    const manager = new RunManager({ idFactory: () => "run-snapshot" });
    const run = manager.create({ task: "Immutable view" });
    run.agentIds.push("fake-agent");
    run.decisionReasons.push({ code: "fake" });

    expect(manager.get(run.id)!.agentIds).toEqual([]);
    expect(manager.get(run.id)!.decisionReasons).toEqual([]);
  });
});
