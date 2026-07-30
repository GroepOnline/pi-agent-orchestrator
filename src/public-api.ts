/**
 * public-api.ts — Single entry point for the orchestrator's typed public API.
 *
 * Re-exports all RPC, hook, and event types that peer extensions and tests
 * need to consume, and provides a Symbol-based discovery mechanism so that
 * consumers don't need direct module references.
 *
 * Usage from a peer extension:
 *
 * ```ts
 * import { getSubagentsApi, type TypedHookPayload } from "@onlinechefgroep/pi-agent-orchestrator/public-api";
 *
 * const api = getSubagentsApi();
 * if (!api) throw new Error("pi-agent-orchestrator extension is not loaded");
 *
 * // Typed RPC
 * const { id } = await api.rpc.spawn({ type: "Explore", prompt: "scan deps" });
 *
 * // Typed lifecycle subscription — handler gets the exact data shape
 * // the extension emits for "subagent:start", not a `Record<string, unknown>`.
 * api.hooks.on("subagent:start", async (payload) => {
 *   //    ^? TypedHookPayload<"subagent:start">  →  { event, agentId, data: AgentStartData, ... }
 *   console.log(payload.data.type, payload.data.description);
 *   return "allow";
 * });
 * ```
 *
 * **Symbol registry contract:** the orchestrator publishes its API on
 * `globalThis[Symbol.for("pi-subagents:api")]` and its raw `HookRegistry` on
 * `globalThis[Symbol.for("pi-subagents:hooks")]`. The latter name is
 * documented in `docs/api-reference.md` but was previously not actually
 * implemented — this module closes that drift.
 */

import {
  createSubagentsRpcClient,
  type EventBus,
  PROTOCOL_VERSION,
  type SubagentsRpcClient,
} from "./cross-extension-rpc.js";
import {
  type HookEvent,
  type HookPayload,
  HookRegistry,
  type HookResponse,
} from "./hooks.js";

// ---------------------------------------------------------------------------
// Symbol-based discovery keys.
//
// We reuse the names already advertised in `docs/api-reference.md` so this
// module is additive (not breaking) for consumers that already know those
// symbols. We also add `pi-subagents:api` for the new typed surface.
// ---------------------------------------------------------------------------

/** Symbol under which the orchestrator publishes its typed public API. */
export const SUBAGENTS_API_SYMBOL = Symbol.for("pi-subagents:api");

/** Symbol under which the orchestrator publishes its raw `HookRegistry`. */
export const SUBAGENTS_HOOKS_SYMBOL = Symbol.for("pi-subagents:hooks");

/** Symbol under which the orchestrator publishes its read-only `SubagentManagerHandle`. */
export const SUBAGENTS_MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");

// ---------------------------------------------------------------------------
// Typed event payload map.
//
// Each `HookEvent` resolves to a specific data shape that the orchestrator
// actually passes in `HookPayload.data`. Handlers subscribed via the typed
// `on(event, handler)` helper get the corresponding shape, not the current
// `Record<string, unknown>` black box. Adding a new `HookEvent` requires
// adding a row here so the type system forces the contract to stay honest.
// ---------------------------------------------------------------------------

export interface AgentStartData {
  type: string;
  description: string;
  parentId?: string;
}

export interface AgentEndData {
  status: "completed" | "aborted" | "error" | "stopped" | "steered";
  result?: string;
  error?: string;
  durationMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  turns?: number;
  /** Final assistant text available to quality-gate hooks. */
  responseText?: string;
  /** 1-based end-hook attempt (initial completion = 1). */
  attempt?: number;
  /** Total allowed attempts = 1 + maxEndHookRevisions. */
  maxAttempts?: number;
}

export interface AgentErrorData {
  error: string;
  stack?: string;
}

export interface AgentSpawnData {
  type: string;
  description: string;
  parentId?: string;
}

export interface AgentSteerData {
  instruction: string;
}

export interface ToolCallData {
  toolName: string;
  input: unknown;
}

export interface ToolResultData {
  toolName: string;
  result: unknown;
  error?: string;
}

export interface CompactionStartData {
  /** Upstream Pi compaction reason (`threshold` | `overflow` | `manual`, etc.). */
  reason: string;
}

export interface CompactionEndData {
  /** Upstream Pi compaction reason. */
  reason: string;
  /** Estimated tokens before the successful compaction summary. */
  tokensBefore: number;
  /** Estimated tokens after summarization when Pi reports them (0.81+). */
  tokensAfter?: number;
  /** Percent reduction from tokensBefore → tokensAfter when both known. */
  reductionPercent?: number;
  /** Always false for successful `compaction:end` hook dispatches. */
  aborted?: boolean;
  /** Whether Pi will retry a failed summarization (0.81.1 resilient compaction). */
  willRetry?: boolean;
  errorMessage?: string;
}

export interface TurnStartData {
  turnNumber: number;
}

export interface TurnEndData {
  turnNumber: number;
}

export interface SwarmJoinData {
  swarmId: string;
  agentId: string;
}

export interface SwarmLeaveData {
  swarmId: string;
  agentId: string;
  reason?: string;
}

export interface ValidationStartData {
  criteria: readonly string[];
}

export interface ValidationEndData {
  passed: boolean;
  summary: string;
}

// `satisfies` enforces exhaustiveness over the `HookEvent` union — adding a
// new `HookEvent` to `src/hooks.ts` without a matching row here fails the build.
export const TYPED_HOOK_PAYLOAD_MAP = {
  "subagent:start": { type: "", description: "" } as AgentStartData,
  "subagent:end": { status: "completed" as const } as AgentEndData,
  "subagent:error": { error: "" } as AgentErrorData,
  "subagent:spawn": { type: "", description: "" } as AgentSpawnData,
  "subagent:steer": { instruction: "" } as AgentSteerData,
  "tool:call": { toolName: "", input: null } as ToolCallData,
  "tool:result": { toolName: "", result: null } as ToolResultData,
  "compaction:start": { reason: "threshold" } as CompactionStartData,
  "compaction:end": { reason: "threshold", tokensBefore: 0 } as CompactionEndData,
  "turn:start": { turnNumber: 0 } as TurnStartData,
  "turn:end": { turnNumber: 0 } as TurnEndData,
  "swarm:join": { swarmId: "", agentId: "" } as SwarmJoinData,
  "swarm:leave": { swarmId: "", agentId: "" } as SwarmLeaveData,
  "validation:start": { criteria: [] } as ValidationStartData,
  "validation:end": { passed: false, summary: "" } as ValidationEndData,
} satisfies Record<HookEvent, unknown>;

export type TypedHookPayloadMap = typeof TYPED_HOOK_PAYLOAD_MAP;

/** Discriminated hook payload — `data` is shaped by `event`. */
export type TypedHookPayload<E extends HookEvent> = {
  event: E;
  agentId: string;
  data: TypedHookPayloadMap[E];
  timestamp?: number;
};

/** Handler shape for the typed `on(event, handler)` helper. */
export type TypedHookHandler<E extends HookEvent> = (
  payload: TypedHookPayload<E>,
) => Promise<HookResponse | undefined> | HookResponse | undefined;

// ---------------------------------------------------------------------------
// Public surface returned by `registerSubagentsApi` / `getSubagentsApi`.
// ---------------------------------------------------------------------------

/** Typed lifecycle subscription — discriminated by event name. */
export interface TypedEventSubscription {
  /** Subscribe to a single typed event. Returns an unsubscribe function. */
  on<E extends HookEvent>(event: E, handler: TypedHookHandler<E>): () => void;
  /** Subscribe to every lifecycle event (typed as the union). Returns an unsubscribe function. */
  onAll(
    handler: (payload: TypedHookPayload<HookEvent>) => Promise<HookResponse | undefined> | HookResponse | undefined,
  ): () => void;
  /** Underlying registry — read-only mirror for advanced consumers. */
  readonly registry: HookRegistry;
}

/** Top-level typed public API exposed to peer extensions. */
export interface SubagentsPublicApi {
  /** Protocol version the consumer is talking to. */
  readonly protocolVersion: number;
  /** Typed RPC client — `ping` / `spawn` / `stop` / `sessionUsage`. */
  readonly rpc: SubagentsRpcClient;
  /** Typed lifecycle subscription. */
  readonly hooks: TypedEventSubscription;
  /** Read-only manager handle — `waitForAll` / `hasRunning` / `getRecord` / `listAgentIds`. */
  readonly manager: SubagentManagerHandle;
}

/**
 * Maximum length of the `description` field exposed on the sanitized manager
 * record. Hardcoded to keep the security contract (don't leak full prompts
 * / long context to peer extensions) obvious; bump in a follow-up if a
 * legitimate consumer needs more.
 */
export const SUBAGENT_MANAGER_MAX_DESCRIPTION_CHARS = 200;

/**
 * Sanitized, non-sensitive shape of an agent record that the manager handle
 * exposes to peer extensions. Sensitive fields (full description, prompt,
 * result, error, internal flags) are intentionally omitted; consumers that
 * need the full record should use the `Agent` tool or RPC instead.
 */
export interface SubagentManagerRecord {
  id: string;
  type: string;
  status: string;
  /** Truncated to `SUBAGENT_MANAGER_MAX_DESCRIPTION_CHARS` by the handle builder. */
  description?: string;
}

/**
 * Read-only handle over the orchestrator's `AgentManager`, exposed to peer
 * extensions so they can observe running agents and read safe metadata
 * without gaining the ability to spawn, stop, or mutate them.
 */
export interface SubagentManagerHandle {
  /** Wait until every currently-running agent has reached a terminal state. */
  waitForAll(): Promise<void>;
  /** Whether any agent is currently running (not yet terminal). */
  hasRunning(): boolean;
  /** Look up an agent by id. Returns a sanitized record or `undefined`. */
  getRecord(id: string): SubagentManagerRecord | undefined;
  /** List the ids of all known agents of a given type. */
  listAgentIds(type: string): string[];
}

/** Structural shape of the manager required by `registerSubagentsApi`. */
export interface SubagentManagerLike {
  waitForAll(): Promise<void>;
  hasRunning(): boolean;
  getRecord(id: string): { id: string; type: string; status: string; description?: string } | undefined;
  listAgents(): ReadonlyArray<{ id: string; type: string }>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Derived from the payload map keys, so adding a new `HookEvent` to
// `src/hooks.ts` plus a row in the map is enough — `onAll` picks it up
// automatically and exhaustiveness is enforced by `satisfies` above.
const ALL_HOOK_EVENTS = Object.keys(TYPED_HOOK_PAYLOAD_MAP) as readonly HookEvent[];

function buildTypedSubscription(registry: HookRegistry): TypedEventSubscription {
  // Adapter for `on`: explicit return type so the casted handler's return
  // is not widened to `void` by contextual typing.
  const onAdapter = <E extends HookEvent>(
    handler: TypedHookHandler<E>,
  ): ((payload: HookPayload) => HookResponse | Promise<HookResponse | undefined> | undefined) => {
    return (payload) => handler(payload as unknown as TypedHookPayload<E>);
  };
  // Adapter for `onAll`: same shape, wider payload type.
  // Drops `void` from the handler return — the underlying registry requires a
  // concrete HookResponse-ish return, and `void` is not assignable to it.
  const onAllAdapter = (
    handler: (payload: TypedHookPayload<HookEvent>) => Promise<HookResponse | undefined> | HookResponse | undefined,
  ): ((payload: HookPayload) => HookResponse | Promise<HookResponse | undefined> | undefined) => {
    return (payload) => handler(payload as unknown as TypedHookPayload<HookEvent>);
  };

  return {
    on<E extends HookEvent>(event: E, handler: TypedHookHandler<E>): () => void {
      // `HookRegistry.register` returns a string id, not a function — wrap
      // it with `unregisterById` to give consumers a real unsubscribe.
      const id = registry.register(event, onAdapter(handler));
      return () => {
        registry.unregisterById(id);
      };
    },
    onAll(
      handler: (payload: TypedHookPayload<HookEvent>) => Promise<HookResponse | undefined> | HookResponse | undefined,
    ): () => void {
      const ids: string[] = [];
      for (const event of ALL_HOOK_EVENTS) {
        ids.push(registry.register(event, onAllAdapter(handler)));
      }
      return () => {
        for (const id of ids) registry.unregisterById(id);
      };
    },
    registry,
  };
}

/**
 * Wrap a real `AgentManager` in the read-only `SubagentManagerHandle`. The
 * handle exposes only the four observation methods and intentionally drops
 * every mutating surface (`spawn`, `stop`, `abort`, `clearCompleted`, etc.).
 * `getRecord` returns a sanitized projection of the internal `AgentRecord` so
 * peer extensions cannot see full prompts, results, or error stacks.
 */
function buildManagerHandle(manager: SubagentManagerLike): SubagentManagerHandle {
  return {
    waitForAll: () => manager.waitForAll(),
    hasRunning: () => manager.hasRunning(),
    getRecord: (id: string) => {
      const r = manager.getRecord(id);
      if (!r) return undefined;
      return {
        id: r.id,
        type: r.type,
        status: r.status,
        description: r.description?.slice(0, SUBAGENT_MANAGER_MAX_DESCRIPTION_CHARS),
      };
    },
    listAgentIds: (type: string) =>
      manager.listAgents().filter((a) => a.type === type).map((a) => a.id),
  };
}

// ---------------------------------------------------------------------------
// Publish / discover
// ---------------------------------------------------------------------------

/**
 * Publish the orchestrator's typed API on `globalThis[Symbol.for("pi-subagents:api")]`,
 * its raw `HookRegistry` on `globalThis[Symbol.for("pi-subagents:hooks")]`, and
 * its read-only `SubagentManagerHandle` on `globalThis[Symbol.for("pi-subagents:manager")]`.
 *
 * Called once by the extension on load. **Idempotent** — last registration wins,
 * matching the pattern documented for `registerRpcHandlers` in
 * `src/cross-extension-rpc.ts`.
 */
export function registerSubagentsApi(
  events: EventBus,
  hooks: HookRegistry,
  manager: SubagentManagerLike,
  options: { extensionId?: string; timeoutMs?: number; authToken?: string } = {},
): SubagentsPublicApi {
  const managerHandle = buildManagerHandle(manager);
  const api: SubagentsPublicApi = {
    protocolVersion: PROTOCOL_VERSION,
    rpc: createSubagentsRpcClient(events, options),
    hooks: buildTypedSubscription(hooks),
    manager: managerHandle,
  };
  const store = globalThis as unknown as Record<symbol, unknown>;
  store[SUBAGENTS_API_SYMBOL] = api;
  store[SUBAGENTS_HOOKS_SYMBOL] = hooks;
  store[SUBAGENTS_MANAGER_SYMBOL] = managerHandle;
  return api;
}

/** Forget the published API, hook registry, and manager handle. Test-only / opt-in cleanup. */
export function clearSubagentsApi(): void {
  const store = globalThis as unknown as Record<symbol, unknown>;
  // Assign `undefined` instead of `delete` — Symbol-keyed globalThis
  // properties are not always configurable, and the getters already
  // treat `=== undefined` as "not registered".
  store[SUBAGENTS_API_SYMBOL] = undefined;
  store[SUBAGENTS_HOOKS_SYMBOL] = undefined;
  store[SUBAGENTS_MANAGER_SYMBOL] = undefined;
}

/**
 * Discover the orchestrator's typed API on globalThis.
 * Returns `undefined` if the extension is not loaded.
 */
export function getSubagentsApi(): SubagentsPublicApi | undefined {
  return (globalThis as unknown as Record<symbol, unknown>)[SUBAGENTS_API_SYMBOL] as
    | SubagentsPublicApi
    | undefined;
}

/** Discover the orchestrator's raw `HookRegistry`. Returns `undefined` if not loaded. */
export function getSubagentsHooks(): HookRegistry | undefined {
  return (globalThis as unknown as Record<symbol, unknown>)[SUBAGENTS_HOOKS_SYMBOL] as
    | HookRegistry
    | undefined;
}

/** Discover the orchestrator's read-only `SubagentManagerHandle`. Returns `undefined` if not loaded. */
export function getSubagentsManager(): SubagentManagerHandle | undefined {
  return (globalThis as unknown as Record<symbol, unknown>)[SUBAGENTS_MANAGER_SYMBOL] as
    | SubagentManagerHandle
    | undefined;
}

// ---------------------------------------------------------------------------
// Re-exports — the full public surface in one place.
//
// Internal callers may continue to import from the source modules directly;
// peer extensions should prefer this entry point for a stable contract.
// ---------------------------------------------------------------------------

export {
  type AuthContext,
  createSubagentsRpcClient,
  createTokenAuthProvider,
  type EventBus,
  type PingRpcReply,
  PROTOCOL_VERSION,
  type RateLimitConfig,
  type RpcReply,
  SAFE_EXTENSION_ID,
  type SessionCapable,
  type SessionUsageRpcReply,
  type SpawnCapable,
  type SpawnRpcRequest,
  type StopRpcRequest,
  type SubagentsRpcClient,
  type SwarmCapable,
  sanitizeRpcSpawnOptions,
} from "./cross-extension-rpc.js";

export {
  composeHandlers,
  type HookEvent,
  type HookHandler,
  type HookPayload,
  HookRegistry,
  type HookResponse,
  isBlockResponse,
  type NormalizedHookDecision,
  normalizeHookResponse,
} from "./hooks.js";
