import { logger } from "./logger.js";
/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * Background agents are subject to a configurable concurrency limit (default: 3).
 * Excess agents are queued and auto-started as running agents complete.
 * Foreground agents bypass the queue (they block the parent anyway).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export const activeAgentStorage = new AsyncLocalStorage<string>();

import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resumeAgent, runAgent, type ToolActivity } from "./agent-runner.js";
import { getConfig } from "./agent-types.js";
import type { CompactionSnapshot } from "./compaction-snapshot.js";
import { type HookRegistry } from "./hooks.js";
import { totalTokens } from "./spend.js";
import { generateCorrelationId } from "./telemetry-otel.js";
import type { AgentInvocation, AgentRecord, IsolationMode, SubagentType, ThinkingLevel } from "./types.js";
import { addUsage } from "./usage.js";
import { cleanupWorktree, createWorktree, pruneWorktrees, } from "./worktree.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
/** Observed upstream compaction metrics (Pi `compaction_end`). */
export type CompactionInfo = CompactionSnapshot;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;

export type BudgetWarningType = "agents_at_80" | "turns_at_80" | "agents_at_90" | "turns_at_90" | "spend_50" | "spend_80" | "spend_100";
export type OnBudgetWarning = (type: BudgetWarningType, usage: { spawnedAgents: number; totalTurns: number }, limits: { maxAgents: number; maxTurns: number }) => void;

/** Default max concurrent background agents. */
/** Fresh-install default: keep typical fan-out in the 1–3 agent range. */
const DEFAULT_MAX_CONCURRENT = 3;

export interface SessionLimits {
  maxAgentsPerSession?: number;
  maxTotalTurnsPerSession?: number;
}

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

interface SpawnOptions {
  description: string;
  model?: Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  /**
   * Skip the maxConcurrent queue check for this spawn — start immediately even
   * if the configured concurrency limit would otherwise queue it. Used by the
   * scheduler so a fired job can't be deferred past its trigger window.
   */
  bypassQueue?: boolean;
  /** Isolation mode — "worktree" creates a temp git worktree for the agent. */
  isolation?: IsolationMode;
  /** Resolved invocation snapshot captured for UI display. */
  invocation?: AgentInvocation;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called when the agent session is created (for accessing session stats). */
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
  /** Nesting depth for this spawn (0 = root). Passed through to the agent record and runner. */
  currentLevel?: number;
  /**
   * Optional override for the auto-generated 8-hex-char correlation id.
   * When omitted, `AgentManager.spawn` calls `generateCorrelationId()` so
   * every record is guaranteed to have one. Pass a deterministic value in
   * tests to make span assertions stable.
   */
  correlationId?: string;
}

interface CompletionGate {
  promise: Promise<string>;
  resolve: (value: string) => void;
  reject: (reason?: unknown) => void;
  settled: boolean;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private maxConcurrent: number;
  private sessionLimits: SessionLimits = {};
  private sessionUsage = { spawnedAgents: 0, totalTurns: 0 };
  private lastTurnCounts = new Map<string, number>();
  /** Once-per-threshold guards so budget warnings fire a single time each. */
  private firedBudgetThresholds = new Set<string>();
  /** Per-agent token cap for spend warnings (0 = off). */
  private perAgentTokenLimit = 0;
  private sessionMaxSpawns = 0;
  private sessionMaxTurns = 0;
  hooks?: HookRegistry;
  onBudgetWarning?: OnBudgetWarning;

  /** Queue of background agents waiting to start. */
  private queue: { id: string; args: SpawnArgs }[] = [];
  /** Number of currently running background agents. */
  private runningBackground = 0;
  /**
   * Spawn-time completion gates. Every record gets one promise before `spawn()`
   * returns; start/abort/startup-failure paths settle it exactly once.
   */
  private completionGates = new Map<string, CompletionGate>();

  /** Cleanup TTL: completed agents older than this are pruned periodically. */
  private cleanupTtlMs: number;

  constructor(
    onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onStart?: OnAgentStart,
    onCompact?: OnAgentCompact,
    /**
     * Cleanup TTL in milliseconds: completed/stopped/errored agents older than
     * this are pruned from memory during periodic cleanup cycles.
     * Default: 60 seconds (down from 120s to reduce memory pressure during long sessions).
     */
    cleanupTtlMs = 60_000,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.onCompact = onCompact;
    this.maxConcurrent = maxConcurrent;
    this.cleanupTtlMs = cleanupTtlMs;
    const CLEANUP_INTERVAL_MS = 30_000;
    this.cleanupInterval = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    this.cleanupInterval.unref();
  }

  /**
   * Set a new cleanup TTL. Completed/stopped/errored agents older than this
   * value will be pruned on the next periodic cleanup cycle.
   */
  setCleanupTtl(ms: number): void {
    this.cleanupTtlMs = Math.max(10_000, ms);
  }

  /** Get the current cleanup TTL in milliseconds. */
  getCleanupTtl(): number {
    return this.cleanupTtlMs;
  }

  /** Update the max concurrent background agents limit. */
  setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, n);
    // Start queued agents if the new limit allows
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  setSessionLimits(limits: SessionLimits): void {
    const agents = limits.maxAgentsPerSession;
    const turns = limits.maxTotalTurnsPerSession;
    this.setSessionMaxSpawns(
      agents !== undefined && Number.isInteger(agents) && agents > 0 ? agents : 0,
    );
    this.setSessionMaxTurns(
      turns !== undefined && Number.isInteger(turns) && turns > 0 ? turns : 0,
    );
  }

  getSessionLimits(): SessionLimits {
    return { ...this.sessionLimits };
  }

  setSessionMaxSpawns(n: number): void {
    const normalized = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
    this.sessionMaxSpawns = normalized;
    this.sessionLimits.maxAgentsPerSession = normalized > 0 ? normalized : undefined;
  }

  getSessionMaxSpawns(): number {
    return this.sessionMaxSpawns;
  }

  setSessionMaxTurns(n: number): void {
    const normalized = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
    this.sessionMaxTurns = normalized;
    this.sessionLimits.maxTotalTurnsPerSession = normalized > 0 ? normalized : undefined;
  }

  getSessionMaxTurns(): number {
    return this.sessionMaxTurns;
  }
  getSessionUsage(): { spawnedAgents: number; totalTurns: number } {
    return { ...this.sessionUsage };
  }

  resetSessionUsage(): void {
    this.sessionUsage = { spawnedAgents: 0, totalTurns: 0 };
    this.lastTurnCounts.clear();
    this.firedBudgetThresholds.clear();
  }

  setBudgetWarningHandler(handler: OnBudgetWarning): void {
    this.onBudgetWarning = handler;
  }

  /** Set the per-agent token cap that arms spend warnings (0 = off). */
  setPerAgentTokenLimit(tokens: number): void {
    this.perAgentTokenLimit = Math.max(0, Math.floor(tokens));
  }

  getPerAgentTokenLimit(): number {
    return this.perAgentTokenLimit;
  }

  /** Get the ID of the agent executing in this async context. */
  getActiveAgentId(): string | undefined {
    return activeAgentStorage.getStore();
  }

  private createCompletionGate(id: string): Promise<string> {
    const gate: CompletionGate = {
      promise: undefined as unknown as Promise<string>,
      resolve: () => {},
      reject: () => {},
      settled: false,
    };
    gate.promise = new Promise<string>((resolve, reject) => {
      gate.resolve = (value) => {
        if (gate.settled) return;
        gate.settled = true;
        this.completionGates.delete(id);
        resolve(value);
      };
      gate.reject = (reason) => {
        if (gate.settled) return;
        gate.settled = true;
        this.completionGates.delete(id);
        reject(reason);
      };
    });
    // Callers may spawn-and-forget (or only inspect listAgents). Attach a
    // rejection handler so startup failures do not become unhandledRejections
    // while still rejecting for any later awaiter of record.promise.
    void gate.promise.catch(() => {});
    this.completionGates.set(id, gate);
    return gate.promise;
  }

  private resolveCompletion(id: string, value: string): void {
    this.completionGates.get(id)?.resolve(value);
  }

  private rejectCompletion(id: string, reason: unknown): void {
    this.completionGates.get(id)?.reject(reason);
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   * Every returned record exposes a stable completion promise immediately.
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    const maxAgents = this.sessionLimits.maxAgentsPerSession;
    if (maxAgents !== undefined && this.sessionUsage.spawnedAgents >= maxAgents) {
      throw new Error(`Session agent limit reached (${this.sessionUsage.spawnedAgents}/${maxAgents})`);
    }

    // --- Budget / depth enforcement & inheritance ---
    const parentId = this.getActiveAgentId();
    const parentRecord = parentId ? this.agents.get(parentId) : undefined;

    if (parentRecord) {
      const taskBudget = parentRecord.invocation?.taskBudget;
      if (taskBudget != null && parentRecord.totalSpawned >= taskBudget) {
        throw new Error(
          `Task budget exhausted (${parentRecord.totalSpawned}/${taskBudget})`,
        );
      }
      const levelLimit = parentRecord.invocation?.levelLimit ?? 5;
      const childLevel = (parentRecord.currentLevel ?? 0) + 1;
      if (childLevel > levelLimit) {
        throw new Error(
          `Max agent depth reached (${childLevel}/${levelLimit})`,
        );
      }
      parentRecord.totalSpawned++;
    }

    const childLevel = parentRecord
      ? (parentRecord.currentLevel ?? 0) + 1
      : (options.currentLevel ?? 0);

    // Inherit taskBudget/levelLimit from parent unless explicitly overridden
    const childInvocation: AgentInvocation = structuredClone(options.invocation ?? {});
    if (parentRecord?.invocation) {
      if (childInvocation.taskBudget === undefined) {
        childInvocation.taskBudget = parentRecord.invocation.taskBudget;
      }
      if (childInvocation.levelLimit === undefined) {
        childInvocation.levelLimit = parentRecord.invocation.levelLimit;
      }
    }

    const id = randomUUID().slice(0, 17);
    // Honor a caller-supplied correlation id (used by tests and by
    // any future code path that wants a deterministic id) but always
    // fall back to a fresh one so the record is never missing one.
    const correlationId = options.correlationId ?? generateCorrelationId();
    const abortController = new AbortController();
    const completionPromise = this.createCompletionGate(id);
    const record: AgentRecord = {
      id,
      type,
      description: options.description,
      status: options.isBackground ? "queued" : "running",
      toolUses: 0,
      spawnedAt: Date.now(),
      startedAt: Date.now(),
      abortController,
      promise: completionPromise,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      invocation: Object.keys(childInvocation).length > 0 ? childInvocation : undefined,
      activePartition: childInvocation.partitions?.[0],
      currentLevel: childLevel,
      totalSpawned: 0,
      parentId,
      contextInputs: { inheritContext: options.inheritContext ?? false },
      correlationId,
    };
    this.agents.set(id, record);
    this.sessionUsage.spawnedAgents++;

    // Dispatch subagent:spawn hook (non-blocking, fire-and-forget)
    this.hooks
      ?.dispatch("subagent:spawn", id, {
        type,
        description: options.description,
        isBackground: options.isBackground ?? false,
      })
      .catch((err) => {
        logger.warn(`Hook dispatch failed:`, { error: err instanceof Error ? err.message : String(err) });
      });

    const args: SpawnArgs = { pi, ctx, type, prompt, options };

    if (options.isBackground && !options.bypassQueue && this.runningBackground >= this.maxConcurrent) {
      // Queue it — will be started when a running agent completes
      this.queue.push({ id, args });
      return id;
    }

    // startAgent is async (worktree creation is non-blocking) — catch
    // late startup failures and clean up the record.
    this.startAgent(id, record, args).catch((err) => {
      // Clean up orphaned record on startup failure (e.g. worktree creation).
      // Decrement usage counter so failed spawns don't consume the session budget.
      this.sessionUsage.spawnedAgents--;
      this.rejectCompletion(id, err instanceof Error ? err : new Error(String(err)));
      // Use removeRecord to clean up map, lastTurnCounts, session, and notify onRecordRemoved.
      this.removeRecord(id, record);
    });
    return id;
  }

  /** Actually start an agent (called immediately or from queue drain). */
  private async startAgent(id: string, record: AgentRecord, { pi, ctx, type, prompt, options }: SpawnArgs) {
    // Wire parent abort before any await so Esc during worktree setup is observed.
    let detachParentSignal: (() => void) | undefined;
    if (options.signal) {
      const onParentAbort = () => this.abort(id);
      if (options.signal.aborted) {
        onParentAbort();
      } else {
        options.signal.addEventListener("abort", onParentAbort, { once: true });
        detachParentSignal = () => options.signal!.removeEventListener("abort", onParentAbort);
      }
    }
    const detach = () => {
      detachParentSignal?.();
      detachParentSignal = undefined;
    };

    const abandonStartup = (result = ""): void => {
      detach();
      if (record.worktree) {
        try {
          cleanupWorktree(ctx.cwd, record.worktree, options.description);
        } catch {
          /* ignore cleanup errors */
        }
      }
      this.resolveCompletion(id, result);
    };

    // Worktree isolation: try to create a temporary git worktree. Strict —
    // fail loud if not possible (no silent fallback to main tree). Done
    // BEFORE state mutation so a throw doesn't leave the record half-running.
    // Now async to avoid blocking the spawn pipeline during `git worktree add`.
    let worktreeCwd: string | undefined;
    if (options.isolation === "worktree") {
      const wt = await createWorktree(ctx.cwd, id);
      if (!wt) {
        detach();
        throw new Error(
          'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
          'Initialize git and commit at least once, or omit `isolation`.',
        );
      }
      record.worktree = wt;
      worktreeCwd = wt.path;
    }

    // Abort may have won during worktree setup (status stopped / signal aborted).
    if (record.status === "stopped" || options.signal?.aborted || record.abortController?.signal.aborted) {
      if (record.status !== "stopped") {
        record.status = "stopped";
        record.completedAt ??= Date.now();
      }
      abandonStartup();
      return;
    }

    record.status = "running";
    record.startedAt = Date.now();
    if (options.isBackground) this.runningBackground++;
    this.onStart?.(record);

    // The parent is captured when spawn() is called. Queued agents may start
    // after their caller has finished, so consulting ambient state here would
    // lose or misattribute the relationship.
    const parentRecord = record.parentId ? this.agents.get(record.parentId) : undefined;
    const parentConfig = parentRecord ? getConfig(parentRecord.type) : undefined;

    // Resolve partitions from child record for partitioned state
    const childPartitions = record.invocation?.partitions;

    const promise = activeAgentStorage.run(id, () => {
      return runAgent(ctx, type, prompt, {
        pi,
        agentId: id,
        model: options.model,
        maxTurns: options.maxTurns,
        isolated: options.isolated,
        inheritContext: options.inheritContext,
        thinkingLevel: options.thinkingLevel,
        currentLevel: record.currentLevel,
        levelLimit: record.invocation?.levelLimit,
        parentConfig,
        partitions: childPartitions ? [...childPartitions] : undefined,
        correlationId: record.correlationId,
        cwd: worktreeCwd,
        signal: record.abortController!.signal,
        hooks: this.hooks,
        spawnedAt: record.spawnedAt,
        onContextBuilt: (timestamp) => {
          record.contextBuiltAt = timestamp;
        },
        onToolActivity: (activity) => {
          if (activity.type === "end") record.toolUses++;
          options.onToolActivity?.(activity);
        },
        onTurnEnd: (turnCount) => {
          const previous = this.lastTurnCounts.get(id) ?? 0;
          const delta = Math.max(0, turnCount - previous);
          this.lastTurnCounts.set(id, turnCount);
          if (delta > 0) {
            this.sessionUsage.totalTurns += delta;
          }
          const maxTurns = this.sessionLimits.maxTotalTurnsPerSession;
          if (maxTurns !== undefined && this.sessionUsage.totalTurns >= maxTurns) {
            record.abortController?.abort();
            record.error = `Session turn limit reached (${this.sessionUsage.totalTurns}/${maxTurns})`;
          }
          // Budget warning at 80% of limits
          this.checkBudgetWarning();
          options.onTurnEnd?.(turnCount);
        },
        onTextDelta: options.onTextDelta,
        onAssistantUsage: (usage) => {
          addUsage(record.lifetimeUsage, usage);
          this.checkAgentSpend(record);
          options.onAssistantUsage?.(usage);
        },
        onCompaction: (info) => {
          record.lastCompaction = info;
          if (!info.aborted) {
            record.compactionCount++;
            if (info.usage) addUsage(record.lifetimeUsage, info.usage);
          }
          this.onCompact?.(record, info);
          options.onCompaction?.(info);
        },
        onSessionCreated: (session) => {
          record.session = session;
          // Flush any steers that arrived before the session was ready
          if (record.pendingSteers?.length) {
            for (const msg of record.pendingSteers) {
              session.steer(msg).catch(() => {});
            }
            record.pendingSteers = undefined;
          }
          options.onSessionCreated?.(session);
        },
      });
    })
      .then(({ responseText, session, aborted, timedOut, steered, validationResults, validated, error }) => {
        record.result = responseText;
        record.session = session;
        // A surfaced model/provider error (no thrown exception) is still a
        // failure: record it as an error status so dashboards and automation
        // do not treat a model-less run as completed.
        const status = error ? "error" : aborted ? "aborted" : steered ? "steered" : "completed";

        // Surface a quota-timeout cause so the UI/dashboard can show *why* the
        // agent was aborted, instead of a bare "aborted" with no explanation.
        if (timedOut) {
          record.error = "Duration quota exceeded";
        }

        // Store validation results on the record
        if (validationResults) {
          record.validationResults = validationResults;
          record.validated = validated;

          // Append validation feedback when validators fail
          if (!validated) {
            let failedFeedback = "";
            for (const r of validationResults) {
              if (r.passed) continue;
              let details = "";
              for (const c of r.criteria) {
                if (!c.passed) {
                  details += `\n  - ${c.criterion}: ${c.feedback}`;
                }
              }
              if (failedFeedback) failedFeedback += "\n\n";
              failedFeedback += `[${r.agentId}] ${r.summary}${details}`;
            }
            record.result = (record.result ?? "") +
              `\n\n---\n## Validation Feedback (FAILED)\n${failedFeedback}`;
          }
        }

        this.finalizeAgent(record, ctx, options.description, !!options.isBackground, detach, status, error);
        return responseText;
      })
      .catch((err) => {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.finalizeAgent(record, ctx, options.description, !!options.isBackground, detach, "error", errorMsg);
        return "";
      });

    void promise.then(
      (text) => this.resolveCompletion(id, text),
      (err) => this.rejectCompletion(id, err),
    );
  }

  /**
   * Shared cleanup for agent completion (success or error).
   * Handles status/error assignment, output flush, worktree cleanup,
   * and background queue drain. Called from both .then() and .catch() after
   * result-specific logic.
   */
  private finalizeAgent(
    record: AgentRecord,
    ctx: ExtensionContext,
    description: string,
    isBackground: boolean,
    detach: () => void,
    status?: "completed" | "aborted" | "steered" | "error",
    error?: string,
  ): void {
    // Don't overwrite status if externally stopped via abort()
    if (record.status !== "stopped" && status) {
      record.status = status;
    }
    record.completedAt ??= Date.now();
    if (error) record.error = error;

    detach();

    // Final flush of streaming output file
    if (record.outputCleanup) {
      try { record.outputCleanup(); } catch { /* ignore */ }
      record.outputCleanup = undefined;
    }

    // Clean up worktree if used
    if (record.worktree) {
      try {
        const wtResult = cleanupWorktree(ctx.cwd, record.worktree, description);
        record.worktreeResult = wtResult;
        if (!error && wtResult.hasChanges && wtResult.branch) {
          record.result = (record.result ?? "") +
            `\n\n---\nChanges saved to branch \`${wtResult.branch}\`. Merge with: \`git merge ${wtResult.branch}\``;
        }
      } catch { /* ignore cleanup errors */ }
    }

    // Background agent bookkeeping
    if (isBackground) {
      this.runningBackground--;
      try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
      this.drainQueue();
    }
  }

  /** Start queued agents up to the concurrency limit. */
  private drainQueue() {
    // Use head-index instead of .shift() to avoid O(N²) on large queues (P5).
    let head = 0;
    while (head < this.queue.length && this.runningBackground < this.maxConcurrent) {
      const next = this.queue[head++];
      const record = this.agents.get(next.id);
      if (record?.status !== "queued") continue;
      // startAgent is async — handle late failures via catch
      this.startAgent(next.id, record, next.args).catch((err) => {
        // Late failure (e.g. strict worktree-isolation) — clean up counters,
        // surface on the record so the user/agent can see it via /agents, then keep draining.
        this.sessionUsage.spawnedAgents--;
        // runningBackground is only incremented after successful startup; do not
        // decrement it when startAgent throws before that point.
        if (record.status === "running") {
          this.runningBackground--;
        }
        record.status = "error";
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt = Date.now();
        this.rejectCompletion(next.id, err instanceof Error ? err : new Error(String(err)));
        this.onComplete?.(record);
      });
    }
    if (head > 0) this.queue = this.queue.slice(head);
  }

  /**
   * Spawn an agent and wait for completion (foreground use).
   * Foreground agents bypass the concurrency queue.
   */
  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
  ): Promise<AgentRecord> {
    const id = this.spawn(pi, ctx, type, prompt, { ...options, isBackground: false });
    const record = this.agents.get(id)!;
    await record.promise;
    return record;
  }

  /**
   * Resume an existing agent session with a new prompt.
   */
  async resume(
    id: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<AgentRecord | undefined> {
    const record = this.agents.get(id);
    if (!record?.session) return undefined;

    record.status = "running";
    record.startedAt = Date.now();
    record.completedAt = undefined;
    record.result = undefined;
    record.error = undefined;

    try {
      const responseText = await resumeAgent(record.session, prompt, {
        agentId: id,
        hooks: this.hooks,
        onToolActivity: (activity) => {
          if (activity.type === "end") record.toolUses++;
        },
        onAssistantUsage: (usage) => {
          addUsage(record.lifetimeUsage, usage);
        },
        onCompaction: (info) => {
          record.lastCompaction = info;
          if (!info.aborted) {
            record.compactionCount++;
            if (info.usage) addUsage(record.lifetimeUsage, info.usage);
          }
          this.onCompact?.(record, info);
        },
        signal,
      });
      record.status = "completed";
      record.result = responseText;
      record.completedAt = Date.now();
    } catch (err) {
      record.status = "error";
      record.error = err instanceof Error ? err.message : String(err);
      record.completedAt = Date.now();
    }

    return record;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort(
      (a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0),
    );
  }

  /**
   * Get the correlation id of a previously-spawned agent. Returns
   * `undefined` if the id is unknown or the record was created before
   * the `correlationId` field was added. Safe to call from the UI, log
   * helpers, and the `/agents health` report.
   */
  getCorrelationId(id: string): string | undefined {
    return this.agents.get(id)?.correlationId;
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    // Remove from queue if queued (including mid-startAgent worktree setup).
    if (record.status === "queued") {
      this.queue = this.queue.filter(q => q.id !== id);
      record.status = "stopped";
      record.completedAt = Date.now();
      // Queued agents never start, so finalizeAgent/onComplete would not run.
      this.resolveCompletion(id, "");
      try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
      return true;
    }
    if (record.status === "running") {
      record.abortController?.abort();
      record.status = "stopped";
      record.completedAt = Date.now();
      // If runAgent has not been wired yet (worktree setup), the startAgent
      // abandon path settles the gate. Once the run promise exists, it settles.
      return true;
    }
    return false;
  }

  /** Callback invoked when a record is removed from the agent map (cleanup). */
  onRecordRemoved?: (id: string) => void;

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): void {
    record.session?.dispose?.();
    record.session = undefined;
    this.agents.delete(id);
    this.lastTurnCounts.delete(id);
    this.completionGates.delete(id);
    // Notify external observers (e.g. index.ts) so they can purge agentActivity
    this.onRecordRemoved?.(id);
  }

  private checkBudgetWarning(): void {
    const handler = this.onBudgetWarning;
    if (!handler) return;
    const { maxAgentsPerSession, maxTotalTurnsPerSession } = this.sessionLimits;

    // Once-per-threshold guards: each warning fires a single time per session,
    // instead of re-spamming on every turn_end while above the line.
    const fire = (key: string, type: BudgetWarningType): void => {
      if (this.firedBudgetThresholds.has(key)) return;
      this.firedBudgetThresholds.add(key);
      handler(type, this.sessionUsage, { maxAgents: maxAgentsPerSession ?? 0, maxTurns: maxTotalTurnsPerSession ?? 0 });
    };

    if (maxAgentsPerSession !== undefined && maxAgentsPerSession > 0) {
      const pct = this.sessionUsage.spawnedAgents / maxAgentsPerSession;
      if (pct >= 0.9) fire("agents_90", "agents_at_90");
      else if (pct >= 0.8) fire("agents_80", "agents_at_80");
    }
    if (maxTotalTurnsPerSession !== undefined && maxTotalTurnsPerSession > 0) {
      const pct = this.sessionUsage.totalTurns / maxTotalTurnsPerSession;
      if (pct >= 0.9) fire("turns_90", "turns_at_90");
      else if (pct >= 0.8) fire("turns_80", "turns_at_80");
    }
  }

  /**
   * Per-subagent spend warnings: fire once at 50/80/100% of the per-agent
   * token cap based on lifetime usage accumulated so far.
   */
  private checkAgentSpend(record: AgentRecord): void {
    const handler = this.onBudgetWarning;
    const limit = this.perAgentTokenLimit;
    if (!handler || limit <= 0) return;
    if (!record.spendFlags) record.spendFlags = new Set();
    const used = totalTokens(record.lifetimeUsage);
    const pct = used / limit;
    for (const [threshold, type] of [[0.5, "spend_50"], [0.8, "spend_80"], [1, "spend_100"]] as const) {
      const key = `${threshold * 100}`;
      if (pct >= threshold && !record.spendFlags.has(key)) {
        record.spendFlags.add(key);
        handler(type, this.sessionUsage, { maxAgents: 0, maxTurns: 0 });
      }
    }
  }

  private cleanup() {
    // Aggressive cleanup: remove inactive records after cleanupTtlMs.
    // Default 60s keeps memory usage low during long sessions.
    const cutoff = Date.now() - this.cleanupTtlMs;
    let removed = 0;
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      this.removeRecord(id, record);
      removed++;
    }
    if (removed > 0) {
      logger.debug(`Cleanup: removed ${removed} stale agent records (TTL: ${this.cleanupTtlMs}ms)`);
    }
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   */
  clearCompleted(): void {
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      this.removeRecord(id, record);
    }
  }

  /** Whether any agents are still running or queued. */
  hasRunning(): boolean {
    return [...this.agents.values()].some(
      r => r.status === "running" || r.status === "queued",
    );
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    let count = 0;
    this.queue = [];
    // Settle every non-terminal record — including agents dequeued into
    // async startAgent() worktree setup (status still "queued", no longer
    // in this.queue). Those never reach finalizeAgent on their own.
    for (const record of this.agents.values()) {
      if (record.status === "queued") {
        record.status = "stopped";
        record.completedAt = Date.now();
        this.resolveCompletion(record.id, "");
        try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
        count++;
      } else if (record.status === "running") {
        // onComplete fires via finalizeAgent when the run settles
        record.abortController?.abort();
        record.status = "stopped";
        record.completedAt = Date.now();
        count++;
      }
    }
    return count;
  }

  /** Wait for all running and queued agents to complete (including queued ones). */
  async waitForAll(): Promise<void> {
    // Loop because drainQueue respects the concurrency limit — as running
    // agents finish they start queued ones, which need awaiting too.
    while (true) {
      this.drainQueue();
      const pending = [...this.agents.values()]
        .filter(r => r.status === "running" || r.status === "queued")
        .map(r => r.promise)
        .filter(Boolean);
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  dispose() {
    clearInterval(this.cleanupInterval);
    this.queue = [];
    // Settle every non-terminal record — queue members, dequeued-but-still-
    // starting (status "queued"), and running. Clearing the gate map alone
    // would leave spawn-time promises pending for waitForAll()/get-result.
    for (const [id, record] of this.agents) {
      if (record.status === "queued" || record.status === "running") {
        if (record.status === "running") {
          record.abortController?.abort();
        }
        record.status = "stopped";
        record.completedAt = Date.now();
        this.resolveCompletion(id, record.result ?? "");
      }
      record.session?.dispose();
    }
    this.agents.clear();
    this.lastTurnCounts.clear();
    this.completionGates.clear();
    // Prune any orphaned git worktrees (crash recovery)
    try { pruneWorktrees(process.cwd()); } catch (err) { logger.warn("Failed to prune worktrees", { error: err instanceof Error ? err.message : String(err) }); }
  }
}
