/**
 * batch-orchestrator.ts — Enterprise Batch Orchestration Engine
 *
 * Manages batch tracking for background agents spawned in the current turn.
 * Debounced timer captures parallel tool calls across microtasks.
 * Integrates with GroupJoinManager (fixed groups) and SwarmCoordinator
 * (dynamic collaborative swarms) with full async lifecycle support.
 */

import type { AgentManager } from "./agent-manager.js";
import { GroupJoinManager } from "./group-join.js";
import { logger } from "./logger.js";
import { type SwarmConfig, SwarmCoordinator, type SwarmStrategy } from "./swarm-join.js";
import type { AgentRecord, JoinMode } from "./types.js";

export interface BatchOrchestratorDeps {
  manager: AgentManager;
  groupJoin: GroupJoinManager;
  swarmJoin: SwarmCoordinator;
  onAgentHandled: (record: AgentRecord) => void;
  onWidgetUpdate: () => void;
}

export interface BatchConfig {
  /** Debounce window for batch finalization (ms). Default: 100. */
  debounceMs?: number;
  /** Minimum agents to form a smart group. Default: 2. */
  smartGroupThreshold?: number;
  /** Minimum agents to form a swarm. Default: 1. */
  swarmThreshold?: number;
  /** Default swarm strategy when not specified. Default: "live". */
  defaultSwarmStrategy?: SwarmStrategy;
  /** Default swarm config overrides. */
  defaultSwarmConfig?: Partial<Omit<SwarmConfig, "swarmId">>;
  /** Callback when a batch is finalized. */
  onBatchFinalized?: (batchId: number, stats: BatchStats) => void;
}

export interface BatchStats {
  batchId: number;
  totalAgents: number;
  smartGroups: number;
  swarmCount: number;
  individualAgents: number;
  durationMs: number;
}

interface PendingAgent {
  id: string;
  joinMode: JoinMode;
  /** Optional per-agent swarm strategy override. */
  swarmStrategy?: SwarmStrategy;
  addedAt: number;
}

export class BatchOrchestrator {
  private currentBatch: PendingAgent[] = [];
  private batchFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
  private batchCounter = 0;
  private config: Required<Pick<BatchConfig, "debounceMs" | "smartGroupThreshold" | "swarmThreshold">> &
    Omit<BatchConfig, "debounceMs" | "smartGroupThreshold" | "swarmThreshold">;
  private isFinalizing = false;
  private batchStartTime = 0;
  /**
   * Pending mid-fanout partial mark: members of the intended fan-out that
   * will never spawn. Consumed by the next finalizeBatch together with the
   * batch it was marked against.
   */
  private pendingPartialFanout: { missingCount: number } | undefined;

  constructor(
    private deps: BatchOrchestratorDeps,
    config: BatchConfig = {},
  ) {
    this.config = {
      debounceMs: 100,
      smartGroupThreshold: 2,
      swarmThreshold: 1,
      ...config,
    };
  }

  /**
   * Add an agent to the current batch.
   * Resets the debounce timer to capture parallel tool calls.
   */
  addToBatch(id: string, joinMode: JoinMode, options?: { strategy?: SwarmStrategy }): void {
    // Prevent adding duplicates
    const existing = this.currentBatch.find((a) => a.id === id);
    if (existing) {
      existing.joinMode = joinMode;
      if (options?.strategy) existing.swarmStrategy = options.strategy;
      return;
    }

    if (this.currentBatch.length === 0) {
      this.batchStartTime = Date.now();
    }

    this.currentBatch.push({
      id,
      joinMode,
      swarmStrategy: options?.strategy,
      addedAt: Date.now(),
    });

    if (this.batchFinalizeTimer) clearTimeout(this.batchFinalizeTimer);
    this.batchFinalizeTimer = setTimeout(() => this.finalizeBatch(), this.config.debounceMs);
  }

  /**
   * Mark the current pending batch as a partial fan-out: `missingCount`
   * members of the intended dispatch will never spawn (mid-fanout failure).
   * The next finalization forms the surviving group with an explicit
   * missing-members count so it never finalizes as unqualified success.
   * No-op when nothing is pending or the count is not positive — with zero
   * survivors there is no group to finalize, and a mark must never leak into
   * an unrelated later batch.
   */
  markBatchPartial(missingCount: number): void {
    if (!Number.isFinite(missingCount) || missingCount <= 0) return;
    if (this.currentBatch.length === 0) return;
    const prev = this.pendingPartialFanout?.missingCount ?? 0;
    this.pendingPartialFanout = { missingCount: prev + missingCount };
  }

  /**
   * Force immediate finalization of the current batch.
   * Useful for shutdown or explicit flush scenarios.
   */
  async flush(): Promise<void> {
    if (this.batchFinalizeTimer) {
      clearTimeout(this.batchFinalizeTimer);
      this.batchFinalizeTimer = undefined;
    }
    if (this.currentBatch.length > 0 && !this.isFinalizing) {
      await this.finalizeBatch();
    }
  }

  /**
   * Finalize the current batch:
   * - smart/group agents → fixed GroupJoinManager groups
   * - swarm agents → dynamic SwarmCoordinator with full config support
   * - leftovers → individual nudges
   */
  private async finalizeBatch(): Promise<void> {
    if (this.isFinalizing || this.currentBatch.length === 0) return;
    this.isFinalizing = true;
    this.batchFinalizeTimer = undefined;

    const batchAgents = [...this.currentBatch];
    this.currentBatch = [];
    const missingMembers = this.pendingPartialFanout?.missingCount ?? 0;
    this.pendingPartialFanout = undefined;
    const batchId = ++this.batchCounter;
    const startTime = this.batchStartTime;

    try {
      // Partition agents by join mode.
      // smart and group share the same GroupJoinManager path (smart ≡ group for batching).
      const smartAgents = batchAgents.filter((a) => a.joinMode === "smart" || a.joinMode === "group");
      const swarmAgents = batchAgents.filter((a) => a.joinMode === "swarm");
      const _individualAgents = batchAgents.filter(
        (a) => a.joinMode !== "smart" && a.joinMode !== "group" && a.joinMode !== "swarm",
      );

      const handled = new Set<string>();
      let smartGroups = 0;
      let swarmCount = 0;

      // --- Smart/Group batching ---
      // A partial fan-out (mid-fanout spawn failure) forces a group even below
      // the threshold so the survivors finalize with an explicit missing-member
      // count instead of individual nudges that hide the loss (R5).
      const forceGroup = missingMembers > 0 && smartAgents.length > 0;
      if (smartAgents.length >= this.config.smartGroupThreshold || forceGroup) {
        const groupId = `batch-${batchId}-group`;
        const ids = smartAgents.map((a) => a.id);
        for (const id of ids) handled.add(id);
        smartGroups++;

        if (missingMembers > 0) {
          this.deps.groupJoin.registerGroup(groupId, ids, { missingMembers });
        } else {
          this.deps.groupJoin.registerGroup(groupId, ids);
        }
        for (const { id } of smartAgents) {
          const record = this.deps.manager.getRecord(id);
          if (!record) continue;
          record.groupId = groupId;
          if (record.completedAt != null && !record.resultConsumed) {
            this.deps.groupJoin.onAgentComplete(record);
          }
        }
      }

      // --- Swarm batching ---
      if (swarmAgents.length >= this.config.swarmThreshold) {
        const strategy = this.config.defaultSwarmStrategy || "live";
        const swarmId = this.deps.swarmJoin.createSwarm({
          name: `Batch-${batchId} Swarm`,
          strategy,
          ...(missingMembers > 0 ? { missingMembers } : {}),
          ...this.config.defaultSwarmConfig,
        });
        swarmCount++;

        for (const { id } of swarmAgents) {
          this.deps.swarmJoin.addAgentToSwarm(swarmId, id);
          // If agent already completed before batch finalization, process it
          const record = this.deps.manager.getRecord(id);
          if (!record) continue;
          record.swarmId = swarmId;
          if (record.completedAt != null && !record.resultConsumed) {
            this.deps.swarmJoin.onAgentComplete(record);
          }
        }
        for (const { id } of swarmAgents) handled.add(id);
      }

      // --- Individual leftovers ---
      for (const { id } of batchAgents) {
        if (handled.has(id)) continue;
        const record = this.deps.manager.getRecord(id);
        if (record?.completedAt != null && !record.resultConsumed) {
          this.deps.onAgentHandled(record);
        }
      }

      // Stats callback
      const stats: BatchStats = {
        batchId,
        totalAgents: batchAgents.length,
        smartGroups,
        swarmCount,
        individualAgents: batchAgents.length - handled.size,
        durationMs: Date.now() - startTime,
      };
      this.config.onBatchFinalized?.(batchId, stats);

      logger.debug(`Batch finalized`, { ...stats } as Record<string, unknown>);
    } catch (err) {
      logger.error(`Batch finalization failed`, {
        batchId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Fallback: nudge all individually to prevent deadlock
      for (const { id } of batchAgents) {
        const record = this.deps.manager.getRecord(id);
        if (record?.completedAt != null && !record.resultConsumed) {
          this.deps.onAgentHandled(record);
        }
      }
    } finally {
      this.isFinalizing = false;
      this.deps.onWidgetUpdate();
    }
  }

  /**
   * Check if an agent is currently pending batch finalization.
   */
  isPendingBatchFinalization(agentId: string): boolean {
    return this.currentBatch.some((a) => a.id === agentId);
  }

  /**
   * Get current pending batch info (for UI/dashboard).
   */
  getPendingBatch(): { agents: PendingAgent[]; timeUntilFlushMs: number } | null {
    if (this.currentBatch.length === 0) return null;
    const oldest = Math.min(...this.currentBatch.map((a) => a.addedAt));
    const timeUntilFlushMs = Math.max(0, this.config.debounceMs - (Date.now() - oldest));
    return { agents: [...this.currentBatch], timeUntilFlushMs };
  }

  /**
   * Clean up resources (clear timer, reset state, flush pending).
   */
  async dispose(): Promise<void> {
    await this.flush();
    if (this.batchFinalizeTimer) {
      clearTimeout(this.batchFinalizeTimer);
      this.batchFinalizeTimer = undefined;
    }
    this.currentBatch = [];
    this.pendingPartialFanout = undefined;
  }
}
