import type {
  OrchestraArtifactReference,
  OrchestraExecutionCorrelation,
  OrchestraExecutionError,
} from "./orchestra-execution-contract.js";

/** User-facing vNext execution strategies. */
export type ExecutionStrategy = "focused" | "adaptive" | "parallel" | "workflow";

/** Run-level result delivery policy. */
export type DeliveryPolicy = "automatic" | "individual" | "combined" | "progressive";

export type RunStatus =
  | "created"
  | "resolving"
  | "queued"
  | "running"
  | "waiting"
  | "reviewing"
  | "completed"
  | "failed"
  | "cancelled";

export type RunStepStatus =
  | "waiting_dependency"
  | "ready"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled";

/**
 * Typed reason metadata for Adaptive decisions. CHE-134 owns the canonical
 * reason-code catalog; the domain model intentionally accepts namespaced
 * strings so the resolver can evolve without changing Run storage shape.
 */
export interface DecisionReason {
  code: string;
  detail?: string;
}

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  toolUses: number;
  turns: number;
}

export const EMPTY_RUN_USAGE: RunUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  toolUses: 0,
  turns: 0,
};

export interface RunStep {
  id: string;
  role?: string;
  title: string;
  description?: string;
  dependsOn: string[];
  status: RunStepStatus;
  agentIds: string[];
  artifacts: OrchestraArtifactReference[];
  result?: string;
  error?: OrchestraExecutionError;
  startedAt?: number;
  completedAt?: number;
}

export interface OrchestraRun {
  id: string;
  task: string;
  requestedStrategy: ExecutionStrategy;
  effectiveStrategy?: Exclude<ExecutionStrategy, "adaptive">;
  decisionReasons: DecisionReason[];
  delivery: DeliveryPolicy;
  status: RunStatus;
  steps: RunStep[];
  agentIds: string[];
  correlation?: OrchestraExecutionCorrelation;
  usage: RunUsage;
  artifacts: OrchestraArtifactReference[];
  result?: string;
  error?: OrchestraExecutionError;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export type RunEventType =
  | "run:created"
  | "run:strategy_resolved"
  | "run:started"
  | "run:status_changed"
  | "run:agent_attached"
  | "run:artifact_added"
  | "run:completed"
  | "run:failed"
  | "run:cancelled"
  | "step:created"
  | "step:status_changed"
  | "step:agent_attached"
  | "step:artifact_added";

export interface RunEvent {
  type: RunEventType;
  runId: string;
  timestamp: number;
  stepId?: string;
  agentId?: string;
  details?: Readonly<Record<string, unknown>>;
}

export interface CreateRunInput {
  task: string;
  requestedStrategy?: ExecutionStrategy;
  delivery?: DeliveryPolicy;
  correlation?: OrchestraExecutionCorrelation;
}

export interface CreateStepInput {
  id?: string;
  role?: string;
  title: string;
  description?: string;
  dependsOn?: readonly string[];
}

export interface CompleteRunInput {
  result?: string;
  artifacts?: readonly OrchestraArtifactReference[];
  usage?: Partial<RunUsage>;
}
