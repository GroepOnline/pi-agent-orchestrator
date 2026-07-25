
/**
 * schedule.ts — `SubagentScheduler`: timer-driven dispatcher of scheduled subagents.
 *
 * Mirrors the engine shape of pi-cron-schedule/src/scheduler.ts:
 *   - two-Map split (jobs = croner Cron, intervals = setInterval/setTimeout)
 *   - addJob/removeJob/updateJob/scheduleJob/unscheduleJob/executeJob
 *   - static parsers for cron / "+10m" / "5m" / ISO formats
 *
 * Differences vs pi-cron-schedule:
 *   - Persistence is via ScheduleStore (PID-locked, session-scoped, atomic).
 *   - `executeJob` calls `manager.spawn(..., { bypassQueue: true })` instead
 *     of dispatching a user message — schedule fires bypass maxConcurrent so
 *     a 5-minute interval can't be deferred behind 4 long-running agents.
 *   - Result delivery is implicit: spawn → background completion → existing
 *     `subagent-notification` followUp path. No new delivery code.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Cron } from "croner";
import { nanoid } from "nanoid";
import type { AgentManager } from "./agent-manager.js";
import { logger } from "./logger.js";
import { resolveModel } from "./model-resolver.js";

import type { ScheduleStore } from "./schedule-store.js";
import type { IsolationMode, ScheduledSubagent, SubagentType, ThinkingLevel } from "./types.js";

// CVE-005 FIX: Schedule input bounds
const MAX_INTERVAL = 2147483647;   // ~24.8 days (setTimeout limit)
const MIN_INTERVAL = (process.env.NODE_ENV === "test" || process.env.VITEST === "true") ? 10 : 60000;        // 1 minute minimum
const MAX_SCHEDULES = 100;         // Per session limit
const MAX_PROMPT_SIZE = 50000;     // 50KB max prompt
const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;

/** Event emitted on `pi.events` for cross-extension consumers. */
export type ScheduleChangeEvent =
  | { type: "added"; job: ScheduledSubagent }
  | { type: "removed"; jobId: string }
  | { type: "updated"; job: ScheduledSubagent }
  | { type: "fired"; jobId: string; agentId: string; name: string }
  | { type: "error"; jobId: string; error: string };

/** Params accepted at job creation — ID, timestamps, and state are derived. */
export interface NewJobInput {
  name: string;
  description: string;
  schedule: string;
  subagent_type: SubagentType;
  prompt: string;
  model?: string;
  thinking?: ThinkingLevel;
  max_turns?: number;
  isolated?: boolean;
  isolation?: IsolationMode;
}

export class SubagentScheduler {
  private jobs = new Map<string, Cron>();
  private intervals = new Map<string, NodeJS.Timeout>();
  /** Job ids currently executing — prevents overlap stacking under short cadences. */
  private inflight = new Set<string>();
  /** Last successful fire start (ms) per job — enforces MIN_INTERVAL for cron too. */
  private lastFireAt = new Map<string, number>();
  /**
   * Monotonic scheduler generation, bumped on every stop(). An in-flight
   * execution captures the generation at fire time and only cleans up its own
   * markers while that generation is still active, so a stop()/start() cycle
   * can never let a stale run evict a newer run's in-flight marker.
   */
  private generation = 0;
  private store: ScheduleStore | undefined;
  private pi: ExtensionAPI | undefined;
  private ctx: ExtensionContext | undefined;
  private manager: AgentManager | undefined;

  /** Start the scheduler: bind to a session's store and arm enabled jobs. */
  async start(pi: ExtensionAPI, ctx: ExtensionContext, manager: AgentManager, store: ScheduleStore): Promise<void> {
    this.pi = pi;
    this.ctx = ctx;
    this.manager = manager;
    this.store = store;

    for (const job of store.list()) {
      if (job.enabled) await this.scheduleJob(job);
    }
  }

  /** Stop all timers; drop refs. Safe to call repeatedly. */
  stop(): void {
    // Invalidate the current generation so any still-running execution's
    // later cleanup cannot touch markers owned by a subsequent start().
    this.generation++;
    for (const cron of this.jobs.values()) cron.stop();
    this.jobs.clear();
    for (const t of this.intervals.values()) clearTimeout(t);
    this.intervals.clear();
    this.inflight.clear();
    this.lastFireAt.clear();
    this.store = undefined;
    this.pi = undefined;
    this.ctx = undefined;
    this.manager = undefined;
  }

  /** True if start() has bound a store and the scheduler is active. */
  isActive(): boolean {
    return this.store !== undefined;
  }

  list(): ScheduledSubagent[] {
    return this.store?.list() ?? [];
  }

  /**
   * CVE-005 FIX: Validate schedule input bounds.
   * Returns array of error messages (empty if valid).
   */
  private validateScheduleInput(input: NewJobInput): string[] {
    const errors: string[] = [];
    
    // Validate name
    if (!input.name || typeof input.name !== 'string' || input.name.length > MAX_NAME_LENGTH) {
      errors.push(`Schedule name is required and must be a string <= ${MAX_NAME_LENGTH} characters`);
    }
    
    // Validate description
    if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > MAX_DESCRIPTION_LENGTH)) {
      errors.push(`Description must be a string <= ${MAX_DESCRIPTION_LENGTH} characters`);
    }
    
    // Validate prompt size
    if (!input.prompt || typeof input.prompt !== 'string' || input.prompt.length > MAX_PROMPT_SIZE) {
      errors.push(`Prompt is required and must be a string <= ${MAX_PROMPT_SIZE} characters`);
    }
    
    // Validate schedule format and bounds
    if (typeof input.schedule !== 'string') {
      errors.push('Schedule must be a string');
    } else {
      try {
        const detected = SubagentScheduler.detectSchedule(input.schedule);
        if (detected.type === 'interval' && detected.intervalMs) {
          if (detected.intervalMs < MIN_INTERVAL) {
            errors.push(`Interval ${detected.intervalMs}ms is below minimum ${MIN_INTERVAL}ms (1 minute)`);
          }
          if (detected.intervalMs > MAX_INTERVAL) {
            errors.push(`Interval ${detected.intervalMs}ms exceeds maximum ${MAX_INTERVAL}ms (~24.8 days)`);
          }
        }
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    
    return errors;
  }

  /**
   * Build a `ScheduledSubagent` from user input. Validates the schedule
   * format and tags `scheduleType`. Throws on invalid input.
   */
  buildJob(input: NewJobInput): ScheduledSubagent {
    // CVE-005 FIX: Validate input before building
    const errors = this.validateScheduleInput(input);
    if (errors.length > 0) {
      throw new Error(`Invalid schedule input: ${errors.join(', ')}`);
    }
    
    const detected = SubagentScheduler.detectSchedule(input.schedule);
    return {
      id: nanoid(10),
      name: input.name,
      description: input.description,
      schedule: detected.normalized,
      scheduleType: detected.type,
      intervalMs: detected.intervalMs,
      subagent_type: input.subagent_type,
      prompt: input.prompt,
      model: input.model,
      thinking: input.thinking,
      max_turns: input.max_turns,
      isolated: input.isolated,
      isolation: input.isolation,
      enabled: true,
      createdAt: new Date().toISOString(),
      runCount: 0,
    };
  }

  /** Add a job, persist, and arm if enabled. Returns the stored job. */
  async addJob(input: NewJobInput): Promise<ScheduledSubagent> {
    const store = this.requireStore();
    
    // Fast-fail checks (checked again strictly inside the store lock to prevent TOCTOU races)
    const currentJobs = store.list();
    if (currentJobs.length >= MAX_SCHEDULES) {
      throw new Error(`Maximum number of schedules reached (${MAX_SCHEDULES}). Remove existing schedules before adding new ones.`);
    }
    if (store.hasName(input.name)) {
      throw new Error(`A scheduled job named "${input.name}" already exists.`);
    }

    const job = this.buildJob(input);
    // CVE-005 FIX: Enforce max schedules limit strictly inside the store lock
    await store.add(job, MAX_SCHEDULES);
    if (job.enabled) await this.scheduleJob(job);
    this.emit({ type: "added", job });
    return job;
  }

  async removeJob(id: string): Promise<boolean> {
    const store = this.requireStore();
    if (!store.get(id)) return false;
    this.unscheduleJob(id);
    // Permanent removal: drop the overlap-guard timestamp so removed jobs
    // don't retain an entry for the scheduler's lifetime across add/remove
    // cycles. (updateJob re-arms the same id, so it intentionally keeps it.)
    this.lastFireAt.delete(id);
    const ok = await store.remove(id);
    if (ok) this.emit({ type: "removed", jobId: id });
    return ok;
  }

  /** Toggle / mutate a job. Re-arms based on the new `enabled` state. */
  async updateJob(id: string, patch: Partial<ScheduledSubagent>): Promise<ScheduledSubagent | undefined> {
    // CVE-005 FIX: Enforce bounds on updates to prevent bypassing size limits
    if (patch.name !== undefined && (typeof patch.name !== 'string' || patch.name.length > MAX_NAME_LENGTH)) {
      throw new Error(`Schedule name must be a string <= ${MAX_NAME_LENGTH} characters`);
    }
    if (patch.description !== undefined && (typeof patch.description !== 'string' || patch.description.length > MAX_DESCRIPTION_LENGTH)) {
      throw new Error(`Description must be a string <= ${MAX_DESCRIPTION_LENGTH} characters`);
    }
    if (patch.prompt !== undefined && (typeof patch.prompt !== 'string' || patch.prompt.length > MAX_PROMPT_SIZE)) {
      throw new Error(`Prompt must be a string <= ${MAX_PROMPT_SIZE} characters`);
    }

    const store = this.requireStore();
    const existing = store.get(id);
    if (existing) {
      // Validate bounds on the merged object to ensure updates don't bypass limits
      const merged: NewJobInput = { ...existing, ...patch };
      const errors = this.validateScheduleInput(merged);
      if (errors.length > 0) {
        throw new Error(`Invalid schedule update: ${errors.join(', ')}`);
      }
    }
    const updated = await store.update(id, patch);
    if (!updated) return undefined;
    this.unscheduleJob(id);
    if (updated.enabled) await this.scheduleJob(updated);
    this.emit({ type: "updated", job: updated });
    return updated;
  }

  /** Next-run time as ISO, or undefined if not currently armed. */
  getNextRun(jobId: string): string | undefined {
    const cron = this.jobs.get(jobId);
    if (cron) return cron.nextRun()?.toISOString();
    const job = this.store?.get(jobId);
    if (!job?.enabled) return undefined;
    if (job.scheduleType === "once") return job.schedule;
    if (job.scheduleType === "interval" && job.intervalMs) {
      // Before the first fire there's no `lastRun`, so fall back to "now" —
      // accurate at create time (setInterval was just armed) and within
      // intervalMs of correct in any pre-first-fire view.
      const base = job.lastRun ? new Date(job.lastRun).getTime() : Date.now();
      return new Date(base + job.intervalMs).toISOString();
    }
    return undefined;
  }

  // ── Scheduling primitives ────────────────────────────────────────────

  private async scheduleJob(job: ScheduledSubagent): Promise<void> {
    const store = this.store;
    if (!store) return;
    try {
      if (job.scheduleType === "interval" && job.intervalMs) {
        // CVE-005 FIX: Cap interval at max 24 days to avoid setTimeout limits
        if (job.intervalMs > MAX_INTERVAL) {
          logger.warn(`Interval ${job.intervalMs}ms exceeds max ${MAX_INTERVAL}ms; capping to ${MAX_INTERVAL}ms`);
        }
        const interval = Math.min(job.intervalMs, MAX_INTERVAL);
        const t = setInterval(() => this.executeJob(job.id), interval);
        this.intervals.set(job.id, t);
      } else if (job.scheduleType === "once") {
        const target = new Date(job.schedule);
        if (target.getTime() > Date.now()) {
          // Use Cron for one-shot dates. It natively handles dates far in the future
          // that would otherwise exceed Node.js's 32-bit setTimeout limits.
          const cron = new Cron(target, async () => {
            // executeJob handles status updates and one-shot auto-disable
            // atomically inside its finalize path.
            await this.executeJob(job.id).catch(() => {});
          });
          this.jobs.set(job.id, cron);
        } else {
          // Past timestamp — disable, mark error, never fire
          await store.update(job.id, { enabled: false, lastStatus: "error" });
          this.emit({ type: "error", jobId: job.id, error: `Scheduled time ${job.schedule} is in the past` });
        }
      } else {
        const cron = new Cron(job.schedule, () => this.executeJob(job.id));
        this.jobs.set(job.id, cron);
      }
    } catch (err) {
      this.emit({ type: "error", jobId: job.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private unscheduleJob(id: string): void {
    const cron = this.jobs.get(id);
    if (cron) {
      cron.stop();
      this.jobs.delete(id);
    }
    const t = this.intervals.get(id);
    if (t) {
      clearTimeout(t);
      clearInterval(t);
      this.intervals.delete(id);
    }
  }

  /**
   * Fire a job: persist running state, spawn (bypassing the concurrency
   * queue), persist completion. Fire-and-forget: the timer tick returns
   * immediately so other jobs keep firing.
   */
  private async executeJob(id: string): Promise<void> {
    const store = this.store;
    const pi = this.pi;
    const ctx = this.ctx;
    const manager = this.manager;
    if (!store || !pi || !ctx || !manager) return;
    const job = store.get(id);
    if (!job?.enabled) return;

    // Skip overlapping fires for the same job (short interval/cron cadences).
    if (this.inflight.has(id)) return;
    const last = this.lastFireAt.get(id);
    if (last !== undefined && Date.now() - last < MIN_INTERVAL) return;

    // Capture the generation this run belongs to; used below so a run whose
    // scheduler was stop()ed mid-flight does not evict a newer run's marker.
    const generation = this.generation;
    this.inflight.add(id);
    this.lastFireAt.set(id, Date.now());

    try {
      await store.update(id, { lastStatus: "running" });

    // Resolve model at fire time — registry contents may have changed since the
    // job was created (auth added/removed). Fall back silently to spawn-default
    // if resolution fails; the spawn path handles undefined model gracefully.
    let resolvedModel: any | undefined;
    if (job.model) {
      const r = resolveModel(job.model, ctx.modelRegistry);
      if (typeof r !== "string") resolvedModel = r;
    }

    let agentId: string;
    try {
      agentId = manager.spawn(pi, ctx, job.subagent_type, job.prompt, {
        description: job.description,
        isBackground: true,
        bypassQueue: true,
        model: resolvedModel,
        maxTurns: job.max_turns,
        isolated: job.isolated,
        thinkingLevel: job.thinking,
        isolation: job.isolation,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.emit({ type: "error", jobId: id, error });
      await store.update(id, { lastRun: new Date().toISOString(), lastStatus: "error" });
      return;
    }

    this.emit({ type: "fired", jobId: id, agentId, name: job.name });

    const record = manager.getRecord(agentId);
    const finalize = async (status: "success" | "error") => {
      const next = this.getNextRun(id);
      const current = store.get(id);
      await store.update(id, {
        lastRun: new Date().toISOString(),
        lastStatus: status,
        runCount: (current?.runCount ?? 0) + 1,
        nextRun: next,
        // Auto-disable one-shots atomically with the status update to
        // prevent races with a concurrent store.update from the Cron callback.
        ...(current?.scheduleType === "once" ? { enabled: false } : {}),
      });
      if (current?.scheduleType === "once") {
        const updated = store.get(id);
        if (updated) this.emit({ type: "updated", job: updated });
      }
    };

    // AgentManager's promise resolves either way (its .catch returns ""), so we
    // can't infer success/failure from the promise — read record.status instead.
    // Terminal states: completed/steered = success; error/aborted/stopped = error.
    // Await the full chain so executeJob doesn't return before finalize completes.
    // This ensures runCount/lastStatus are reflected before the Cron callback or
    // interval tick resolves, preventing races with scheduler.stop() cleanup.
    if (record?.promise) {
      try {
        await record.promise;
        const r = manager.getRecord(agentId);
        const failed = r?.status === "error" || r?.status === "aborted" || r?.status === "stopped";
        await finalize(failed ? "error" : "success");
      } catch {
        // record.promise rejected (defensive — the real AgentManager's .catch
        // returns "" so this should never fire, but handle it for safety).
        await finalize("error").catch(() => {});
      }
    } else {
      // Spawn returned without a promise (defensive — bypassQueue path always sets one).
      await finalize("success").catch(() => {});
    }
    } catch (err) {
      this.emit({ type: "error", jobId: id, error: err instanceof Error ? err.message : String(err) });
    } finally {
      // Only clear our own marker: if stop() bumped the generation while we
      // ran, a newer start() now owns this id's inflight entry — leave it be.
      if (generation === this.generation) this.inflight.delete(id);
    }
  }

  private emit(event: ScheduleChangeEvent): void {
    if (this.pi) this.pi.events.emit("subagents:scheduled", event);
  }

  private requireStore(): ScheduleStore {
    if (!this.store) throw new Error("Scheduler not started — no active session.");
    return this.store;
  }

  // ── Format detection / parsers (statics — pure) ──────────────────────

  /**
   * Sniff a schedule string and tag its type. Throws on invalid input.
   * Order matters: relative ("+10m") and interval ("5m") both match digit+unit;
   * relative requires the leading "+" to disambiguate.
   */
  static detectSchedule(s: string): { type: "cron" | "once" | "interval"; intervalMs?: number; normalized: string } {
    const trimmed = s.trim();
    // "+10m" — relative one-shot
    const rel = SubagentScheduler.parseRelativeTime(trimmed);
    if (rel !== null) return { type: "once", normalized: rel };
    // "5m" — interval
    const ivl = SubagentScheduler.parseInterval(trimmed);
    if (ivl !== null) return { type: "interval", intervalMs: ivl, normalized: trimmed };
    // ISO timestamp — one-shot. Reject past timestamps upfront so we never
    // create a dead-on-arrival record (scheduleJob's safety net still catches
    // micro-races from `+0s`-style relatives).
    if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
      const d = new Date(trimmed);
      if (!Number.isNaN(d.getTime())) {
        if (d.getTime() <= Date.now()) {
          throw new Error(`Scheduled time ${d.toISOString()} is in the past.`);
        }
        return { type: "once", normalized: d.toISOString() };
      }
    }
    // Cron — 6-field
    const cronCheck = SubagentScheduler.validateCronExpression(trimmed);
    if (cronCheck.valid) return { type: "cron", normalized: trimmed };
    throw new Error(
      `Invalid schedule "${s}". Use 6-field cron (e.g. "0 0 9 * * 1" — 9am every Monday), interval ("5m"/"1h"), or one-shot ("+10m" / ISO).`
    );
  }

  /** 6-field cron — 'second minute hour dom month dow'. */
  static validateCronExpression(expr: string): { valid: boolean; error?: string } {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 6) {
      return {
        valid: false,
        error: `Cron must have 6 fields (second minute hour dom month dow), got ${fields.length}. Example: "0 0 9 * * 1" for 9am every Monday.`,
      };
    }
    try {
      // Croner validates by construction.
      new Cron(expr, () => {});
      return { valid: true };
    } catch (e) {
      return { valid: false, error: e instanceof Error ? e.message : "Invalid cron expression" };
    }
  }

  /** "+10s"/"+5m"/"+1h"/"+2d" → ISO timestamp. */
  static parseRelativeTime(s: string): string | null {
    const m = s.match(/^\+(\d+)(s|m|h|d)$/);
    if (!m) return null;
    const ms = parseInt(m[1], 10) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
    return new Date(Date.now() + ms).toISOString();
  }

  /** "10s"/"5m"/"1h"/"2d" → milliseconds. */
  static parseInterval(s: string): number | null {
    const m = s.match(/^(\d+)(ms|s|m|h|d)$/);
    if (!m) return null;
    if (m[2] === "ms") return parseInt(m[1], 10);
    return parseInt(m[1], 10) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  }
}
