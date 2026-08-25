/**
 * settings-schema.ts — Single source of truth for the /agents → Settings menu.
 *
 * Every menu-editable setting is ONE descriptor entry here: stable `id`,
 * live `label()` (rendered into the picker), and an `edit()` flow. The menu
 * dispatches on the descriptor, never on label text, so labels can change
 * freely and a new setting is a new entry instead of edits in five files.
 *
 * Factories (`toggleEntry`, `intEntry`) cover the repeated shapes; bespoke
 * flows stay plain entries. Session-only settings declare `persist: false`
 * and bypass the save/persist path deliberately.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager.js";
import {
  type AnimationStyle,
  getAnimationStyle,
  getDashboardRefreshInterval,
  getOrchestrationMode,
  getPromptCompressionLevel,
  getUiStyle,
  isFreeModelsOnly,
  isShowActivityStream,
  isShowTokenUsage,
  isShowTurnProgress,
  setAnimationStyle,
  setDashboardRefreshInterval,
  setFreeModelsOnly,
  setShowActivityStream,
  setShowTokenUsage,
  setShowTurnProgress,
  setUiStyle,
} from "../agent-registry.js";
import type { SubagentScheduler } from "../schedule.js";
import type { SettingsGetters, SettingsSetters } from "../settings.js";
import { setSpinnerStyle } from "./animation.js";

type Ctx = ExtensionCommandContext;

/** Dependency bag threaded through every settings editor. */
export interface SettingsUiDeps {
  pi: ExtensionAPI;
  manager: AgentManager;
  scheduler: SubagentScheduler;
  getters: SettingsGetters;
  setters: SettingsSetters;
  /** Persist snapshot + notify after an accepted change. */
  notifyApplied: (ctx: Ctx, message: string) => void;
}

export interface SettingEntry {
  /** Stable dispatch id — routing never matches on label text. */
  id: string;
  /** Picker label including the live current value. */
  label: (deps: SettingsUiDeps) => string;
  /** Editor flow for the selected entry. */
  edit: (ctx: Ctx, deps: SettingsUiDeps) => Promise<void>;
}

// ── Shared editor helpers ────────────────────────────────────────────────

async function askInt(
  ctx: Ctx,
  prompt: string,
  current: number,
  min: number,
  max: number,
): Promise<number | undefined> {
  const value = await ctx.ui.input(prompt, String(current));
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < min || parsed > max) {
    ctx.ui.notify(`Must be an integer from ${min} to ${max}.`, "warning");
    return undefined;
  }
  return parsed;
}

/** Boolean toggle entry. Persists unless `persist: false`. */
function toggleEntry(config: {
  id: string;
  name: string;
  get: (deps: SettingsUiDeps) => boolean;
  set: (deps: SettingsUiDeps, v: boolean) => void;
  onLabel?: string;
  offLabel?: string;
  note?: string;
  persist?: boolean;
}): SettingEntry {
  const on = config.onLabel ?? "enabled";
  const off = config.offLabel ?? "disabled";
  const suffix = config.persist === false ? " — session-only" : "";
  return {
    id: config.id,
    label: (deps) => `${config.name} (current: ${config.get(deps) ? on : off}${suffix})`,
    edit: async (ctx, deps) => {
      const next = !config.get(deps);
      config.set(deps, next);
      if (config.persist === false) {
        ctx.ui.notify(`${config.name} ${next ? "enabled" : "disabled"} — session-only, not persisted.`, "info");
        return;
      }
      deps.notifyApplied(ctx, `${config.name} ${next ? on : off}${config.note ? `. ${config.note}` : ""}`);
    },
  };
}

/** Integer input entry (min..max, persists). */
function intEntry(config: {
  id: string;
  name: string;
  get: (deps: SettingsUiDeps) => number;
  set: (deps: SettingsUiDeps, v: number) => void;
  min: number;
  max: number;
  prompt?: string;
}): SettingEntry {
  return {
    id: config.id,
    label: (deps) => `${config.name} (current: ${config.get(deps)})`,
    edit: async (ctx, deps) => {
      const value = await askInt(ctx, config.prompt ?? config.name, config.get(deps), config.min, config.max);
      if (value === undefined) return;
      config.set(deps, value);
      deps.notifyApplied(ctx, `${config.name} set to ${value}`);
    },
  };
}

// ── The table ────────────────────────────────────────────────────────────

/** Motion profile options shared between entry and editor. */
export const MOTION_PROFILE_OPTIONS: ReadonlyArray<{
  profile: AnimationStyle;
  preview: string;
  description: string;
}> = [
  { profile: "orchestrator", preview: "⊙ ▖ ⌜ ◆ △", description: "semantic identities for explore, plan, build, review and validation (default)" },
  { profile: "signals", preview: "▁ ▍ ⣤ ▚", description: "telemetry, scanline and data-flow motion" },
  { profile: "minimal", preview: "⠁ • ◇ ◑", description: "restrained low-noise geometric motion" },
  { profile: "reduced", preview: "⊙ ┈ ⠏", description: "static semantic glyphs; no frame animation" },
  { profile: "braille", preview: "⠋", description: "single consistent braille spinner" },
  { profile: "dots", preview: "⠁", description: "single consistent dots spinner" },
  { profile: "lines", preview: "-", description: "single consistent ASCII spinner" },
  { profile: "classic", preview: "*", description: "static asterisk" },
  { profile: "none", preview: "·", description: "disable motion glyphs" },
];

export function buildSettingEntries(submenus: {
  openCoordination: (ctx: Ctx, deps: SettingsUiDeps) => Promise<void>;
  openCompression: (ctx: Ctx, deps: SettingsUiDeps) => Promise<void>;
}): ReadonlyArray<SettingEntry> {
  return [
    intEntry({
      id: "maxConcurrent",
      name: "Max concurrency",
      get: (deps) => deps.manager.getMaxConcurrent(),
      set: (deps, v) => deps.manager.setMaxConcurrent(v),
      min: 1,
      max: 1024,
      prompt: "Max concurrent background agents",
    }),
    {
      id: "sessionLimits",
      label: (deps) =>
        `Session limits (agents: ${deps.manager.getSessionLimits().maxAgentsPerSession ?? "unlimited"}, turns: ${deps.manager.getSessionLimits().maxTotalTurnsPerSession ?? "unlimited"})`,
      edit: async (ctx, deps) => {
        const current = deps.manager.getSessionLimits();
        const agentValue = await ctx.ui.input("Max agents per session (0 = unlimited)", String(current.maxAgentsPerSession ?? 0));
        if (agentValue === undefined) return;
        const turnValue = await ctx.ui.input("Max total turns per session (0 = unlimited)", String(current.maxTotalTurnsPerSession ?? 0));
        if (turnValue === undefined) return;
        const maxAgents = Number.parseInt(agentValue, 10);
        const maxTurns = Number.parseInt(turnValue, 10);
        if (Number.isNaN(maxAgents) || maxAgents < 0 || Number.isNaN(maxTurns) || maxTurns < 0) {
          ctx.ui.notify("Use 0 (unlimited) or a positive integer.", "warning");
          return;
        }
        deps.manager.setSessionLimits({
          maxAgentsPerSession: maxAgents === 0 ? undefined : maxAgents,
          maxTotalTurnsPerSession: maxTurns === 0 ? undefined : maxTurns,
        });
        deps.notifyApplied(ctx, "Session limits updated");
      },
    },
    {
      id: "defaultMaxTurns",
      label: (deps) => `Default max turns (current: ${deps.getters.getDefaultMaxTurns() ?? "unlimited"})`,
      edit: async (ctx, deps) => {
        const value = await ctx.ui.input("Default max turns before wrap-up (0 = unlimited)", String(deps.getters.getDefaultMaxTurns() ?? 0));
        if (!value) return;
        const parsed = Number.parseInt(value, 10);
        if (parsed === 0) {
          deps.setters.setDefaultMaxTurns(undefined);
          deps.notifyApplied(ctx, "Default max turns set to unlimited");
        } else if (parsed >= 1) {
          deps.setters.setDefaultMaxTurns(parsed);
          deps.notifyApplied(ctx, `Default max turns set to ${parsed}`);
        } else {
          ctx.ui.notify("Must be 0 (unlimited) or a positive integer.", "warning");
        }
      },
    },
    intEntry({
      id: "graceTurns",
      name: "Grace turns",
      get: (deps) => deps.getters.getGraceTurns(),
      set: (deps, v) => deps.setters.setGraceTurns(v),
      min: 1,
      max: 1000,
      prompt: "Grace turns after wrap-up steer",
    }),
    intEntry({
      id: "endHookRevisions",
      name: "End-hook revisions",
      get: (deps) => deps.getters.getMaxEndHookRevisions(),
      set: (deps, v) => deps.setters.setMaxEndHookRevisions(v),
      min: 0,
      max: 10,
      prompt: "Max revision turns after a blocking subagent:end hook (0 = fail closed)",
    }),
    {
      id: "coordination",
      label: (deps) => `Coordination (join: ${deps.getters.getDefaultJoinMode()}, orch: ${getOrchestrationMode()})`,
      edit: (ctx, deps) => submenus.openCoordination(ctx, deps),
    },
    toggleEntry({
      id: "scheduling",
      name: "Scheduling",
      get: (deps) => deps.getters.isSchedulingEnabled(),
      set: (deps, v) => {
        deps.setters.setSchedulingEnabled(v);
        if (!v) deps.scheduler.stop();
      },
      note: "Tool spec change takes effect on next pi session",
    }),
    toggleEntry({
      id: "tracing",
      name: "Tracing",
      get: (deps) => deps.getters.isTracingEnabled(),
      set: (deps, v) => deps.setters.setTracingEnabled(v),
    }),
    toggleEntry({
      id: "freeModelsOnly",
      name: "Free models only",
      get: () => isFreeModelsOnly(),
      set: (_d, v) => setFreeModelsOnly(v),
      onLabel: "free only",
      offLabel: "all (paid + free)",
      persist: false,
    }),
    {
      id: "motionProfile",
      label: () => `Motion profile (current: ${getAnimationStyle()})`,
      edit: async (ctx, deps) => {
        const current = getAnimationStyle();
        const value = await ctx.ui.select(
          "Motion profile",
          MOTION_PROFILE_OPTIONS.map(({ profile, preview, description }) =>
            `${profile}  ${preview} — ${description}${profile === current ? " ◀ current" : ""}`,
          ),
        );
        if (!value) return;
        const profile = value.split(" ")[0] as AnimationStyle;
        if (profile === current) {
          ctx.ui.notify(`Motion profile already ${profile}.`, "info");
          return;
        }
        setAnimationStyle(profile);
        setSpinnerStyle(profile);
        deps.notifyApplied(ctx, `Motion profile set to ${profile}`);
      },
    },
    {
      id: "uiStyle",
      label: () => `UI/UX Style (current: ${getUiStyle()})`,
      edit: async (ctx, deps) => {
        const value = await ctx.ui.select("UI/UX Style", [
          "premium — truecolor gradients and rounded connectors (default)",
          "retro — 16-color fallback and straight box lines",
          "plain — minimal markers, plain text with no ANSI styles",
        ]);
        if (!value) return;
        const style = value.split(" ")[0] as "premium" | "retro" | "plain";
        setUiStyle(style);
        deps.notifyApplied(ctx, `UI/UX style set to ${style}`);
      },
    },
    intEntry({
      id: "dashboardRefresh",
      name: "Dashboard refresh interval",
      get: getDashboardRefreshInterval,
      set: (_deps, v) => setDashboardRefreshInterval(v),
      min: 100,
      max: 60_000,
      prompt: "Dashboard refresh interval in milliseconds (100-60000)",
    }),
    {
      id: "promptCompression",
      label: () => `Prompt compression (current: ${getPromptCompressionLevel()})`,
      edit: (ctx, deps) => submenus.openCompression(ctx, deps),
    },
    toggleEntry({ id: "showActivityStream", name: "Activity stream", get: () => isShowActivityStream(), set: (_d, v) => setShowActivityStream(v) }),
    toggleEntry({ id: "showTokenUsage", name: "Token usage display", get: () => isShowTokenUsage(), set: (_d, v) => setShowTokenUsage(v) }),
    toggleEntry({ id: "showTurnProgress", name: "Turn progress display", get: () => isShowTurnProgress(), set: (_d, v) => setShowTurnProgress(v) }),
  ];
}
