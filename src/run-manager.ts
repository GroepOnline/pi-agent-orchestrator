import { randomUUID } from "node:crypto";
import {
  type OrchestraArtifactReference,
  type OrchestraExecutionError,
  validateOrchestraExecutionCorrelation,
} from "./orchestra-execution-contract.js";
import {
  type CompleteRunInput,
  type CreateRunInput,
  type CreateStepInput,
  type DecisionReason,
  EMPTY_RUN_USAGE,
  type OrchestraRun,
  type RunEvent,
  type RunEventType,
  type RunStatus,
  type RunStep,
  type RunStepStatus,
  type RunUsage,
} from "./run-types.js";

export interface RunWorkerController {
  /** Best-effort cancellation of an execution-local worker. */
  cancel(agentId: string): boolean | undefined;
}

export interface RunManagerOptions {
  workerController?: RunWorkerController;
  now?: () => number;
  idFactory?: () => string;
}

export type RunEventListener = (event: RunEvent, run: OrchestraRun) => void;

const TERMINAL_RUN_STATUSES = new Set<RunStatus>(["completed", "failed", "cancelled"]);
const TERMINAL_STEP_STATUSES = new Set<RunStepStatus>(["completed", "failed", "skipped", "cancelled"]);

function copyUsage(usage: RunUsage): RunUsage {
  return { ...usage };
}

function copyArtifact(artifact: OrchestraArtifactReference): OrchestraArtifactReference {
  return {
    ...artifact,
    metadata: artifact.metadata ? { ...artifact.metadata } : undefined,
  };
}

function snapshotStep(step: RunStep): RunStep {
  return {
    ...step,
    dependsOn: [...step.dependsOn],
    agentIds: [...step.agentIds],
    artifacts: step.artifacts.map(copyArtifact),
    error: step.error ? { ...step.error } : undefined,
  };
}

export function snapshotRun(run: OrchestraRun): OrchestraRun {
  return {
    ...run,
    decisionReasons: run.decisionReasons.map((reason) => ({ ...reason })),
    steps: run.steps.map(snapshotStep),
    agentIds: [...run.agentIds],
    correlation: run.correlation ? { ...run.correlation } : undefined,
    usage: copyUsage(run.usage),
    artifacts: run.artifacts.map(copyArtifact),
    error: run.error ? { ...run.error } : undefined,
  };
}

/**
 * Execution-local Run state manager.
 *
 * This deliberately has no persistence/replay implementation. Durable mission
 * recovery remains owned by pi-missions; RunManager only coordinates one live
 * Orchestra execution and retains in-process history for UI/diagnostics.
 */
export class RunManager {
  private readonly runs = new Map<string, OrchestraRun>();
  private readonly idempotencyIndex = new Map<string, string>();
  private readonly events: RunEvent[] = [];
  private readonly listeners = new Set<RunEventListener>();
  private readonly workerController?: RunWorkerController;
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(options: RunManagerOptions = {}) {
    this.workerController = options.workerController;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => `run-${randomUUID()}`);
  }

  create(input: CreateRunInput): OrchestraRun {
    const task = input.task.trim();
    if (!task) throw new Error("Run task is required");

    if (input.correlation) {
      const validation = validateOrchestraExecutionCorrelation(input.correlation);
      if (!validation.ok) {
        throw new Error(`Invalid Orchestra execution correlation: ${validation.reason}`);
      }
      const key = input.correlation.idempotencyKey;
      if (key) {
        const existingId = this.idempotencyIndex.get(key);
        if (existingId) return this.require(existingId);
      }
    }

    const run: OrchestraRun = {
      id: this.idFactory(),
      task,
      requestedStrategy: input.requestedStrategy ?? "focused",
      decisionReasons: [],
      delivery: input.delivery ?? "automatic",
      status: "created",
      steps: [],
      agentIds: [],
      correlation: input.correlation ? { ...input.correlation } : undefined,
      usage: { ...EMPTY_RUN_USAGE },
      artifacts: [],
      createdAt: this.now(),
    };

    this.runs.set(run.id, run);
    if (run.correlation?.idempotencyKey) {
      this.idempotencyIndex.set(run.correlation.idempotencyKey, run.id);
    }
    this.emit("run:created", run);
    return snapshotRun(run);
  }

  get(id: string): OrchestraRun | undefined {
    const run = this.runs.get(id);
    return run ? snapshotRun(run) : undefined;
  }

  require(id: string): OrchestraRun {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Unknown Orchestra run: ${id}`);
    return snapshotRun(run);
  }

  list(): OrchestraRun[] {
    return [...this.runs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(snapshotRun);
  }

  listActive(): OrchestraRun[] {
    return this.list().filter((run) => !TERMINAL_RUN_STATUSES.has(run.status));
  }

  resolveStrategy(
    runId: string,
    effectiveStrategy: NonNullable<OrchestraRun["effectiveStrategy"]>,
    reasons: readonly DecisionReason[] = [],
  ): OrchestraRun {
    const run = this.mutable(runId);
    this.ensureMutable(run);
    run.status = "resolving";
    run.effectiveStrategy = effectiveStrategy;
    run.decisionReasons = reasons.map((reason) => ({ ...reason }));
    this.emit("run:strategy_resolved", run, {
      effectiveStrategy,
      reasons: run.decisionReasons,
    });
    return snapshotRun(run);
  }

  start(runId: string): OrchestraRun {
    const run = this.mutable(runId);
    this.ensureMutable(run);
    if (run.requestedStrategy === "adaptive" && !run.effectiveStrategy) {
      throw new Error(`Adaptive run ${run.id} cannot start before strategy resolution`);
    }
    if (!run.effectiveStrategy) {
      run.effectiveStrategy = run.requestedStrategy === "adaptive" ? undefined : run.requestedStrategy;
    }
    run.status = "running";
    run.startedAt ??= this.now();
    this.emit("run:started", run);
    return snapshotRun(run);
  }

  setStatus(runId: string, status: Exclude<RunStatus, "completed" | "failed" | "cancelled">): OrchestraRun {
    const run = this.mutable(runId);
    this.ensureMutable(run);
    run.status = status;
    if (status === "running") run.startedAt ??= this.now();
    this.emit("run:status_changed", run, { status });
    return snapshotRun(run);
  }

  addStep(runId: string, input: CreateStepInput): RunStep {
    const run = this.mutable(runId);
    this.ensureMutable(run);
    const id = input.id?.trim() || `step-${run.steps.length + 1}`;
    if (run.steps.some((step) => step.id === id)) {
      throw new Error(`Duplicate step id in run ${run.id}: ${id}`);
    }
    const dependsOn = [...new Set(input.dependsOn ?? [])];
    if (dependsOn.includes(id)) throw new Error(`Step ${id} cannot depend on itself`);
    for (const dependencyId of dependsOn) {
      if (!run.steps.some((step) => step.id === dependencyId)) {
        throw new Error(`Unknown dependency ${dependencyId} for step ${id}`);
      }
    }

    const step: RunStep = {
      id,
      role: input.role,
      title: input.title,
      description: input.description,
      dependsOn,
      status: dependsOn.length === 0 ? "ready" : "waiting_dependency",
      agentIds: [],
      artifacts: [],
    };
    run.steps.push(step);
    this.emit("step:created", run, { stepId: id, status: step.status });
    // Late-added steps (e.g. revision loops) may depend on already-terminal
    // work. Refresh immediately so they become ready instead of staying stuck.
    this.refreshDependencyReadiness(run);
    return snapshotStep(this.step(run, id));
  }

  attachAgent(runId: string, agentId: string, stepId?: string): OrchestraRun {
    const run = this.mutable(runId);
    this.ensureMutable(run);
    const normalized = agentId.trim();
    if (!normalized) throw new Error("Agent id is required");
    if (!run.agentIds.includes(normalized)) run.agentIds.push(normalized);
    this.emit("run:agent_attached", run, { agentId: normalized, stepId });

    if (stepId) {
      const step = this.step(run, stepId);
      if (!step.agentIds.includes(normalized)) step.agentIds.push(normalized);
      this.emit("step:agent_attached", run, { agentId: normalized, stepId });
    }
    return snapshotRun(run);
  }

  startStep(runId: string, stepId: string): RunStep {
    const run = this.mutable(runId);
    this.ensureMutable(run);
    const step = this.step(run, stepId);
    if (!this.dependenciesSatisfied(run, step)) {
      throw new Error(`Step ${step.id} cannot start before dependencies complete`);
    }
    if (TERMINAL_STEP_STATUSES.has(step.status)) {
      throw new Error(`Step ${step.id} is already terminal: ${step.status}`);
    }
    step.status = "running";
    step.startedAt ??= this.now();
    run.startedAt ??= step.startedAt;
    if (run.status === "created" || run.status === "resolving" || run.status === "queued" || run.status === "waiting") {
      run.status = "running";
    }
    this.emit("step:status_changed", run, { stepId, status: step.status });
    return snapshotStep(step);
  }

  queueStep(runId: string, stepId: string): RunStep {
    return this.setStepStatus(runId, stepId, "queued", true);
  }

  completeStep(
    runId: string,
    stepId: string,
    options: { result?: string; artifacts?: readonly OrchestraArtifactReference[] } = {},
  ): RunStep {
    const run = this.mutable(runId);
    this.ensureMutable(run);
    const step = this.step(run, stepId);
    if (step.status !== "running" && step.status !== "queued" && step.status !== "ready") {
      throw new Error(`Step ${step.id} cannot complete from ${step.status}`);
    }
    step.status = "completed";
    step.completedAt = this.now();
    step.result = options.result;
    if (options.artifacts) {
      for (const artifact of options.artifacts) {
        const copied = copyArtifact(artifact);
        step.artifacts.push(copied);
        run.artifacts.push(copyArtifact(artifact));
        this.emit("step:artifact_added", run, { stepId, artifact: copied });
      }
    }
    this.emit("step:status_changed", run, { stepId, status: step.status });
    this.refreshDependencyReadiness(run);
    return snapshotStep(step);
  }

  failStep(runId: string, stepId: string, error: OrchestraExecutionError): RunStep {
    const run = this.mutable(runId);
    this.ensureMutable(run);
    const step = this.step(run, stepId);
    if (TERMINAL_STEP_STATUSES.has(step.status)) {
      throw new Error(`Step ${step.id} is already terminal: ${step.status}`);
    }
    step.status = "failed";
    step.error = { ...error };
    step.completedAt = this.now();
    this.emit("step:status_changed", run, { stepId, status: step.status, error: step.error });
    return snapshotStep(step);
  }

  skipStep(runId: string, stepId: string): RunStep {
    return this.setStepStatus(runId, stepId, "skipped", false, true);
  }

  addArtifact(runId: string, artifact: OrchestraArtifactReference, stepId?: string): OrchestraRun {
    const run = this.mutable(runId);
    this.ensureMutable(run);
    const copied = copyArtifact(artifact);
    run.artifacts.push(copied);
    this.emit("run:artifact_added", run, { stepId, artifact: copied });
    if (stepId) {
      const step = this.step(run, stepId);
      step.artifacts.push(copyArtifact(artifact));
      this.emit("step:artifact_added", run, { stepId, artifact: copied });
    }
    return snapshotRun(run);
  }

  addUsage(runId: string, delta: Partial<RunUsage>): OrchestraRun {
    const run = this.mutable(runId);
    this.ensureMutable(run);
    for (const key of Object.keys(EMPTY_RUN_USAGE) as Array<keyof RunUsage>) {
      const amount = delta[key] ?? 0;
      if (!Number.isFinite(amount) || amount < 0) throw new Error(`Invalid usage delta for ${key}`);
      run.usage[key] += amount;
    }
    return snapshotRun(run);
  }

  complete(runId: string, input: CompleteRunInput = {}): OrchestraRun {
    const run = this.mutable(runId);
    this.ensureMutable(run);
    const incomplete = run.steps.filter((step) => !TERMINAL_STEP_STATUSES.has(step.status));
    if (incomplete.length > 0) {
      throw new Error(`Run ${run.id} still has non-terminal steps: ${incomplete.map((step) => step.id).join(", ")}`);
    }
    const failed = run.steps.filter((step) => step.status === "failed");
    if (failed.length > 0) {
      throw new Error(`Run ${run.id} has failed steps: ${failed.map((step) => step.id).join(", ")}`);
    }

    run.status = "completed";
    run.result = input.result;
    run.completedAt = this.now();
    if (input.artifacts) {
      run.artifacts.push(...input.artifacts.map(copyArtifact));
    }
    if (input.usage) this.applyUsage(run, input.usage);
    this.emit("run:completed", run);
    return snapshotRun(run);
  }

  fail(runId: string, error: OrchestraExecutionError): OrchestraRun {
    const run = this.mutable(runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) return snapshotRun(run);
    run.status = "failed";
    run.error = { ...error };
    run.completedAt = this.now();
    this.cancelWorkers(run);
    for (const step of run.steps) {
      if (!TERMINAL_STEP_STATUSES.has(step.status)) {
        step.status = "cancelled";
        step.completedAt = run.completedAt;
        this.emit("step:status_changed", run, { stepId: step.id, status: step.status });
      }
    }
    this.emit("run:failed", run, { error: run.error });
    return snapshotRun(run);
  }

  cancel(runId: string): OrchestraRun {
    const run = this.mutable(runId);
    if (run.status === "cancelled") return snapshotRun(run);
    if (run.status === "completed" || run.status === "failed") return snapshotRun(run);

    run.status = "cancelled";
    run.completedAt = this.now();
    this.cancelWorkers(run);
    for (const step of run.steps) {
      if (!TERMINAL_STEP_STATUSES.has(step.status)) {
        step.status = "cancelled";
        step.completedAt = run.completedAt;
        this.emit("step:status_changed", run, { stepId: step.id, status: step.status });
      }
    }
    this.emit("run:cancelled", run);
    return snapshotRun(run);
  }

  history(runId?: string): RunEvent[] {
    return this.events
      .filter((event) => !runId || event.runId === runId)
      .map((event) => ({ ...event, details: event.details ? { ...event.details } : undefined }));
  }

  onEvent(listener: RunEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private mutable(id: string): OrchestraRun {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Unknown Orchestra run: ${id}`);
    return run;
  }

  private step(run: OrchestraRun, stepId: string): RunStep {
    const step = run.steps.find((candidate) => candidate.id === stepId);
    if (!step) throw new Error(`Unknown step ${stepId} in run ${run.id}`);
    return step;
  }

  private ensureMutable(run: OrchestraRun): void {
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      throw new Error(`Run ${run.id} is already terminal: ${run.status}`);
    }
  }

  private dependenciesSatisfied(run: OrchestraRun, step: RunStep): boolean {
    // completed unlocks dependents normally; skipped unlocks them under
    // failurePolicy "continue" so the DAG does not deadlock on optional work.
    return step.dependsOn.every((dependencyId) => {
      const status = this.step(run, dependencyId).status;
      return status === "completed" || status === "skipped";
    });
  }

  private refreshDependencyReadiness(run: OrchestraRun): void {
    for (const step of run.steps) {
      if (step.status === "waiting_dependency" && this.dependenciesSatisfied(run, step)) {
        step.status = "ready";
        this.emit("step:status_changed", run, { stepId: step.id, status: step.status });
      }
    }
  }

  private setStepStatus(
    runId: string,
    stepId: string,
    status: RunStepStatus,
    requireDependencies: boolean,
    terminal = false,
  ): RunStep {
    const run = this.mutable(runId);
    this.ensureMutable(run);
    const step = this.step(run, stepId);
    if (requireDependencies && !this.dependenciesSatisfied(run, step)) {
      throw new Error(`Step ${step.id} cannot become ${status} before dependencies complete`);
    }
    if (TERMINAL_STEP_STATUSES.has(step.status)) {
      throw new Error(`Step ${step.id} is already terminal: ${step.status}`);
    }
    step.status = status;
    if (terminal) step.completedAt = this.now();
    this.emit("step:status_changed", run, { stepId, status });
    if (terminal) this.refreshDependencyReadiness(run);
    return snapshotStep(step);
  }

  private applyUsage(run: OrchestraRun, delta: Partial<RunUsage>): void {
    for (const key of Object.keys(EMPTY_RUN_USAGE) as Array<keyof RunUsage>) {
      const amount = delta[key] ?? 0;
      if (!Number.isFinite(amount) || amount < 0) throw new Error(`Invalid usage delta for ${key}`);
      run.usage[key] += amount;
    }
  }

  private cancelWorkers(run: OrchestraRun): void {
    if (!this.workerController) return;
    for (const agentId of run.agentIds) {
      try {
        this.workerController.cancel(agentId);
      } catch {
        // Best-effort local cancellation. Durable retry/cancellation policy belongs
        // to the caller (notably pi-missions), not RunManager.
      }
    }
  }

  private emit(
    type: RunEventType,
    run: OrchestraRun,
    details: Record<string, unknown> & { stepId?: string; agentId?: string } = {},
  ): void {
    const { stepId, agentId, ...eventDetails } = details;
    const event: RunEvent = {
      type,
      runId: run.id,
      timestamp: this.now(),
      stepId,
      agentId,
      details: Object.keys(eventDetails).length > 0 ? eventDetails : undefined,
    };
    this.events.push(event);
    const snapshot = snapshotRun(run);
    for (const listener of this.listeners) listener({ ...event }, snapshot);
  }
}
