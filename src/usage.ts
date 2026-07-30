/** * usage.ts — Token usage: shapes, accumulator operators, session-stats readers.
 */

/**
 * Lifetime usage components, accumulated via `message_end` events. Survives
 * compaction. cacheRead is excluded because each turn's cacheRead is
 * the cumulative cached prefix re-read on that one call.
 */
export interface LifetimeUsage {
    input: number;
    output: number;
    cacheWrite: number;
}

/** Sum of lifetime usage components, or 0 if undefined. */
export function getLifetimeTotal(u?: LifetimeUsage): number {
    return u ? u.input + u.output + u.cacheWrite : 0;
}

/** Add a usage delta into a target accumulator (mutates target). */
export function addUsage(into: LifetimeUsage, delta: LifetimeUsage): void {
    into.input += delta.input;
    into.output += delta.output;
    into.cacheWrite += delta.cacheWrite;
}

/** Minimal shape we read from upstream `getSessionStats()`. */
export interface SessionStatsLike {
    tokens: { input: number; output: number; cacheWrite: number; cacheRead?: number; total?: number };
    contextUsage?: { percent: number | null };
}

export interface SessionLike {
    getSessionStats(): SessionStatsLike;
}

/**
 * Session-scoped token count: input + output + cacheWrite as reported by
 * upstream `getSessionStats().tokens`.
 *
 * On Pi 0.81+, these totals aggregate assistant, toolResult, compaction, and
 * branch-summary usage across the session (they do not reset at compaction).
 * For the orchestrator's own accumulator, use `getLifetimeTotal`.
 */
export function getSessionTokens(session?: SessionLike): number {
    try {
        const t = session?.getSessionStats?.()?.tokens;
        return t ? t.input + t.output + t.cacheWrite : 0;
    } catch {
        return 0;
    }
}

/**
 * Context-window utilization (0–100), or null when unavailable.
 */
export function getSessionContextPercent(session?: SessionLike): number | null {
    try {
        return session?.getSessionStats?.()?.contextUsage?.percent ?? null;
    } catch {
        return null;
    }
}
