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
  isFreeModelsOnly,
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

/**
 * Menu entry with a stable dispatch id. Labels may change freely; routing
 * always goes through `id`, so a label tweak can no longer break the menu.
 */
interface AgentsMenuEntry {
  id: string;
  label: (deps: AgentsMenuDeps, agents: AgentRecord[], allNames: string[]) => string | null;
  run: (ctx: ExtensionCommandContext, deps: AgentsMenuDeps) => Promise<void>;
}

const MENU_ENTRIES: ReadonlyArray<AgentsMenuEntry> = [
  {
    id: "running",
    label: (_deps, agents) => {
      if (agents.length === 0) return null;
      let running = 0;
      let done = 0;
      for (const a of agents) {
        if (a.status === "running" || a.status === "queued") running++;
        else if (a.status === "completed" || a.status === "steered") done++;
      }
      return `Running agents (${agents.length}) — ${running} running, ${done} done`;
    },
    run: async (ctx, deps) => {
      await showRunningAgents(ctx, deps.manager, deps.agentActivity);
    },
  },
  {
    id: "dashboard",
    label: (_deps, agents) => agents.length > 0 ? "Interactive dashboard (hotkeys • live tree • steering)" : null,
    run: async (ctx, deps) => {
      await launchAgentDashboard(ctx, deps);
    },
  },
  {
    id: "tree",
    label: (_deps, agents) => agents.length > 0 ? "View execution tree" : null,
    run: async (ctx, deps) => {
      const treeFormat = await ctx.ui.select("Execution Tree Format", [
        "Formatted Text Tree",
        "Mermaid Diagram Graph",
        "Raw JSON Tree",
      ]);
      if (!treeFormat) return;
      let format: "text" | "mermaid" | "json" = "text";
      if (treeFormat.includes("Mermaid")) format = "mermaid";
      if (treeFormat.includes("JSON")) format = "json";
      const treeData = buildExecutionTree(deps.manager.listAgents(), format);
      await ctx.ui.editor(`Execution Tree (${format})`, treeData);
    },
  },
  {
    id: "types",
    label: (_deps, _agents, allNames) => allNames.length > 0 ? `Agent types (${allNames.length})` : null,
    run: async (ctx) => {
      await showAllAgentsList(ctx, ctx.modelRegistry);
    },
  },
  {
    id: "schedules",
    label: (deps) => deps.scheduler.isActive() ? `Scheduled jobs (${deps.scheduler.list().length})` : null,
    run: async (ctx, deps) => {
      await showSchedulesMenu(ctx, deps.scheduler);
    },
  },
  {
    id: "create",
    label: () => "Create new agent",
    run: async (ctx, deps) => {
      // Create wizard manages its own re-entry; caller skips reopen for it.
      await showCreateWizard(ctx, deps.pi, deps.manager, deps.scheduler);
    },
  },
  {
    id: "templates",
    label: () => "Agent templates (browse & install)",
    run: async (ctx) => {
      await showTemplatesMenu(ctx);
    },
  },
  {
    id: "health",
    label: () => "Health check (tracing, scheduler, swarm, agents, settings)",
    run: async (ctx, deps) => {
      await showHealth(ctx, {
        manager: deps.manager,
        scheduler: deps.scheduler,
        swarmJoin: deps.swarmJoin ?? null,
        getters: deps.settingsGetters,
      });
    },
  },
  {
    id: "settings",
    label: () => isFreeModelsOnly() ? "Settings — free-only ON (session)" : "Settings",
    run: async (ctx, deps) => {
      await showSettings(
        ctx, deps.manager, deps.pi, deps.scheduler,
        deps.settingsGetters, deps.settingsSetters,
      );
    },
  },
  {
    id: "top-widget",
    label: () => isShowAgentTopWidget()
      ? "Agent top widget: ON — live stats above session when agents run"
      : "Agent top widget: OFF — enable persistent live stats strip",
    run: async (ctx, deps) => {
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
    },
  },
];

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

  const entries = MENU_ENTRIES
    .map((entry) => ({ entry, label: entry.label(deps, agents, allNames) }))
    .filter((e): e is { entry: AgentsMenuEntry; label: string } => e.label !== null);

  const noAgentsMsg = allNames.length === 0 && agents.length === 0
    ? "No agents found. Create specialized subagents that can be delegated to.\n\n" +
      "Each subagent has its own context window, custom system prompt, and specific tools.\n\n" +
      "Try creating: Code Reviewer, Security Auditor, Test Writer, or Documentation Writer.\n\n"
    : "";

  if (noAgentsMsg) {
    ctx.ui.notify(noAgentsMsg, "info");
  }

  const choice = await ctx.ui.select("Agents", entries.map((e) => e.label));
  if (!choice) return;

  const selected = entries.find((e) => e.label === choice);
  if (!selected) return;

  await selected.entry.run(ctx, deps);
  if (selected.entry.id !== "create") {
    await showAgentsMenu(ctx, deps);
  }
}
