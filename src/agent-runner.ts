/**
 * agent-runner.ts — Enterprise Agent Execution Engine
 *
 * Core execution engine that creates sessions, runs agents, collects results.
 * Enhanced with:
 * - Swarm integration (heartbeats, inter-agent messaging)
 * - Resource quotas (token budgets, time limits, tool limits)
 * - Circuit breaker for model calls
 * - Structured error classification
 * - Graceful degradation strategies
 * - Comprehensive telemetry and metrics
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { isAbortError } from "./abort-wait.js";
import { getPromptCompressionLevel } from "./agent-registry.js";
import {
  runAdversarialValidation,
} from "./agent-runner-validator.js";
import { type EffectiveConfig, getAgentConfig, getConfig, getMemoryToolNames, getReadOnlyMemoryToolNames, getToolNamesForType } from "./agent-types.js";
import { loadChefGroepPreflight } from "./chefgroep-preflight.js";
import { buildCompactionSnapshot, type CompactionSnapshot } from "./compaction-snapshot.js";
import { buildParentContext, extractText } from "./context.js";
import { resolveCtxInjectionForAgent } from "./context-mode-bridge.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import { detectEnv } from "./env.js";
import { buildEnvFromContext } from "./env-context.js";
import { type AgentHandoff, parseHandoff, renderHandoffForParent } from "./handoff.js";
import { type HookRegistry, normalizeHookResponse } from "./hooks.js";
import { logger } from "./logger.js";
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "./memory.js";
import { buildAgentPrompt, type PromptExtras } from "./prompts.js";
import { loadSettings } from "./settings.js";
import { preloadSkills } from "./skill-loader.js";
import { getSwarmCoordinator } from "./swarm-join.js";
import { emitTelemetry } from "./telemetry.js";
import {
  endAgentSpan,
  endCompactionSpan,
  endToolSpan,
  endTurnSpan,
  startAgentSpan,
  startCompactionSpan,
  startToolSpan,
  startTurnSpan,
} from "./telemetry-otel.js";
import type { SubagentType, ThinkingLevel, ValidationResult } from "./types.js";
import {
  hasValidators,
} from "./validators.js";

// ============================================================================
// Constants & Error Types
// ============================================================================

/** Names of tools registered by this extension that subagents must NOT inherit. */
const EXCLUDED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Agent",
  "get_subagent_result",
  "steer_subagent",
]);

/**
 * Default max turns. undefined = unlimited.
 * Data-driven default (2026-08-10, 268-session eval): workers without an
 * explicit budget ran to the 10min duration quota (DEFAULT_MAX_DURATION_MS)
 * and were aborted with no final report — 40/43 subagent aborts in the
 * eval were exactly that. A finite default turns the duration kill into a
 * soft-limit steer (with graceTurns of headroom for the report) so workers
 * always return an end report instead of dying silently.
 * 30 turns ≈ 4-8 min at typical model turn cost; oversize tasks should
 * pass an explicit max_turns instead of relying on the ceiling.
 */
let defaultMaxTurns: number | undefined = 30;

/** Additional turns allowed after the soft limit steer message. */
let graceTurns = 5;

/**
 * Max revision turns after a blocking `subagent:end` hook.
 * 0 = fail closed immediately (no revision). Fresh-install default keeps
 * end hooks observational unless a quality gate opts into revisions.
 */
let maxEndHookRevisions = 0;

/** Resource quota defaults. */
const DEFAULT_MAX_TOKENS = 500_000;
const DEFAULT_MAX_DURATION_MS = 600_000; // 10 minutes
const DEFAULT_MAX_TOOL_CALLS = 100;

/** Circuit breaker defaults. */
const CB_FAILURE_THRESHOLD = 5;
const CB_RECOVERY_TIMEOUT_MS = 30_000;

export class AgentRunnerError extends Error {
  constructor(
    message: string,
    public readonly code: "depth_exceeded" | "model_unavailable" | "quota_exceeded" | "aborted" | "timeout" | "unknown",
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AgentRunnerError";
  }
}

// ============================================================================
// Configuration
// ============================================================================

export function normalizeMaxTurns(n: number | undefined): number | undefined {
  if (n == null || typeof n !== "number" || Number.isNaN(n) || !Number.isFinite(n) || n === 0) return undefined;
  return Math.max(1, Math.floor(n));
}

export function getDefaultMaxTurns(): number | undefined {
  return defaultMaxTurns;
}

export function setDefaultMaxTurns(n: number | undefined): void {
  defaultMaxTurns = normalizeMaxTurns(n);
}

export function getGraceTurns(): number {
  return graceTurns;
}

export function setGraceTurns(n: number): void {
  graceTurns = Math.max(1, n);
}

export function getMaxEndHookRevisions(): number {
  return maxEndHookRevisions;
}

/** Clamp end-hook revision budget to a safe finite 0..10 range (NaN/Inf → 0). */
export function clampMaxEndHookRevisions(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(10, Math.trunc(n))) : 0;
}

export function setMaxEndHookRevisions(n: number): void {
  maxEndHookRevisions = clampMaxEndHookRevisions(n);
}

// ============================================================================
// Circuit Breaker for Model Calls
// ============================================================================

class ModelCircuitBreaker {
  private failures = 0;
  private lastFailureAt = 0;
  private state: "closed" | "open" | "half-open" = "closed";

  call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailureAt > CB_RECOVERY_TIMEOUT_MS) {
        this.state = "half-open";
      } else {
        throw new AgentRunnerError(
          "Model circuit breaker is OPEN — too many consecutive failures",
          "model_unavailable",
          { failures: this.failures, lastFailure: this.lastFailureAt },
        );
      }
    }

    return fn().then(
      (result) => {
        if (this.state === "half-open") {
          this.state = "closed";
        }
        this.failures = 0;
        return result;
      },
      (err) => {
        this.failures++;
        this.lastFailureAt = Date.now();
        if (this.failures >= CB_FAILURE_THRESHOLD) {
          this.state = "open";
        }
        throw err;
      },
    );
  }

  getState(): { state: string; failures: number; lastFailureAt: number } {
    return { state: this.state, failures: this.failures, lastFailureAt: this.lastFailureAt };
  }
}

const globalCircuitBreaker = new ModelCircuitBreaker();

// ============================================================================
// Model Resolution
// ============================================================================

let _cachedRegistry: unknown = null;
let _cachedKeys: Set<string> | null = null;

function getAvailableKeys(
  registry: { getAvailable?(): Model<Api>[] },
): Set<string> | undefined {
  if (registry === _cachedRegistry && _cachedKeys) return _cachedKeys;
  const available = registry.getAvailable?.();
  if (!available) return undefined;
  _cachedKeys = new Set(available.map((m) => `${m.provider}/${m.id}`));
  _cachedRegistry = registry;
  return _cachedKeys;
}

/**
 * Resolve the effective configured model string for a spawned agent.
 *
 * A `subagentModel` setting overrides the agent's own configured model:
 * - `"inherit"` → `undefined`, so `resolveDefaultModel` falls back to the
 *   session-default (parent) model. This is the escape hatch when a built-in
 *   read-only agent's pinned model is unreachable (e.g. provider 401).
 * - any other non-empty string → used verbatim as a `provider/modelId`.
 * - `undefined` → the agent's own configured model is used (current behavior).
 */
export function resolveConfiguredModel(
  subagentModelSetting: string | undefined,
  agentModel: string | undefined,
): string | undefined {
  if (subagentModelSetting === "inherit") return undefined;
  return subagentModelSetting ?? agentModel;
}

function resolveDefaultModel(
  parentModel: Model<Api> | undefined,
  registry: {
    find(provider: string, modelId: string): Model<Api> | undefined;
    getAvailable?(): Model<Api>[];
  },
  configModel?: string,
): Model<Api> | undefined {
  if (configModel) {
    const slashIdx = configModel.indexOf("/");
    if (slashIdx !== -1) {
      const provider = configModel.slice(0, slashIdx);
      const modelId = configModel.slice(slashIdx + 1);

      const availableKeys = getAvailableKeys(registry);
      const isAvailable = (p: string, id: string) =>
        !availableKeys || availableKeys.has(`${p}/${id}`);

      const found = registry.find(provider, modelId);
      if (found && isAvailable(provider, modelId)) return found;
    }
  }
  return parentModel;
}

// ============================================================================
// Types
// ============================================================================

export interface ToolActivity {
  type: "start" | "end";
  toolName: string;
}

export interface ResourceQuotas {
  /** Max total tokens (input + output) before hard stop. */
  maxTokens?: number;
  /** Max execution duration in ms. */
  maxDurationMs?: number;
  /** Max number of tool calls. */
  maxToolCalls?: number;
}

export interface SwarmOptions {
  /** Enable swarm heartbeat reporting. */
  enableHeartbeat?: boolean;
  /** Heartbeat interval in ms (default: 10000). */
  heartbeatIntervalMs?: number;
  /** Enable inter-agent message polling. */
  enableMessaging?: boolean;
  /** Poll interval in ms (default: 5000). */
  messagePollIntervalMs?: number;
}

export interface RunOptions {
  pi: ExtensionAPI;
  agentId?: string;
  model?: Model<Api>;
  maxTurns?: number;
  signal?: AbortSignal;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  cwd?: string;
  onToolActivity?: (activity: ToolActivity) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  onTurnEnd?: (turnCount: number) => void;
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  onCompaction?: (info: CompactionSnapshot) => void;
  skipValidators?: boolean;
  onValidationComplete?: (results: ValidationResult[]) => void;
  currentLevel?: number;
  levelLimit?: number;
  parentConfig?: EffectiveConfig;
  partitions?: readonly string[];
  /**
   * Short correlation id (8 hex chars) shared by every span the agent
   * emits. If absent, `startAgentSpan` simply omits the `correlation.id`
   * attribute. The manager sets this on every spawn so the id is stable
   * across `resumeAgent` calls and is queryable from the agent record.
   */
  correlationId?: string;
  hooks?: HookRegistry;
  spawnedAt?: number;
  onContextBuilt?: (timestamp: number) => void;
  /** Resource quotas for this run. */
  quotas?: ResourceQuotas;
  /** Swarm collaboration options. */
  swarm?: SwarmOptions;
  /** Called when a swarm message is received. */
  onSwarmMessage?: (from: string, payload: unknown) => void;
  /**
   * Override the module-level `maxEndHookRevisions` setting for this run.
   * `0` = fail closed on `subagent:end` block with no revision turn.
   */
  maxEndHookRevisions?: number;
}

export interface RunResult {
  responseText: string;
  session: AgentSession;
  aborted: boolean;
  /** True when the run was aborted because it exceeded its duration quota. */
  timedOut?: boolean;
  steered: boolean;
  validationResults?: ValidationResult[];
  validated?: boolean;
  handoff?: AgentHandoff;
  /** Execution metrics. */
  metrics: RunMetrics;
  /**
   * Set when the run ended because the model/provider errored on its final
   * turn (no thrown exception). Callers that key off status should treat a
   * non-empty `error` as a failure even though `session.prompt` resolved.
   */
  error?: string;
}

export interface RunMetrics {
  durationMs: number;
  turns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  tokensCacheWrite: number;
  contextBuiltAt?: number;
  latencyToFirstTokenMs?: number;
}

// ============================================================================
// Response Collection
// ============================================================================

function collectResponseText(session: AgentSession) {
  let text = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start") {
      text = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text += event.assistantMessageEvent.delta;
    }
  });
  return { getText: () => text, unsubscribe };
}

function getLastAssistantText(session: AgentSession): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const text = extractText(msg.content).trim();
    if (text) return text;
  }
  return "";
}

/**
 * Return the most recent assistant turn's model/provider error, if any.
 *
 * The host surfaces a model or provider failure (401 auth, unavailable model,
 * rate limit, etc.) as an AssistantMessage with `stopReason: "error"` and an
 * `errorMessage`. The run loop does not throw for these — the session simply
 * ends — so without this check the error is silently dropped and the agent
 * appears to complete with empty output.
 */
function getLastAssistantError(session: AgentSession): string | undefined {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    // Only the most recent assistant turn reflects the run's final outcome.
    // An earlier errored turn is stale once a later assistant turn exists
    // (e.g. a retry/revision that produced an empty-but-non-error turn), so we
    // do not scan past the latest assistant message.
    return msg.stopReason === "error" && msg.errorMessage ? msg.errorMessage : undefined;
  }
  return undefined;
}

function forwardAbortSignal(
  session: AgentSession,
  signal?: AbortSignal,
  onExternalAbort?: () => void,
): () => void {
  if (!signal) return () => {};
  const onAbort = () => {
    // Mark the run aborted *before* session.abort() so that when prompt()
    // rejects with AbortError, the catch path treats it as a graceful stop
    // (CHE-19) rather than a subagent:error / OTel error span.
    onExternalAbort?.();
    session.abort();
  };
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

// ============================================================================
// Deferred Context
// ============================================================================

export function buildEffectivePrompt(
  ctx: ExtensionContext,
  prompt: string,
  options: RunOptions,
): string {
  if (!options.inheritContext) return prompt;

  const parentContext = buildParentContext(ctx);
  const builtAt = Date.now();
  options.onContextBuilt?.(builtAt);

  const spawnedAgo = options.spawnedAt ? builtAt - options.spawnedAt : 0;
  logger.debug("Context built after spawn", { agentId: options.agentId ?? "unknown", spawnedAgo });

  if (!parentContext) return prompt;
  return parentContext + prompt;
}

// ============================================================================
// Main Agent Runner
// ============================================================================

export async function runAgent(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  const startTime = performance.now();
  const quotas = {
    maxTokens: options.quotas?.maxTokens ?? DEFAULT_MAX_TOKENS,
    maxDurationMs: options.quotas?.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
    maxToolCalls: options.quotas?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
  };

  // Check duration quota early. Returns true once the quota is exceeded so the
  // subscriber can abort the session gracefully. We intentionally do NOT throw
  // here: this runs inside a sync session event subscriber invoked by the host
  // emitter, and a throw escapes the run loop and surfaces as an uncaught
  // exception that kills the whole host process. Quota exhaustion is a normal
  // runtime outcome and must be handled like the token/tool-call quotas below
  // (abort + flag + return).
  let durationQuotaTripped = false;
  const checkDurationQuota = (): boolean => {
    if (durationQuotaTripped) return true;
    const elapsedMs = performance.now() - startTime;
    if (elapsedMs > quotas.maxDurationMs) {
      durationQuotaTripped = true;
      return true;
    }
    return false;
  };

  const config = getConfig(type, options.parentConfig, options.partitions);
  const agentConfig = getAgentConfig(type);

  // Early exit: check level limit
  const currentLevel = options.currentLevel ?? 0;
  const depthLimit = options.levelLimit ?? 5;
  if (currentLevel >= depthLimit) {
    throw new AgentRunnerError(
      `Max agent depth reached (${currentLevel}/${depthLimit})`,
      "depth_exceeded",
      { currentLevel, depthLimit },
    );
  }

  // Telemetry
  emitTelemetry("agent:spawned", {
    type,
    parentType: options.parentConfig ? type : undefined,
    depth: currentLevel,
    budget: options.maxTurns,
  });

  const effectiveCwd = options.cwd ?? ctx.cwd;
  // CHEF-100 Phase 1 dual-read: consume host workspaceContext when
  // available (zero shell-out), fall back to legacy detectEnv on pre-RFC
  // hosts. See src/env-context.ts and docs/chef-rfcs/CHEF-100-workspace-context.md.
  const env = buildEnvFromContext(options.pi) ?? await detectEnv(options.pi, effectiveCwd);
  const parentSystemPrompt = ctx.getSystemPrompt();

  // Resolve extensions/skills
  const extensions = options.isolated ? false : config.extensions;
  const skills = options.isolated ? false : config.skills;
  const extras: PromptExtras = {};

  if (Array.isArray(skills)) {
    const loaded = preloadSkills(skills, effectiveCwd);
    if (loaded.length > 0) extras.skillBlocks = loaded;
  }

  let toolNames = getToolNamesForType(type);

  // Persistent memory
  if (agentConfig?.memory) {
    const existingNames = new Set(toolNames);
    const denied = agentConfig.disallowedTools ? new Set(agentConfig.disallowedTools) : undefined;
    const effectivelyHas = (name: string) => existingNames.has(name) && !denied?.has(name);
    const hasWriteTools = effectivelyHas("write") || effectivelyHas("edit");

    if (hasWriteTools) {
      const extraNames = getMemoryToolNames(existingNames);
      if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames];
      extras.memoryBlock = buildMemoryBlock(agentConfig.name, agentConfig.memory, effectiveCwd, agentConfig.maxMemoryLines);
    } else {
      const extraNames = getReadOnlyMemoryToolNames(existingNames);
      if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames];
      extras.memoryBlock = buildReadOnlyMemoryBlock(agentConfig.name, agentConfig.memory, effectiveCwd, agentConfig.maxMemoryLines);
    }
  }

  // Parent permission inheritance
  const allowedTools = new Set(config.builtinToolNames);
  toolNames = toolNames.filter((t) => allowedTools.has(t));

  // Build system prompt
  const compressionLevel = agentConfig?.promptCompressionLevel ?? getPromptCompressionLevel();
  let systemPrompt: string;
  if (agentConfig) {
    systemPrompt = buildAgentPrompt(agentConfig, effectiveCwd, env, parentSystemPrompt, extras, compressionLevel);
  } else {
    const fallback = DEFAULT_AGENTS.get("general-purpose");
    if (!fallback) {
      throw new AgentRunnerError(
        `No fallback config available for unknown type "${type}"`,
        "unknown",
      );
    }
    systemPrompt = buildAgentPrompt({ ...fallback, name: type }, effectiveCwd, env, parentSystemPrompt, extras, compressionLevel);
  }

  // ChefGroep OS operational context is injected unconditionally when present.
  // This removes per-agent prompting and keeps every subagent on the same fleet,
  // datastore and mutation-logging contract. Ordinary installations fail open
  // when ChefGroep OS is not installed; malformed/oversized state is visible.
  const chefPreflight = loadChefGroepPreflight({ agentId: options.agentId });
  if (chefPreflight.status === "loaded" && chefPreflight.systemPromptAddition) {
    systemPrompt = `${systemPrompt}

${chefPreflight.systemPromptAddition}`;
    logger.debug("ChefGroep operational preflight injected", {
      agentId: options.agentId ?? "unknown",
      path: chefPreflight.path,
    });
  } else if (chefPreflight.status === "invalid" || chefPreflight.status === "oversize") {
    logger.warn("ChefGroep operational preflight rejected", {
      agentId: options.agentId ?? "unknown",
      path: chefPreflight.path,
      status: chefPreflight.status,
      error: chefPreflight.error,
    });
  } else {
    logger.debug("ChefGroep operational preflight unavailable", {
      agentId: options.agentId ?? "unknown",
      path: chefPreflight.path,
      status: chefPreflight.status,
    });
  }

  // Context-mode injection — only for agents that opt in via useContextMode,
  // and only when getConfig kept ctx_* tools in the effective allowlist.
  const ctxInjection = resolveCtxInjectionForAgent(agentConfig?.useContextMode);
  if (ctxInjection) {
    const allowed = new Set(config.builtinToolNames);
    // Exclude tools the agent denies via disallowedTools, matching the active-tool
    // filter below (Lines 614-634). Otherwise an opted-in agent that denies a ctx_*
    // tool would still get the context-mode prompt/log for a tool the session removes.
    const denied = agentConfig?.disallowedTools ? new Set(agentConfig.disallowedTools) : undefined;
    const injectable = ctxInjection.toolAllowList.filter(
      (t) => allowed.has(t) && !toolNames.includes(t) && !denied?.has(t),
    );
    if (injectable.length > 0) {
      systemPrompt = `${systemPrompt}\n\n${ctxInjection.systemPromptAddition}`;
      toolNames = [...toolNames, ...injectable];
      logger.debug("context-mode tools injected", { agentId: options.agentId ?? "unknown" });
    }
  }

  const noSkills = skills === false || Array.isArray(skills);
  const agentDir = getAgentDir();

  const loader = new DefaultResourceLoader({
    cwd: effectiveCwd,
    agentDir,
    noExtensions: extensions === false,
    noSkills,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  // Resolve model with circuit breaker. A `subagentModel` setting can override
  // the agent's configured model ("inherit" falls back to the session-default
  // model; "provider/modelId" pins a specific one). Lets read-only agents move
  // off a broken configured model without a code change.
  const configuredModel = resolveConfiguredModel(
    loadSettings(effectiveCwd).subagentModel,
    agentConfig?.model,
  );
  const model = options.model ?? resolveDefaultModel(
    ctx.model, ctx.modelRegistry, configuredModel,
  );

  if (!model) {
    throw new AgentRunnerError(
      "No model available for agent execution",
      "model_unavailable",
    );
  }

  const thinkingLevel = options.thinkingLevel ?? agentConfig?.thinking;

  const sessionOpts: Parameters<typeof createAgentSession>[0] = {
    cwd: effectiveCwd,
    agentDir,
    sessionManager: SessionManager.inMemory(effectiveCwd),
    settingsManager: SettingsManager.create(effectiveCwd, agentDir),
    // Pi 0.80.8 replaced CreateAgentSessionOptions.modelRegistry with the async
    // modelRuntime. Extensions only receive the synchronous ModelRegistry
    // facade (ctx.modelRegistry), not the underlying ModelRuntime, so we let
    // the SDK build its default runtime from the same agentDir (auth.json +
    // models.json). The subagent shares the host agentDir, so credentials and
    // the model catalog match, and `model` is passed explicitly above.
    model,
    tools: toolNames,
    // Keep orchestration tools out of the initial active set (Pi 0.81+).
    excludeTools: [...EXCLUDED_TOOL_NAMES],
    resourceLoader: loader,
  };
  if (thinkingLevel) {
    sessionOpts.thinkingLevel = thinkingLevel;
  }

  // Hook: subagent:start
  if (options.hooks) {
    const hookResult = await options.hooks.dispatch("subagent:start", options.agentId ?? "unknown", {
      type,
      model: `${model.provider}/${model.id}`,
      quotas,
    });
    const startDecision = normalizeHookResponse(hookResult);
    if (startDecision.action === "block") {
      throw new AgentRunnerError(startDecision.reason ?? "Blocked by hook", "aborted", {
        hook: "subagent:start",
        ...(startDecision.feedback !== undefined ? { feedback: startDecision.feedback } : {}),
      });
    }
  }

  const effectivePrompt = buildEffectivePrompt(ctx, prompt, options);

  // Circuit breaker protected session creation
  const { session } = await globalCircuitBreaker.call(() => createAgentSession(sessionOpts));

  const baseSessionName = agentConfig?.name ?? type;
  session.setSessionName(
    options.agentId ? `${baseSessionName}#${options.agentId.slice(0, 8)}` : baseSessionName,
  );

  // Swarm integration: register heartbeat
  let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
  let messagePollInterval: ReturnType<typeof setInterval> | undefined;
  const swarmCoord = getSwarmCoordinator();
  if (swarmCoord && options.agentId && options.swarm?.enableHeartbeat) {
    const interval = options.swarm.heartbeatIntervalMs ?? 10_000;
    heartbeatInterval = setInterval(() => {
      swarmCoord.heartbeat(options.agentId!);
    }, interval);
  }

  // Swarm messaging poll
  let lastMessagePoll = 0;
  if (swarmCoord && options.agentId && options.swarm?.enableMessaging) {
    const interval = options.swarm.messagePollIntervalMs ?? 5_000;
    messagePollInterval = setInterval(() => {
      const messages = swarmCoord.pollMessages(options.agentId!, lastMessagePoll);
      for (const msg of messages) {
        lastMessagePoll = Math.max(lastMessagePoll, msg.ts);
        options.onSwarmMessage?.(msg.from, msg.payload);
      }
    }, interval);
  }

  // Tool filtering
  const disallowedSet = agentConfig?.disallowedTools
    ? new Set(agentConfig.disallowedTools)
    : undefined;

  if (extensions !== false) {
    const builtinToolNameSet = new Set(toolNames);
    const activeTools = session.getActiveToolNames().filter((t) => {
      if (EXCLUDED_TOOL_NAMES.has(t)) return false;
      if (disallowedSet?.has(t)) return false;
      if (builtinToolNameSet.has(t)) return true;
      if (Array.isArray(extensions)) {
        return extensions.some((ext) => t.startsWith(ext) || t.includes(ext));
      }
      return true;
    });
    session.setActiveToolsByName(activeTools);
  } else if (disallowedSet) {
    const activeTools = session.getActiveToolNames().filter((t) => !disallowedSet.has(t));
    session.setActiveToolsByName(activeTools);
  }

  await session.bindExtensions({
    onError: (err) => {
      options.onToolActivity?.({
        type: "end",
        toolName: `extension-error:${err.extensionPath}`,
      });
    },
  });

  options.onSessionCreated?.(session);

  // OpenTelemetry span — created after all throwable setup completes.
  // If session creation or hook dispatch throws, no span leaks.
  const { span: agentSpan, ctx: agentCtx } = startAgentSpan(options.agentId ?? "unknown", type, {
    description: agentConfig?.description,
    depth: currentLevel,
    model: `${model.provider}/${model.id}`,
    correlationId: options.correlationId,
  });
  const activeToolSpans = new Map<string, import("@opentelemetry/api").Span>();
  let currentTurnSpan: import("@opentelemetry/api").Span | undefined;
  let toolSpanSeq = 0;

  // Turn tracking and quotas
  let turnCount = 0;
  let toolCallCount = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let tokensCacheWrite = 0;
  let latencyToFirstToken: number | undefined;
  const maxTurns = normalizeMaxTurns(options.maxTurns ?? agentConfig?.maxTurns ?? defaultMaxTurns);
  let softLimitReached = false;
  let aborted = false;
  let timedOut = false;

  let currentMessageText = "";
  const unsubTurns = session.subscribe((event: AgentSessionEvent) => {
    // Quota checks — guard re-entry: once timed out, stop re-aborting on
    // every subsequent event (session.abort() can emit synchronously).
    if (timedOut) return;
    if (checkDurationQuota()) {
      const elapsedMs = performance.now() - startTime;
      logger.warn(`Duration quota exceeded`, {
        agentId: options.agentId,
        elapsedMs,
        maxDurationMs: quotas.maxDurationMs,
      });
      timedOut = true;
      session.abort();
      aborted = true;
      return;
    }
    const totalTokens = tokensIn + tokensOut;
    if (totalTokens > quotas.maxTokens) {
      logger.warn(`Token quota exceeded`, { agentId: options.agentId, totalTokens, maxTokens: quotas.maxTokens });
      session.abort();
      aborted = true;
      return;
    }

    if (event.type === "turn_end") {
      // End previous turn span
      if (currentTurnSpan) { endTurnSpan(currentTurnSpan); currentTurnSpan = undefined; }

      options.hooks
        ?.dispatch("turn:end", options.agentId ?? "unknown")
        .catch((err) => {
          logger.debug(`Hook dispatch error: ${err instanceof Error ? err.message : String(err)}`);
        });
      turnCount++;
      options.onTurnEnd?.(turnCount);
      if (maxTurns != null) {
        if (!softLimitReached && turnCount >= maxTurns) {
          softLimitReached = true;
          session.steer("You have reached your turn budget. Wrap up NOW: write your final end report — findings, what is done, what is blocked, exact file paths/commit SHAs. Do not start new work.");
        } else if (softLimitReached && turnCount >= maxTurns + graceTurns) {
          aborted = true;
          session.abort();
        }
      }
    }

    if (event.type === "turn_start") {
      // End any prior turn span (safety)
      if (currentTurnSpan) { endTurnSpan(currentTurnSpan); currentTurnSpan = undefined; }
      // Start new turn span
      currentTurnSpan = startTurnSpan(options.agentId ?? "unknown", turnCount + 1, agentCtx);

      options.hooks
        ?.dispatch("turn:start", options.agentId ?? "unknown")
        .catch((err) => {
          logger.debug(`Hook dispatch error: ${err instanceof Error ? err.message : String(err)}`);
        });
    }

    if (event.type === "message_start") {
      currentMessageText = "";
      if (latencyToFirstToken === undefined) {
        latencyToFirstToken = performance.now() - startTime;
      }
    }

    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      currentMessageText += event.assistantMessageEvent.delta;
      options.onTextDelta?.(event.assistantMessageEvent.delta, currentMessageText);
    }

    if (event.type === "tool_execution_start") {
      toolCallCount++;
      // Start tool span
      const toolSpanKey = `${event.toolName}-${++toolSpanSeq}`;
      const toolSpan = startToolSpan(options.agentId ?? "unknown", event.toolName, agentCtx);
      activeToolSpans.set(toolSpanKey, toolSpan);

      if (toolCallCount > quotas.maxToolCalls) {
        logger.warn(`Tool call quota exceeded`, { agentId: options.agentId, toolCallCount, maxToolCalls: quotas.maxToolCalls });
        session.abort();
        aborted = true;
        return;
      }
      options.onToolActivity?.({ type: "start", toolName: event.toolName });
    }

    if (event.type === "tool_execution_end") {
      // End tool span — iterate in reverse for most-recent matching span
      for (const [key, ts] of [...activeToolSpans.entries()].reverse()) {
        if (key.startsWith(`${event.toolName}-`)) {
          endToolSpan(ts);
          activeToolSpans.delete(key);
          break;
        }
      }

      options.onToolActivity?.({ type: "end", toolName: event.toolName });
    }

    if (event.type === "message_end" && event.message.role === "assistant") {
      const msg = event.message as { usage?: { input?: number; output?: number; cacheWrite?: number } };
      const u = msg.usage;
      if (u) {
        tokensIn += u.input ?? 0;
        tokensOut += u.output ?? 0;
        tokensCacheWrite += u.cacheWrite ?? 0;
        options.onAssistantUsage?.({
          input: u.input ?? 0,
          output: u.output ?? 0,
          cacheWrite: u.cacheWrite ?? 0,
        });
      }
    }

    if (event.type === "compaction_end") {
      const snapshot = buildCompactionSnapshot(event);
      options.onCompaction?.(snapshot);
      if (!event.aborted) {
        const compactionSpan = startCompactionSpan(
          options.agentId ?? "unknown",
          event.reason,
          snapshot.tokensBefore,
          agentCtx,
        );
        endCompactionSpan(compactionSpan);

        options.hooks
          ?.dispatch("compaction:end", options.agentId ?? "unknown", {
            reason: event.reason,
            tokensBefore: snapshot.tokensBefore,
            tokensAfter: snapshot.tokensAfter,
            reductionPercent: snapshot.reductionPercent,
            aborted: false,
            willRetry: snapshot.willRetry,
          })
          .catch((err) => {
            logger.debug(`Hook dispatch error: ${err instanceof Error ? err.message : String(err)}`);
          });
      } else {
        logger.debug(
          `Compaction aborted for ${options.agentId ?? "unknown"}: ${event.errorMessage ?? event.reason}` +
            (event.willRetry ? " (will retry)" : ""),
        );
      }
    }

    if (
      event.type === "summarization_retry_scheduled" ||
      event.type === "summarization_retry_attempt_start" ||
      event.type === "summarization_retry_finished"
    ) {
      const attempt = event.type === "summarization_retry_scheduled" ? event.attempt : undefined;
      const maxAttempts = event.type === "summarization_retry_scheduled" ? event.maxAttempts : undefined;
      const detail =
        event.type === "summarization_retry_scheduled"
          ? `: ${event.errorMessage}`
          : event.type === "summarization_retry_attempt_start"
            ? ` source=${event.source}`
            : "";
      logger.debug(
        `Summarization retry (${event.type}) for ${options.agentId ?? "unknown"}` +
          (attempt !== undefined ? ` attempt=${attempt}/${maxAttempts}` : "") +
          detail,
      );
      emitTelemetry("subagent:summarization_retry", {
        agentId: options.agentId ?? "unknown",
        phase: event.type,
        attempt,
        maxAttempts,
      });
    }

    if (event.type === "compaction_start") {
      options.hooks
        ?.dispatch("compaction:start", options.agentId ?? "unknown", {
          reason: event.reason,
        })
        .catch((err) => {
          logger.debug(`Hook dispatch error: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
  });

  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal, () => {
    aborted = true;
  });
  let gatedResponseText = "";

  try {
    await session.prompt(effectivePrompt);
    gatedResponseText = collector.getText().trim() || getLastAssistantText(session);

    if (options.hooks) {
      const revisionBudget = clampMaxEndHookRevisions(
        options.maxEndHookRevisions ?? maxEndHookRevisions,
      );
      let attempt = 1;
      const maxAttempts = revisionBudget + 1;

      while (true) {
        // Resolve end status from the *current* session state before publishing.
        // A model/provider failure (stopReason "error", empty content) must not
        // advertise status "completed" — that lied to hooks/telemetry even though
        // the manager later stored the run as failed.
        const endModelError = getLastAssistantError(session);
        const endStatus =
          aborted ? "aborted"
          : softLimitReached ? "steered"
          : (!gatedResponseText && endModelError) ? "error"
          : "completed";
        const endDecision = normalizeHookResponse(
          await options.hooks.dispatch("subagent:end", options.agentId ?? "unknown", {
            status: endStatus,
            ...(endStatus === "error" && endModelError ? { error: endModelError } : {}),
            tokensIn,
            tokensOut,
            turns: turnCount,
            responseText: gatedResponseText,
            attempt,
            maxAttempts,
          }),
        );

        if (endDecision.action !== "block") break;

        if (attempt > revisionBudget) {
          throw new AgentRunnerError(
            endDecision.reason ?? "Blocked by hook",
            "aborted",
            {
              hook: "subagent:end",
              attempt,
              maxAttempts,
              ...(endDecision.feedback !== undefined ? { feedback: endDecision.feedback } : {}),
            },
          );
        }

        const revisionPrompt =
          endDecision.feedback?.trim() ||
          "Your previous output was rejected by a quality gate. Revise and improve it.";
        await session.prompt(revisionPrompt);
        gatedResponseText = collector.getText().trim() || getLastAssistantText(session);
        attempt++;
      }
    }
  } catch (err) {
    // A duration-quota (or token/tool) abort — or an external AbortSignal —
    // makes the active session.prompt() reject with an AbortError. That is the
    // *expected* outcome of a graceful stop — swallow it so runAgent resolves
    // with { aborted, timedOut } instead of throwing and masking the stop as an
    // error (CHE-19 for external signals; quota path already set aborted=true).
    if ((timedOut || aborted || options.signal?.aborted) && isAbortError(err)) {
      aborted = true;
      // fall through to the graceful return path below
    } else {
    // End agent span with error status
    const errDuration = performance.now() - startTime;
    endAgentSpan(agentSpan, {
      status: "error",
      durationMs: errDuration,
      turns: turnCount,
      toolCalls: toolCallCount,
      tokensIn,
      tokensOut,
      tokensCacheWrite,
      error: err instanceof Error ? err.message : String(err),
    });

    options.hooks
      ?.dispatch("subagent:error", options.agentId ?? "unknown", {
        error: err instanceof Error ? err.message : String(err),
      })
      .catch((err2) => {
        logger.debug(`Hook dispatch error: ${err2 instanceof Error ? err2.message : String(err2)}`);
      });
    throw err;
    }
  } finally {
    unsubTurns();
    collector.unsubscribe();
    cleanupAbort();
    // Clean up any dangling turn/tool spans
    if (currentTurnSpan) { endTurnSpan(currentTurnSpan); currentTurnSpan = undefined; }
    for (const ts of activeToolSpans.values()) { endToolSpan(ts); }
    activeToolSpans.clear();
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (messagePollInterval) clearInterval(messagePollInterval);
  }

  let responseText = gatedResponseText || collector.getText().trim() || getLastAssistantText(session);
  let runError: string | undefined;
  const modelError = getLastAssistantError(session);
  if (!responseText && modelError) {
    // The run produced no text because the model/provider errored on its final
    // turn (e.g. 401 auth, unavailable model). Surface it instead of returning
    // an empty "completed" result that hides the failure from the caller, and
    // record it on the result so the manager finalizes the agent as failed.
    logger.warn("Subagent stopped with a model/provider error", {
      agentId: options.agentId ?? "unknown",
      error: modelError,
    });
    responseText = `Agent stopped with a model/provider error: ${modelError}`;
    runError = modelError;
    options.hooks
      ?.dispatch("subagent:error", options.agentId ?? "unknown", { error: modelError })
      .catch((hookErr) => {
        logger.debug(`Hook dispatch error: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`);
      });
  }
  const duration = performance.now() - startTime;

  // Structured handoff parsing
  let handoff: AgentHandoff | undefined;
  if (agentConfig?.handoff) {
    const parsed = parseHandoff(responseText);
    if (parsed) {
      handoff = parsed;
      responseText = renderHandoffForParent(parsed);
    }
  }

  // Adversarial validation (extracted to agent-runner-validator.ts)
  let validationResults: ValidationResult[] | undefined;
  let validated: boolean | undefined;

  if (!options.skipValidators && hasValidators(agentConfig)) {
    const result = await runAdversarialValidation(
      session,
      ctx,
      responseText,
      agentConfig,
      options.agentId ?? "unknown",
      {
        pi: options.pi,
        model: options.model,
        signal: options.signal,
        hooks: options.hooks,
        onToolActivity: options.onToolActivity,
        onAssistantUsage: options.onAssistantUsage,
        onCompaction: options.onCompaction,
        onValidationComplete: options.onValidationComplete,
        runAgent,
        resumeAgent,
      },
    );
    responseText = result.responseText;
    validationResults = result.validationResults;
    validated = result.validated;
  }

  // Telemetry
  emitTelemetry("agent:completed", {
    type,
    duration,
    validatorResults: validationResults?.map((r) => ({ passed: r.passed, summary: r.summary })),
  });

  // End OpenTelemetry agent span. `timedOut` implies `aborted`, but we record
  // the cause in the span so the trace still distinguishes a quota timeout.
  // A surfaced model/provider error must also land as "error" — never "completed".
  const finalStatus =
    runError ? "error"
    : aborted ? "aborted"
    : softLimitReached ? "steered"
    : "completed";
  endAgentSpan(agentSpan, {
    status: finalStatus,
    ...(timedOut ? { error: `Duration quota exceeded (${quotas.maxDurationMs}ms)` }
    : runError ? { error: runError }
    : {}),
    durationMs: duration,
    turns: turnCount,
    toolCalls: toolCallCount,
    tokensIn,
    tokensOut,
    tokensCacheWrite,
    validated,
  });

  const metrics: RunMetrics = {
    durationMs: duration,
    turns: turnCount,
    toolCalls: toolCallCount,
    tokensIn,
    tokensOut,
    tokensCacheWrite,
    latencyToFirstTokenMs: latencyToFirstToken,
  };

  return { responseText, session, aborted, timedOut, steered: softLimitReached, validationResults, validated, handoff, metrics, error: runError };
}

// ============================================================================
// Resume Agent
// ============================================================================

export async function resumeAgent(
  session: AgentSession,
  prompt: string,
  options: {
    agentId?: string;
    hooks?: HookRegistry;
    onToolActivity?: (activity: ToolActivity) => void;
    onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
    onCompaction?: (info: CompactionSnapshot) => void;
    signal?: AbortSignal;
    inheritContext?: boolean;
    ctx?: ExtensionContext;
  } = {},
): Promise<string> {
  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);
  const agentId = options.agentId ?? "unknown";

  const unsubEvents = (options.onToolActivity || options.onAssistantUsage || options.onCompaction || options.hooks)
    ? session.subscribe((event: AgentSessionEvent) => {
        if (event.type === "tool_execution_start") options.onToolActivity?.({ type: "start", toolName: event.toolName });
        if (event.type === "tool_execution_end") options.onToolActivity?.({ type: "end", toolName: event.toolName });
        if (event.type === "message_end" && event.message.role === "assistant") {
          const msg = event.message as { usage?: { input?: number; output?: number; cacheWrite?: number } };
          const u = msg.usage;
          if (u) options.onAssistantUsage?.({ input: u.input ?? 0, output: u.output ?? 0, cacheWrite: u.cacheWrite ?? 0 });
        }
        if (event.type === "compaction_start") {
          options.hooks
            ?.dispatch("compaction:start", agentId, { reason: event.reason })
            .catch((err) => {
              logger.debug(`Hook dispatch error: ${err instanceof Error ? err.message : String(err)}`);
            });
        }
        if (event.type === "compaction_end") {
          const snapshot = buildCompactionSnapshot(event);
          options.onCompaction?.(snapshot);
          if (!event.aborted) {
            options.hooks
              ?.dispatch("compaction:end", agentId, {
                reason: event.reason,
                tokensBefore: snapshot.tokensBefore,
                tokensAfter: snapshot.tokensAfter,
                reductionPercent: snapshot.reductionPercent,
                aborted: false,
                willRetry: snapshot.willRetry,
              })
              .catch((err) => {
                logger.debug(`Hook dispatch error: ${err instanceof Error ? err.message : String(err)}`);
              });
          }
        }
        if (
          event.type === "summarization_retry_scheduled" ||
          event.type === "summarization_retry_attempt_start" ||
          event.type === "summarization_retry_finished"
        ) {
          const attempt = event.type === "summarization_retry_scheduled" ? event.attempt : undefined;
          const maxAttempts = event.type === "summarization_retry_scheduled" ? event.maxAttempts : undefined;
          logger.debug(`Summarization retry (${event.type}) for ${agentId}`);
          emitTelemetry("subagent:summarization_retry", {
            agentId,
            phase: event.type,
            attempt,
            maxAttempts,
          });
        }
      })
    : () => {};

  let effectivePrompt = prompt;
  if (options.inheritContext && options.ctx) {
    const parentContext = buildParentContext(options.ctx);
    if (parentContext) {
      effectivePrompt = parentContext + prompt;
    }
  }

  try {
    await session.prompt(effectivePrompt);
  } finally {
    collector.unsubscribe();
    unsubEvents();
    cleanupAbort();
  }

  return collector.getText().trim() || getLastAssistantText(session);
}

// ============================================================================
// Steering
// ============================================================================

export async function steerAgent(session: AgentSession, message: string): Promise<void> {
  await session.steer(message);
}

// ============================================================================
// Conversation Serialization
// ============================================================================

export function getAgentConversation(session: AgentSession): string {
  const parts: string[] = [];

  for (const msg of session.messages) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
      if (text.trim()) parts.push(`[User]: ${text.trim()}`);
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: string[] = [];
      for (const c of msg.content) {
        if (c.type === "text" && c.text) textParts.push(c.text);
        else if (c.type === "toolCall") toolCalls.push(`  Tool: ${c.name ?? "unknown"}`);
      }
      if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
      if (toolCalls.length > 0) parts.push(`[Tool Calls]:\n${toolCalls.join("\n")}`);
    } else if (msg.role === "toolResult") {
      const text = extractText(msg.content);
      const truncated = text.length > 200 ? `${text.slice(0, 200)}...` : text;
      parts.push(`[Tool Result (${msg.toolName})]: ${truncated}`);
    }
  }

  return parts.join("\n\n");
}

// ============================================================================
// Utility Exports
// ============================================================================

export { globalCircuitBreaker };
