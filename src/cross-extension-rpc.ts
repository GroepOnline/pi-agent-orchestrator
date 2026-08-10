/**
 * Cross-extension RPC handlers for the subagents extension.
 *
 * Exposes ping, spawn, and stop RPCs over the pi.events event bus,
 * using per-request scoped reply channels.
 *
 * Reply envelope follows pi-mono convention:
 *   success → { success: true, data?: T }
 *   error   → { success: false, error: string }
 */

import { randomUUID } from "node:crypto";

import { type AuditOutcome, recordAudit } from "./audit-logger.js";
import { type ModelRegistry, resolveModel } from "./model-resolver.js";

// ---------------------------------------------------------------------------
// Typed RPC errors — used by auditedRpc to classify outcomes without
// fragile string matching.
// ---------------------------------------------------------------------------

export type RpcErrorCode = "RATE_LIMITED" | "UNAUTHORIZED" | "INVALID_PARAMS" | "ERROR";

export class RpcError extends Error {
  readonly code: RpcErrorCode;
  constructor(code: RpcErrorCode, message: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

/** Minimal event bus interface needed by the RPC handlers. */
export interface EventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

/** RPC reply envelope — matches pi-mono's RpcResponse shape. */
export type RpcReply<T = void> =
  | { success: true; data?: T }
  | { success: false; error: string };

/** RPC protocol version — bumped when the envelope or method contracts change. */
export const PROTOCOL_VERSION = 2;

export interface SpawnCapable {
  spawn(pi: unknown, ctx: unknown, type: string, prompt: string, options: any): string;
  abort(id: string): boolean;
}

export interface SessionCapable extends SpawnCapable {
  getSessionUsage(): { spawnedAgents: number; totalTurns: number };
  getSessionMaxSpawns(): number;
  getSessionMaxTurns(): number;
}

export interface SwarmCapable {
  listSwarms(): Array<{ swarmId: string; name: string; agentCount: number; strategy: string }>;
  getSwarmMetrics(swarmId?: string): {
    totalDeliveries: number;
    totalRecordsDelivered: number;
    partialDeliveries: number;
    timedOutDeliveries: number;
    averageLatencyMs?: number;
    bySwarm: Record<string, { deliveries: number; records: number; partials: number; timeouts: number }>;
  };
}

// Host-provided authentication context for RPC calls.
export interface AuthContext {
  extensionId: string;
  extensionName?: string;
  /**
   * Host-issued capability token. Required by {@link createTokenAuthProvider}.
   * Peers obtain it from `subagents:ready` or via `registerSubagentsApi` options.
   */
  authToken?: string;
}

/** Safe extension id for rate-limit buckets (no path separators / traversal). */
export const SAFE_EXTENSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Allowlisted spawn option keys for cross-extension RPC.
 * Privilege escalators (`bypassQueue`, callbacks, `cwd`, `signal`) are excluded.
 */
const RPC_SPAWN_OPTION_KEYS = new Set([
  "description",
  "model",
  "maxTurns",
  "isolated",
  "inheritContext",
  "thinkingLevel",
  "isBackground",
  "isolation",
  "currentLevel",
]);

/**
 * Build an authProvider that requires a host-issued token and only then
 * accepts a sanitized caller `extensionId` for rate-limit attribution.
 * Spoofed extensionIds without the token are rejected.
 */
export function createTokenAuthProvider(
  expectedToken: string,
): (requestId: string, payload: unknown) => AuthContext | undefined {
  return (_requestId, payload) => {
    if (!payload || typeof payload !== "object") return undefined;
    const authContext = (payload as { authContext?: unknown }).authContext;
    if (!authContext || typeof authContext !== "object") return undefined;
    const ctx = authContext as Record<string, unknown>;
    if (typeof ctx.authToken !== "string" || ctx.authToken !== expectedToken) {
      return undefined;
    }
    if (typeof ctx.extensionId !== "string" || !SAFE_EXTENSION_ID.test(ctx.extensionId)) {
      return undefined;
    }
    const result: AuthContext = { extensionId: ctx.extensionId };
    if (typeof ctx.extensionName === "string" && ctx.extensionName.length > 0 && ctx.extensionName.length <= 200) {
      result.extensionName = ctx.extensionName;
    }
    return result;
  };
}

/** Strip non-allowlisted keys from an RPC spawn `options` object. */
export function sanitizeRpcSpawnOptions(options: unknown): Record<string, unknown> {
  if (!options || typeof options !== "object" || Array.isArray(options)) return {};
  const src = options as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of RPC_SPAWN_OPTION_KEYS) {
    if (Object.hasOwn(src, key)) out[key] = src[key];
  }
  return out;
}

export interface SpawnRpcRequest {
  type: string;
  prompt: string;
  options?: Record<string, unknown>;
}

export interface StopRpcRequest {
  agentId: string;
}

export interface SessionUsageRpcReply {
  usage: { spawnedAgents: number; totalTurns: number };
  limits: { maxAgents: number; maxTurns: number };
}

export interface PingRpcReply {
  version: number;
}

export interface SubagentsRpcClient {
  ping(): Promise<PingRpcReply>;
  spawn(request: SpawnRpcRequest): Promise<{ id: string }>;
  stop(request: StopRpcRequest): Promise<void>;
  sessionUsage(): Promise<SessionUsageRpcReply>;
}

// ---------------------------------------------------------------------------
// Rate limiter — configurable window and max via RateLimitConfig
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/** Tunables for the per-extension rate limiter. */
export interface RateLimitConfig {
  /** Sliding window size in milliseconds (default 60 000 — one minute). */
  windowMs?: number;
  /** Maximum calls per window per extension+operation (default 10). */
  maxPerWindow?: number;
}

const DEFAULT_RATE_LIMIT_WINDOW = 60_000;
const DEFAULT_RATE_LIMIT_MAX = 10;

let rateLimitWindow = DEFAULT_RATE_LIMIT_WINDOW;
let rateLimitMax = DEFAULT_RATE_LIMIT_MAX;
const rateLimitMap = new Map<string, RateLimitEntry>();

/** Apply rate-limit configuration. Safe to call multiple times. */
export function configureRateLimit(config: RateLimitConfig): void {
  let windowChanged = false;
  if (config.windowMs !== undefined && Number.isFinite(config.windowMs) && config.windowMs > 0) {
    rateLimitWindow = config.windowMs;
    windowChanged = true;
  }
  if (config.maxPerWindow !== undefined && Number.isFinite(config.maxPerWindow) && config.maxPerWindow > 0) {
    rateLimitMax = config.maxPerWindow;
  }
  // Restart cleanup timer when the window changes so the interval stays aligned.
  if (windowChanged) {
    clearInterval(rateLimitCleanup);
    rateLimitCleanup = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of rateLimitMap.entries()) {
        if (now > entry.resetAt) {
          rateLimitMap.delete(key);
        }
      }
    }, Math.max(1_000, Math.floor(rateLimitWindow / 2)));
    rateLimitCleanup.unref?.();
  }
}

const MAX_RATE_LIMIT_ENTRIES = 1000;

function checkRateLimit(extensionId: string, operation: string): boolean {
  if (typeof extensionId !== "string" || extensionId.length > 200) return false;

  const now = Date.now();
  const key = `${extensionId}:${operation}`;
  const entry = rateLimitMap.get(key);

  if (!entry || now > entry.resetAt) {
    if (rateLimitMap.size >= MAX_RATE_LIMIT_ENTRIES) {
      const oldestKey = rateLimitMap.keys().next().value;
      if (oldestKey) rateLimitMap.delete(oldestKey);
    }
    rateLimitMap.set(key, { count: 1, resetAt: now + rateLimitWindow });
    return true;
  }

  if (entry.count >= rateLimitMax) {
    return false;
  }

  entry.count++;
  return true;
}

// Clean up old rate limit entries periodically.
// Derive interval from the configured window so expired entries don't linger
// when the window is shorter than the old hardcoded 60 s.
let rateLimitCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap.entries()) {
    if (now > entry.resetAt) {
      rateLimitMap.delete(key);
    }
  }
}, Math.max(1_000, Math.floor(rateLimitWindow / 2)));
rateLimitCleanup.unref?.();

export function resetRpcRateLimitsForTests(): void {
  rateLimitMap.clear();
  rateLimitWindow = DEFAULT_RATE_LIMIT_WINDOW;
  rateLimitMax = DEFAULT_RATE_LIMIT_MAX;
}

/** Return current effective rate-limit settings (useful in tests & diagnostics). */
export function getRateLimitConfig(): Required<RateLimitConfig> {
  return { windowMs: rateLimitWindow, maxPerWindow: rateLimitMax };
}

export interface RpcDeps {
  events: EventBus;
  pi: unknown;                    // passed through to manager.spawn
  getCtx: () => unknown | undefined;  // returns current ExtensionContext
  manager: SpawnCapable;
  authProvider?: (requestId: string, payload: any) => AuthContext | undefined;
  /** Optional rate-limit tunables applied at registration time. */
  rateLimit?: RateLimitConfig;
  /** Optional session-capable manager for session usage RPC. */
  sessionManager?: SessionCapable;
  /** Optional swarm coordinator for swarm health RPC. */
  swarmCoordinator?: SwarmCapable;
}

export interface RpcHandle {
  unsubPing: () => void;
  unsubSpawn: () => void;
  unsubStop: () => void;
  unsubSessionUsage: () => void;
  /** No-op when swarmCoordinator was not provided to registerRpcHandlers. */
  unsubSwarmHealth?: () => void;
}

/**
 * Wire a single RPC handler: listen on `channel`, run `fn(params)`,
 * emit the reply envelope on `channel:reply:${requestId}`.
 */
function handleRpc<P extends { requestId: string }>(
  events: EventBus,
  channel: string,
  fn: (params: P) => unknown | Promise<unknown>,
): () => void {
  return events.on(channel, async (raw: unknown) => {
    try {
      if (typeof raw !== "object" || raw === null) {
        throw new RpcError("INVALID_PARAMS", "Expected object payload");
      }
      const rawObj = raw as Record<string, unknown>;
      if (typeof rawObj.requestId !== "string" || !rawObj.requestId) {
        throw new RpcError("INVALID_PARAMS", "Missing or empty requestId");
      }
      const params = raw as P;
      const data = await fn(params);
      const reply: { success: true; data?: unknown } = { success: true };
      if (data !== undefined) reply.data = data;
      events.emit(`${channel}:reply:${params.requestId}`, reply);
    } catch (err: unknown) {
      const requestId = (raw as Record<string, unknown>)?.requestId;
      events.emit(`${channel}:reply:${requestId}`, {
        success: false, error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

function createRequestId(): string {
  return `rpc-${randomUUID()}`;
}

function requestRpc<T>(
  events: EventBus,
  channel: string,
  payload: object,
  timeoutMs: number,
): Promise<T> {
  const requestId = createRequestId();
  const replyChannel = `${channel}:reply:${requestId}`;
  return new Promise((resolve, reject) => {
    const unsub = events.on(replyChannel, (raw) => {
      clearTimeout(timer);
      unsub();
      const reply = raw as RpcReply<T>;
      if (reply.success) resolve(reply.data as T);
      else reject(new Error(reply.error));
    });
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`RPC timeout waiting for ${channel}`));
    }, timeoutMs);
    events.emit(channel, { ...payload, requestId });
  });
}

export function createSubagentsRpcClient(
  events: EventBus,
  options: { timeoutMs?: number; extensionId?: string; authToken?: string } = {},
): SubagentsRpcClient {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const authContext: AuthContext = {
    extensionId: options.extensionId ?? "legacy",
    ...(options.authToken ? { authToken: options.authToken } : {}),
  };
  return {
    ping: () => requestRpc<PingRpcReply>(events, "subagents:rpc:ping", { authContext }, timeoutMs),
    spawn: (request) => requestRpc<{ id: string }>(events, "subagents:rpc:spawn", { ...request, authContext }, timeoutMs),
    stop: async (request) => {
      await requestRpc<void>(events, "subagents:rpc:stop", { ...request, authContext }, timeoutMs);
    },
    sessionUsage: () => requestRpc<SessionUsageRpcReply>(events, "subagents:rpc:sessionUsage", { authContext }, timeoutMs),
  };
}

function resolveAuth(deps: RpcDeps, requestId: string, payload: any): AuthContext {
  if (!deps.authProvider) {
    return { extensionId: "legacy" };
  }

  const auth = deps.authProvider(requestId, payload);
  if (!auth?.extensionId) {
    throw new RpcError("UNAUTHORIZED", "Unauthorized RPC request");
  }
  return auth;
}

function authorizeRpcMutation(deps: RpcDeps, requestId: string, operation: string, payload: any): AuthContext {
  const auth = resolveAuth(deps, requestId, payload);
  if (!checkRateLimit(auth.extensionId, operation)) {
    throw new RpcError("RATE_LIMITED", `Rate limit exceeded for extension ${auth.extensionId}`);
  }
  return auth;
}

// ---------------------------------------------------------------------------
// Audit-trail helper — wraps an RPC handler to capture outcome and duration.
// ---------------------------------------------------------------------------

type AuditableOperation = "ping" | "spawn" | "stop" | "sessionUsage" | "swarmHealth";

function auditedRpc<P extends { requestId: string }>(
  deps: RpcDeps,
  operation: AuditableOperation,
  fn: (params: P) => { auth: AuthContext; result: unknown | Promise<unknown> },
): (params: P) => unknown | Promise<unknown> {
  return async (params: P) => {
    const start = Date.now();
    let outcome: AuditOutcome = "success";
    // Eagerly resolve caller identity so the audit entry is attributed
    // even when the handler throws (rate-limit, unauthorized, etc.).
    let auth: AuthContext;
    try {
      auth = resolveAuth(deps, params.requestId, params);
    } catch {
      auth = { extensionId: "unknown" };
    }
    let metadata: Record<string, unknown> | undefined;
    try {
      const out = fn(params);
      auth = out.auth;
      const result = await out.result;
      return result;
    } catch (err: unknown) {
      if (err instanceof RpcError) {
        outcome = err.code === "RATE_LIMITED"
          ? "rate_limited"
          : err.code === "UNAUTHORIZED"
            ? "unauthorized"
            : "error";
      } else {
        outcome = "error";
      }
      metadata = { error: err instanceof Error ? err.message : String(err) };
      throw err;
    } finally {
      recordAudit({
        timestamp: new Date().toISOString(),
        extensionId: auth.extensionId,
        extensionName: auth.extensionName,
        operation,
        outcome,
        durationMs: Date.now() - start,
        metadata,
      });
    }
  };
}

/**
 * Register ping, spawn, stop, and sessionUsage RPC handlers on the event bus.
 * Returns unsub functions for cleanup.
 *
 * **Global rate-limit state:** Calling this function with `deps.rateLimit` will
 * mutate module-level globals (`rateLimitWindow`, `rateLimitMax`) via
 * {@link configureRateLimit}. Multiple registrations in the same process share
 * and override these settings — the last registration wins. This is intentional
 * for the expected single-registration pattern; callers registering multiple
 * times should be aware of the side effect.
 */
export function registerRpcHandlers(deps: RpcDeps): RpcHandle {
  const { events, pi, getCtx, manager, sessionManager, swarmCoordinator } = deps;

  // Apply caller-provided rate-limit tunables (if any).
  if (deps.rateLimit) configureRateLimit(deps.rateLimit);

  const unsubPing = handleRpc(
    events,
    "subagents:rpc:ping",
    auditedRpc<{ requestId: string; authContext?: AuthContext }>(deps, "ping", (params) => {
      const auth = resolveAuth(deps, params.requestId, params);
      return { auth, result: { version: PROTOCOL_VERSION } };
    }),
  );

  const unsubSpawn = handleRpc<{ requestId: string; type: string; prompt: string; options?: any; authContext?: AuthContext }>(
    events,
    "subagents:rpc:spawn",
    auditedRpc<{ requestId: string; type: string; prompt: string; options?: any; authContext?: AuthContext }>(
      deps,
      "spawn",
      (params) => {
        const { requestId, type, prompt, options } = params;
        const ctx = getCtx();
        if (!ctx) {
          throw new Error(`No active session for rpc:spawn (type=${type}, requestId=${requestId})`);
        }

        // Forward the full params (including authContext) so token auth can validate.
        const auth = authorizeRpcMutation(deps, requestId, "spawn", params);

        // Cross-extension RPC callers (e.g. pi-tasks TaskExecute) naturally
        // forward serializable values, so options.model can be a string like
        // "openai-codex/gpt-5.5". Resolve it to a real Model instance here
        // — same pattern the scheduler path already uses — so the spawned
        // agent's auth lookup doesn't crash with "No API key found for
        // undefined".
        let normalizedOptions = sanitizeRpcSpawnOptions(options);
        if (typeof normalizedOptions.model === "string") {
          const registry = (ctx as { modelRegistry?: ModelRegistry }).modelRegistry;
          if (!registry) {
            throw new Error(
              `Model override "${normalizedOptions.model}" provided but ctx.modelRegistry is unavailable`,
            );
          }
          const resolved = resolveModel(normalizedOptions.model, registry);
          if (typeof resolved === "string") {
            throw new Error(resolved);
          }
          normalizedOptions = { ...normalizedOptions, model: resolved };
        }

        const id = manager.spawn(pi, ctx, type, prompt, normalizedOptions);
        return { auth, result: { id } };
      },
    ),
  );

  const unsubStop = handleRpc<{ requestId: string; agentId: string; authContext?: AuthContext }>(
    events,
    "subagents:rpc:stop",
    auditedRpc<{ requestId: string; agentId: string; authContext?: AuthContext }>(deps, "stop", (params) => {
      const auth = authorizeRpcMutation(deps, params.requestId, "stop", params);
      if (!manager.abort(params.agentId)) throw new Error("Agent not found");
      return { auth, result: undefined };
    }),
  );

  const unsubSessionUsage = sessionManager
    ? handleRpc(
        events,
        "subagents:rpc:sessionUsage",
        auditedRpc<{ requestId: string; authContext?: AuthContext }>(deps, "sessionUsage", (params) => {
          const auth = resolveAuth(deps, params.requestId, params);
          return {
            auth,
            result: {
              usage: sessionManager!.getSessionUsage(),
              limits: {
                maxAgents: sessionManager!.getSessionMaxSpawns(),
                maxTurns: sessionManager!.getSessionMaxTurns(),
              },
            },
          };
        }),
      )
    : () => {};

  const unsubSwarmHealth = swarmCoordinator
    ? handleRpc(
        events,
        "subagents:rpc:swarmHealth",
        auditedRpc<{ requestId: string; authContext?: AuthContext }>(deps, "swarmHealth", (params) => {
          const auth = resolveAuth(deps, params.requestId, params);
          return {
            auth,
            result: {
              swarms: swarmCoordinator!.listSwarms(),
              metrics: swarmCoordinator!.getSwarmMetrics(),
            },
          };
        }),
      )
    : () => {};

  return { unsubPing, unsubSpawn, unsubStop, unsubSessionUsage, unsubSwarmHealth };
}
