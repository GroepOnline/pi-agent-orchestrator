import { randomUUID } from "node:crypto";
import { logger } from "./logger.js";

/** All hook event types in the subagent lifecycle. */
export type HookEvent =
  | "subagent:start"
  | "subagent:end"
  | "subagent:error"
  | "subagent:spawn"
  | "subagent:steer"
  | "tool:call"
  | "tool:result"
  | "compaction:start"
  | "compaction:end"
  | "turn:start"
  | "turn:end"
  | "swarm:join"
  | "swarm:leave"
  | "validation:start"
  | "validation:end";

/** Payload delivered to hook handlers. */
export interface HookPayload {
  event: HookEvent;
  agentId: string;
  data?: Record<string, unknown>;
  /** Timestamp when the event fired. */
  timestamp?: number;
}

/**
 * Response from a blocking hook handler.
 *
 * String forms remain the primary contract. The object form is only for
 * `block` so a quality-gate hook can return revision feedback without a
 * side channel.
 */
export type HookResponse =
  | "allow"
  | "block"
  | "modify"
  | { action: "block"; reason?: string; feedback?: string };

/** Normalized decision used by the runner and compose helpers. */
export interface NormalizedHookDecision {
  action: "allow" | "block" | "modify";
  reason?: string;
  feedback?: string;
}

/** True when a handler result is a blocking decision (string or object). */
export function isBlockResponse(
  result: HookResponse | undefined,
): result is "block" | { action: "block"; reason?: string; feedback?: string } {
  return result === "block" || (typeof result === "object" && result !== null && result.action === "block");
}

/** Collapse string/object hook results into a single decision shape. */
export function normalizeHookResponse(result: HookResponse | undefined): NormalizedHookDecision {
  if (result === "block") return { action: "block" };
  if (result === "modify") return { action: "modify" };
  if (typeof result === "object" && result !== null && result.action === "block") {
    return {
      action: "block",
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ...(result.feedback !== undefined ? { feedback: result.feedback } : {}),
    };
  }
  return { action: "allow" };
}

/** Hook priority: lower numbers run first. */
export type HookPriority = "critical" | "high" | "normal" | "low" | "background";

const PRIORITY_MAP: Record<HookPriority, number> = {
  critical: 0,
  high: 25,
  normal: 50,
  low: 75,
  background: 100,
};

/** A hook handler function with metadata. */
export interface HookHandler {
  fn: (
    payload: HookPayload,
  ) => Promise<HookResponse | undefined> | HookResponse | undefined;
  priority: number;
  id: string;
}

/** Default timeout for individual hook handlers (5 seconds). */
const DEFAULT_HANDLER_TIMEOUT_MS = 5_000;

/**
 * Execute a single handler with timeout and error protection.
 * Handler failures are logged and treated as "allow" (fail-open).
 */
async function executeHandler(
  handler: HookHandler,
  payload: HookPayload,
  timeoutMs: number,
): Promise<HookResponse | undefined> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const handlerPromise = (async () => {
    try {
      return await handler.fn(payload);
    } catch (err) {
      logger.warn(`Handler "${handler.id}" threw on "${payload.event}":`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  })();

  const timeoutPromise = new Promise<undefined>((resolve) => {
    timeoutId = setTimeout(() => {
      logger.warn(`Handler "${handler.id}" timed out after ${timeoutMs}ms on "${payload.event}"`);
      resolve(undefined);
    }, timeoutMs);
  });

  const result = await Promise.race([handlerPromise, timeoutPromise]);

  if (timeoutId) clearTimeout(timeoutId);

  return result;
}

/** Registry for hook handlers with fail-open semantics. */
export class HookRegistry {
  private handlers = new Map<HookEvent, HookHandler[]>();
  private handlerEventMap = new Map<string, HookEvent>();

  /** Register a handler for a specific event with priority. */
  register(
    event: HookEvent,
    handler: HookHandler["fn"],
    options?: {
      priority?: HookPriority | number;
      id?: string;
    },
  ): string {
    // `id` is the primary key for `handlerEventMap`; a collision would leave a
    // ghost handler that runHandlers() silently skips. Use a UUID suffix and,
    // for auto-generated ids, regenerate on the vanishingly rare clash.
    let id = options?.id;
    if (!id) {
      do {
        id = `${event}-${Date.now().toString(36)}-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      } while (this.handlerEventMap.has(id));
    }
    const priority = typeof options?.priority === "number"
      ? options.priority
      : PRIORITY_MAP[options?.priority ?? "normal"];

    const hookHandler: HookHandler = {
      fn: handler,
      priority,
      id,
    };

    const list = this.handlers.get(event);
    if (list) {
      list.push(hookHandler);
      list.sort((a, b) => a.priority - b.priority);
    } else {
      this.handlers.set(event, [hookHandler]);
    }

    this.handlerEventMap.set(id, event);

    return id;
  }

  /** Remove a previously registered handler by ID. */
  unregisterById(handlerId: string): boolean {
    const event = this.handlerEventMap.get(handlerId);
    if (!event) return false;

    const list = this.handlers.get(event);
    if (list) {
      const idx = list.findIndex((h) => h.id === handlerId);
      if (idx !== -1) {
        list.splice(idx, 1);
        this.handlerEventMap.delete(handlerId);
        if (list.length === 0) this.handlers.delete(event);
        return true;
      }
    }
    return false;
  }

  /** Remove a previously registered handler by function reference (legacy). */
  unregister(event: HookEvent, handler: HookHandler["fn"]): void {
    const list = this.handlers.get(event);
    if (!list) return;

    const idx = list.findIndex((h) => h.fn === handler);
    if (idx !== -1) {
      const id = list[idx].id;
      this.handlerEventMap.delete(id);
      list.splice(idx, 1);
    }

    if (list.length === 0) this.handlers.delete(event);
  }

  /**
   * Dispatch an event to all registered handlers.
   *
   * Handlers run in priority order (critical → background).
   * Short-circuits on "block", aggregates "modify".
   * Each handler runs with timeout protection; failures are caught and logged.
   */
  async dispatch(
    event: HookEvent,
    agentId: string,
    data?: Record<string, unknown>,
    timeoutMs = DEFAULT_HANDLER_TIMEOUT_MS,
  ): Promise<HookResponse> {
    const list = this.handlers.get(event);
    if (!list || list.length === 0) return "allow";

    const payload: HookPayload = {
      event,
      agentId,
      data,
      timestamp: Date.now(),
    };

    return this.runHandlers(list, payload, timeoutMs);
  }

  private async runHandlers(
    list: HookHandler[],
    payload: HookPayload,
    timeoutMs: number,
  ): Promise<HookResponse> {
    let hasModify = false;

    for (const handler of list) {
      const result = await executeHandler(handler, payload, timeoutMs);

      if (isBlockResponse(result)) {
        return typeof result === "object" ? result : "block";
      }
      if (result === "modify") hasModify = true;
    }

    return hasModify ? "modify" : "allow";
  }

  /** Get a frozen snapshot of the handler map for inspection/testing. */
  getHandlers(): ReadonlyMap<HookEvent, ReadonlyArray<{ id: string; priority: number }>> {
    const snapshot = new Map<HookEvent, ReadonlyArray<{ id: string; priority: number }>>();
    for (const [event, handlers] of this.handlers) {
      snapshot.set(
        event,
        handlers.map((h) => ({ id: h.id, priority: h.priority })),
      );
    }
    return snapshot;
  }
}

/** Compose multiple hook handlers into a single handler (sequential execution). */
export function composeHandlers(
  ...handlers: HookHandler["fn"][]
): (payload: HookPayload) => Promise<HookResponse | undefined> {
  return async (payload) => {
    let hasModify = false;
    for (const handler of handlers) {
      const result = await handler(payload);
      if (isBlockResponse(result)) {
        return typeof result === "object" ? result : "block";
      }
      if (result === "modify") hasModify = true;
    }
    return hasModify ? "modify" : "allow";
  };
}
