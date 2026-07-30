import type { AgentManager } from "../agent-manager.js";
import {
  getAnimationStyle,
  getDashboardRefreshInterval,
  getOrchestrationMode,
  getPromptCompressionLevel,
  getUiStyle,
  isShowAgentTopWidget,
} from "../agent-registry.js";
import type { SettingsGetters, SubagentsSettings } from "../settings.js";

/**
 * Build a settings snapshot for persistence.
 */
export function buildSettingsSnapshot(manager: AgentManager, getters: SettingsGetters): SubagentsSettings {
  return {
    maxConcurrent: manager.getMaxConcurrent(),
    ...manager.getSessionLimits(),
    // 0 = unlimited — per SubagentsSettings.defaultMaxTurns docstring and
    // normalizeMaxTurns() in agent-runner.ts (which maps 0 → undefined).
    defaultMaxTurns: getters.getDefaultMaxTurns() ?? 0,
    graceTurns: getters.getGraceTurns(),
    maxEndHookRevisions: getters.getMaxEndHookRevisions(),
    defaultJoinMode: getters.getDefaultJoinMode(),
    schedulingEnabled: getters.isSchedulingEnabled(),
    tracingEnabled: getters.isTracingEnabled(),
    animationStyle: getAnimationStyle(),
    uiStyle: getUiStyle(),
    orchestrationMode: getOrchestrationMode(),
    dashboardRefreshInterval: getDashboardRefreshInterval(),
    sessionMaxSpawns: manager.getSessionMaxSpawns(),
    sessionMaxTurns: manager.getSessionMaxTurns(),
    promptCompressionLevel: getPromptCompressionLevel(),
    showAgentTopWidget: isShowAgentTopWidget(),
  };
}
