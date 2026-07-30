/**
 * agent-runner-validator.ts — Adversarial validation loop for agent output.
 *
 * Extracted from agent-runner.ts to reduce its size (~100 fewer lines) and
 * to make validation logic independently testable. Depends on `runAgent` /
 * `resumeAgent` being injected as higher-order functions to avoid a circular
 * dependency with agent-runner.ts.
 *
 * ## Design
 *
 * The validation loop runs N validator agents (N ≤ MAX_CRITERIA_COUNT) against
 * the main agent's output, with up to VALIDATION_MAX_RETRIES self-healing
 * rounds when validation fails. Each validator runs with strict isolation:
 *   - `isolated: true` — no extension/MCP tools
 *   - `skipValidators: true` — no recursive validation
 *   - `levelLimit: 0` — no nested sub-agents
 *   - Tight quotas (50k tokens, 120s, 10 tool calls)
 *
 * On failure, `resumeAgent` is called with structured feedback so the main
 * agent can self-correct before the next retry round.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactionSnapshot } from "./compaction-snapshot.js";
import type { HookRegistry } from "./hooks.js";
import type { AgentConfig, ValidationResult } from "./types.js";
import {
  buildValidatorPrompt,
  getAgentDescription,
  hasValidators,
  parseValidationResult,
} from "./validators.js";

// ── Injected dependency types ──────────────────────────────────────────────
//
// These are kept minimal — structural types only — so the module doesn't need
// to import from agent-runner.ts. The two injected functions (runAgent /
// resumeAgent) are the only bridge back to the main runner.

/** Minimal shape of the `runAgent` options the validator loop needs. */
export interface ValidatorRunOptions {
  pi: ExtensionAPI;
  model?: Model<Api>;
  isolated: boolean;
  skipValidators: boolean;
  levelLimit: number;
  signal?: AbortSignal;
  quotas: { maxTokens: number; maxDurationMs: number; maxToolCalls: number };
}

/** Minimum return type from `runAgent` for the validator consumer. */
export interface ValidatorRunResult {
  responseText: string;
}

/** Signature of `runAgent` as consumed by this module. */
export type RunAgentFn = (
  ctx: ExtensionContext,
  type: string,
  prompt: string,
  options: ValidatorRunOptions,
) => Promise<ValidatorRunResult>;

/** Options for the injected `resumeAgent` call. */
export interface ValidatorResumeOptions {
  onToolActivity?: (activity: { type: "start" | "end"; toolName: string }) => void;
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  onCompaction?: (info: CompactionSnapshot) => void;
  signal?: AbortSignal;
}

/** Signature of `resumeAgent` as consumed by this module. */
export type ResumeAgentFn = (
  session: AgentSession,
  prompt: string,
  options: ValidatorResumeOptions,
) => Promise<string>;

/** All external dependencies the validation loop needs. */
export interface ValidationDeps {
  pi: ExtensionAPI;
  model?: Model<Api>;
  signal?: AbortSignal;
  hooks?: HookRegistry;
  runAgent: RunAgentFn;
  resumeAgent: ResumeAgentFn;
  onToolActivity?: (activity: { type: "start" | "end"; toolName: string }) => void;
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  onCompaction?: (info: CompactionSnapshot) => void;
  onValidationComplete?: (results: ValidationResult[]) => void;
}

/** Return type of the adversarial validation function. */
export interface ValidationOutput {
  responseText: string;
  validationResults?: ValidationResult[];
  validated?: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────

const VALIDATION_MAX_RETRIES = 2;

// ── Extracted Validation Loop ──────────────────────────────────────────────

/**
 * Run adversarial validation on an agent's output.
 *
 * Takes the current `responseText`, the `agentConfig` (for validators), and
 * the `session` (for self-healing via `resumeAgent`). Skips validation when
 * the agent has no validators configured or when `skipValidators` is true
 * (caller should check this before calling).
 *
 * @param session - Agent session, used for self-healing resume calls
 * @param ctx - Extension context for recursive runAgent calls
 * @param responseText - Current agent output to validate
 * @param agentConfig - Agent config (may have validators defined)
 * @param agentId - Agent ID for hook dispatch
 * @param deps - Injected dependencies (pi, model, signal, hooks, callbacks, runAgent, resumeAgent)
 * @returns Updated response text (may have been self-healed) and validation results
 */
export async function runAdversarialValidation(
  session: AgentSession,
  ctx: ExtensionContext,
  responseText: string,
  agentConfig: AgentConfig | undefined,
  agentId: string,
  deps: ValidationDeps,
): Promise<ValidationOutput> {
  // Early exit: no validators configured
  if (!hasValidators(agentConfig)) {
    return { responseText, validationResults: undefined, validated: undefined };
  }

  const validators = agentConfig!.validators!;
  const agentDescription = getAgentDescription(agentConfig);
  let currentText = responseText;
  let validationResults: ValidationResult[] | undefined;
  let validated: boolean | undefined;
  let retries = 0;

  while (retries <= VALIDATION_MAX_RETRIES) {
    deps.hooks?.dispatch("validation:start", agentId, {
      attempt: retries + 1,
      validatorCount: validators.length,
    }).catch(() => {});

    const validatorPromises = validators.map((v) =>
      deps.runAgent(ctx, v.agentId, buildValidatorPrompt(currentText, v.criteria, agentDescription), {
        pi: deps.pi,
        model: deps.model,
        isolated: true,
        skipValidators: true,
        levelLimit: 0,
        signal: deps.signal,
        quotas: { maxTokens: 50_000, maxDurationMs: 120_000, maxToolCalls: 10 },
      })
        .then((result) => parseValidationResult(result.responseText, v.agentId))
        .catch((err) => ({
          agentId: v.agentId,
          passed: false,
          criteria: [],
          summary: `Validator error: ${err instanceof Error ? err.message : String(err)}`,
        })),
    );

    validationResults = await Promise.all(validatorPromises);
    validated = validationResults.every((r) => r.passed);

    deps.hooks?.dispatch("validation:end", agentId, {
      passed: validated,
      results: validationResults,
    }).catch(() => {});

    if (validated || retries >= VALIDATION_MAX_RETRIES) {
      deps.onValidationComplete?.(validationResults);
      break;
    }

    // Self-healing feedback
    const failedFeedback = validationResults
      .filter((r) => !r.passed)
      .map((r) => {
        const failedCriteria = r.criteria.filter((c) => !c.passed);
        const details = failedCriteria.length > 0
          ? `\n${failedCriteria.map((c) => `  - ${c.criterion}: ${c.feedback}`).join("\n")}`
          : "";
        return `[${r.agentId}] ${r.summary}${details}`;
      })
      .join("\n\n");

    const fixPrompt = `Validation failed. Please fix the following issues and provide an updated final response:\n\n${failedFeedback}`;

    try {
      currentText = await deps.resumeAgent(session, fixPrompt, {
        onToolActivity: deps.onToolActivity,
        onAssistantUsage: deps.onAssistantUsage,
        onCompaction: deps.onCompaction,
        signal: deps.signal,
      });
    } catch {
      deps.onValidationComplete?.(validationResults);
      break;
    }

    retries++;
  }

  return { responseText: currentText, validationResults, validated };
}
