/**
 * compaction-snapshot.ts — Upstream Pi compaction observation shape.
 *
 * Runtime truth (#325): subagent sessions compact via Pi `AgentSession`
 * auto-compaction. This module maps `compaction_end` events (incl. 0.81
 * `usage` / `estimatedTokensAfter` / retry fields) into a stable snapshot
 * stored on `AgentRecord.lastCompaction`.
 */

import type { LifetimeUsage } from "./usage.js";

export type CompactionReason = "manual" | "threshold" | "overflow";

/** Observed metrics from the most recent upstream compaction attempt. */
export interface CompactionSnapshot {
  reason: CompactionReason;
  tokensBefore: number;
  tokensAfter?: number;
  reductionPercent?: number;
  firstKeptEntryId?: string;
  /** Summarization LLM usage charged during compaction (Pi 0.81+). */
  usage?: LifetimeUsage;
  aborted?: boolean;
  willRetry?: boolean;
  errorMessage?: string;
}

export interface UpstreamCompactionEndEvent {
  reason: CompactionReason;
  aborted: boolean;
  willRetry?: boolean;
  errorMessage?: string;
  result?: {
    tokensBefore?: number;
    estimatedTokensAfter?: number;
    firstKeptEntryId?: string;
    usage?: {
      input?: number;
      output?: number;
      cacheWrite?: number;
    };
  };
}

/** Map a Pi `compaction_end` event into an orchestrator snapshot. */
export function buildCompactionSnapshot(event: UpstreamCompactionEndEvent): CompactionSnapshot {
  const tokensBefore = event.result?.tokensBefore ?? 0;
  const tokensAfter = event.result?.estimatedTokensAfter;
  const usageRaw = event.result?.usage;
  const usage = usageRaw
    ? {
        input: usageRaw.input ?? 0,
        output: usageRaw.output ?? 0,
        cacheWrite: usageRaw.cacheWrite ?? 0,
      }
    : undefined;

  let reductionPercent: number | undefined;
  if (tokensAfter !== undefined && tokensBefore > 0) {
    reductionPercent = Math.round(((tokensBefore - tokensAfter) / tokensBefore) * 100);
  }

  return {
    reason: event.reason,
    tokensBefore,
    ...(tokensAfter !== undefined ? { tokensAfter } : {}),
    ...(reductionPercent !== undefined ? { reductionPercent } : {}),
    ...(event.result?.firstKeptEntryId ? { firstKeptEntryId: event.result.firstKeptEntryId } : {}),
    ...(usage ? { usage } : {}),
    aborted: event.aborted,
    ...(event.willRetry !== undefined ? { willRetry: event.willRetry } : {}),
    ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
  };
}
