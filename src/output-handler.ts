/**
 * output-handler.ts — Entry point for the /agents command.
 *
 * All UI logic lives in focused modules under src/ui/:
 *   agent-dashboard.ts     — rich TUI dashboard
 *   agent-file-helpers.ts  — findAgentFile, getModelLabel
 *   agent-viewer.ts        — viewAgentConversation launcher
 *   agent-list-views.ts    — showAllAgentsList, showRunningAgents
 *   agent-detail.ts        — showAgentDetail, showAgentPermissions
 *   agent-actions.ts       — ejectAgent, disableAgent, enableAgent
 *   agent-wizards.ts       — showCreateWizard, showGenerateWizard, showManualWizard
 *   settings-snapshot.ts   — buildSettingsSnapshot
 *   settings-menu.ts       — showSettings, notifyApplied
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "./agent-manager.js";
import {
  isShowAgentTopWidget,
  reloadCustomAgents,
  setShowAgentTopWidget,
} from "./agent-registry.js";
import { buildAgentTreeJson, buildAgentTreeMermaid, buildAgentTreeText } from "./agent-tree.js";
import { getAllTypes } from "./agent-types.js";
import { showTemplatesMenu } from "./commands/templates.js";
import type { SubagentScheduler } from "./schedule.js";
import type { SettingsGetters, SettingsSetters } from "./settings.js";
import { type SwarmCoordinator, uiCreateOrJoinSwarm } from "./swarm-join.js";
import type { AgentRecord } from "./types.js";
import { showAgentDashboard } from "./ui/agent-dashboard.js";
import { showAgentPermissions } from "./ui/agent-detail.js";
import { showAllAgentsList, showRunningAgents } from "./ui/agent-list-views.js";
import type { AgentActivity } from "./ui/agent-ui-types.js";
import { viewAgentConversation } from "./ui/agent-viewer.js";
import { showCreateWizard } from "./ui/agent-wizards.js";
import { showHealth } from "./ui/health-view.js";
import { showSchedulesMenu } from "./ui/schedule-menu.js";
import { notifyApplied, showSettings } from "./ui/settings-menu.js";

/** Dependencies injected into the agents menu so callers don't pass 11 positional args. */
export interface AgentsMenuDeps {
  pi: ExtensionAPI;
  manager: AgentManager;
  scheduler: SubagentScheduler;
  agentActivity: Map<string, AgentActivity>;
  /**
   * Optional swarm coordinator — present when the swarm peer is wired in
   * (default for `index.ts`). The health check uses it to surface swarm
   * counts + delivery totals; the rest of the menu ignores it. Absent
   * (e.g. in unit tests that build a minimal `AgentsMenuDeps`) the
   * health report marks the swarm section as "not configured".
   */
  swarmJoin?: SwarmCoordinator | null;
  /**
   * Read-side accessors for the settings that the /agents menu can change
   * (default max turns, grace turns, join mode, scheduling, tracing).
   * Bundled to stop the 14-positional-arg spiral on `showSettings` — when
   * a new menu-editable setting is added, update `SettingsGetters` and
   * `SettingsSetters` in `settings.ts` and the call site in
   * `commands/agents.ts`; no other signatures need to change.
   */
  settingsGetters: SettingsGetters;
  /** Write-side counterpart of `settingsGetters`. */
  settingsSetters: SettingsSetters;
  /** UI-layer refresh after Agent top widget toggle (keeps registry free of UI hooks). */
  onAgentTopWidgetToggle?: () => void;
}

/** Re-open the agents menu after a sub-flow completes. */
async function reopenMenu(ctx: ExtensionCommandContext, deps: AgentsMenuDeps): Promise<void> {
  await showAgentsMenu(ctx, deps);
}

/** Build the dashboard callbacks and launch the rich TUI. */
async function launchAgentDashboard(
  ctx: ExtensionCommandContext,
  deps: AgentsMenuDeps,
): Promise<void> {
  const { manager, agentActivity, scheduler } = deps;

  const viewConv = (rec: import("./types.js").AgentRecord) =>
    viewAgentConversation(ctx, rec, agentActivity);

  const onAbort = (id: string) => manager.abort(id);

  const onSteer = async (id: string) => {
    const record = manager.getRecord(id);
    if (!record) {
      ctx.ui.notify("Agent not found.", "warning");
      return;
    }
    if (record.status !== "running") {
      ctx.ui.notify(`Cannot steer — agent is ${record.status}.`, "warning");
      return;
    }

    const message = await ctx.ui.editor(
      "Steering message (injected into agent conversation)",
      "Continue working on X, but also do Y first. Be careful with Z.",
    );

    const trimmed = message?.trim();
    if (!trimmed) return;

    if (!record.session) {
      if (!record.pendingSteers) record.pendingSteers = [];
      record.pendingSteers.push(trimmed);
      ctx.ui.notify(`Steering message queued for ${id}. Will be delivered when session is ready.`, "info");
    } else {
      try {
        const { steerAgent } = await import("./agent-runner.js");
        await steerAgent(record.session, trimmed);
        ctx.ui.notify(`Steering message sent to ${id}.`, "info");
      } catch (e) {
        ctx.ui.notify(`Steer failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    }

    await showAgentDashboard(ctx, manager, agentActivity, scheduler, viewConv, onAbort, onSteer, onPerms, onSwarm);
  };

  const onPerms = (r: import("./types.js").AgentRecord) => showAgentPermissions(ctx, r);

  const onSwarm = async (action: string, ids: string[]) => {
    if (ids.length === 0) {
      ctx.ui.notify("Select agents first (Space) then press w for swarm actions.", "info");
      return;
    }

    if (action === "menu" || action === "create") {
      const swarmId = uiCreateOrJoinSwarm(ids, "Dashboard Swarm");
      if (swarmId) {
        ctx.ui.notify(`Swarm created: ${swarmId} — ${ids.length} agents joined.`, "info");
      }
    } else {
      ctx.ui.notify(`Swarm action: ${action} on ${ids.length} agents`, "info");
    }

    await showAgentDashboard(ctx, manager, agentActivity, scheduler, viewConv, onAbort, onSteer, onPerms, onSwarm);
  };

  await showAgentDashboard(ctx, manager, agentActivity, scheduler, viewConv, onAbort, onSteer, onPerms, onSwarm);
}

function buildExecutionTree(records: AgentRecord[], format: "text" | "mermaid" | "json"): string {
  if (format === "mermaid") return buildAgentTreeMermaid(records);
  if (format === "json") return buildAgentTreeJson(records);
  return buildAgentTreeText(records);
}

/**
 * Display the main agents menu with options for dashboard, agent types, scheduling, and settings.
 */
export async function showAgentsMenu(
  ctx: ExtensionCommandContext,
  deps: AgentsMenuDeps,
): Promise<void> {
  await reloadCustomAgents();
  const allNames = getAllTypes();
  const agents = deps.manager.listAgents();

  const options: string[] = [];

  if (agents.length > 0) {
    let running = 0;
    let done = 0;
    for (let i = 0; i < agents.length; i++) {
      const s = agents[i].status;
      if (s === "running" || s === "queued") running++;
      else if (s === "completed" || s === "steered") done++;
    }
    options.push(`Running agents (${agents.length}) — ${running} running, ${done} done`);
  }

  if (agents.length > 0) {
    options.push("Interactive dashboard (hotkeys • live tree • steering)");
    options.push("View execution tree");
  }

  if (allNames.length > 0) {
    options.push(`Agent types (${allNames.length})`);
  }

  if (deps.scheduler.isActive()) {
    const jobCount = deps.scheduler.list().length;
    options.push(`Scheduled jobs (${jobCount})`);
  }

  options.push("Create new agent");
  options.push("Agent templates (browse & install)");
  options.push("Health check (tracing, scheduler, swarm, agents, settings)");
  options.push("Settings");
  const topOn = isShowAgentTopWidget();
  options.push(
    topOn
      ? "Agent top widget: ON — live stats above session when agents run"
      : "Agent top widget: OFF — enable persistent live stats strip",
  );

  const noAgentsMsg = allNames.length === 0 && agents.length === 0
    ? "No agents found. Create specialized subagents that can be delegated to.\n\n" +
      "Each subagent has its own context window, custom system prompt, and specific tools.\n\n" +
      "Try creating: Code Reviewer, Security Auditor, Test Writer, or Documentation Writer.\n\n"
    : "";

  if (noAgentsMsg) {
    ctx.ui.notify(noAgentsMsg, "info");
  }

  const choice = await ctx.ui.select("Agents", options);
  if (!choice) return;

  if (choice.startsWith("Running agents (")) {
    await showRunningAgents(ctx, deps.manager, deps.agentActivity);
    await reopenMenu(ctx, deps);
  } else if (choice === "Interactive dashboard (hotkeys • live tree • steering)") {
    await launchAgentDashboard(ctx, deps);
    await reopenMenu(ctx, deps);
  } else if (choice === "View execution tree") {
    const treeFormat = await ctx.ui.select("Execution Tree Format", [
      "Formatted Text Tree",
      "Mermaid Diagram Graph",
      "Raw JSON Tree"
    ]);
    if (treeFormat) {
      let format: "text" | "mermaid" | "json" = "text";
      if (treeFormat.includes("Mermaid")) format = "mermaid";
      if (treeFormat.includes("JSON")) format = "json";
      
      const treeData = buildExecutionTree(agents, format);
      await ctx.ui.editor(`Execution Tree (${format})`, treeData);
    }
    await reopenMenu(ctx, deps);
  } else if (choice.startsWith("Agent types (")) {
    await showAllAgentsList(ctx, ctx.modelRegistry);
    await reopenMenu(ctx, deps);
  } else if (choice.startsWith("Scheduled jobs (")) {
    await showSchedulesMenu(ctx, deps.scheduler);
    await reopenMenu(ctx, deps);
  } else if (choice === "Create new agent") {
    await showCreateWizard(ctx, deps.pi, deps.manager);
  } else if (choice === "Agent templates (browse & install)") {
    await showTemplatesMenu(ctx);
    await reopenMenu(ctx, deps);
  } else if (choice.startsWith("Health check")) {
    await showHealth(ctx, {
      manager: deps.manager,
      scheduler: deps.scheduler,
      swarmJoin: deps.swarmJoin ?? null,
      getters: deps.settingsGetters,
    });
    await reopenMenu(ctx, deps);
  } else if (choice === "Settings") {
    await showSettings(
      ctx, deps.manager, deps.pi, deps.scheduler,
      deps.settingsGetters, deps.settingsSetters,
    );
    await reopenMenu(ctx, deps);
  } else if (choice.startsWith("Agent top widget:")) {
    const next = !isShowAgentTopWidget();
    setShowAgentTopWidget(next);
    deps.onAgentTopWidgetToggle?.();
    notifyApplied(
      ctx,
      deps.pi,
      deps.manager,
      deps.settingsGetters,
      next
        ? "Agent top widget enabled — appears above the session when agents run"
        : "Agent top widget disabled",
    );
    await reopenMenu(ctx, deps);
  }
}
