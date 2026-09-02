/**
 * spend.ts — Token/cost accounting for per-subagent budget warnings.
 *
 * Pure functions over the pi-ai model `cost` shape (same source as the
 * free-only gate in agent-runner): rates are $ per million tokens.
 * Free models (all-zero cost) report "free" and never trip spend warnings.
 */

/** Subset of the pi-ai Model cost shape this module needs. */
export interface ModelCost {
  input?: number;
  output?: number;
  cacheWrite?: number;
  cacheRead?: number;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead?: number;
}

const PER_MILLION = 1_000_000;

/**
 * Estimated USD cost for accumulated usage at the given model's rates.
 * Missing cost fields count as free; a missing/zero-everything model → 0.
 */
export function estimateCostUsd(cost: ModelCost | undefined, u: UsageTotals): number {
  if (!cost) return 0;
  const part = (rate: number | undefined, tokens: number) => ((rate ?? 0) * tokens) / PER_MILLION;
  return (
    part(cost.input, u.input)
    + part(cost.output, u.output)
    + part(cost.cacheWrite, u.cacheWrite ?? 0)
    + part(cost.cacheRead, u.cacheRead ?? 0)
  );
}

/** Compact display: "$1.23" / "<$0.01" / "$0.00". */
export function formatSpend(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** Total billable-ish tokens (input + output; cache tracked separately by callers). */
export function totalTokens(u: UsageTotals): number {
  return u.input + u.output;
}

/**
 * Utilization percentage of a cap: floor(used / cap * 100).
 *
 * Single source of truth for budget-warning percentages (R1): the result is
 * NEVER clamped, so going over the cap yields >100 (30/25 → 120) and the
 * percentage always matches the rendered counter ratio. A non-positive cap
 * yields 0 instead of Infinity/NaN (render sites never pass one: the manager
 * only fires a warning after checking the cap is positive).
 */
export function utilization(used: number, cap: number): number {
  if (cap <= 0) return 0;
  return Math.floor((used / cap) * 100);
}

/**
 * "N% used (used/cap)" for budget-warning lines. The percentage and the
 * counter are derived from the SAME used/cap pair, so they can never
 * disagree — including at and above the cap (25/25 → "100% used (25/25)",
 * 30/25 → "120% used (30/25)").
 */
export function utilizationLabel(used: number, cap: number): string {
  return `${utilization(used, cap)}% used (${used}/${cap})`;
}

/**
 * Operator actions named by every session budget warning (R3): raise the
 * limit, restart the session, or deny further work.
 */
const SESSION_BUDGET_ACTION =
  "Raise the limit via /agents → Settings, restart the session for a fresh budget, or deny further work.";

/** Input for a session-level budget warning (agent count or turn count threshold). */
export interface SessionBudgetWarningInput {
  kind: "agents" | "turns";
  used: number;
  cap: number;
  /** True for the 90% thresholds, where enforcement is imminent. */
  critical: boolean;
}

/**
 * Full text of a session budget warning (R1 + R3): the percentage and the
 * counter come from the same used/cap pair via utilizationLabel, and the
 * message names concrete operator actions — raise the limit, restart the
 * session, or deny further work. The critical (90%) variants lead with the
 * imminent-stop consequence.
 */
export function sessionBudgetWarningMessage({ kind, used, cap, critical }: SessionBudgetWarningInput): string {
  const noun = kind === "agents" ? "agent" : "turn";
  const prefix = critical ? "🚨" : "⚠️";
  const consequence = critical
    ? (kind === "agents" ? "Spawns will stop soon — " : "Agents will stop soon — ")
    : "";
  return `${prefix} Session ${noun} budget ${utilizationLabel(used, cap)}. ${consequence}${SESSION_BUDGET_ACTION}`;
}

/**
 * Full text of a per-agent token-cap warning (R1 + R3). `thresholdPct` is
 * the crossed threshold (50/80/100); the rendered percentage routes through
 * `utilization` so it always matches the counter. The hint names the two
 * actions that apply to a per-agent cap: raise it via settings, or deny
 * further work for the agent (it aborts at the cap).
 */
export function spendBudgetWarningMessage(input: {
  thresholdPct: number;
  perAgentTokenLimit: number;
  agentCount: number;
}): string {
  const pct = utilization(input.thresholdPct, 100);
  const prefix = pct === 100 ? "🚨" : "⚠️";
  const action = pct === 100
    ? "The agent aborts at the cap — raise the per-agent token cap via /agents → Settings, or deny further work for this agent."
    : "Raise the per-agent token cap via /agents → Settings, or deny further heavy work for this agent.";
  return `${prefix} Subagent token budget ${pct}% used (${input.agentCount} agent(s) capped at ${input.perAgentTokenLimit} tokens). ${action}`;
}
