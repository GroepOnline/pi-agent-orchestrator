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
