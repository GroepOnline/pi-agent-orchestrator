/**
 * notification-hub.ts — Cancellable completion notifications for index.ts.
 *
 * Owns the pending-nudge debounce (a completed agent's notification is held
 * briefly so get_subagent_result can consume the result first), individual
 * nudge emission, and lifetime usage → event-data mapping. Extracted from
 * index.ts so the entry point shrinks to wiring, not notification logic.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { logger } from "./logger.js";
import { buildNotificationDetails, formatTaskNotification } from "./tool-result-helpers.js";
import type { AgentRecord, NotificationDetails } from "./types.js";
import type { AgentActivity } from "./ui/agent-ui-types.js";
import { getLifetimeTotal } from "./usage.js";

/** Minimal widget surface the hub needs (avoids importing LiveWidgets class). */
export interface NotificationWidgets {
  markFinished(id: string): void;
  update(): void;
}

export interface NotificationHubDeps {
  pi: ExtensionAPI;
  /** Shared activity map — read for details, written on send. */
  agentActivity: Map<string, AgentActivity>;
  /** Accessor because LiveWidgets is constructed after the hub in index.ts. */
  getWidgets: () => NotificationWidgets | undefined;
}

export class NotificationHub {
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly NUDGE_HOLD_MS = 200;

  constructor(private readonly deps: NotificationHubDeps) {}

  /**
   * Hold a notification briefly so get_subagent_result can cancel it before
   * it reaches pi.sendMessage (fire-and-forget).
   */
  schedule(key: string, send: () => void, delay = NotificationHub.NUDGE_HOLD_MS): void {
    this.cancel(key);
    this.pending.set(key, setTimeout(() => {
      this.pending.delete(key);
      try {
        send();
      } catch (err) {
        logger.debug(`Swallowed error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, delay));
  }

  cancel(key: string): void {
    const timer = this.pending.get(key);
    if (timer != null) {
      clearTimeout(timer);
      this.pending.delete(key);
    }
  }

  emitIndividual(record: AgentRecord): void {
    if (record.resultConsumed) return; // re-check at send time

    const notification = formatTaskNotification(record, 500);
    const footer = record.outputFile ? `\nFull transcript available at: ${record.outputFile}` : "";

    this.deps.pi.sendMessage<NotificationDetails>({
      customType: "subagent-notification",
      content: notification + footer,
      display: true,
      details: buildNotificationDetails(record, 500, this.deps.agentActivity.get(record.id)),
    }, { deliverAs: "followUp", triggerTurn: true });
  }

  sendIndividual(record: AgentRecord): void {
    this.deps.agentActivity.delete(record.id);
    const widgets = this.deps.getWidgets();
    if (!widgets) return;
    widgets.markFinished(record.id);
    this.schedule(record.id, () => this.emitIndividual(record));
    widgets.update();
  }

  /** Lifetime-accumulated usage → lifecycle event payload. */
  buildEventData(record: AgentRecord) {
    const durationMs = record.completedAt
      ? record.completedAt - (record.startedAt ?? 0)
      : Date.now() - (record.startedAt ?? 0);
    // All three fields are lifetime-accumulated (Σ over every assistant message_end),
    // so they survive compaction together — input + output ≤ total always.
    // tokens is omitted when nothing was ever produced (e.g. agent errored before
    // any message_end fired), preserving prior payload shape.
    const u = record.lifetimeUsage;
    const total = getLifetimeTotal(u);
    const tokens = total > 0 ? { input: u.input, output: u.output, total } : undefined;
    return {
      id: record.id,
      type: record.type,
      description: record.description,
      result: record.result,
      error: record.error,
      status: record.status,
      toolUses: record.toolUses,
      durationMs,
      tokens,
    };
  }

  dispose(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }
}
