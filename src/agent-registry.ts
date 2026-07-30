/**
 * agent-registry.ts — Agent type definitions, configuration, and registry helpers.
 *
 * Provides functions for:
 * - Reloading custom agents from .pi/agents/*.md files
 * - Building type lists for tool descriptions
 * - Join mode and scheduling configuration
 */

import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getAgentConfig, getDefaultAgentNames, getUserAgentNames, registerAgents } from "./agent-types.js";
import { loadCustomAgents } from "./custom-agents.js";
import type { JoinMode, PromptCompressionLevel } from "./types.js";
import type { DashboardKeybindings, DashboardKeybindingsOverride } from "./ui/dashboard-keybindings.js";
import {
  DEFAULT_DASHBOARD_KEYBINDINGS,
  resolveDashboardKeybindings,
} from "./ui/dashboard-keybindings.js";
import type { FooterStatusConfig } from "./ui/footer-status-config.js";
import {
  DEFAULT_FOOTER_STATUS_CONFIG,
  resolveFooterStatusConfig,
} from "./ui/footer-status-config.js";

// ---- Join mode configuration ----

let defaultJoinMode: JoinMode = "smart";

/** Get the default join mode for background agents. */
export function getDefaultJoinMode(): JoinMode {
  return defaultJoinMode;
}

/** Set the default join mode for background agents. */
export function setDefaultJoinMode(mode: JoinMode): void {
  defaultJoinMode = mode;
}

// ---- Orchestration mode configuration ----

export type OrchestrationMode = "auto" | "single" | "swarm" | "crew";

// One Agent tool call should create one agent unless the user explicitly
// opts into automatic or multi-agent dispatch in project settings.
let defaultOrchestrationMode: OrchestrationMode = "single";

/** Get the default orchestration mode for agent execution. */
export function getOrchestrationMode(): OrchestrationMode {
  return defaultOrchestrationMode;
}

/** Set the default orchestration mode for agent execution. */
export function setOrchestrationMode(mode: OrchestrationMode): void {
  defaultOrchestrationMode = mode;
}

// ---- Dashboard refresh interval configuration ----

let dashboardRefreshInterval = 750;

/** Get the dashboard refresh interval in milliseconds. */
export function getDashboardRefreshInterval(): number {
  return dashboardRefreshInterval;
}

/** Set the dashboard refresh interval in milliseconds. */
export function setDashboardRefreshInterval(interval: number): void {
  dashboardRefreshInterval = interval;
}

// ---- Scheduling switch ----

/**
 * Master switch for the schedule subagent feature. Defaults to enabled.
 * Read once at extension init (before tool registration) so the Agent tool's
 * param schema reflects the persisted setting. Runtime toggles via /agents
 * → Settings short-circuit the menu entry + the execute-time addJob path
 * immediately, but the schema-level removal only takes effect on next
 * extension load (next pi session).
 */
let schedulingEnabled = true;

/** Check if scheduling is enabled. */
export function isSchedulingEnabled(): boolean {
  return schedulingEnabled;
}

/** Enable or disable scheduling. */
export function setSchedulingEnabled(enabled: boolean): void {
  schedulingEnabled = enabled;
}

// ---- Tracing switch ----

/**
 * Master switch for OpenTelemetry span emission in agent-runner. Defaults to
 * enabled. When false, every public telemetry helper short-circuits to a shared
 * no-op span. Runtime toggles affect subsequent spans immediately.
 */
let tracingEnabled = true;

/** Check if OpenTelemetry tracing is enabled. */
export function isTracingEnabled(): boolean {
  return tracingEnabled;
}

/** Enable or disable OpenTelemetry tracing. */
export function setTracingEnabled(enabled: boolean): void {
  tracingEnabled = enabled;
}

// ---- Animation & UI/UX style configuration ----

/**
 * Motion profiles are backwards compatible with the original single-spinner
 * choices. Pack profiles select deterministic per-agent motion; `reduced`
 * freezes semantic glyphs while preserving state communication; `none` removes
 * motion glyphs entirely.
 */
export type AnimationStyle =
  | "orchestrator"
  | "signals"
  | "minimal"
  | "reduced"
  | "braille"
  | "dots"
  | "lines"
  | "classic"
  | "none";

export type UiStyle = "premium" | "retro" | "plain";

let activeUiStyle: UiStyle = "premium";
let animationStyle: AnimationStyle = "orchestrator";

// ---- Display settings ----

let showActivityStream = true;
let showTokenUsage = true;
let showTurnProgress = true;
/** Persistent AGENT TOP strip above the editor (not a fullscreen overlay). */
let showAgentTopWidget = true;

export function getAnimationStyle(): AnimationStyle {
  return animationStyle;
}

export function setAnimationStyle(style: AnimationStyle): void {
  animationStyle = style;
}

export function getUiStyle(): UiStyle {
  return activeUiStyle;
}

export function setUiStyle(style: UiStyle): void {
  activeUiStyle = style;
}

export function isShowActivityStream(): boolean {
  return showActivityStream;
}

export function setShowActivityStream(enabled: boolean): void {
  showActivityStream = enabled;
}

export function isShowTokenUsage(): boolean {
  return showTokenUsage;
}

export function setShowTokenUsage(enabled: boolean): void {
  showTokenUsage = enabled;
}

export function isShowTurnProgress(): boolean {
  return showTurnProgress;
}

export function setShowTurnProgress(enabled: boolean): void {
  showTurnProgress = enabled;
}

export function isShowAgentTopWidget(): boolean {
  return showAgentTopWidget;
}

export function setShowAgentTopWidget(enabled: boolean): void {
  showAgentTopWidget = enabled;
}

// ---- Prompt compression level ----

let promptCompressionLevel: PromptCompressionLevel = "balanced";

/** Get the current prompt compression level. */
export function getPromptCompressionLevel(): PromptCompressionLevel {
  return promptCompressionLevel;
}

/** Set the current prompt compression level. */
export function setPromptCompressionLevel(level: PromptCompressionLevel): void {
  promptCompressionLevel = level;
}

// ---- Debug-capture switch + path overrides ----

let debugCaptureEnabled = false;

export function isDebugCaptureEnabled(): boolean {
  return debugCaptureEnabled;
}

export function setDebugCapture(enabled: boolean): void {
  debugCaptureEnabled = enabled;
}

let debugCapturePathOverrides: { project?: string; personal?: string } = {};

export function setDebugCapturePaths(paths: { project?: string; personal?: string }): void {
  debugCapturePathOverrides = {
    ...(paths?.project !== undefined ? { project: paths.project } : {}),
    ...(paths?.personal !== undefined ? { personal: paths.personal } : {}),
  };
}

export function getDebugCapturePaths(): { project: string; personal: string } {
  return {
    project: debugCapturePathOverrides.project ?? join(process.cwd(), ".pi", "subagent-debug"),
    personal: debugCapturePathOverrides.personal ?? join(getAgentDir(), "subagent-debug"),
  };
}

// ---- Dashboard keybindings ----

let dashboardKeybindings: DashboardKeybindings = DEFAULT_DASHBOARD_KEYBINDINGS;

export function getDashboardKeybindings(): DashboardKeybindings {
  return dashboardKeybindings;
}

export function setDashboardKeybindings(override?: DashboardKeybindingsOverride): void {
  dashboardKeybindings = resolveDashboardKeybindings(override);
}

// ---- Footer status bar ----

let footerStatusConfig: FooterStatusConfig = DEFAULT_FOOTER_STATUS_CONFIG;

export function getFooterStatusConfig(): FooterStatusConfig {
  return footerStatusConfig;
}

export function setFooterStatusConfig(override?: Partial<FooterStatusConfig>): void {
  footerStatusConfig = resolveFooterStatusConfig(override);
}

// ---- Custom agent reloading ----

export async function reloadCustomAgents(): Promise<void> {
  const userAgents = await loadCustomAgents(process.cwd());
  registerAgents(userAgents);
}

// ---- Type list building ----

export function getModelLabelFromConfig(model: string): string {
  const name = model.includes("/") ? (model.split("/").pop() ?? model) : model;
  return name.replace(/-\d{8}$/, "");
}

export function buildTypeListText(): string {
  const defaultNames = getDefaultAgentNames();
  const userNames = getUserAgentNames();

  const defaultDescs = defaultNames.map((name) => {
    const config = getAgentConfig(name);
    const modelSuffix = config?.model ? ` (${getModelLabelFromConfig(config.model)})` : "";
    return `- ${name}: ${config?.description ?? name}${modelSuffix}`;
  });

  const customDescs = userNames.map((name) => {
    const config = getAgentConfig(name);
    return `- ${name}: ${config?.description ?? name}`;
  });

  return [
    "Default agents:",
    ...defaultDescs,
    ...(customDescs.length > 0 ? ["", "Custom agents:", ...customDescs] : []),
    "",
    `Custom agents can be defined in .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global) — they are picked up automatically. Project-level agents override global ones. Creating a .md file with the same name as a default agent overrides it.`,
  ].join("\n");
}
