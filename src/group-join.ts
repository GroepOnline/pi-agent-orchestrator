/**
 * group-join.ts — Enterprise Group Join Manager
 *
 * Manages fixed background agent completion notifications with:
 * - Event-driven state changes (for dashboard/UI observability)
 * - Delivery retry with exponential backoff
 * - Partial delivery strategies (all-or-nothing vs. progressive)
 * - Health monitoring and timeout escalation
 * - Metrics collection
 *
 * Unlike SwarmCoordinator (dynamic), groups are fixed at spawn time
 * and deliver consolidated notifications when all complete (or timeout).
 */

import { logger } from "./logger.js";
import type { AgentRecord } from "./types.js";

export type DeliveryCallback = (records: AgentRecord[], partial: boolean, meta?: GroupDeliveryMeta) => void;

export interface GroupDeliveryMeta {
  groupId: string;
  totalAgents: number;
  completedAgents: number;
  timedOut: boolean;
  durationMs: number;
  retryAttempt?: number;
  /**
   * Members that never joined this group because their spawn failed
   * mid-fanout. Absent when the group spawned complete. Lets the delivery
   * layer render an explicit partial status naming spawned/missing counts
   * even when every spawned member completed.
   */
  missingMembers?: number;
}

export type GroupEvent =
  | { type: "agent:completed"; agentId: string; timestamp: number }
  | { type: "agent:timeout"; agentId: string; timestamp: number }
  | { type: "delivery:attempt"; records: AgentRecord[]; partial: boolean; attempt: number; timestamp: number }
  | { type: "delivery:success"; records: AgentRecord[]; partial: boolean; timestamp: number }
  | { type: "delivery:failed"; error: string; attempt: number; timestamp: number }
  | { type: "group:created"; timestamp: number }
  | { type: "group:disposed"; timestamp: number };

export interface GroupConfig {
  groupId: string;
  agentIds: string[];
  /** Timeout after first completion (ms). Default: 30s. */
  timeout?: number;
  /** Shorter timeout for stragglers after partial delivery (ms). Default: 15s. */
  stragglerTimeout?: number;
  /** Max retries for delivery callback failure. Default: 3. */
  maxRetries?: number;
  /** Backoff multiplier for retries. Default: 2. */
  retryBackoff?: number;
  /** If true, deliver progressively as agents complete. Default: false (all-or-nothing). */
  progressiveDelivery?: boolean;
  /**
   * Members that will never join this group (mid-fanout spawn failure).
   * Surfaced in the delivery meta so the group finalizes with an explicit
   * partial status instead of unqualified success. Default: 0.
   */
  missingMembers?: number;
  /** Callback for group lifecycle events. */
  onEvent?: (groupId: string, event: GroupEvent) => void;
}

interface AgentGroup {
  config: GroupConfig;
  agentIds: Set<string>;
  completedRecords: Map<string, AgentRecord>;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  delivered: boolean;
  isStraggler: boolean;
  createdAt: number;
  firstCompletionAt?: number;
  retryCount: number;
  retryHandle?: ReturnType<typeof setTimeout>;
  missingMembers: number;
}

const DEFAULT_TIMEOUT = 30_000;
const STRAGGLER_TIMEOUT = 15_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BACKOFF = 2;
const RETRY_BASE_DELAY_MS = 500;

export class GroupJoinManager {
  private groups = new Map<string, AgentGroup>();
  private agentToGroup = new Map<string, string>();
  private deliverCb: DeliveryCallback;
  private defaultGroupTimeout?: number;

  constructor(
    deliverCb: DeliveryCallback,
    groupTimeout?: number,
  ) {
    this.deliverCb = deliverCb;
    this.defaultGroupTimeout = groupTimeout;
  }

  /** Register a group with full configuration. */
  registerGroup(config: GroupConfig): void;
  /** Legacy: register a group of agent IDs, optionally marking members that will never join (mid-fanout spawn failure). */
  registerGroup(groupId: string, agentIds: string[], opts?: { missingMembers?: number }): void;
  registerGroup(configOrId: GroupConfig | string, agentIds?: string[], opts?: { missingMembers?: number }): void {
    let config: GroupConfig;
    if (typeof configOrId === "string") {
      config = {
        groupId: configOrId,
        agentIds: agentIds || [],
        timeout: this.defaultGroupTimeout,
        ...(opts?.missingMembers ? { missingMembers: opts.missingMembers } : {}),
      };
    } else {
      config = configOrId;
    }

    const group: AgentGroup = {
      config,
      agentIds: new Set(config.agentIds),
      completedRecords: new Map(),
      delivered: false,
      isStraggler: false,
      createdAt: Date.now(),
      retryCount: 0,
      missingMembers: config.missingMembers ?? 0,
    };

    this.groups.set(config.groupId, group);
    for (const id of config.agentIds) {
      this.agentToGroup.set(id, config.groupId);
    }

    this.emit(group, { type: "group:created", timestamp: Date.now() });
  }

  /**
   * Called when an agent completes.
   * Returns:
   * - 'pass'      — agent is not grouped, caller should send individual nudge
   * - 'held'      — result held, waiting for group completion
   * - 'delivered'  — this completion triggered the group notification
   */
  onAgentComplete(record: AgentRecord): "delivered" | "held" | "pass" {
    const groupId = this.agentToGroup.get(record.id);
    if (!groupId) return "pass";

    const group = this.groups.get(groupId);
    if (!group || group.delivered) return "pass";

    group.completedRecords.set(record.id, record);
    this.emit(group, { type: "agent:completed", agentId: record.id, timestamp: Date.now() });

    // Track first completion time for duration metrics
    if (!group.firstCompletionAt) {
      group.firstCompletionAt = Date.now();
    }

    // All done — deliver immediately
    if (group.completedRecords.size >= group.agentIds.size) {
      this.deliver(group, false);
      return "delivered";
    }

    // Progressive delivery: send what we have so far (if enabled)
    if (group.config.progressiveDelivery) {
      this.deliver(group, true);
    }

    // First completion in this batch — start timeout
    if (!group.timeoutHandle) {
      const timeout = group.isStraggler
        ? (group.config.stragglerTimeout ?? STRAGGLER_TIMEOUT)
        : (group.config.timeout ?? DEFAULT_TIMEOUT);
      group.timeoutHandle = setTimeout(() => this.onTimeout(group), timeout);
    }

    return "held";
  }

  /**
   * Mark an agent as timed out / failed.
   */
  onAgentTimeout(agentId: string): boolean {
    const groupId = this.agentToGroup.get(agentId);
    if (!groupId) return false;

    const group = this.groups.get(groupId);
    if (!group || group.delivered) return false;

    this.emit(group, { type: "agent:timeout", agentId, timestamp: Date.now() });

    // Remove from active set so we don't wait forever
    group.agentIds.delete(agentId);
    this.agentToGroup.delete(agentId);

    // If everyone else is done, deliver now
    if (group.completedRecords.size >= group.agentIds.size) {
      this.deliver(group, true);
      if (group.agentIds.size === 0 && !group.retryHandle) {
        this.cleanupGroup(groupId);
      }
      return true;
    }

    return true;
  }

  private onTimeout(group: AgentGroup): void {
    if (group.delivered) return;
    group.timeoutHandle = undefined;

    // Partial delivery — some agents still running
    const remaining = new Set<string>();
    for (const id of group.agentIds) {
      if (!group.completedRecords.has(id)) remaining.add(id);
    }

    // Clean up agentToGroup for delivered agents
    for (const id of group.completedRecords.keys()) {
      this.agentToGroup.delete(id);
    }

    // Deliver what we have
    this.deliver(group, true);

    // Set up straggler group for remaining agents
    group.completedRecords.clear();
    group.agentIds = remaining;
    group.isStraggler = true;
    // Timeout will be started when the next straggler completes
  }

  private deliver(group: AgentGroup, partial: boolean): void {
    if (group.timeoutHandle) {
      clearTimeout(group.timeoutHandle);
      group.timeoutHandle = undefined;
    }
    group.delivered = !partial;

    const records = [...group.completedRecords.values()];
    const duration = group.firstCompletionAt ? Date.now() - group.firstCompletionAt : 0;

    const meta: GroupDeliveryMeta = {
      groupId: group.config.groupId,
      totalAgents: group.agentIds.size + group.completedRecords.size,
      completedAgents: group.completedRecords.size,
      timedOut: partial,
      durationMs: duration,
      retryAttempt: group.retryCount,
      ...(group.missingMembers > 0 ? { missingMembers: group.missingMembers } : {}),
    };

    this.emit(group, { type: "delivery:attempt", records, partial, attempt: group.retryCount + 1, timestamp: Date.now() });

    try {
      this.deliverCb(records, partial, meta);
      this.emit(group, { type: "delivery:success", records, partial, timestamp: Date.now() });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(`Group delivery failed`, { groupId: group.config.groupId, error, attempt: group.retryCount + 1 });
      this.emit(group, { type: "delivery:failed", error, attempt: group.retryCount + 1, timestamp: Date.now() });

      // Retry with exponential backoff
      const maxRetries = group.config.maxRetries ?? DEFAULT_MAX_RETRIES;
      if (group.retryCount < maxRetries) {
        group.retryCount++;
        const delay = RETRY_BASE_DELAY_MS * Math.pow(group.config.retryBackoff ?? DEFAULT_RETRY_BACKOFF, group.retryCount - 1);
        group.retryHandle = setTimeout(() => {
          group.delivered = false; // Reset to allow redelivery
          this.deliver(group, partial);
        }, delay);
        return; // Don't cleanup yet, retry pending
      }
    }

    if (!partial) {
      this.cleanupGroup(group.config.groupId);
    }
  }

  private cleanupGroup(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group) return;

    if (group.retryHandle) clearTimeout(group.retryHandle);
    for (const id of group.agentIds) {
      this.agentToGroup.delete(id);
    }
    for (const id of group.completedRecords.keys()) {
      this.agentToGroup.delete(id);
    }

    this.groups.delete(groupId);
    this.emit(group, { type: "group:disposed", timestamp: Date.now() });
  }

  private emit(group: AgentGroup, event: GroupEvent): void {
    try {
      group.config.onEvent?.(group.config.groupId, event);
    } catch (err) {
      logger.warn(`Group event handler failed`, {
        groupId: group.config.groupId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Check if an agent is in a group. */
  isGrouped(agentId: string): boolean {
    return this.agentToGroup.has(agentId);
  }

  /** Get group info for dashboard. */
  getGroupInfo(groupId: string): { total: number; completed: number; delivered: boolean; isStraggler: boolean } | undefined {
    const group = this.groups.get(groupId);
    if (!group) return undefined;
    return {
      total: group.agentIds.size + group.completedRecords.size,
      completed: group.completedRecords.size,
      delivered: group.delivered,
      isStraggler: group.isStraggler,
    };
  }

  listGroups(): string[] {
    return [...this.groups.keys()];
  }

  dispose(): void {
    for (const group of this.groups.values()) {
      if (group.timeoutHandle) clearTimeout(group.timeoutHandle);
      if (group.retryHandle) clearTimeout(group.retryHandle);
    }
    this.groups.clear();
    this.agentToGroup.clear();
  }
}
