import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager.js";
import { getDefaultJoinMode, isSchedulingEnabled, isTracingEnabled, setDefaultJoinMode, setSchedulingEnabled, setTracingEnabled } from "../agent-registry.js";
import { getDefaultMaxTurns, getGraceTurns, getMaxEndHookRevisions, setDefaultMaxTurns, setGraceTurns, setMaxEndHookRevisions } from "../agent-runner.js";
import { showAgentsMenu } from "../output-handler.js";
import type { SubagentScheduler } from "../schedule.js";
import type { SettingsGetters, SettingsSetters } from "../settings.js";
import type { SwarmCoordinator } from "../swarm-join.js";
import type { AgentActivity } from "../ui/agent-ui-types.js";

/**
 * Read-side accessors for the /agents menu. Snapshot of the current runtime
 * state — passed as a single object so the menu signature stays stable when
 * new menu-editable settings are added.
 */
const settingsGetters: SettingsGetters = {
  getDefaultMaxTurns,
  getGraceTurns,
  getMaxEndHookRevisions,
  getDefaultJoinMode,
  isSchedulingEnabled,
  isTracingEnabled,
};

/** Write-side counterpart of `settingsGetters`. */
const settingsSetters: SettingsSetters = {
  setDefaultMaxTurns,
  setGraceTurns,
  setMaxEndHookRevisions,
  setDefaultJoinMode,
  setSchedulingEnabled,
  setTracingEnabled,
};

export function registerAgentsCommand(
  pi: ExtensionAPI,
  manager: AgentManager,
  scheduler: SubagentScheduler,
  agentActivity: Map<string, AgentActivity>,
  swarmJoin?: SwarmCoordinator | null,
  /** Refresh AGENT TOP immediately after menu toggles (UI-layer, not registry). */
  onAgentTopWidgetToggle?: () => void,
) {
  pi.registerCommand("agents", {
    description: "Manage agents",
    handler: async (_args, ctx) => {
      await showAgentsMenu(ctx, {
        pi,
        manager,
        scheduler,
        agentActivity,
        swarmJoin: swarmJoin ?? null,
        settingsGetters,
        settingsSetters,
        onAgentTopWidgetToggle,
      });
    },
  });
}
