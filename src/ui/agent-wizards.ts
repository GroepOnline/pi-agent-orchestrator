import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager.js";
import { reloadCustomAgents } from "../agent-registry.js";
import { BUILTIN_TOOL_NAMES, getAgentConfig } from "../agent-types.js";
import type { SubagentScheduler } from "../schedule.js";
import {
  type AgentArchitectureMode,
  type AgentAutonomyProfile,
  type AgentSystemBlueprint,
  type BlueprintSelectionContext,
  buildAgentSystemPrompt,
  normalizeWizardName,
  parseAgentSystemBlueprint,
  type ScheduleRequest,
  type SkillGenerationPolicy,
  validateBlueprintForSelections,
} from "./agent-blueprint.js";
import { writeBlueprintFilesAtomically } from "./agent-blueprint-writer.js";
import { personalAgentsDir, projectAgentsDir } from "./agent-file-helpers.js";

const ARCHITECTURE_OPTIONS: Record<string, AgentArchitectureMode> = {
  "Claude decides — smallest correct architecture": "auto",
  "Single specialist agent": "single",
  "Agent + reusable skills": "skill",
  "Autonomous handoff chain": "chain",
  "Self-validating agentic loop": "loop",
  "Timed / scheduled agent": "scheduled",
  "Full autonomous system": "full",
};

const AUTONOMY_OPTIONS: Record<string, AgentAutonomyProfile> = {
  "Safe least-privilege defaults": "safe",
  "Strictly read-only": "read-only",
  "Implementation in isolated worktrees": "implementation",
  "Full autonomy with budgets and validation": "full",
};

const SKILL_OPTIONS: Record<string, SkillGenerationPolicy> = {
  "Claude decides when a reusable skill is justified": "auto",
  "Always create reusable skills": "always",
  "Do not create skills": "never",
};

const ACTIVATION_OPTIONS = [
  "On demand only",
  "Run once — ISO date/time or +duration",
  "Repeat on interval — e.g. 30m, 2h",
  "Cron schedule — e.g. 0 9 * * 1-5",
  "Let Claude propose timing when the goal requires it",
] as const;

function mapChoice<T>(choice: string | undefined, options: Record<string, T>): T | undefined {
  return choice ? options[choice] : undefined;
}

function agentPath(targetDir: string, name: string): string {
  return join(targetDir, `${name}.md`);
}

function skillPath(targetDir: string, name: string): string {
  return join(targetDir, "..", "skills", name, "SKILL.md");
}

function formatBlueprintSummary(blueprint: AgentSystemBlueprint): string {
  const agents = blueprint.agents
    .map((agent) => `${agent.name}${agent.primary ? " (primary)" : ""}`)
    .join(", ");
  const skills = blueprint.skills.length > 0
    ? blueprint.skills.map((skill) => skill.name).join(", ")
    : "none";
  const lines = [
    blueprint.summary,
    "",
    `Agents: ${agents}`,
    `Skills: ${skills}`,
    `Schedule: ${blueprint.schedule?.schedule ?? "none"}`,
  ];
  if (blueprint.warnings.length > 0) lines.push("", `Warnings: ${blueprint.warnings.join(" | ")}`);
  return lines.join("\n");
}

async function collectScheduleRequest(
  ctx: ExtensionCommandContext,
  architecture: AgentArchitectureMode,
): Promise<ScheduleRequest | null> {
  const activation = await ctx.ui.select("Activation", [...ACTIVATION_OPTIONS]);
  if (!activation) return null;

  if (activation === "On demand only") {
    if (architecture === "scheduled") {
      return {
        mode: "required",
        hint: "A concrete schedule is required. Infer the safest useful cadence from the user's goal.",
      };
    }
    return { mode: "none", hint: "On demand only. Return schedule: null." };
  }

  if (activation === "Let Claude propose timing when the goal requires it") {
    return architecture === "scheduled"
      ? {
        mode: "required",
        hint: "A concrete schedule is required. Choose the safest useful cadence from the user's goal.",
      }
      : {
        mode: "optional",
        hint: "Propose a schedule only when recurrence or timing is materially required by the goal.",
      };
  }

  const defaults: Record<string, string> = {
    "Run once — ISO date/time or +duration": "+10m",
    "Repeat on interval — e.g. 30m, 2h": "1h",
    "Cron schedule — e.g. 0 9 * * 1-5": "0 9 * * 1-5",
  };
  const expression = (await ctx.ui.input("Schedule expression", defaults[activation]))?.trim();
  if (!expression) return null;

  const kind = activation.startsWith("Run once")
    ? "one-shot"
    : activation.startsWith("Repeat")
      ? "recurring interval"
      : "cron";
  return {
    mode: "exact",
    expectedExpression: expression,
    hint: `Create a ${kind} schedule using exactly "${expression}". Do not substitute another cadence.`,
  };
}

function preflightOverwrite(
  ctx: ExtensionCommandContext,
  targetDir: string,
  blueprint: AgentSystemBlueprint,
): Promise<boolean> {
  const existing = [
    ...blueprint.agents.map((agent) => agentPath(targetDir, agent.name)),
    ...blueprint.skills.map((skill) => skillPath(targetDir, skill.name)),
  ].filter(existsSync);
  if (existing.length === 0) return Promise.resolve(true);

  const preview = existing.length <= 8
    ? existing.join("\n")
    : `${existing.slice(0, 8).join("\n")}\n…and ${existing.length - 8} more`;
  return ctx.ui.confirm(
    `Overwrite ${existing.length} existing resource${existing.length === 1 ? "" : "s"}?`,
    preview,
  );
}

async function persistBlueprint(targetDir: string, blueprint: AgentSystemBlueprint): Promise<void> {
  const transaction = writeBlueprintFilesAtomically(targetDir, blueprint);
  try {
    await reloadCustomAgents();
    const unavailable = blueprint.agents.filter((agent) => {
      const config = getAgentConfig(agent.name);
      return !config || config.enabled === false;
    });
    if (unavailable.length > 0) {
      throw new Error(`Generated agent(s) failed runtime loading: ${unavailable.map((agent) => agent.name).join(", ")}`);
    }
    transaction.finalize();
  } catch (error) {
    transaction.rollback();
    try {
      await reloadCustomAgents();
    } catch {
      // Preserve the original persistence/validation error.
    }
    throw error;
  }
}

async function generateValidatedBlueprint(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  manager: AgentManager,
  name: string,
  generatePrompt: string,
  selection: BlueprintSelectionContext,
): Promise<AgentSystemBlueprint | undefined> {
  ctx.ui.notify("Architecting agent system...", "info");
  let record = await manager.spawnAndWait(pi, ctx, "Explore", generatePrompt, {
    description: `Architect ${name} agent system`,
    maxTurns: 10,
    isolated: true,
    inheritContext: false,
  });

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (record.status === "error") {
      ctx.ui.notify(`Generation failed: ${record.error ?? "unknown error"}`, "warning");
      return undefined;
    }

    const output = record.result?.trim() ?? "";
    let rejection = "";
    if (!output) {
      rejection = "The response was empty.";
    } else {
      try {
        const blueprint = parseAgentSystemBlueprint(output, name);
        rejection = validateBlueprintForSelections(blueprint, selection) ?? "";
        if (!rejection) return blueprint;
      } catch (error) {
        rejection = error instanceof Error ? error.message : String(error);
      }
    }

    if (attempt === 3) {
      ctx.ui.notify(`Claude could not produce a valid blueprint: ${rejection}`, "warning");
      if (output) await ctx.ui.editor("Rejected architect output", output);
      return undefined;
    }

    ctx.ui.notify(`Blueprint rejected (${attempt}/3): ${rejection} Asking Claude to repair it...`, "warning");
    const repaired = await manager.resume(
      record.id,
      `Your previous blueprint was rejected by the host validator.

REJECTION:
${rejection}

Return a COMPLETE replacement blueprint as strict JSON only. Preserve primary name "${name}". Obey the selected architecture, autonomy, skill policy, and activation requirement literally. Do not use a markdown fence and do not call tools.`,
    );
    if (!repaired) {
      ctx.ui.notify("Claude session could not be resumed for blueprint repair.", "warning");
      return undefined;
    }
    record = repaired;
  }
  return undefined;
}

async function activateSchedule(
  ctx: ExtensionCommandContext,
  scheduler: SubagentScheduler | undefined,
  blueprint: AgentSystemBlueprint,
): Promise<boolean> {
  const schedule = blueprint.schedule;
  const primary = blueprint.agents.find((agent) => agent.primary)?.name;
  if (!schedule || !primary) return false;

  if (!scheduler?.isActive()) {
    ctx.ui.notify(
      `Schedule "${schedule.schedule}" was generated but the scheduler is not active in this session.`,
      "warning",
    );
    return false;
  }

  const activate = await ctx.ui.confirm(
    "Activate generated schedule?",
    `${schedule.name}\n${schedule.schedule}\nAgent: ${primary}\n\n${schedule.description}`,
  );
  if (!activate) return false;

  try {
    await scheduler.addJob({
      name: schedule.name,
      description: schedule.description,
      schedule: schedule.schedule,
      subagent_type: primary,
      prompt: schedule.prompt,
      model: schedule.model,
      thinking: schedule.thinking,
      max_turns: schedule.max_turns,
      isolated: schedule.isolated,
      isolation: schedule.isolation,
    });
    ctx.ui.notify(`Activated schedule "${schedule.name}".`, "info");
    return true;
  } catch (error) {
    ctx.ui.notify(
      `Agent files were created, but schedule activation failed: ${error instanceof Error ? error.message : String(error)}`,
      "warning",
    );
    return false;
  }
}

async function runPrimaryNow(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  manager: AgentManager,
  blueprint: AgentSystemBlueprint,
  fallbackPrompt: string,
): Promise<void> {
  const primary = blueprint.agents.find((agent) => agent.primary)?.name;
  if (!primary) return;
  const initialPrompt = await ctx.ui.editor(
    `Initial task for ${primary}`,
    blueprint.schedule?.prompt ?? fallbackPrompt,
  );
  if (!initialPrompt?.trim()) return;

  ctx.ui.notify(`Starting ${primary}...`, "info");
  const record = await manager.spawnAndWait(pi, ctx, primary, initialPrompt.trim(), {
    description: `Run generated agent ${primary}`,
  });
  ctx.ui.notify(
    record.status === "error"
      ? `Agent failed: ${record.error ?? "unknown error"}`
      : `${primary} finished with status ${record.status}.`,
    record.status === "error" ? "warning" : "info",
  );
}

async function runCompleteChainNow(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  manager: AgentManager,
  blueprint: AgentSystemBlueprint,
  fallbackPrompt: string,
): Promise<void> {
  const initialPrompt = await ctx.ui.editor("Initial task for the generated chain", fallbackPrompt);
  if (!initialPrompt?.trim()) return;

  let previousOutput = "";
  for (let index = 0; index < blueprint.agents.length; index++) {
    const agent = blueprint.agents[index];
    const stagePrompt = `Execute stage ${index + 1}/${blueprint.agents.length} of this generated chain.

ORIGINAL TASK:
${initialPrompt.trim()}

${previousOutput
  ? `PREVIOUS STAGE OUTPUT / HANDOFF:\n${previousOutput}`
  : "This is the first stage; there is no previous handoff."}

Complete your role, verify its exit criteria, and emit a concrete handoff for the next stage.`;

    ctx.ui.notify(`Running chain stage ${index + 1}/${blueprint.agents.length}: ${agent.name}`, "info");
    const record = await manager.spawnAndWait(pi, ctx, agent.name, stagePrompt, {
      description: `Chain stage ${index + 1}: ${agent.name}`,
    });
    if (record.status === "error" || !record.result?.trim()) {
      ctx.ui.notify(`Chain stopped at ${agent.name}: ${record.error ?? "agent returned no output"}`, "warning");
      return;
    }
    previousOutput = record.result;
  }

  await ctx.ui.editor("Chain result", previousOutput);
  ctx.ui.notify(`Completed ${blueprint.agents.length}-stage agent chain.`, "info");
}

export async function showCreateWizard(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  manager: AgentManager,
  scheduler?: SubagentScheduler,
): Promise<void> {
  const location = await ctx.ui.select("Choose location", [
    "Project (.pi/agents/)",
    `Personal (${personalAgentsDir()})`,
  ]);
  if (!location) return;
  const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();

  const method = await ctx.ui.select("Creation method", [
    "Generate complete agent system with Claude (recommended)",
    "Manual single-agent configuration",
  ]);
  if (!method) return;
  if (method.startsWith("Generate")) await showGenerateWizard(ctx, targetDir, pi, manager, scheduler);
  else await showManualWizard(ctx, targetDir);
}

export async function showGenerateWizard(
  ctx: ExtensionCommandContext,
  targetDir: string,
  pi: ExtensionAPI,
  manager: AgentManager,
  scheduler?: SubagentScheduler,
): Promise<void> {
  const description = await ctx.ui.editor(
    "Describe the outcome, inputs, tools, success criteria, constraints, and failure behavior",
    "",
  );
  if (!description?.trim()) return;

  const rawName = await ctx.ui.input("Primary agent name (filename, no spaces)");
  if (!rawName) return;
  let name: string;
  try {
    name = normalizeWizardName(rawName);
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
    return;
  }

  const architecture = mapChoice(
    await ctx.ui.select("Architecture", Object.keys(ARCHITECTURE_OPTIONS)),
    ARCHITECTURE_OPTIONS,
  );
  if (!architecture) return;
  const autonomy = mapChoice(
    await ctx.ui.select("Autonomy and permissions", Object.keys(AUTONOMY_OPTIONS)),
    AUTONOMY_OPTIONS,
  );
  if (!autonomy) return;
  const skillPolicy = mapChoice(
    await ctx.ui.select("Reusable skills", Object.keys(SKILL_OPTIONS)),
    SKILL_OPTIONS,
  );
  if (!skillPolicy) return;
  const scheduleRequest = await collectScheduleRequest(ctx, architecture);
  if (!scheduleRequest) return;

  const selection: BlueprintSelectionContext = {
    architecture,
    autonomy,
    skillPolicy,
    scheduleRequest,
  };
  const generatePrompt = buildAgentSystemPrompt({
    requestedName: name,
    description: description.trim(),
    architecture,
    autonomy,
    skillPolicy,
    scheduleRequest,
    targetAgentDir: targetDir,
    targetSkillDir: join(targetDir, "..", "skills"),
  });
  const blueprint = await generateValidatedBlueprint(ctx, pi, manager, name, generatePrompt, selection);
  if (!blueprint) return;

  if (!(await ctx.ui.confirm("Create this agent system?", formatBlueprintSummary(blueprint)))) return;
  if (!(await preflightOverwrite(ctx, targetDir, blueprint))) return;

  try {
    await persistBlueprint(targetDir, blueprint);
  } catch (error) {
    ctx.ui.notify(
      `Failed to create agent system; all file changes were rolled back: ${error instanceof Error ? error.message : String(error)}`,
      "warning",
    );
    return;
  }

  const scheduled = await activateSchedule(ctx, scheduler, blueprint);
  const warningText = blueprint.warnings.length > 0
    ? `\nWarnings: ${blueprint.warnings.join(" | ")}`
    : "";
  ctx.ui.notify(
    `Created ${blueprint.agents.length} agent(s) and ${blueprint.skills.length} skill(s)${scheduled ? " with an active schedule" : ""}.${warningText}`,
    blueprint.warnings.length > 0 ? "warning" : "info",
  );

  const nextAction = await ctx.ui.select("Next action", [
    "Finish",
    "Run primary agent now",
    ...(blueprint.agents.length > 1 ? ["Run complete chain now"] : []),
    ...(blueprint.schedule && scheduler?.isActive() && !scheduled ? ["Activate generated schedule"] : []),
  ]);
  if (nextAction === "Run primary agent now") {
    await runPrimaryNow(ctx, pi, manager, blueprint, description.trim());
  } else if (nextAction === "Run complete chain now") {
    await runCompleteChainNow(ctx, pi, manager, blueprint, description.trim());
  } else if (nextAction === "Activate generated schedule") {
    await activateSchedule(ctx, scheduler, blueprint);
  }
}

export async function showManualWizard(ctx: ExtensionCommandContext, targetDir: string): Promise<void> {
  const rawName = await ctx.ui.input("Agent name (filename, no spaces)");
  if (!rawName) return;
  let name: string;
  try {
    name = normalizeWizardName(rawName);
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
    return;
  }

  const description = await ctx.ui.input("Description (one line)");
  if (!description) return;

  const readOnlyTools = BUILTIN_TOOL_NAMES.filter((tool) => tool !== "edit" && tool !== "write");
  const readOnlyLabel = `read-only (${readOnlyTools.join(", ")})`;
  const toolChoice = await ctx.ui.select("Tools", ["all", "none", readOnlyLabel, "custom..."]);
  if (!toolChoice) return;

  let tools: string;
  if (toolChoice === "all") tools = BUILTIN_TOOL_NAMES.join(", ");
  else if (toolChoice === "none") tools = "none";
  else if (toolChoice === readOnlyLabel) tools = readOnlyTools.join(", ");
  else {
    const customTools = await ctx.ui.input("Tools (comma-separated)", BUILTIN_TOOL_NAMES.join(", "));
    if (!customTools) return;
    tools = customTools;
  }

  const modelChoice = await ctx.ui.select("Model", [
    "inherit (parent model)",
    "haiku",
    "sonnet",
    "opus",
    "custom...",
  ]);
  if (!modelChoice) return;
  let modelLine = "";
  if (modelChoice === "haiku") modelLine = "\nmodel: anthropic/claude-haiku-4-5-20251001";
  else if (modelChoice === "sonnet") modelLine = "\nmodel: anthropic/claude-sonnet-4-6";
  else if (modelChoice === "opus") modelLine = "\nmodel: anthropic/claude-opus-4-6";
  else if (modelChoice === "custom...") {
    const customModel = await ctx.ui.input("Model (provider/modelId)");
    if (customModel) modelLine = `\nmodel: ${customModel}`;
  }

  const thinkingChoice = await ctx.ui.select("Thinking level", [
    "inherit",
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  if (!thinkingChoice) return;
  if (thinkingChoice === "max") {
    const confirmed = await ctx.ui.confirm(
      "Thinking level: max",
      "max requires a supporting model (GPT-5.6 / adaptive Claude). Unsupported models will error or fall back. Continue?",
    );
    if (!confirmed) return;
  }
  const thinkingLine = thinkingChoice === "inherit" ? "" : `\nthinking: ${thinkingChoice}`;

  const systemPrompt = await ctx.ui.editor("System prompt", "");
  if (systemPrompt === undefined) return;
  const content = `---
description: ${description}
tools: ${tools}${modelLine}${thinkingLine}
prompt_mode: replace
---

${systemPrompt}
`;

  mkdirSync(targetDir, { recursive: true });
  const targetPath = agentPath(targetDir, name);
  if (existsSync(targetPath)) {
    const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
    if (!overwrite) return;
  }
  writeFileSync(targetPath, content, "utf-8");
  await reloadCustomAgents();
  ctx.ui.notify(`Created ${targetPath}`, "info");
}
