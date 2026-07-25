import { logger } from "./logger.js";
/**
 * pi-agents — A pi extension providing Claude Code-style autonomous sub-agents.
 *
 * Tools:
 *   Agent             — LLM-callable: spawn a sub-agent
 *   get_subagent_result  — LLM-callable: check background agent status/result
 *   steer_subagent       — LLM-callable: send a steering message to a running agent
 *
 * Commands:
 *   /agents                 — Interactive agent management menu
 */


import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "./agent-manager.js";
import {
  getDebugCapturePaths,
  isDebugCaptureEnabled,
  isSchedulingEnabled,
  reloadCustomAgents,
  setAnimationStyle,
  setDashboardKeybindings,
  setDashboardRefreshInterval,
  setDebugCapture,
  setDebugCapturePaths,
  setDefaultJoinMode,
  setFooterStatusConfig,
  setOrchestrationMode,
  setPromptCompressionLevel,
  setSchedulingEnabled,
  setShowActivityStream,
  setShowTokenUsage,
  setShowTurnProgress,
  setTracingEnabled,
  setUiStyle,
} from "./agent-registry.js";
import { setDefaultMaxTurns, setGraceTurns, setMaxEndHookRevisions } from "./agent-runner.js";
import { BatchOrchestrator } from "./batch-orchestrator.js";
import { registerAgentsCommand } from "./commands/agents.js";
import { registerHooksCommand } from "./commands/hooks.js";
import { registerTemplatesCommand } from "./commands/templates.js";
import { registerRpcHandlers } from "./cross-extension-rpc.js";
import {
  appendAgentEvent,
  appendError,
  appendRpcAudit,
  appendScheduleEvent,
  disable as disableDebugCapture,
  enable as enableDebugCapture,
  isDebugCaptureEnabled as isDebugCaptureSinkOn,
} from "./debug-capture.js";
import { GroupJoinManager } from "./group-join.js";
import { HookRegistry } from "./hooks.js";
import { createPostHogBridge, postHogConfigToMigrate } from "./posthog-bridge.js";
import { clearSubagentsApi, registerSubagentsApi } from "./public-api.js";
import type { ScheduleChangeEvent } from "./schedule.js";
import { SubagentScheduler } from "./schedule.js";
import { resolveStorePath, ScheduleStore } from "./schedule-store.js";
import { applyAndEmitLoaded, loadSettings, saveSettings } from "./settings.js";
import { SwarmCoordinator, setActiveSwarmCoordinator } from "./swarm-join.js";
import { onTelemetry } from "./telemetry.js";
import {
  buildNotificationDetails, formatTaskNotification,
} from "./tool-result-helpers.js";
import { createAgentTool } from "./tools/agent.js";
import { createGetResultTool } from "./tools/get-result.js";
import { createSteerTool } from "./tools/steer.js";
import { type AgentRecord, type NotificationDetails } from "./types.js";
import type { AgentActivity, UICtx } from "./ui/agent-ui-types.js";
import { AgentWidget } from "./ui/agent-widget.js";
import { setSpinnerStyle } from "./ui/animation.js";
import { clearWidgetMetrics, setWidgetMetrics } from "./ui/global-registry.js";
import { createNotificationRenderer } from "./ui/notification-renderer.js";
import { getLifetimeTotal } from "./usage.js";

export default async function (pi: ExtensionAPI) {
  // ---- Register custom notification renderer ----
  pi.registerMessageRenderer<NotificationDetails>(
    "subagent-notification",
    (message, opts, theme) => createNotificationRenderer(theme)(message, opts),
  );

  // Initial load
  await reloadCustomAgents();

  // ---- Agent activity tracking + widget ----
  const agentActivity = new Map<string, AgentActivity>();

  // ---- Cancellable pending notifications ----
  // Holds notifications briefly so get_subagent_result can cancel them
  // before they reach pi.sendMessage (fire-and-forget).
  const pendingNudges = new Map<string, ReturnType<typeof setTimeout>>();
  const NUDGE_HOLD_MS = 200;

  function scheduleNudge(key: string, send: () => void, delay = NUDGE_HOLD_MS) {
    cancelNudge(key);
    pendingNudges.set(key, setTimeout(() => {
      pendingNudges.delete(key);
      try { send(); } catch (err) { logger.debug(`Swallowed error: ${err instanceof Error ? err.message : String(err)}`); }
    }, delay));
  }

  function cancelNudge(key: string) {
    const timer = pendingNudges.get(key);
    if (timer != null) {
      clearTimeout(timer);
      pendingNudges.delete(key);
    }
  }

  // ---- Individual nudge helper (async join mode) ----
  function emitIndividualNudge(record: AgentRecord) {
    if (record.resultConsumed) return;  // re-check at send time

    const notification = formatTaskNotification(record, 500);
    const footer = record.outputFile ? `\nFull transcript available at: ${record.outputFile}` : '';

    pi.sendMessage<NotificationDetails>({
      customType: "subagent-notification",
      content: notification + footer,
      display: true,
      details: buildNotificationDetails(record, 500, agentActivity.get(record.id)),
    }, { deliverAs: "followUp", triggerTurn: true });
  }

  function sendIndividualNudge(record: AgentRecord) {
    agentActivity.delete(record.id);
    widget.markFinished(record.id);
    scheduleNudge(record.id, () => emitIndividualNudge(record));
    widget.update();
  }

  // ---- Group join manager ----
  const groupJoin = new GroupJoinManager(
    (records, partial) => {
      for (const r of records) { agentActivity.delete(r.id); widget.markFinished(r.id); }

      const groupKey = `group:${records.map(r => r.id).join(",")}`;
      scheduleNudge(groupKey, () => {
        // Re-check at send time
        const unconsumed = records.filter(r => !r.resultConsumed);
        if (unconsumed.length === 0) { widget.update(); return; }

        const notifications = unconsumed.map(r => formatTaskNotification(r, 300)).join('\n\n');
        const label = partial
          ? `${unconsumed.length} agent(s) finished (partial — others still running)`
          : `${unconsumed.length} agent(s) finished`;

        const [first, ...rest] = unconsumed;
        const details = buildNotificationDetails(first, 300, agentActivity.get(first.id));
        if (rest.length > 0) {
          details.others = rest.map(r => buildNotificationDetails(r, 300, agentActivity.get(r.id)));
        }

        pi.sendMessage<NotificationDetails>({
          customType: "subagent-notification",
          content: `Background agent group completed: ${label}\n\n${notifications}\n\nUse get_subagent_result for full output.`,
          display: true,
          details,
        }, { deliverAs: "followUp", triggerTurn: true });
      });
      widget.update();
    },
    30_000,
  );

  // ---- Swarm coordinator (dynamic collaborative groups) ----
  // Supports runtime join (the "swarm mode" feature) and provides query APIs
  // for the rich AgentDashboard.
  const swarmJoin = new SwarmCoordinator(
    (records, partial, swarmId) => {
      for (const r of records) { agentActivity.delete(r.id); widget.markFinished(r.id); }

      const swarmKey = `swarm:${swarmId}`;
      scheduleNudge(swarmKey, () => {
        const unconsumed = records.filter(r => !r.resultConsumed);
        if (unconsumed.length === 0) { widget.update(); return; }

        const notifications = unconsumed.map(r => formatTaskNotification(r, 300)).join('\n\n');
        const label = partial
          ? `${unconsumed.length} swarm agent(s) finished (partial — swarm still active)`
          : `Swarm ${swarmId} wave completed`;

        const [first, ...rest] = unconsumed;
        const details = buildNotificationDetails(first, 300, agentActivity.get(first.id));
        if (rest.length > 0) {
          details.others = rest.map(r => buildNotificationDetails(r, 300, agentActivity.get(r.id)));
        }

        pi.sendMessage<NotificationDetails>({
          customType: "subagent-notification",
          content: `Swarm update: ${label}\n\n${notifications}\n\nUse get_subagent_result for full output.`,
          display: true,
          details,
        }, { deliverAs: "followUp", triggerTurn: true });
      });
      widget.update();
    },
    30_000,
  );

  // Make the real coordinator available to the dashboard / output-handler layer
  // so 'w' hotkey actions can actually create and join swarms at runtime.
  setActiveSwarmCoordinator(swarmJoin);

  /** Helper: build event data for lifecycle events from an AgentRecord. */
  function buildEventData(record: AgentRecord) {
    const durationMs = record.completedAt ? record.completedAt - (record.startedAt ?? 0) : Date.now() - (record.startedAt ?? 0);
    // All three fields are lifetime-accumulated (Σ over every assistant message_end),
    // so they survive compaction together — input + output ≤ total always.
    // tokens is omitted when nothing was ever produced (e.g. agent errored before
    // any message_end fired), preserving prior payload shape.
    const u = record.lifetimeUsage;
    const total = getLifetimeTotal(u);
    const tokens = total > 0
      ? { input: u.input, output: u.output, total }
      : undefined;
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

  // Background completion: route through group join or send individual nudge
  const hookRegistry = new HookRegistry();
  const manager = new AgentManager((record) => {
    // Emit lifecycle event based on terminal status
    const isError = record.status === "error" || record.status === "stopped" || record.status === "aborted";
    const eventData = buildEventData(record);
    if (isError) {
      pi.events.emit("subagents:failed", eventData);
    } else {
      pi.events.emit("subagents:completed", eventData);
    }

    // Persist final record for cross-extension history reconstruction
    pi.appendEntry("subagents:record", {
      id: record.id, type: record.type, description: record.description,
      status: record.status, result: record.result, error: record.error,
      startedAt: record.startedAt, completedAt: record.completedAt,
    });

    // Skip notification if result was already consumed via get_subagent_result
    if (record.resultConsumed) {
      agentActivity.delete(record.id);
      widget.markFinished(record.id);
      widget.update();
      return;
    }

    // If this agent is pending batch finalization (debounce window still open),
    // don't send an individual nudge — batch orchestrator will pick it up retroactively.
    if (batchOrchestrator.isPendingBatchFinalization(record.id)) {
      widget.update();
      return;
    }

    const groupResult = groupJoin.onAgentComplete(record);
    const swarmResult = swarmJoin.onAgentComplete(record);

    if (groupResult === 'pass' && swarmResult === 'pass') {
      sendIndividualNudge(record);
    }
    // 'held' or 'delivered' for either → notification handled by the respective coordinator
    widget.update();
  }, undefined, (record) => {
    // Emit started event when agent transitions to running (including from queue)
    pi.events.emit("subagents:started", {
      id: record.id,
      type: record.type,
      description: record.description,
    });
  }, (record, info) => {
    // Emit compacted event when agent's session compacts (preserves count on record).
    pi.events.emit("subagents:compacted", {
      id: record.id,
      type: record.type,
      description: record.description,
      reason: info.reason,
      tokensBefore: info.tokensBefore,
      compactionCount: record.compactionCount,
    });
  });

  // Wire up agentActivity cleanup: when records are removed from the
  // manager (cleanup cycle, clearCompleted), purge corresponding activity entries.
  manager.onRecordRemoved = (id: string) => {
    agentActivity.delete(id);
  };

  // Attach the global hook registry to the agent manager
  manager.hooks = hookRegistry;

  // ---- Debug-capture wiring ----
  // Always-on hook/telemetry/pi-event handlers that forward payloads to the
  // optional local capture sink. Each handler is a no-op when the sink is
  // disabled so there's no observable runtime cost in the default path.
  // The sink itself is a pure module (`debug-capture.ts`) — wiring stays
  // here so the sink stays dependency-free and trivially testable.
  const HOOK_EVENTS_TO_CAPTURE = [
    "subagent:start",
    "subagent:end",
    "subagent:error",
    "subagent:spawn",
    "subagent:steer",
    "tool:call",
    "tool:result",
    "compaction:start",
    "compaction:end",
    "turn:start",
    "turn:end",
    "swarm:join",
    "swarm:leave",
    "validation:start",
    "validation:end",
  ] as const;
  // Always-on hook handlers at background priority. They never block or
  // modify (would freeze agent syscalls) and gate on `isDebugCaptureSinkOn()`
  // so the no-op cost is one bool read per event. The handler list is
  // process-scoped — registered once at extension load, never unregistered.
  for (const event of HOOK_EVENTS_TO_CAPTURE) {
    hookRegistry.register(
      event,
      (payload) => {
        if (!isDebugCaptureSinkOn()) return "allow";
        appendAgentEvent(payload.agentId, payload.event, payload.data);
        if (payload.event === "subagent:error" && payload.data) {
          const data = payload.data as { error?: unknown };
          if (data.error !== undefined) {
            appendError(payload.agentId, data.error, { hookEvent: payload.event });
          }
        }
        return "allow";
      },
      { priority: "background", id: `debug-capture-${event}` },
    );
  }

  // Telemetry-driven captures: agent completion metrics + RPC audit mirror.
  const debugTelemetryUnsubs: Array<() => void> = [];
  debugTelemetryUnsubs.push(
    onTelemetry("agent:completed", (payload) => {
      if (!isDebugCaptureSinkOn()) return;
      // Use a synthetic agent-id so different runs don't collide under one
      // `metrics.json` snapshot — the `type` field already disambiguates.
      const syntheticId = `${payload.type}@${new Date().toISOString().slice(0, 19)}`;
      appendAgentEvent(syntheticId, "agent:completed", payload);
    }),
  );
  debugTelemetryUnsubs.push(
    onTelemetry("rpc:audit", (payload) => {
      if (!isDebugCaptureSinkOn()) return;
      appendRpcAudit(payload as Record<string, unknown>);
    }),
  );

  // ---- PostHog product-analytics bridge (opt-in, inert without a key) ----
  // No project key is hardcoded: the bridge stays null unless the user persists
  // a `posthog.key` in `.pi/subagents.json`, so a default install ships zero
  // outbound analytics. When enabled, agent lifecycle events flow to the user's
  // own PostHog project.
  //
  // First-run migration: seed persisted posthog config from ambient env vars,
  // once. Thereafter the bridge resolves only the persisted PostHogConfig (no
  // runtime env reads), so telemetry egress always requires a stored opt-in.
  const postHogMigrationBase = loadSettings();
  const envPostHogConfig = postHogConfigToMigrate(postHogMigrationBase.posthog);
  if (envPostHogConfig) {
    saveSettings({ ...postHogMigrationBase, posthog: envPostHogConfig });
  }
  const posthogBridge = await createPostHogBridge(loadSettings().posthog ?? {});
  const posthogUnsubs: Array<() => void> = [];
  if (posthogBridge) {
    posthogUnsubs.push(
      onTelemetry("agent:spawned", (p) => posthogBridge.capture("agent_spawned", p)),
      onTelemetry("agent:completed", (p) => posthogBridge.capture("agent_completed", p)),
      onTelemetry("subagent:dispatch_decision", (p) =>
        posthogBridge.capture("subagent_dispatch", p),
      ),
      onTelemetry("agent:validation-failed", (p) =>
        posthogBridge.capture("agent_validation_failed", p),
      ),
      onTelemetry("agent:unknown-tools", (p) =>
        posthogBridge.capture("agent_unknown_tools", p),
      ),
    );
  }

  // Schedule firings + errors arrive on the cross-extension event bus.
  const scheduleUnsub = pi.events.on("subagents:scheduled", (payload) => {
    if (!isDebugCaptureSinkOn()) return;
    const evt = payload as ScheduleChangeEvent;
    // Discriminated-union narrowing via switch: TS verifies exhaustiveness.
    let jobId: string;
    let jobName: string;
    switch (evt.type) {
      case "added":
      case "updated":
        jobId = evt.job.id;
        jobName = evt.job.name;
        break;
      case "fired":
        jobId = evt.jobId;
        jobName = evt.name;
        break;
      case "error":
      case "removed":
        jobId = evt.jobId;
        jobName = evt.jobId;
        break;
    }
    appendScheduleEvent(jobId, jobName, evt.type, evt);
  });

  // Session budget warning at 80% — emit a pi.events notification so the
  // user sees it as a non-blocking alert even if the dashboard isn't open.
  manager.setBudgetWarningHandler((type, usage, limits) => {
    const isCritical = type === "agents_at_90" || type === "turns_at_90";
    const threshold = type === "agents_at_80" || type === "agents_at_90"
      ? `agent budget ${isCritical ? "90" : "80"}% used (${usage.spawnedAgents}/${limits.maxAgents})`
      : `turn budget ${isCritical ? "90" : "80"}% used (${usage.totalTurns}/${limits.maxTurns})`;
    const prefix = isCritical ? "🚨" : "⚠️";
    const advice = isCritical
      ? "Session budget nearly exhausted — spawns will stop soon!"
      : "Consider /agents → Settings to increase limits.";
    pi.events.emit("subagents:budget_warning", {
      type,
      usage,
      limits,
      threshold,
      message: `${prefix} Session ${threshold}. ${advice}`,
    });
    pi.sendMessage({ customType: "subagent-notification", content: `${prefix} Session ${threshold}. ${advice}`, display: true });
  });

  // Publish the typed public API on `globalThis` so peer extensions and tests
  // can discover and consume it. See `src/public-api.ts` for the contract.
  // This supersedes the old read-only `pi-subagents:hooks` mirror: the new
  // publication hands out the real `HookRegistry` instance, a typed RPC
  // client, the typed event subscription helpers, and a read-only
  // `SubagentManagerHandle` (published under `pi-subagents:manager`).
  registerSubagentsApi(pi.events, hookRegistry, manager);

  // Expose widget render metrics via Symbol.for() global registry for dashboard access.
  // The dashboard reads this lazily via getWidgetMetrics() from global-registry.ts.

  // --- Cross-extension RPC via pi.events ---
  let currentCtx: ExtensionContext | undefined;

  // ---- Subagent scheduler ----
  // Session-scoped: store is constructed inside session_start once sessionId
  // is available. Mirrors pi-chonky-tasks's session-scoped task store —
  // schedules reset on /new, restore on /resume.
  const scheduler = new SubagentScheduler();

  async function startScheduler(ctx: ExtensionContext) {
    try {
      const sessionId = ctx.sessionManager?.getSessionId?.();
      if (!sessionId) return;  // sessionId not yet available — try again on next event
      const path = resolveStorePath(ctx.cwd, sessionId);
      const store = await ScheduleStore.create(path);
      await scheduler.start(pi, ctx, manager, store);
      pi.events.emit("subagents:scheduler_ready", { sessionId, jobCount: store.list().length });
    } catch (err) {
      // Scheduling is non-essential — log and move on so the rest of the
      // extension keeps working if e.g. .pi/ is unwritable.
      logger.warn("Failed to start scheduler:", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Capture ctx from session_start for RPC spawn handler + start the scheduler.
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    manager.clearCompleted();
    manager.resetSessionUsage();
    if (isSchedulingEnabled() && !scheduler.isActive()) await startScheduler(ctx);

    // Activate the debug-capture sink if the persisted setting is on. No-op
    // when off (the default) — every append* call short-circuits internally.
    if (isDebugCaptureEnabled()) {
      try {
        // `getDebugCapturePaths()` returns `{ project, personal }` (the resolved
        // defaults or user overrides); `enableDebugCapture` accepts the
        // `{ projectPath, personalPath }` shape. Map deterministically.
        const resolved = getDebugCapturePaths();
        enableDebugCapture(
          { projectPath: resolved.project, personalPath: resolved.personal },
          ctx.sessionManager?.getSessionId?.(),
        );
      } catch (err) {
        logger.debug(`debug-capture init failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });

  pi.on("session_before_switch", () => {
    manager.clearCompleted();
    manager.resetSessionUsage();
    scheduler.stop();
  });

    // Auth provider validates caller identity using authContext provided in the payload.
  // Using the payload ensures each calling extension has its own rate-limit bucket.
  const { unsubPing: unsubPingRpc, unsubSpawn: unsubSpawnRpc, unsubStop: unsubStopRpc, unsubSessionUsage: unsubSessionUsageRpc, unsubSwarmHealth: unsubSwarmHealthRpc } = registerRpcHandlers({
    events: pi.events,
    pi,
    getCtx: () => currentCtx,
    manager,
    sessionManager: manager,
    swarmCoordinator: swarmJoin,
    authProvider: (_requestId, payload) => {
      const extensionId = payload?.authContext?.extensionId;
      if (extensionId && typeof extensionId === "string") {
        return { extensionId, extensionName: payload?.authContext?.extensionName };
      }
      return undefined; // Will throw UNAUTHORIZED in cross-extension-rpc.ts if undefined
    },
  });

  // Broadcast readiness so extensions loaded after us can discover us
  pi.events.emit("subagents:ready", {});

  // On shutdown, abort all agents immediately and clean up.
  // If the session is going down, there's nothing left to consume agent results.
  pi.on("session_shutdown", async () => {
    unsubSpawnRpc();
    unsubStopRpc();
    unsubPingRpc();
    unsubSessionUsageRpc?.();
    unsubSwarmHealthRpc?.();
    currentCtx = undefined;
    clearSubagentsApi();
    clearWidgetMetrics();
    widget.dispose();
    scheduler.stop();
    manager.abortAll();
    for (const timer of pendingNudges.values()) clearTimeout(timer);
    pendingNudges.clear();
    await batchOrchestrator.dispose();
    manager.dispose();
    // Tear down debug-capture last so any final events from the dispose
    // chain above still land in the sink. Best-effort: enable() failures
    // already swallow errors, and disable() is idempotent.
    disableDebugCapture(true);
    for (const unsub of debugTelemetryUnsubs) unsub();
    for (const unsub of posthogUnsubs) unsub();
    // Await the SDK flush so the final queued lifecycle batch is delivered
    // before the host finishes unloading; shutdown failures stay best-effort.
    if (posthogBridge) await posthogBridge.shutdown();
    if (scheduleUnsub) scheduleUnsub();
  });

  // Live widget: show running agents above editor
  const widget = new AgentWidget(manager, agentActivity);

  function bindWidgetUiCtx(ctx: ExtensionContext | undefined) {
    const uiCtx = ctx && typeof ctx.ui === "object" ? (ctx.ui as UICtx) : undefined;
    if (!uiCtx) return;
    widget.setUICtx(uiCtx);
    widget.ensureTimer();
    widget.update();
  }

  setWidgetMetrics({
    getSnapshot: () => widget.getRenderMetrics(),
  });

  // Footer status bar + editor widget bind on session start (no tool call required after reload).
  pi.on("session_start", async (_event, ctx) => {
    bindWidgetUiCtx(ctx);
  });

  // ---- Batch orchestrator for smart/group/swarm join modes ----
  const batchOrchestrator = new BatchOrchestrator({
    manager,
    groupJoin,
    swarmJoin,
    onAgentHandled: sendIndividualNudge,
    onWidgetUpdate: () => widget.update(),
  });

  // Track tool calls per turn so we only age the widget once per turn boundary,
  // avoiding premature agent aging during validator retries within a turn.
  let currentTurnToolCount = 0;

  // Grab UI context from tool execution + clear lingering widget on new turn
  pi.on("tool_execution_start", async (_event, ctx) => {
    bindWidgetUiCtx(ctx);
    currentTurnToolCount++;
    if (currentTurnToolCount === 1) {
      widget.onTurnStart();
    }
  });

  // Reset tool counter at end of each turn
  pi.on("turn_end", () => {
    currentTurnToolCount = 0;
  });


  // Apply persisted settings on startup and emit `subagents:settings_loaded`.
  // Global + project merged; missing → defaults; corrupt file emits a warning
  // to stderr and falls back to defaults.
  applyAndEmitLoaded(
    {
      setMaxConcurrent: (n) => manager.setMaxConcurrent(n),
      setSessionLimits: (limits) => manager.setSessionLimits(limits),
      setDefaultMaxTurns,
      setGraceTurns,
      setMaxEndHookRevisions,
      setDefaultJoinMode,
      setSchedulingEnabled,
      setTracingEnabled,
      setAnimationStyle: (style) => {
        setAnimationStyle(style);
        setSpinnerStyle(style);
      },
      setUiStyle,
      setShowActivityStream,
      setShowTokenUsage,
      setShowTurnProgress,
      setOrchestrationMode,
      setDashboardRefreshInterval,
      setSessionMaxSpawns: (n) => manager.setSessionMaxSpawns(n),
      setSessionMaxTurns: (n) => manager.setSessionMaxTurns(n),
      setPromptCompressionLevel,
      setDebugCapture,
      setDebugCapturePaths,
      setDashboardKeybindings,
      setFooterStatusConfig,
    },
    (event, payload) => pi.events.emit(event, payload),
  );

  // ---- Tool context — shared dependency bag for extracted tool modules ----
  const toolCtx = {
    pi, manager, widget, agentActivity, batchOrchestrator, scheduler, swarmJoin, hookRegistry,
    sendIndividualNudge, cancelNudge, scheduleNudge,
  };

  // ---- Tools ----
  pi.registerTool(createAgentTool(toolCtx));
  pi.registerTool(createGetResultTool(toolCtx));
  pi.registerTool(createSteerTool(toolCtx));

  registerAgentsCommand(pi, manager, scheduler, agentActivity, swarmJoin);
  registerHooksCommand(pi, hookRegistry);
  registerTemplatesCommand(pi);
}
