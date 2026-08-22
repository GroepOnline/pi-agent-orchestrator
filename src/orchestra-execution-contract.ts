export const ORCHESTRA_EXECUTION_CONTRACT_VERSION = 1 as const;

export type OrchestraExecutionContractVersion = typeof ORCHESTRA_EXECUTION_CONTRACT_VERSION;

export type OrchestraArtifactType = "file" | "branch" | "url" | "note" | "opaque";

export interface OrchestraArtifactReference {
  /** Stable artifact identifier when the caller has one. */
  id?: string;
  type: OrchestraArtifactType;
  /** Canonical URI when the artifact can be addressed that way. */
  uri?: string;
  /** Repository/workspace path for file-like artifacts. */
  path?: string;
  title?: string;
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * Correlation carried from a durable caller (notably pi-missions) into one
 * execution-local Orchestra run.
 *
 * Mission-scoped fields are an all-or-nothing set. A transport retry of the
 * same logical attempt MUST reuse the same attemptId + idempotencyKey. A new
 * mission retry MUST allocate a new attemptId and therefore a new key.
 */
export interface OrchestraExecutionCorrelation {
  /** Logical caller, e.g. "pi-missions", "pi-control", "interactive". */
  caller: string;
  missionId?: string;
  taskId?: string;
  attemptId?: string;
  idempotencyKey?: string;
  /** Optional parent execution for nested/local orchestration. */
  parentExecutionId?: string;
}

export interface OrchestraExecutionRequest<TInput = unknown> {
  contractVersion: OrchestraExecutionContractVersion;
  task: string;
  correlation: OrchestraExecutionCorrelation;
  input?: TInput;
  artifacts?: readonly OrchestraArtifactReference[];
}

export type OrchestraExecutionOutcomeStatus = "completed" | "failed" | "cancelled";

export interface OrchestraExecutionError {
  code?: string;
  message: string;
  retryable?: boolean;
}

export interface OrchestraExecutionOutcome<TResult = unknown> {
  contractVersion: OrchestraExecutionContractVersion;
  executionId: string;
  correlation: OrchestraExecutionCorrelation;
  status: OrchestraExecutionOutcomeStatus;
  result?: TResult;
  artifacts?: readonly OrchestraArtifactReference[];
  error?: OrchestraExecutionError;
  startedAt?: number;
  completedAt: number;
}

export type CorrelationValidationResult =
  | { ok: true }
  | { ok: false; reason: "caller_required" | "partial_mission_correlation" | "invalid_idempotency_key" };

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate the cross-repo ownership/correlation contract without imposing Run
 * implementation details. Generic callers only need a caller id. If any
 * mission-scoped field is present, all four mission fields must be present.
 */
export function validateOrchestraExecutionCorrelation(
  correlation: OrchestraExecutionCorrelation,
): CorrelationValidationResult {
  if (!nonEmpty(correlation.caller)) return { ok: false, reason: "caller_required" };

  const missionFields = [
    correlation.missionId,
    correlation.taskId,
    correlation.attemptId,
    correlation.idempotencyKey,
  ];
  const present = missionFields.filter(nonEmpty).length;

  if (present !== 0 && present !== missionFields.length) {
    return { ok: false, reason: "partial_mission_correlation" };
  }

  if (present === missionFields.length) {
    const expected = buildMissionExecutionIdempotencyKey({
      missionId: correlation.missionId!,
      taskId: correlation.taskId!,
      attemptId: correlation.attemptId!,
    });
    if (correlation.idempotencyKey !== expected) {
      return { ok: false, reason: "invalid_idempotency_key" };
    }
  }

  return { ok: true };
}

export interface MissionExecutionIdentity {
  missionId: string;
  taskId: string;
  attemptId: string;
}

function keyPart(value: string): string {
  return encodeURIComponent(value.trim());
}

/**
 * Canonical idempotency key for one logical pi-missions execution attempt.
 * This is intentionally deterministic and contains no process/session state.
 */
export function buildMissionExecutionIdempotencyKey(identity: MissionExecutionIdentity): string {
  return `orchestra:v${ORCHESTRA_EXECUTION_CONTRACT_VERSION}:mission:${keyPart(identity.missionId)}:task:${keyPart(identity.taskId)}:attempt:${keyPart(identity.attemptId)}`;
}

/** Build a fully-valid pi-missions correlation object. */
export function buildMissionExecutionCorrelation(
  identity: MissionExecutionIdentity,
): OrchestraExecutionCorrelation {
  return {
    caller: "pi-missions",
    ...identity,
    idempotencyKey: buildMissionExecutionIdempotencyKey(identity),
  };
}
