import { createHash } from "node:crypto";

import { logger } from "./logger.js";
import { getTelemetryRegistry, setTelemetryRegistry } from "./ui/global-registry.js";

/**
 * telemetry.ts — Structured event emitter for security, validation, and lifecycle events.
 *
 * Provides a lightweight pub/sub system for agent lifecycle events.
 * Fail-open: security events warn; routine lifecycle events are debug-only.
 */

/** Telemetry event types and their payloads */
export interface TelemetryEvents {
  "agent:loaded": { name: string; source: "project" | "global" | "embedded"; hash: string; enabled: boolean };
  "agent:validation-failed": { name: string; errors: string[] };
  "agent:unknown-tools": { name: string; tools: string[] };
  "agent:spawned": { type: string; parentType?: string; depth: number; budget?: number };
  "agent:completed": { type: string; duration: number; validatorResults?: { passed: boolean; summary: string }[] };
  "rpc:audit": {
    timestamp: string;
    extensionId: string;
    extensionName?: string;
    operation: string;
    outcome: string;
    durationMs: number;
    metadata?: Record<string, unknown>;
  };
  /**
   * Emitted by `dispatch-history.ts` on every call to
   * `recordDispatchDecision(...)`. Lets downstream consumers (sentry,
   * splunk, the Go cinematic sidecar) reconstruct the same
   * single/swarm/crew + auto/explicit histogram that the in-memory
   * ring buffer feeds into `/agents → Health check`. Note the event
   * carries the resolved `kind` already (so a `auto → crew` decision
   * surfaces as `kind: "crew"` AND `configuredMode: "auto"` +
   * `source: "auto-heuristic"`), not the heuristic's intermediate
   * `analyzePrompt` output — consumers wanting the raw signals can
   * subscribe to a separate (not-yet-emitted) `subagent:dispatch_signals`
   * event if/when that becomes useful.
   */
  "subagent:dispatch_decision": {
    kind: "single" | "swarm" | "crew";
    configuredMode: "auto" | "single" | "swarm" | "crew";
    source: "explicit" | "auto-heuristic";
    promptLength: number;
    description: string;
  };
  /** Pi 0.81+ resilient compaction summarization retries. */
  "subagent:summarization_retry": {
    agentId: string;
    phase:
      | "summarization_retry_scheduled"
      | "summarization_retry_attempt_start"
      | "summarization_retry_finished";
    attempt?: number;
    maxAttempts?: number;
    success?: boolean;
  };
}

/** Event names as a union type */
export type TelemetryEventName = keyof TelemetryEvents;

/** Handler function type */
export type TelemetryHandler<E extends TelemetryEventName> = (payload: TelemetryEvents[E]) => void;

/** Security-relevant events that always warn when no listeners are registered. */
const SECURITY_EVENTS: ReadonlySet<TelemetryEventName> = new Set<TelemetryEventName>([
  "agent:validation-failed",
  "agent:unknown-tools",
]);

/** Routine lifecycle events retained for opt-in diagnostics without polluting normal stderr. */
const DEBUG_FALLBACK_EVENTS: ReadonlySet<TelemetryEventName> = new Set<TelemetryEventName>([
  "agent:loaded",
]);

/** Global registry of telemetry handlers (Symbol-based to avoid collisions) */

type HandlerRegistry = Map<TelemetryEventName, Set<unknown>>;

function getRegistry(): HandlerRegistry {
  let registry = getTelemetryRegistry<HandlerRegistry>();
  if (!registry) {
    registry = new Map();
    setTelemetryRegistry(registry);
  }
  return registry;
}

/**
 * Subscribe to a telemetry event.
 * Returns an unsubscribe function.
 */
export function onTelemetry<E extends TelemetryEventName>(
  event: E,
  handler: TelemetryHandler<E>,
): () => void {
  const registry = getRegistry();
  let handlers = registry.get(event) as Set<TelemetryHandler<E>> | undefined;
  if (!handlers) {
    handlers = new Set();
    registry.set(event, handlers);
  }
  handlers.add(handler);

  return () => {
    handlers?.delete(handler);
  };
}

/**
 * Emit a telemetry event.
 * If no listeners are registered, security events warn and routine lifecycle
 * events are emitted at debug level only.
 */
export function emitTelemetry<E extends TelemetryEventName>(
  event: E,
  payload: TelemetryEvents[E],
): void {
  const registry = getRegistry();
  const handlers = registry.get(event) as Set<TelemetryHandler<E>> | undefined;

  if (handlers && handlers.size > 0) {
    for (const handler of handlers) {
      try {
        handler(payload);
      } catch (err) {
        // Handler errors are logged but don't break the emitter
        logger.warn(`Telemetry handler error for ${event}:`, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  } else if (SECURITY_EVENTS.has(event as TelemetryEventName)) {
    logger.warn(`[telemetry] security event: ${event}`, { payload });
  } else if (DEBUG_FALLBACK_EVENTS.has(event as TelemetryEventName)) {
    logger.debug(`[telemetry] lifecycle event: ${event}`, { payload });
  }
}

/**
 * Compute SHA-256 hash of a string (hex-encoded).
 * Used for agent content integrity logging.
 */
export async function hashContent(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Synchronous hash using Node.js crypto (fallback for non-browser environments).
 * Used when async hash is not convenient.
 */
export function hashContentSync(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
