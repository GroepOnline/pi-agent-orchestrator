import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager.js";
import {
  getOrchestrationMode,
  getPromptCompressionLevel,
  type OrchestrationMode,
  setOrchestrationMode,
  setPromptCompressionLevel,
} from "../agent-registry.js";
import type { SubagentScheduler } from "../schedule.js";
import type { SettingsGetters, SettingsSetters } from "../settings.js";
import { saveAndEmitChanged } from "../settings.js";
import type { JoinMode, PromptCompressionLevel } from "../types.js";
import {
  buildSettingEntries,
  type SettingsUiDeps,
} from "./settings-schema.js";
import { buildSettingsSnapshot } from "./settings-snapshot.js";

type Ctx = ExtensionCommandContext;

export async function showSettings(
  ctx: ExtensionCommandContext,
  manager: AgentManager,
  pi: ExtensionAPI,
  scheduler: SubagentScheduler,
  getters: SettingsGetters,
  setters: SettingsSetters,
): Promise<void> {
  const deps: SettingsUiDeps = {
    pi, manager, scheduler, getters, setters,
    notifyApplied: (c, message) => notifyApplied(c, pi, manager, getters, message),
  };

  const entries = buildSettingEntries({
    openCoordination: (c, d) => showCoordinationMenu(c, d.pi, d.manager, d.getters, d.setters),
    openCompression: (c, d) => showPromptCompressionMenu(c, d.pi, d.manager, d.getters),
  });

  const labels = entries.map((e) => e.label(deps));
  const choice = await ctx.ui.select("Settings", labels);
  if (!choice) return;

  // Dispatch on descriptor identity (stable id), never on label text.
  const idx = labels.indexOf(choice);
  if (idx < 0) return;
  await entries[idx].edit(ctx, deps);
}

const JOIN_MODE_OPTIONS: ReadonlyArray<{ mode: JoinMode; desc: string }> = [
  { mode: "smart", desc: "auto-group 2+ agents in same turn (default)" },
  { mode: "async", desc: "always notify individually" },
  { mode: "group", desc: "always group background agents" },
  { mode: "swarm", desc: "dynamic collaborative group (agents can join at runtime)" },
];

const ORCH_MODE_OPTIONS: ReadonlyArray<{ mode: import("../agent-registry.js").OrchestrationMode; desc: string }> = [
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

// ── Prompt compression submenu ───────────────────────────────────────────

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
