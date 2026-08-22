import { analyzePrompt } from "./orchestration-dispatch.js";
import type { DecisionReason, ExecutionStrategy } from "./run-types.js";

export const DECISION_REASON_CODES = [
  "explicit_strategy",
  "planning_required",
  "review_required",
  "refactor_validation",
  "multi_file_implementation",
  "multi_step_implementation",
  "comparison_requested",
  "explicit_parallelism",
  "narrow_task",
] as const;

export type DecisionReasonCode = (typeof DECISION_REASON_CODES)[number];

export type ParallelVariant = "same-task" | "perspectives" | "split";

export interface StrategyDecision {
  requested: ExecutionStrategy;
  effective: Exclude<ExecutionStrategy, "adaptive">;
  reasons: Array<DecisionReason & { code: DecisionReasonCode }>;
  parallel?: {
    variant: ParallelVariant;
  };
  resolverVersion: 1;
}

export interface ResolveExecutionStrategyInput {
  requested: ExecutionStrategy;
  prompt: string;
  /** Explicit Parallel variant. Defaults to same-task when Parallel is selected. */
  parallelVariant?: ParallelVariant;
}

function reason(code: DecisionReasonCode, detail?: string): DecisionReason & { code: DecisionReasonCode } {
  return detail ? { code, detail } : { code };
}

/**
 * Resolve vNext execution strategy without side effects or model calls.
 *
 * The first cut deliberately mirrors current orchestration routing precedence so
 * rollout can separate terminology/domain changes from heuristic behavior
 * changes. Unlike the legacy resolver, every Adaptive decision is explainable.
 */
export function resolveExecutionStrategy(input: ResolveExecutionStrategyInput): StrategyDecision {
  const requested = input.requested;

  if (requested !== "adaptive") {
    const decision: StrategyDecision = {
      requested,
      effective: requested,
      reasons: [reason("explicit_strategy", requested)],
      resolverVersion: 1,
    };
    if (requested === "parallel") {
      decision.parallel = { variant: input.parallelVariant ?? "same-task" };
    }
    return decision;
  }

  const analysis = analyzePrompt(input.prompt);
  const reasons: StrategyDecision["reasons"] = [];

  // Preserve legacy precedence: planning/review beats parallel wording.
  if (analysis.hasPlanKeyword || analysis.hasReviewKeyword) {
    if (analysis.hasPlanKeyword) reasons.push(reason("planning_required"));
    if (analysis.hasReviewKeyword) reasons.push(reason("review_required"));
    return {
      requested,
      effective: "workflow",
      reasons,
      resolverVersion: 1,
    };
  }

  if (analysis.hasRefactorKeyword && (analysis.hasTestKeyword || analysis.hasMultipleFiles)) {
    reasons.push(reason("refactor_validation"));
    if (analysis.hasMultipleFiles) reasons.push(reason("multi_file_implementation"));
    return {
      requested,
      effective: "workflow",
      reasons,
      resolverVersion: 1,
    };
  }

  if (analysis.hasImplementKeyword && analysis.hasMultipleFiles) {
    return {
      requested,
      effective: "workflow",
      reasons: [reason("multi_file_implementation")],
      resolverVersion: 1,
    };
  }

  if (analysis.hasImplementKeyword && analysis.length > 800 && analysis.estimatedSteps >= 3) {
    return {
      requested,
      effective: "workflow",
      reasons: [reason("multi_step_implementation", `${analysis.estimatedSteps} detected steps`)],
      resolverVersion: 1,
    };
  }

  if (analysis.hasParallelKeyword) {
    const comparison = /\bcompar(?:e|ison|ing)\b|\bbenchmark\b/i.test(input.prompt);
    return {
      requested,
      effective: "parallel",
      reasons: [reason(comparison ? "comparison_requested" : "explicit_parallelism")],
      parallel: { variant: input.parallelVariant ?? "same-task" },
      resolverVersion: 1,
    };
  }

  return {
    requested,
    effective: "focused",
    reasons: [reason("narrow_task")],
    resolverVersion: 1,
  };
}

export interface ParallelPlanMember {
  id: string;
  description: string;
  prompt: string;
  perspective?: string;
}

export interface BuildParallelPlanInput {
  prompt: string;
  description: string;
  variant: ParallelVariant;
  size?: number;
  perspectives?: readonly string[];
  subtasks?: readonly string[];
}

function boundedParallelSize(size: number | undefined): number {
  return Math.max(2, Math.min(5, size ?? 2));
}

/**
 * Build a plan whose semantics are explicit instead of hiding three different
 * behaviors behind the old `swarm` name.
 */
export function buildParallelPlan(input: BuildParallelPlanInput): ParallelPlanMember[] {
  if (input.variant === "same-task") {
    const size = boundedParallelSize(input.size);
    return Array.from({ length: size }, (_, index) => ({
      id: `attempt-${index + 1}`,
      description: `${input.description} (${index + 1}/${size})`,
      prompt: input.prompt,
    }));
  }

  if (input.variant === "perspectives") {
    const perspectives = (input.perspectives ?? []).map((value) => value.trim()).filter(Boolean);
    if (perspectives.length < 2) {
      throw new Error("Parallel perspectives requires at least two non-empty perspectives");
    }
    if (perspectives.length > 5) {
      throw new Error("Parallel execution supports at most five perspectives");
    }
    return perspectives.map((perspective, index) => ({
      id: `perspective-${index + 1}`,
      description: `${input.description} — ${perspective}`,
      perspective,
      prompt: `Analyze the task from the ${perspective} perspective. Work independently and return a self-contained result.\n\n## Task\n${input.prompt}`,
    }));
  }

  const subtasks = (input.subtasks ?? []).map((value) => value.trim()).filter(Boolean);
  if (subtasks.length < 2) {
    throw new Error("Parallel split requires at least two independent subtasks");
  }
  if (subtasks.length > 5) {
    throw new Error("Parallel execution supports at most five subtasks");
  }
  return subtasks.map((subtask, index) => ({
    id: `subtask-${index + 1}`,
    description: `${input.description} — part ${index + 1}/${subtasks.length}`,
    prompt: `Complete only the independent subtask below. Do not attempt the other parallel parts.\n\n## Original task\n${input.prompt}\n\n## Your subtask\n${subtask}`,
  }));
}

export type ParallelMemberStatus = "completed" | "failed" | "cancelled";

export interface ParallelMemberOutcome {
  id: string;
  status: ParallelMemberStatus;
  result?: string;
  error?: string;
}

export interface ParallelOutcome {
  status: "completed" | "partial" | "failed" | "cancelled";
  members: ParallelMemberOutcome[];
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
}

/**
 * Aggregate already-ordered member outcomes without hiding partial failure.
 * Input order is preserved so UI/result synthesis remains deterministic.
 */
export function aggregateParallelOutcomes(
  members: readonly ParallelMemberOutcome[],
): ParallelOutcome {
  const copied = members.map((member) => ({ ...member }));
  const completedCount = copied.filter((member) => member.status === "completed").length;
  const failedCount = copied.filter((member) => member.status === "failed").length;
  const cancelledCount = copied.filter((member) => member.status === "cancelled").length;

  let status: ParallelOutcome["status"];
  if (copied.length > 0 && cancelledCount === copied.length) {
    status = "cancelled";
  } else if (completedCount === copied.length) {
    status = "completed";
  } else if (completedCount > 0) {
    status = "partial";
  } else if (failedCount > 0) {
    status = "failed";
  } else {
    status = "cancelled";
  }

  return {
    status,
    members: copied,
    completedCount,
    failedCount,
    cancelledCount,
  };
}
