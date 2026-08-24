import { describe, expect, it, vi } from "vitest";
import { RunManager } from "../src/run-manager.js";
import {
  parseReviewVerdict,
  WorkflowRunner,
  type WorkflowWorkerAdapter,
  type WorkflowWorkerRequest,
  type WorkflowWorkerResult,
} from "../src/workflow-runner.js";

function createQueuedWorkers(results: WorkflowWorkerResult[]) {
  const requests: WorkflowWorkerRequest[] = [];
  const cancel = vi.fn(() => true);
  let next = 0;
  const adapter: WorkflowWorkerAdapter = {
    cancel,
    spawn(request) {
      requests.push(request);
      const index = next++;
      const result = results[index];
      if (!result) throw new Error(`No fake worker result for request ${index}`);
      return {
        agentId: `agent-${index + 1}`,
        result: Promise.resolve(result),
      };
    },
  };
  return { adapter, requests, cancel };
}

describe("WorkflowRunner generic dependency execution", () => {
  it("does not start a dependent worker until its dependency completed", async () => {
    const workers = createQueuedWorkers([
      { status: "completed", result: "plan result", artifacts: [{ type: "note", uri: "memory://plan" }] },
      { status: "completed", result: "build result" },
    ]);
    const runs = new RunManager({ idFactory: () => "run-dag" });
    const run = runs.create({ task: "Build feature", requestedStrategy: "workflow" });
    const runner = new WorkflowRunner(runs, workers.adapter);

    const result = await runner.run({
      runId: run.id,
      steps: [
        {
          id: "plan",
          title: "Plan",
          agentType: "Plan",
          buildPrompt: ({ task }) => `plan:${task}`,
        },
        {
          id: "build",
          title: "Build",
          agentType: "general-purpose",
          dependsOn: ["plan"],
          buildPrompt: ({ dependencies }) => `build:${dependencies[0]?.result}`,
        },
      ],
    });

    expect(result.status).toBe("completed");
    expect(workers.requests.map((request) => request.stepId)).toEqual(["plan", "build"]);
    expect(workers.requests[1]!.prompt).toContain("plan result");
    expect(workers.requests[1]!.dependencyOutputs[0]!.artifacts[0]!.uri).toBe("memory://plan");
  });
});

describe("Plan → Implement → Review workflow", () => {
  it("reviews the actual completed executor result and artifacts", async () => {
    const workers = createQueuedWorkers([
      {
        status: "completed",
        result: "Use src/auth.ts and add tests",
        artifacts: [{ type: "note", uri: "memory://plan", title: "Plan" }],
      },
      {
        status: "completed",
        result: "Implemented auth refactor",
        artifacts: [{ type: "file", path: "src/auth.ts", title: "Auth implementation" }],
      },
      {
        status: "completed",
        result: JSON.stringify({ verdict: "PASS", findings: [], summary: "Looks correct" }),
      },
    ]);
    const runs = new RunManager({ idFactory: () => "run-crew-replacement" });
    const run = runs.create({ task: "Refactor authentication", requestedStrategy: "workflow" });
    const runner = new WorkflowRunner(runs, workers.adapter);

    const result = await runner.runPlanImplementReview({
      runId: run.id,
      task: run.task,
      maxRevisions: 1,
    });

    expect(result.status).toBe("completed");
    expect(workers.requests.map((request) => request.stepId)).toEqual(["plan", "implement", "review-1"]);

    const implementRequest = workers.requests[1]!;
    expect(implementRequest.prompt).toContain("Use src/auth.ts and add tests");
    expect(implementRequest.prompt).toContain("memory://plan");

    const reviewRequest = workers.requests[2]!;
    expect(reviewRequest.prompt).toContain("Implemented auth refactor");
    expect(reviewRequest.prompt).toContain("src/auth.ts");
    expect(reviewRequest.dependencyOutputs[0]!.stepId).toBe("implement");
    expect(reviewRequest.dependencyOutputs[0]!.artifacts[0]!.path).toBe("src/auth.ts");
  });

  it("runs an explicit bounded revision and re-reviews the revised artifacts", async () => {
    const workers = createQueuedWorkers([
      { status: "completed", result: "Plan" },
      {
        status: "completed",
        result: "Initial implementation",
        artifacts: [{ type: "file", path: "src/auth.ts" }],
      },
      {
        status: "completed",
        result: JSON.stringify({ verdict: "FAIL", findings: ["Missing error test"] }),
      },
      {
        status: "completed",
        result: "Added error test",
        artifacts: [{ type: "file", path: "test/auth-error.test.ts" }],
      },
      {
        status: "completed",
        result: JSON.stringify({ verdict: "PASS", findings: [] }),
      },
    ]);
    const runs = new RunManager({ idFactory: () => "run-revision" });
    const run = runs.create({ task: "Implement auth safely", requestedStrategy: "workflow" });
    const runner = new WorkflowRunner(runs, workers.adapter);

    const result = await runner.runPlanImplementReview({
      runId: run.id,
      task: run.task,
      maxRevisions: 1,
    });

    expect(result.status).toBe("completed");
    expect(workers.requests.map((request) => request.stepId)).toEqual([
      "plan",
      "implement",
      "review-1",
      "revision-1",
      "review-2",
    ]);
    expect(workers.requests[3]!.prompt).toContain("Missing error test");
    expect(workers.requests[4]!.prompt).toContain("Added error test");
    expect(workers.requests[4]!.prompt).toContain("test/auth-error.test.ts");
  });

  it("fails after the configured revision budget is exhausted", async () => {
    const workers = createQueuedWorkers([
      { status: "completed", result: "Plan" },
      { status: "completed", result: "Implementation" },
      { status: "completed", result: "FAIL: still incorrect" },
    ]);
    const runs = new RunManager({ idFactory: () => "run-review-fail" });
    const run = runs.create({ task: "Implement", requestedStrategy: "workflow" });
    const runner = new WorkflowRunner(runs, workers.adapter);

    const result = await runner.runPlanImplementReview({
      runId: run.id,
      task: run.task,
      maxRevisions: 0,
    });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("workflow_review_failed");
  });

  it("cancels active work and prevents waiting workflow steps from starting", async () => {
    const requests: WorkflowWorkerRequest[] = [];
    const cancel = vi.fn(() => true);
    const adapter: WorkflowWorkerAdapter = {
      cancel,
      spawn(request) {
        requests.push(request);
        return {
          agentId: "agent-running-plan",
          result: new Promise<WorkflowWorkerResult>(() => {}),
        };
      },
    };
    const runs = new RunManager({ idFactory: () => "run-cancel-workflow" });
    const run = runs.create({ task: "Long workflow", requestedStrategy: "workflow" });
    const runner = new WorkflowRunner(runs, adapter);
    const controller = new AbortController();

    const pending = runner.runPlanImplementReview({
      runId: run.id,
      task: run.task,
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;

    expect(result.status).toBe("cancelled");
    expect(cancel).toHaveBeenCalledWith("agent-running-plan");
    expect(requests.map((request) => request.stepId)).toEqual(["plan"]);
    expect(result.steps.find((step) => step.id === "implement")!.status).toBe("cancelled");
    expect(result.steps.find((step) => step.id === "review-1")!.status).toBe("cancelled");
  });
});

describe("parseReviewVerdict", () => {
  it("parses fenced JSON and explicit text verdicts", () => {
    expect(parseReviewVerdict("```json\n{\"verdict\":\"PASS\",\"findings\":[]}\n```"))
      .toMatchObject({ verdict: "PASS", findings: [] });
    expect(parseReviewVerdict("FAIL: missing tests"))
      .toMatchObject({ verdict: "FAIL", findings: ["missing tests"] });
  });

  it("fails closed on an unparseable verdict", () => {
    expect(parseReviewVerdict("Looks mostly fine"))
      .toMatchObject({ verdict: "FAIL", summary: "Unparseable review verdict" });
  });
});

describe("WorkflowRunner failurePolicy continue", () => {
  it("skips a failed continue step and still completes the run", async () => {
    const workers = createQueuedWorkers([
      { status: "failed", error: { code: "worker_boom", message: "optional step failed", retryable: false } },
      { status: "completed", result: "downstream ok" },
    ]);
    const runs = new RunManager({ idFactory: () => "run-continue" });
    const run = runs.create({ task: "Optional then required", requestedStrategy: "workflow" });
    const runner = new WorkflowRunner(runs, workers.adapter);

    const result = await runner.run({
      runId: run.id,
      steps: [
        {
          id: "optional",
          title: "Optional",
          agentType: "general-purpose",
          failurePolicy: "continue",
          buildPrompt: ({ task }) => `optional:${task}`,
        },
        {
          id: "required",
          title: "Required",
          agentType: "general-purpose",
          dependsOn: ["optional"],
          buildPrompt: ({ dependencies }) => `required:${dependencies[0]?.stepId}`,
        },
      ],
    });

    expect(result.status).toBe("completed");
    expect(result.steps.find((step) => step.id === "optional")!.status).toBe("skipped");
    expect(result.steps.find((step) => step.id === "required")!.status).toBe("completed");
    expect(workers.requests.map((request) => request.stepId)).toEqual(["optional", "required"]);
  });
});
