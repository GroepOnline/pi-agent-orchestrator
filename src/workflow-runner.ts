import type {
  OrchestraArtifactReference,
  OrchestraExecutionError,
} from "./orchestra-execution-contract.js";
import { RunManager } from "./run-manager.js";
import type { OrchestraRun, RunStep } from "./run-types.js";

export type WorkflowFailurePolicy = "fail-run" | "continue";

export interface WorkflowDependencyOutput {
  stepId: string;
  result?: string;
  artifacts: OrchestraArtifactReference[];
}

export interface WorkflowStepContext {
  runId: string;
  task: string;
  dependencies: WorkflowDependencyOutput[];
}

export interface WorkflowStepDefinition {
  id: string;
  title: string;
  role?: string;
  agentType: string;
  dependsOn?: readonly string[];
  failurePolicy?: WorkflowFailurePolicy;
  buildPrompt(context: WorkflowStepContext): string;
}

export interface WorkflowWorkerRequest {
  runId: string;
  stepId: string;
  role?: string;
  agentType: string;
  prompt: string;
  dependencyOutputs: WorkflowDependencyOutput[];
}

export type WorkflowWorkerStatus = "completed" | "failed" | "cancelled";

export interface WorkflowWorkerResult {
  status: WorkflowWorkerStatus;
  result?: string;
  artifacts?: readonly OrchestraArtifactReference[];
  error?: OrchestraExecutionError;
}

export interface WorkflowWorkerHandle {
  agentId: string;
  result: Promise<WorkflowWorkerResult>;
}

export interface WorkflowWorkerAdapter {
  spawn(request: WorkflowWorkerRequest): WorkflowWorkerHandle;
  cancel(agentId: string): boolean | undefined;
}

export interface RunWorkflowInput {
  runId: string;
  steps: readonly WorkflowStepDefinition[];
  signal?: AbortSignal;
  finalResultStepId?: string;
}

export interface PlanImplementReviewProfiles {
  planner?: string;
  executor?: string;
  reviewer?: string;
}

export interface PlanImplementReviewInput {
  runId: string;
  task: string;
  signal?: AbortSignal;
  profiles?: PlanImplementReviewProfiles;
  /** Number of implementation revisions allowed after a FAIL verdict. */
  maxRevisions?: number;
}

export interface ReviewVerdict {
  verdict: "PASS" | "FAIL";
  findings: string[];
  summary?: string;
}

function copyArtifact(artifact: OrchestraArtifactReference): OrchestraArtifactReference {
  return {
    ...artifact,
    metadata: artifact.metadata ? { ...artifact.metadata } : undefined,
  };
}

function stepOutput(step: RunStep): WorkflowDependencyOutput {
  return {
    stepId: step.id,
    result: step.result,
    artifacts: step.artifacts.map(copyArtifact),
  };
}

function formatArtifacts(artifacts: readonly OrchestraArtifactReference[]): string {
  if (artifacts.length === 0) return "(none)";
  return artifacts
    .map((artifact) => {
      const locator = artifact.path ?? artifact.uri ?? artifact.id ?? "unlocated";
      return `- ${artifact.type}: ${artifact.title ?? locator} (${locator})`;
    })
    .join("\n");
}

function formatDependencyOutput(output: WorkflowDependencyOutput): string {
  return [
    `### ${output.stepId}`,
    output.result?.trim() || "(no textual result)",
    "Artifacts:",
    formatArtifacts(output.artifacts),
  ].join("\n");
}

function abortError(): Error {
  const error = new Error("Workflow execution aborted");
  error.name = "AbortError";
  return error;
}

async function waitForWorkerResult(
  promise: Promise<WorkflowWorkerResult>,
  signal: AbortSignal | undefined,
  onAbort: () => void,
): Promise<WorkflowWorkerResult> {
  if (!signal) return promise;
  if (signal.aborted) {
    onAbort();
    throw abortError();
  }

  let cleanup = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const handler = () => {
      onAbort();
      reject(abortError());
    };
    signal.addEventListener("abort", handler, { once: true });
    cleanup = () => signal.removeEventListener("abort", handler);
  });

  try {
    return await Promise.race([promise, aborted]);
  } finally {
    cleanup();
  }
}

/**
 * Execution-local dependency runner. It delegates worker execution through a
 * narrow adapter and uses RunManager as the canonical state/timeline source.
 */
export class WorkflowRunner {
  private readonly activeAgentsByRun = new Map<string, Set<string>>();
  private readonly dynamicDefinitions = new Map<string, Map<string, WorkflowStepDefinition>>();

  constructor(
    private readonly runs: RunManager,
    private readonly workers: WorkflowWorkerAdapter,
  ) {}

  async run(input: RunWorkflowInput): Promise<OrchestraRun> {
    this.materializeSteps(input.runId, input.steps);
    this.ensureStarted(input.runId);

    try {
      while (true) {
        this.throwIfAborted(input.runId, input.signal);
        const run = this.runs.require(input.runId);
        const unfinished = run.steps.filter((step) => !["completed", "failed", "skipped", "cancelled"].includes(step.status));
        if (unfinished.length === 0) break;

        const readyDefinitions = input.steps.filter((definition) => {
          const step = run.steps.find((candidate) => candidate.id === definition.id);
          return step?.status === "ready";
        });
        if (readyDefinitions.length === 0) {
          this.runs.fail(input.runId, {
            code: "workflow_deadlock",
            message: "Workflow has unfinished steps but none are dependency-ready",
            retryable: false,
          });
          return this.runs.require(input.runId);
        }

        const results = await Promise.all(
          readyDefinitions.map(async (definition) => ({
            definition,
            result: await this.executeStep(input.runId, definition, input.signal),
          })),
        );

        const fatal = results.find(({ definition, result }) =>
          result.status !== "completed" && (definition.failurePolicy ?? "fail-run") === "fail-run");
        if (fatal) {
          const error = fatal.result.error ?? {
            code: fatal.result.status === "cancelled" ? "workflow_cancelled" : "workflow_step_failed",
            message: `Workflow step ${fatal.definition.id} ${fatal.result.status}`,
            retryable: false,
          };
          if (fatal.result.status === "cancelled") this.cancel(input.runId);
          else this.runs.fail(input.runId, error);
          return this.runs.require(input.runId);
        }
      }

      const finalStepId = input.finalResultStepId ?? input.steps.at(-1)?.id;
      const finalStep = finalStepId
        ? this.runs.require(input.runId).steps.find((step) => step.id === finalStepId)
        : undefined;
      return this.runs.complete(input.runId, { result: finalStep?.result });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        this.cancel(input.runId);
        return this.runs.require(input.runId);
      }
      if (!["completed", "failed", "cancelled"].includes(this.runs.require(input.runId).status)) {
        this.runs.fail(input.runId, {
          code: "workflow_runner_error",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        });
      }
      throw error;
    } finally {
      this.activeAgentsByRun.delete(input.runId);
    }
  }

  /**
   * Canonical replacement for legacy `crew`: runtime-enforced
   * Plan → Implement → Review with a bounded revision loop.
   */
  async runPlanImplementReview(input: PlanImplementReviewInput): Promise<OrchestraRun> {
    const maxRevisions = Math.max(0, Math.min(3, input.maxRevisions ?? 1));
    const planner = input.profiles?.planner ?? "Plan";
    const executor = input.profiles?.executor ?? "general-purpose";
    const reviewer = input.profiles?.reviewer ?? "Analysis";

    this.addStepIfMissing(input.runId, {
      id: "plan",
      title: "Plan",
      role: "planner",
      agentType: planner,
      buildPrompt: ({ task }) => [
        "Create an implementation plan for the task below.",
        "Return a concrete plan and identify artifacts/files the executor should use.",
        "",
        "## Task",
        task,
      ].join("\n"),
    });
    this.addStepIfMissing(input.runId, {
      id: "implement",
      title: "Implement",
      role: "executor",
      agentType: executor,
      dependsOn: ["plan"],
      buildPrompt: ({ task, dependencies }) => [
        "Implement the task end-to-end using the completed planner output below.",
        "Do not re-plan from scratch. Return the implementation result and concrete artifact references.",
        "",
        "## Original task",
        task,
        "",
        "## Planner output",
        ...dependencies.map(formatDependencyOutput),
      ].join("\n"),
    });
    this.addStepIfMissing(input.runId, {
      id: "review-1",
      title: "Review",
      role: "reviewer",
      agentType: reviewer,
      dependsOn: ["implement"],
      buildPrompt: ({ task, dependencies }) => this.reviewPrompt(task, dependencies),
    });

    this.ensureStarted(input.runId);

    try {
      const planResult = await this.executeNamedStep(input.runId, "plan", input.signal);
      if (!this.acceptOrTerminate(input.runId, "plan", planResult)) return this.runs.require(input.runId);

      const implementationResult = await this.executeNamedStep(input.runId, "implement", input.signal);
      if (!this.acceptOrTerminate(input.runId, "implement", implementationResult)) return this.runs.require(input.runId);

      let implementationStepId = "implement";
      let reviewStepId = "review-1";
      let reviewResult = await this.executeNamedStep(input.runId, reviewStepId, input.signal);
      if (!this.acceptOrTerminate(input.runId, reviewStepId, reviewResult)) return this.runs.require(input.runId);
      let verdict = parseReviewVerdict(reviewResult.result ?? "");

      for (let revision = 1; verdict.verdict === "FAIL" && revision <= maxRevisions; revision++) {
        const revisionStepId = `revision-${revision}`;
        const nextReviewStepId = `review-${revision + 1}`;
        const findings = verdict.findings.length > 0 ? verdict.findings.join("\n- ") : verdict.summary ?? "Review failed";

        this.addStepIfMissing(input.runId, {
          id: revisionStepId,
          title: `Revision ${revision}`,
          role: "executor",
          agentType: executor,
          dependsOn: [implementationStepId, reviewStepId],
          buildPrompt: ({ task, dependencies }) => [
            "Revise the implementation to address the reviewer findings.",
            "Return updated implementation output and artifact references.",
            "",
            "## Original task",
            task,
            "",
            "## Reviewer findings",
            `- ${findings}`,
            "",
            "## Prior execution context",
            ...dependencies.map(formatDependencyOutput),
          ].join("\n"),
        });

        const revisionResult = await this.executeNamedStep(input.runId, revisionStepId, input.signal);
        if (!this.acceptOrTerminate(input.runId, revisionStepId, revisionResult)) return this.runs.require(input.runId);
        implementationStepId = revisionStepId;

        this.addStepIfMissing(input.runId, {
          id: nextReviewStepId,
          title: `Review ${revision + 1}`,
          role: "reviewer",
          agentType: reviewer,
          dependsOn: [revisionStepId],
          buildPrompt: ({ task, dependencies }) => this.reviewPrompt(task, dependencies),
        });
        reviewStepId = nextReviewStepId;
        reviewResult = await this.executeNamedStep(input.runId, reviewStepId, input.signal);
        if (!this.acceptOrTerminate(input.runId, reviewStepId, reviewResult)) return this.runs.require(input.runId);
        verdict = parseReviewVerdict(reviewResult.result ?? "");
      }

      if (verdict.verdict === "FAIL") {
        this.runs.fail(input.runId, {
          code: "workflow_review_failed",
          message: verdict.summary || verdict.findings.join("; ") || "Reviewer rejected the implementation",
          retryable: false,
        });
        return this.runs.require(input.runId);
      }

      const implementation = this.runs.require(input.runId).steps.find((step) => step.id === implementationStepId);
      return this.runs.complete(input.runId, {
        result: implementation?.result,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        this.cancel(input.runId);
        return this.runs.require(input.runId);
      }
      if (!["completed", "failed", "cancelled"].includes(this.runs.require(input.runId).status)) {
        this.runs.fail(input.runId, {
          code: "workflow_runner_error",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        });
      }
      throw error;
    } finally {
      this.activeAgentsByRun.delete(input.runId);
      this.dynamicDefinitions.delete(input.runId);
    }
  }

  cancel(runId: string): OrchestraRun {
    for (const agentId of this.activeAgentsByRun.get(runId) ?? []) {
      try {
        this.workers.cancel(agentId);
      } catch {
        // RunManager remains the source of terminal state; cancellation transport
        // is best effort and may already have happened through its own adapter.
      }
    }
    return this.runs.cancel(runId);
  }

  private materializeSteps(runId: string, definitions: readonly WorkflowStepDefinition[]): void {
    const seen = new Set<string>();
    for (const definition of definitions) {
      if (seen.has(definition.id)) throw new Error(`Duplicate workflow step definition: ${definition.id}`);
      for (const dependency of definition.dependsOn ?? []) {
        if (!seen.has(dependency)) {
          throw new Error(`Workflow step ${definition.id} depends on unknown or forward step ${dependency}`);
        }
      }
      this.runs.addStep(runId, {
        id: definition.id,
        title: definition.title,
        role: definition.role,
        dependsOn: definition.dependsOn,
      });
      seen.add(definition.id);
    }
  }

  private addStepIfMissing(runId: string, definition: WorkflowStepDefinition): void {
    if (this.runs.require(runId).steps.some((step) => step.id === definition.id)) return;
    this.runs.addStep(runId, {
      id: definition.id,
      title: definition.title,
      role: definition.role,
      dependsOn: definition.dependsOn,
    });
    this.planReviewDefinitions(runId).set(definition.id, definition);
  }

  private planReviewDefinitions(runId: string): Map<string, WorkflowStepDefinition> {
    let definitions = this.dynamicDefinitions.get(runId);
    if (!definitions) {
      definitions = new Map();
      this.dynamicDefinitions.set(runId, definitions);
    }
    return definitions;
  }

  private ensureStarted(runId: string): void {
    const run = this.runs.require(runId);
    if (run.status === "created" || run.status === "resolving" || run.status === "queued" || run.status === "waiting") {
      this.runs.start(runId);
    }
  }

  private throwIfAborted(runId: string, signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    this.cancel(runId);
    throw abortError();
  }

  private async executeNamedStep(
    runId: string,
    stepId: string,
    signal?: AbortSignal,
  ): Promise<WorkflowWorkerResult> {
    const definition = this.planReviewDefinitions(runId).get(stepId);
    if (!definition) throw new Error(`Missing workflow definition for step ${stepId}`);
    return this.executeStep(runId, definition, signal);
  }

  private async executeStep(
    runId: string,
    definition: WorkflowStepDefinition,
    signal?: AbortSignal,
  ): Promise<WorkflowWorkerResult> {
    this.throwIfAborted(runId, signal);
    const run = this.runs.require(runId);
    const current = run.steps.find((step) => step.id === definition.id);
    if (!current) throw new Error(`Run ${runId} has no step ${definition.id}`);
    if (current.status !== "ready") {
      throw new Error(`Workflow step ${definition.id} is not ready: ${current.status}`);
    }

    const dependencyOutputs = current.dependsOn.map((dependencyId) => {
      const dependency = run.steps.find((step) => step.id === dependencyId);
      if (!dependency) throw new Error(`Missing dependency ${dependencyId}`);
      return stepOutput(dependency);
    });
    const prompt = definition.buildPrompt({
      runId,
      task: run.task,
      dependencies: dependencyOutputs,
    });

    this.runs.startStep(runId, definition.id);
    const handle = this.workers.spawn({
      runId,
      stepId: definition.id,
      role: definition.role,
      agentType: definition.agentType,
      prompt,
      dependencyOutputs,
    });
    this.runs.attachAgent(runId, handle.agentId, definition.id);
    let active = this.activeAgentsByRun.get(runId);
    if (!active) {
      active = new Set();
      this.activeAgentsByRun.set(runId, active);
    }
    active.add(handle.agentId);

    let result: WorkflowWorkerResult;
    try {
      result = await waitForWorkerResult(handle.result, signal, () => {
        try {
          this.workers.cancel(handle.agentId);
        } catch {
          // best effort; RunManager will transition the run to cancelled
        }
      });
    } finally {
      active.delete(handle.agentId);
    }

    if (result.status === "completed") {
      this.runs.completeStep(runId, definition.id, {
        result: result.result,
        artifacts: result.artifacts,
      });
    } else if (result.status === "failed") {
      this.runs.failStep(runId, definition.id, result.error ?? {
        code: "workflow_step_failed",
        message: `Worker ${handle.agentId} failed step ${definition.id}`,
        retryable: false,
      });
    } else {
      this.cancel(runId);
    }
    return result;
  }

  private acceptOrTerminate(
    runId: string,
    stepId: string,
    result: WorkflowWorkerResult,
  ): boolean {
    if (result.status === "completed") return true;
    if (result.status === "cancelled") {
      this.cancel(runId);
      return false;
    }
    this.runs.fail(runId, result.error ?? {
      code: "workflow_step_failed",
      message: `Workflow step ${stepId} failed`,
      retryable: false,
    });
    return false;
  }

  private reviewPrompt(task: string, dependencies: WorkflowDependencyOutput[]): string {
    return [
      "Review the completed implementation against the original task.",
      "You are reviewing actual completed dependency output and artifacts, not an assumed future result.",
      "Return a structured verdict as JSON: {\"verdict\":\"PASS|FAIL\",\"findings\":[\"...\"],\"summary\":\"...\"}.",
      "",
      "## Original task",
      task,
      "",
      "## Completed implementation context",
      ...dependencies.map(formatDependencyOutput),
    ].join("\n");
  }
}

/** Parse the reviewer's structured verdict with a conservative text fallback. */
export function parseReviewVerdict(text: string): ReviewVerdict {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.unshift(fenced[1].trim());
  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch?.[0]) candidates.unshift(objectMatch[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        verdict?: unknown;
        findings?: unknown;
        summary?: unknown;
      };
      const verdict = typeof parsed.verdict === "string" ? parsed.verdict.toUpperCase() : "";
      if (verdict === "PASS" || verdict === "FAIL") {
        return {
          verdict,
          findings: Array.isArray(parsed.findings)
            ? parsed.findings.filter((item): item is string => typeof item === "string")
            : [],
          summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
        };
      }
    } catch {
      // Try the next candidate, then fall back to an explicit text verdict.
    }
  }

  const explicit = trimmed.match(/(?:^|\n)\s*(PASS|FAIL)\b[:\s-]*(.*)$/im);
  if (explicit) {
    return {
      verdict: explicit[1]!.toUpperCase() as "PASS" | "FAIL",
      findings: explicit[1]!.toUpperCase() === "FAIL" && explicit[2]?.trim() ? [explicit[2].trim()] : [],
      summary: explicit[2]?.trim() || undefined,
    };
  }

  return {
    verdict: "FAIL",
    findings: ["Reviewer did not return an explicit PASS/FAIL verdict"],
    summary: "Unparseable review verdict",
  };
}
