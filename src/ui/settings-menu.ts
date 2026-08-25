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
  type OrchestrationMode,
  setAnimationStyle,
  setDashboardRefreshInterval,
  setFreeModelsOnly,
  setOrchestrationMode,
  setPromptCompressionLevel,
  setUiStyle,
} from "../agent-registry.js";
import type { SubagentScheduler } from "../schedule.js";
import type { SettingsGetters, SettingsSetters } from "../settings.js";
import { saveAndEmitChanged } from "../settings.js";
import type { JoinMode, PromptCompressionLevel } from "../types.js";
import { setSpinnerStyle } from "./animation.js";
import { buildSettingsSnapshot } from "./settings-snapshot.js";

type Ctx = ExtensionCommandContext;

const MOTION_PROFILE_OPTIONS: ReadonlyArray<{
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

export async function showSettings(
  ctx: ExtensionCommandContext,
  manager: AgentManager,
  pi: ExtensionAPI,
  scheduler: SubagentScheduler,
  getters: SettingsGetters,
  setters: SettingsSetters,
): Promise<void> {
  const choice = await ctx.ui.select("Settings", [
    `Max concurrency (current: ${manager.getMaxConcurrent()})`,
    `Session limits (agents: ${manager.getSessionLimits().maxAgentsPerSession ?? "unlimited"}, turns: ${manager.getSessionLimits().maxTotalTurnsPerSession ?? "unlimited"})`,
    `Default max turns (current: ${getters.getDefaultMaxTurns() ?? "unlimited"})`,
    `Grace turns (current: ${getters.getGraceTurns()})`,
    `End-hook revisions (current: ${getters.getMaxEndHookRevisions()})`,
    `Coordination (join: ${getters.getDefaultJoinMode()}, orch: ${getOrchestrationMode()})`,
    `Scheduling (current: ${getters.isSchedulingEnabled() ? "enabled" : "disabled"})`,
    `Tracing (current: ${getters.isTracingEnabled() ? "enabled" : "disabled"})`,
    `Free models only (current: ${isFreeModelsOnly() ? "free only — session-only" : "all (paid + free)"})`,
    `Motion profile (current: ${getAnimationStyle()})`,
    `UI/UX Style (current: ${getUiStyle()})`,
    `Dashboard refresh interval (current: ${getDashboardRefreshInterval()}ms)`,
    `Prompt compression (current: ${getPromptCompressionLevel()})`,
  ]);
  if (!choice) return;

  if (choice.startsWith("Max concurrency")) {
    const value = await ctx.ui.input("Max concurrent background agents", String(manager.getMaxConcurrent()));
    if (!value) return;
    const parsed = Number.parseInt(value, 10);
    if (parsed < 1) return ctx.ui.notify("Must be a positive integer.", "warning");
    manager.setMaxConcurrent(parsed);
    notifyApplied(ctx, pi, manager, getters, `Max concurrency set to ${parsed}`);
    return;
  }

  if (choice.startsWith("Session limits")) {
    const current = manager.getSessionLimits();
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
    manager.setSessionLimits({
      maxAgentsPerSession: maxAgents === 0 ? undefined : maxAgents,
      maxTotalTurnsPerSession: maxTurns === 0 ? undefined : maxTurns,
    });
    notifyApplied(ctx, pi, manager, getters, "Session limits updated");
    return;
  }

  if (choice.startsWith("Default max turns")) {
    const value = await ctx.ui.input("Default max turns before wrap-up (0 = unlimited)", String(getters.getDefaultMaxTurns() ?? 0));
    if (!value) return;
    const parsed = Number.parseInt(value, 10);
    if (parsed === 0) {
      setters.setDefaultMaxTurns(undefined);
      notifyApplied(ctx, pi, manager, getters, "Default max turns set to unlimited");
    } else if (parsed >= 1) {
      setters.setDefaultMaxTurns(parsed);
      notifyApplied(ctx, pi, manager, getters, `Default max turns set to ${parsed}`);
    } else {
      ctx.ui.notify("Must be 0 (unlimited) or a positive integer.", "warning");
    }
    return;
  }

  if (choice.startsWith("Grace turns")) {
    const value = await ctx.ui.input("Grace turns after wrap-up steer", String(getters.getGraceTurns()));
    if (!value) return;
    const parsed = Number.parseInt(value, 10);
    if (parsed < 1) return ctx.ui.notify("Must be a positive integer.", "warning");
    setters.setGraceTurns(parsed);
    notifyApplied(ctx, pi, manager, getters, `Grace turns set to ${parsed}`);
    return;
  }

  if (choice.startsWith("End-hook revisions")) {
    const value = await ctx.ui.input(
      "Max revision turns after a blocking subagent:end hook (0 = fail closed, no revision)",
      String(getters.getMaxEndHookRevisions()),
    );
    if (!value) return;
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed < 0 || parsed > 10) {
      return ctx.ui.notify("Must be an integer from 0 to 10.", "warning");
    }
    setters.setMaxEndHookRevisions(parsed);
    notifyApplied(ctx, pi, manager, getters, `End-hook revisions set to ${parsed}`);
    return;
  }

  if (choice.startsWith("Coordination")) {
    await showCoordinationMenu(ctx, pi, manager, getters, setters);
    return;
  }

  if (choice.startsWith("Scheduling")) {
    const value = await ctx.ui.select("Schedule subagent feature", [
      "enabled — Agent tool accepts a `schedule` param; /agents → Scheduled jobs visible",
      "disabled — `schedule` removed from Agent tool spec (no LLM-context cost); menu hidden",
    ]);
    if (!value) return;
    const enabled = value.startsWith("enabled");
    if (enabled === getters.isSchedulingEnabled()) {
      ctx.ui.notify(`Scheduling already ${enabled ? "enabled" : "disabled"}.`, "info");
      return;
    }
    setters.setSchedulingEnabled(enabled);
    if (!enabled) scheduler.stop();
    notifyApplied(
      ctx,
      pi,
      manager,
      getters,
      `Scheduling ${enabled ? "enabled" : "disabled"}. Tool spec change takes effect on next pi session.`,
    );
    return;
  }

  if (choice.startsWith("Tracing")) {
    const value = await ctx.ui.select("OpenTelemetry span emission", [
      "enabled — agent lifecycle spans are emitted to the configured TracerProvider (default)",
      "disabled — span helpers short-circuit to a shared no-op; no TracerProvider is consulted",
    ]);
    if (!value) return;
    const enabled = value.startsWith("enabled");
    if (enabled === getters.isTracingEnabled()) {
      ctx.ui.notify(`Tracing already ${enabled ? "enabled" : "disabled"}.`, "info");
      return;
    }
    setters.setTracingEnabled(enabled);
    notifyApplied(ctx, pi, manager, getters, `Tracing ${enabled ? "enabled" : "disabled"}.`);
    return;
  }

  if (choice.startsWith("Free models")) {
    const value = await ctx.ui.select("Free models only (session-only, not persisted)", [
      "free only — subagents only use zero-cost models (this session)",
      "all — subagents may use any available model (default)",
    ]);
    if (!value) return;
    const enabled = value.startsWith("free only");
    if (enabled === isFreeModelsOnly()) {
      ctx.ui.notify(`Free-only already ${enabled ? "enabled" : "disabled"} (session-only).`, "info");
      return;
    }
    setFreeModelsOnly(enabled);
    ctx.ui.notify(`Free models only ${enabled ? "enabled" : "disabled"} — session-only, not persisted.`, "info");
    return;
  }

  if (choice.startsWith("Motion profile")) {
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
    notifyApplied(ctx, pi, manager, getters, `Motion profile set to ${profile}`);
    return;
  }

  if (choice.startsWith("UI/UX Style")) {
    const value = await ctx.ui.select("UI/UX Style", [
      "premium — truecolor gradients and rounded connectors (default)",
      "retro — 16-color fallback and straight box lines",
      "plain — minimal markers, plain text with no ANSI styles",
    ]);
    if (!value) return;
    const style = value.split(" ")[0] as "premium" | "retro" | "plain";
    setUiStyle(style);
    notifyApplied(ctx, pi, manager, getters, `UI/UX style set to ${style}`);
    return;
  }

  if (choice.startsWith("Dashboard refresh interval")) {
    const value = await ctx.ui.input(
      "Dashboard refresh interval in milliseconds (100-60000)",
      String(getDashboardRefreshInterval()),
    );
    if (!value) return;
    const parsed = Number.parseInt(value, 10);
    if (parsed < 100 || parsed > 60_000) {
      ctx.ui.notify("Must be between 100 and 60000 milliseconds.", "warning");
      return;
    }
    setDashboardRefreshInterval(parsed);
    notifyApplied(ctx, pi, manager, getters, `Dashboard refresh interval set to ${parsed}ms`);
    return;
  }

  if (choice.startsWith("Prompt compression")) {
    await showPromptCompressionMenu(ctx, pi, manager, getters);
  }
}

const JOIN_MODE_OPTIONS: ReadonlyArray<{ mode: JoinMode; desc: string }> = [
  { mode: "smart", desc: "auto-group 2+ agents in same turn (default)" },
  { mode: "async", desc: "always notify individually" },
  { mode: "group", desc: "always group background agents" },
  { mode: "swarm", desc: "dynamic collaborative group (agents can join at runtime)" },
];

const ORCH_MODE_OPTIONS: ReadonlyArray<{ mode: OrchestrationMode; desc: string }> = [
  { mode: "single", desc: "one tool call creates one agent (safe default)" },
  { mode: "auto", desc: "heuristic fan-out; some prompts create 3 agents" },
  { mode: "swarm", desc: "every tool call creates a collaborative multi-agent group" },
  { mode: "crew", desc: "every tool call creates planner/executor/reviewer agents" },
];

export async function showCoordinationMenu(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  manager: AgentManager,
  getters: SettingsGetters,
  setters: SettingsSetters,
): Promise<void> {
  const mark = (current: string, candidate: string): string => candidate === current ? " ◀ current" : "";

  while (true) {
    const currentJoin = getters.getDefaultJoinMode();
    const currentOrchestration = getOrchestrationMode();
    const options = [
      ...JOIN_MODE_OPTIONS.map(({ mode, desc }) => `JOIN: ${mode} — ${desc}${mark(currentJoin, mode)}`),
      ...ORCH_MODE_OPTIONS.map(({ mode, desc }) => `ORCH: ${mode} — ${desc}${mark(currentOrchestration, mode)}`),
    ];
    const value = await ctx.ui.select("Coordination (join + orchestration mode)", options);
    if (!value) return;

    if (value.startsWith("JOIN: ")) {
      const mode = value.slice("JOIN: ".length).split(" ")[0] as JoinMode;
      if (mode === currentJoin) {
        ctx.ui.notify(`Join mode already ${mode}.`, "info");
        continue;
      }
      setters.setDefaultJoinMode(mode);
      notifyApplied(ctx, pi, manager, getters, `Join mode set to ${mode}`);
      continue;
    }

    if (value.startsWith("ORCH: ")) {
      const mode = value.slice("ORCH: ".length).split(" ")[0] as OrchestrationMode;
      if (mode === currentOrchestration) {
        ctx.ui.notify(`Orchestration mode already ${mode}.`, "info");
        continue;
      }
      setOrchestrationMode(mode);
      notifyApplied(ctx, pi, manager, getters, `Orchestration mode set to ${mode}`);
      continue;
    }

    ctx.ui.notify("Unexpected coordination option — please report this.", "warning");
  }
}

async function showPromptCompressionMenu(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  manager: AgentManager,
  getters: SettingsGetters,
): Promise<void> {
  while (true) {
    const current = getPromptCompressionLevel();
    const mark = (level: string): string => level === current ? " ◀ current" : "";
    const value = await ctx.ui.select("Prompt compression level", [
      `minimal — least compression; most explicit guidance${mark("minimal")}`,
      `balanced — concise guidance (default)${mark("balanced")}`,
      `aggressive — shortest guidance; reduced protocol detail${mark("aggressive")}`,
      "📊 Scope and template-size comparison",
    ]);
    if (!value) return;
    if (value.startsWith("📊")) {
      await showCompressionComparison(ctx);
      continue;
    }

    const level = value.split(" ")[0] as PromptCompressionLevel;
    if (level === current) {
      ctx.ui.notify(`Prompt compression already set to ${level}.`, "info");
      continue;
    }
    setPromptCompressionLevel(level);
    notifyApplied(ctx, pi, manager, getters, `Prompt compression set to ${level}`);
    return;
  }
}

async function showCompressionComparison(ctx: Ctx): Promise<void> {
  const table = `# Prompt Compression — Scope and Template Size

Selects static instruction variants. It does not compact conversation history,
inherited context, task prompts, custom-agent bodies, memory, skills, or tool schemas.

Character counts below compare isolated templates, not complete model requests.
They are not tokenizer measurements. Do not add rows together: one agent run uses
one agent prompt, and the handoff row applies only when handoff: true.

${"─".repeat(83)}
| Component            | Minimal chars | Balanced chars | Aggressive chars | Aggressive vs balanced |
|──────────────────────|──────────────:|───────────────:|─────────────────:|──────────────────────:|
| Handoff instructions |         2,334 |            971 |              118 |            −853 chars |
| Explore readonly     |         1,159 |            802 |              571 |            −231 chars |
| Plan readonly        |         1,188 |            831 |              600 |            −231 chars |
| Analysis readonly    |         1,244 |            887 |              656 |            −231 chars |
${"─".repeat(83)}

SCOPE:
- Built-in Explore/Plan/Analysis: read-only warning + tool guidance.
- Agents with handoff: true: structured handoff instructions.
- Custom prompt bodies are not compressed. With handoff: false, a custom-agent
  prompt_compression override currently has no effect.
- Append-mode agents vary only when an enabled handoff block is present.

ACTUAL IMPACT:
Provider input tokens depend on the model tokenizer, prompt caching, selected agent,
turn count, inherited context, memory, skills, and tool schemas. Measure real runs
with provider-reported input usage or runner telemetry.

PRECEDENCE: per-agent prompt_compression > global setting > balanced
`;
  await ctx.ui.editor("Prompt Compression Scope", table);
}

export function notifyApplied(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  manager: AgentManager,
  getters: SettingsGetters,
  successMessage: string,
): void {
  const snapshot = buildSettingsSnapshot(manager, getters);
  const { message, level } = saveAndEmitChanged(
    snapshot,
    successMessage,
    (event, payload) => pi.events.emit(event, payload),
  );
  ctx.ui.notify(message, level);
}
