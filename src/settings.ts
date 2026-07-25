import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AnimationStyle, OrchestrationMode } from "./agent-registry.js";
import { logger } from "./logger.js";
import type { PostHogConfig } from "./posthog-bridge.js";
import type { JoinMode, PromptCompressionLevel } from "./types.js";
import type { DashboardKeybindingsOverride } from "./ui/dashboard-keybindings.js";
import { sanitizeDashboardKeybindings } from "./ui/dashboard-keybindings.js";
import type { FooterStatusConfig } from "./ui/footer-status-config.js";
import { sanitizeFooterStatusConfig } from "./ui/footer-status-config.js";

/** Optional override roots for local offline debug captures. */
export interface DebugCapturePathOverrides {
  project?: string;
  personal?: string;
}

export type { PromptCompressionLevel } from "./types.js";

export interface SubagentsSettings {
  maxConcurrent?: number;
  maxAgentsPerSession?: number;
  maxTotalTurnsPerSession?: number;
  /** 0 is the explicit unlimited marker. */
  defaultMaxTurns?: number;
  graceTurns?: number;
  /**
   * Max revision turns after a blocking `subagent:end` hook.
   * `0` (default) = fail closed on block with no revision attempt.
   */
  maxEndHookRevisions?: number;
  defaultJoinMode?: JoinMode;
  schedulingEnabled?: boolean;
  tracingEnabled?: boolean;
  /**
   * Optional PostHog product-analytics bridge. Inert unless `posthog.key`
   * (or `POSTHOG_KEY`) is set, so a default install ships zero outbound
   * analytics. When enabled, agent lifecycle events are captured to the
   * configured project.
   */
  posthog?: PostHogConfig;
  /** Persisted motion profile; legacy single-spinner values remain valid. */
  animationStyle?: AnimationStyle;
  uiStyle?: "premium" | "retro" | "plain";
  showActivityStream?: boolean;
  showTokenUsage?: boolean;
  showTurnProgress?: boolean;
  orchestrationMode?: OrchestrationMode;
  dashboardRefreshInterval?: number;
  sessionMaxSpawns?: number;
  sessionMaxTurns?: number;
  promptCompressionLevel?: PromptCompressionLevel;
  debugCapture?: boolean;
  debugCapturePaths?: DebugCapturePathOverrides;
  /** Per-action key lists for the interactive dashboard and top view. */
  dashboardKeybindings?: DashboardKeybindingsOverride;
  /** Pi footer status slot configuration (the `subagents` bar). */
  footerStatus?: Partial<FooterStatusConfig>;
}

export interface SettingsAppliers {
  setMaxConcurrent: (value: number) => void;
  setSessionLimits: (limits: { maxAgentsPerSession?: number; maxTotalTurnsPerSession?: number }) => void;
  setDefaultMaxTurns: (value: number) => void;
  setGraceTurns: (value: number) => void;
  setMaxEndHookRevisions: (value: number) => void;
  setDefaultJoinMode: (mode: JoinMode) => void;
  setSchedulingEnabled: (enabled: boolean) => void;
  setTracingEnabled: (enabled: boolean) => void;
  setAnimationStyle: (style: AnimationStyle) => void;
  setUiStyle: (style: "premium" | "retro" | "plain") => void;
  setShowActivityStream: (enabled: boolean) => void;
  setShowTokenUsage: (enabled: boolean) => void;
  setShowTurnProgress: (enabled: boolean) => void;
  setOrchestrationMode: (mode: OrchestrationMode) => void;
  setDashboardRefreshInterval: (interval: number) => void;
  setSessionMaxSpawns: (value: number) => void;
  setSessionMaxTurns: (value: number) => void;
  setPromptCompressionLevel: (level: PromptCompressionLevel) => void;
  setDebugCapture: (enabled: boolean) => void;
  setDebugCapturePaths: (paths: DebugCapturePathOverrides) => void;
  setDashboardKeybindings: (bindings?: DashboardKeybindingsOverride) => void;
  setFooterStatusConfig: (config?: Partial<FooterStatusConfig>) => void;
}

export interface SettingsGetters {
  getDefaultMaxTurns: () => number | undefined;
  getGraceTurns: () => number;
  getMaxEndHookRevisions: () => number;
  getDefaultJoinMode: () => JoinMode;
  isSchedulingEnabled: () => boolean;
  isTracingEnabled: () => boolean;
}

export interface SettingsSetters {
  setDefaultMaxTurns: (value: number | undefined) => void;
  setGraceTurns: (value: number) => void;
  setMaxEndHookRevisions: (value: number) => void;
  setDefaultJoinMode: (mode: JoinMode) => void;
  setSchedulingEnabled: (enabled: boolean) => void;
  setTracingEnabled: (enabled: boolean) => void;
}

export type SettingsEmit = (event: string, payload: unknown) => void;

const VALID_JOIN_MODES = ["async", "group", "smart", "swarm"] as const;
const VALID_ORCHESTRATION_MODES = ["auto", "single", "swarm", "crew"] as const;
export const VALID_ANIMATION_STYLES = [
  "orchestrator",
  "signals",
  "minimal",
  "reduced",
  "braille",
  "dots",
  "lines",
  "classic",
  "none",
] as const satisfies readonly AnimationStyle[];
const VALID_UI_STYLES = ["premium", "retro", "plain"] as const;
const VALID_COMPRESSION_LEVELS = ["minimal", "balanced", "aggressive"] as const;

const MAX_CONCURRENT_CEILING = 1024;
const MAX_AGENTS_PER_SESSION_CEILING = 10_000;
const MAX_TURNS_CEILING = 10_000;
const MAX_TOTAL_TURNS_PER_SESSION_CEILING = 100_000;
const GRACE_TURNS_CEILING = 1_000;
const MAX_END_HOOK_REVISIONS_CEILING = 10;
const SESSION_MAX_SPAWNS_CEILING = 10_000;
const SESSION_MAX_TURNS_CEILING = 100_000;

function validateInt(
  raw: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const value = raw[key];
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

function validateEnum<T extends string>(
  raw: Record<string, unknown>,
  key: string,
  valid: readonly T[],
): T | undefined {
  const value = raw[key];
  return typeof value === "string" && (valid as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** Drop fields that do not match the expected shape. */
function sanitize(raw: unknown): SubagentsSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const settings: SubagentsSettings = {};

  const integerFields = [
    ["maxConcurrent", 1, MAX_CONCURRENT_CEILING],
    ["maxAgentsPerSession", 1, MAX_AGENTS_PER_SESSION_CEILING],
    ["maxTotalTurnsPerSession", 1, MAX_TOTAL_TURNS_PER_SESSION_CEILING],
    ["graceTurns", 1, GRACE_TURNS_CEILING],
    ["dashboardRefreshInterval", 100, 60_000],
    ["sessionMaxSpawns", 1, SESSION_MAX_SPAWNS_CEILING],
    ["sessionMaxTurns", 1, SESSION_MAX_TURNS_CEILING],
  ] as const;

  for (const [key, min, max] of integerFields) {
    const value = validateInt(source, key, min, max, 0);
    if (value > 0) (settings as Record<string, unknown>)[key] = value;
  }

  const defaultMaxTurns = validateInt(source, "defaultMaxTurns", 0, MAX_TURNS_CEILING, -1);
  if (defaultMaxTurns >= 0) settings.defaultMaxTurns = defaultMaxTurns;

  // 0 is a valid explicit value (no revisions / fail-closed on block).
  const maxEndHookRevisions = validateInt(source, "maxEndHookRevisions", 0, MAX_END_HOOK_REVISIONS_CEILING, -1);
  if (maxEndHookRevisions >= 0) settings.maxEndHookRevisions = maxEndHookRevisions;

  const defaultJoinMode = validateEnum(source, "defaultJoinMode", VALID_JOIN_MODES);
  if (defaultJoinMode) settings.defaultJoinMode = defaultJoinMode;

  const animationStyle = validateEnum(source, "animationStyle", VALID_ANIMATION_STYLES);
  if (animationStyle) settings.animationStyle = animationStyle;

  const uiStyle = validateEnum(source, "uiStyle", VALID_UI_STYLES);
  if (uiStyle) settings.uiStyle = uiStyle;

  const orchestrationMode = validateEnum(source, "orchestrationMode", VALID_ORCHESTRATION_MODES);
  if (orchestrationMode) settings.orchestrationMode = orchestrationMode;

  const compression = validateEnum(source, "promptCompressionLevel", VALID_COMPRESSION_LEVELS);
  if (compression) settings.promptCompressionLevel = compression;

  const booleanFields = [
    "schedulingEnabled",
    "tracingEnabled",
    "showActivityStream",
    "showTokenUsage",
    "showTurnProgress",
    "debugCapture",
  ] as const;
  for (const key of booleanFields) {
    if (typeof source[key] === "boolean") settings[key] = source[key];
  }

  const rawPaths = source.debugCapturePaths;
  if (rawPaths && typeof rawPaths === "object" && !Array.isArray(rawPaths)) {
    const pathSource = rawPaths as Record<string, unknown>;
    const paths: DebugCapturePathOverrides = {};
    if (typeof pathSource.project === "string" && pathSource.project) paths.project = pathSource.project;
    if (typeof pathSource.personal === "string" && pathSource.personal) paths.personal = pathSource.personal;
    if (paths.project !== undefined || paths.personal !== undefined) settings.debugCapturePaths = paths;
  }

  const dashboardKeybindings = sanitizeDashboardKeybindings(source.dashboardKeybindings);
  if (dashboardKeybindings) settings.dashboardKeybindings = dashboardKeybindings;

  const footerStatus = sanitizeFooterStatusConfig(source.footerStatus);
  if (footerStatus) settings.footerStatus = footerStatus;

  // PostHog bridge config: preserve explicitly set string fields so a saved
  // `posthog.key` survives sanitization and reaches the bridge at activation.
  const rawPostHog = source.posthog;
  if (rawPostHog && typeof rawPostHog === "object" && !Array.isArray(rawPostHog)) {
    const phSource = rawPostHog as Record<string, unknown>;
    const posthog: PostHogConfig = {};
    if (typeof phSource.key === "string" && phSource.key) posthog.key = phSource.key;
    if (typeof phSource.host === "string" && phSource.host) posthog.host = phSource.host;
    if (typeof phSource.distinctId === "string" && phSource.distinctId) {
      posthog.distinctId = phSource.distinctId;
    }
    if (posthog.key !== undefined || posthog.host !== undefined || posthog.distinctId !== undefined) {
      settings.posthog = posthog;
    }
  }

  return settings;
}

function globalPath(): string {
  return join(getAgentDir(), "subagents.json");
}

function projectPath(cwd: string): string {
  return join(cwd, ".pi", "subagents.json");
}

function readSettingsFile(path: string): SubagentsSettings {
  if (!existsSync(path)) return {};
  try {
    return sanitize(JSON.parse(readFileSync(path, "utf-8")));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(`Ignoring malformed settings at ${path}: ${reason}`);
    return {};
  }
}

/** Load merged settings: global provides defaults, project overrides. */
export function loadSettings(cwd: string = process.cwd()): SubagentsSettings {
  return { ...readSettingsFile(globalPath()), ...readSettingsFile(projectPath(cwd)) };
}

/** Persist project-local settings. Global defaults are never mutated. */
export function saveSettings(settings: SubagentsSettings, cwd: string = process.cwd()): boolean {
  const path = projectPath(cwd);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(settings, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** Apply persisted settings to in-memory state. */
export function applySettings(settings: SubagentsSettings, appliers: SettingsAppliers): void {
  if (typeof settings.maxConcurrent === "number") appliers.setMaxConcurrent(settings.maxConcurrent);
  if (typeof settings.maxAgentsPerSession === "number" || typeof settings.maxTotalTurnsPerSession === "number") {
    appliers.setSessionLimits({
      maxAgentsPerSession: settings.maxAgentsPerSession,
      maxTotalTurnsPerSession: settings.maxTotalTurnsPerSession,
    });
  }
  if (typeof settings.defaultMaxTurns === "number") appliers.setDefaultMaxTurns(settings.defaultMaxTurns);
  if (typeof settings.graceTurns === "number") appliers.setGraceTurns(settings.graceTurns);
  if (typeof settings.maxEndHookRevisions === "number") {
    appliers.setMaxEndHookRevisions(settings.maxEndHookRevisions);
  }
  if (settings.defaultJoinMode) appliers.setDefaultJoinMode(settings.defaultJoinMode);
  if (typeof settings.schedulingEnabled === "boolean") appliers.setSchedulingEnabled(settings.schedulingEnabled);
  if (typeof settings.tracingEnabled === "boolean") appliers.setTracingEnabled(settings.tracingEnabled);
  if (settings.animationStyle) appliers.setAnimationStyle(settings.animationStyle);
  if (settings.uiStyle) appliers.setUiStyle(settings.uiStyle);
  if (typeof settings.showActivityStream === "boolean") appliers.setShowActivityStream(settings.showActivityStream);
  if (typeof settings.showTokenUsage === "boolean") appliers.setShowTokenUsage(settings.showTokenUsage);
  if (typeof settings.showTurnProgress === "boolean") appliers.setShowTurnProgress(settings.showTurnProgress);
  if (settings.orchestrationMode) appliers.setOrchestrationMode(settings.orchestrationMode);
  if (typeof settings.dashboardRefreshInterval === "number") {
    appliers.setDashboardRefreshInterval(settings.dashboardRefreshInterval);
  }
  if (typeof settings.sessionMaxSpawns === "number") appliers.setSessionMaxSpawns(settings.sessionMaxSpawns);
  if (typeof settings.sessionMaxTurns === "number") appliers.setSessionMaxTurns(settings.sessionMaxTurns);
  if (settings.promptCompressionLevel) appliers.setPromptCompressionLevel(settings.promptCompressionLevel);
  if (typeof settings.debugCapture === "boolean") appliers.setDebugCapture(settings.debugCapture);
  if (settings.debugCapturePaths !== undefined) appliers.setDebugCapturePaths(settings.debugCapturePaths);
  if (settings.dashboardKeybindings !== undefined) {
    appliers.setDashboardKeybindings(settings.dashboardKeybindings);
  }
  if (settings.footerStatus !== undefined) appliers.setFooterStatusConfig(settings.footerStatus);
}

export function persistToastFor(
  successMessage: string,
  persisted: boolean,
): { message: string; level: "info" | "warning" } {
  return persisted
    ? { message: successMessage, level: "info" }
    : { message: `${successMessage} (session only; failed to persist)`, level: "warning" };
}

export function applyAndEmitLoaded(
  appliers: SettingsAppliers,
  emit: SettingsEmit,
  cwd: string = process.cwd(),
): SubagentsSettings {
  const settings = loadSettings(cwd);
  applySettings(settings, appliers);
  emit("subagents:settings_loaded", { settings });
  return settings;
}

export function saveAndEmitChanged(
  snapshot: SubagentsSettings,
  successMessage: string,
  emit: SettingsEmit,
  cwd: string = process.cwd(),
): { message: string; level: "info" | "warning" } {
  const persisted = saveSettings(snapshot, cwd);
  emit("subagents:settings_changed", { settings: snapshot, persisted });
  return persistToastFor(successMessage, persisted);
}
