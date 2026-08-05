/**
 * Deterministic parsing and host-side validation for AI-generated agent systems.
 * The architect returns JSON only; it never receives write access.
 */

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES } from "../agent-types.js";
import type { ThinkingLevel } from "../types.js";

export type AgentArchitectureMode =
  | "auto"
  | "single"
  | "skill"
  | "chain"
  | "loop"
  | "scheduled"
  | "full";

export type AgentAutonomyProfile = "safe" | "read-only" | "implementation" | "full";
export type SkillGenerationPolicy = "auto" | "always" | "never";
export type ScheduleRequestMode = "none" | "optional" | "required" | "exact";

export interface ScheduleRequest {
  mode: ScheduleRequestMode;
  hint: string;
  expectedExpression?: string;
}

export interface AgentBlueprintFile {
  name: string;
  content: string;
  primary: boolean;
}

export interface SkillBlueprintFile {
  name: string;
  content: string;
}

export interface ScheduleBlueprint {
  name: string;
  description: string;
  schedule: string;
  prompt: string;
  model?: string;
  thinking?: ThinkingLevel;
  max_turns?: number;
  isolated?: boolean;
  isolation?: "worktree";
}

export interface AgentSystemBlueprint {
  summary: string;
  warnings: string[];
  agents: AgentBlueprintFile[];
  skills: SkillBlueprintFile[];
  schedule?: ScheduleBlueprint;
}

export interface GenerationPromptInput {
  requestedName: string;
  description: string;
  architecture: AgentArchitectureMode;
  autonomy: AgentAutonomyProfile;
  skillPolicy: SkillGenerationPolicy;
  scheduleRequest: ScheduleRequest;
  targetAgentDir: string;
  targetSkillDir: string;
}

export interface BlueprintSelectionContext {
  architecture: AgentArchitectureMode;
  autonomy: AgentAutonomyProfile;
  skillPolicy: SkillGenerationPolicy;
  scheduleRequest: ScheduleRequest;
}

export interface AgentDefinitionInspection {
  frontmatter: Record<string, unknown>;
  tools?: string[];
  disallowedTools: string[];
  extensions?: boolean | string;
  isolated?: boolean;
  isolation?: "worktree";
  handoff: boolean;
  validators: readonly { agentId: string; criteria: readonly string[] }[];
}

const SAFE_RESOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_AGENT_FILES = 6;
const MAX_SKILL_FILES = 8;
const MAX_FILE_CONTENT = 100_000;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const AGENT_FIELDS = new Set([
  "display_name",
  "description",
  "tools",
  "disallowed_tools",
  "extensions",
  "skills",
  "model",
  "thinking",
  "max_turns",
  "prompt_mode",
  "inherit_context",
  "run_in_background",
  "isolated",
  "memory",
  "isolation",
  "handoff",
  "prompt_compression",
  "validators",
  "enabled",
  "version",
  "template",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  value: unknown,
  field: string,
  options: { allowEmpty?: boolean; maxLength?: number } = {},
): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  if (!options.allowEmpty && !value.trim()) throw new Error(`${field} must not be empty`);
  const maxLength = options.maxLength ?? MAX_FILE_CONTENT;
  if (value.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters`);
  return value;
}

function requireSafeName(value: unknown, field: string): string {
  const name = requireString(value, field, { maxLength: 100 }).trim();
  if (!SAFE_RESOURCE_NAME.test(name) || name === "." || name === "..") {
    throw new Error(`${field} must use only letters, numbers, dot, underscore, and dash; no spaces or paths`);
  }
  return name;
}

function requireBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === true || value === false) return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  throw new Error(`${field} must be a boolean`);
}

function parseCsv(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a comma-separated string`);
  const normalized = value.trim();
  if (!normalized || normalized === "none") return [];
  return normalized.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseValidators(
  value: unknown,
  field: string,
): readonly { agentId: string; criteria: readonly string[] }[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be a YAML array`);
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`${field}[${index}] must be an object`);
    const agentId = requireSafeName(item.agentId, `${field}[${index}].agentId`);
    if (!Array.isArray(item.criteria) || item.criteria.length === 0) {
      throw new Error(`${field}[${index}].criteria must be a non-empty string array`);
    }
    const criteria = item.criteria.map((criterion, criterionIndex) =>
      requireString(criterion, `${field}[${index}].criteria[${criterionIndex}]`, { maxLength: 2_000 }).trim(),
    );
    return { agentId, criteria };
  });
}

function parseDefinition(
  content: unknown,
  field: string,
): { value: string; frontmatter: Record<string, unknown>; body: string } {
  const value = requireString(content, field);
  if (!value.trimStart().startsWith("---")) throw new Error(`${field} must start with YAML frontmatter`);

  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter<Record<string, unknown>>(value);
  } catch (error) {
    throw new Error(`${field} has invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isRecord(parsed.frontmatter)) throw new Error(`${field} frontmatter must be a YAML mapping`);
  if (!parsed.body.trim()) throw new Error(`${field} must contain an instruction body after frontmatter`);
  return {
    value: value.endsWith("\n") ? value : `${value}\n`,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
  };
}

function validateAgentFrontmatter(frontmatter: Record<string, unknown>, field: string): AgentDefinitionInspection {
  for (const key of Object.keys(frontmatter)) {
    if (!AGENT_FIELDS.has(key)) throw new Error(`${field} contains unsupported frontmatter field "${key}"`);
  }

  requireString(frontmatter.description, `${field}.description`, { maxLength: 100_000 });
  if (frontmatter.display_name !== undefined) requireString(frontmatter.display_name, `${field}.display_name`, { maxLength: 100 });
  if (frontmatter.model !== undefined) requireString(frontmatter.model, `${field}.model`, { maxLength: 200 });
  if (frontmatter.version !== undefined) requireString(frontmatter.version, `${field}.version`, { maxLength: 100 });

  const tools = parseCsv(frontmatter.tools, `${field}.tools`);
  if (tools) {
    const knownTools = new Set(BUILTIN_TOOL_NAMES);
    const unknown = tools.filter((tool) => !knownTools.has(tool));
    if (unknown.length > 0) throw new Error(`${field}.tools contains unknown built-in tool(s): ${unknown.join(", ")}`);
  }
  const disallowedTools = parseCsv(frontmatter.disallowed_tools, `${field}.disallowed_tools`) ?? [];

  for (const key of ["extensions", "skills"] as const) {
    const value = frontmatter[key];
    if (value !== undefined && typeof value !== "boolean" && typeof value !== "string") {
      throw new Error(`${field}.${key} must be a boolean or comma-separated string`);
    }
  }

  if (frontmatter.thinking !== undefined) {
    const thinking = requireString(frontmatter.thinking, `${field}.thinking`, { maxLength: 20 }).trim();
    if (!THINKING_LEVELS.has(thinking)) throw new Error(`${field}.thinking is not supported`);
  }
  if (frontmatter.max_turns !== undefined) {
    if (!Number.isInteger(frontmatter.max_turns) || (frontmatter.max_turns as number) < 0) {
      throw new Error(`${field}.max_turns must be a non-negative integer`);
    }
  }
  if (frontmatter.prompt_mode !== undefined && frontmatter.prompt_mode !== "replace" && frontmatter.prompt_mode !== "append") {
    throw new Error(`${field}.prompt_mode must be replace or append`);
  }
  if (frontmatter.memory !== undefined && !["user", "project", "local"].includes(String(frontmatter.memory))) {
    throw new Error(`${field}.memory must be user, project, or local`);
  }
  if (frontmatter.isolation !== undefined && frontmatter.isolation !== "worktree") {
    throw new Error(`${field}.isolation must be worktree`);
  }
  if (
    frontmatter.prompt_compression !== undefined
    && !["minimal", "balanced", "aggressive"].includes(String(frontmatter.prompt_compression))
  ) {
    throw new Error(`${field}.prompt_compression must be minimal, balanced, or aggressive`);
  }

  const inheritContext = requireBoolean(frontmatter.inherit_context, `${field}.inherit_context`);
  const runInBackground = requireBoolean(frontmatter.run_in_background, `${field}.run_in_background`);
  const isolated = requireBoolean(frontmatter.isolated, `${field}.isolated`);
  const handoff = requireBoolean(frontmatter.handoff, `${field}.handoff`) ?? false;
  const enabled = requireBoolean(frontmatter.enabled, `${field}.enabled`);
  const template = requireBoolean(frontmatter.template, `${field}.template`);
  void inheritContext;
  void runInBackground;
  void enabled;
  void template;

  return {
    frontmatter,
    tools,
    disallowedTools,
    extensions: frontmatter.extensions as boolean | string | undefined,
    isolated,
    isolation: frontmatter.isolation === "worktree" ? "worktree" : undefined,
    handoff,
    validators: parseValidators(frontmatter.validators, `${field}.validators`),
  };
}

function requireAgentDefinitionFile(content: unknown, field: string): string {
  const parsed = parseDefinition(content, field);
  validateAgentFrontmatter(parsed.frontmatter, `${field}.frontmatter`);
  return parsed.value;
}

function requireSkillDefinitionFile(content: unknown, expectedName: string, field: string): string {
  const parsed = parseDefinition(content, field);
  const name = requireSafeName(parsed.frontmatter.name, `${field}.frontmatter.name`);
  if (name !== expectedName) throw new Error(`${field} skill name must equal "${expectedName}"`);
  requireString(parsed.frontmatter.description, `${field}.frontmatter.description`, { maxLength: 10_000 });
  return parsed.value;
}

export function inspectAgentDefinition(content: string, field = "agent"): AgentDefinitionInspection {
  const parsed = parseDefinition(content, field);
  return validateAgentFrontmatter(parsed.frontmatter, `${field}.frontmatter`);
}

/** Remove terminal control characters (including DEL/backspace leakage) and validate the filename. */
export function normalizeWizardName(raw: string): string {
  return requireSafeName(raw.replace(/[\u0000-\u001f\u007f]/g, "").trim(), "Agent name");
}

function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Architect returned an empty response");
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Architect response did not contain a JSON object");
  return unfenced.slice(start, end + 1);
}

function parseSchedule(value: unknown, requestedName: string): ScheduleBlueprint | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error("schedule must be an object or null");

  const result: ScheduleBlueprint = {
    name: value.name === undefined ? `${requestedName}-schedule` : requireSafeName(value.name, "schedule.name"),
    description: value.description === undefined
      ? `Scheduled execution for ${requestedName}`
      : requireString(value.description, "schedule.description", { maxLength: 500 }).trim(),
    schedule: requireString(value.schedule, "schedule.schedule", { maxLength: 200 }).trim(),
    prompt: requireString(value.prompt, "schedule.prompt", { maxLength: 50_000 }),
  };

  if (value.model !== undefined) result.model = requireString(value.model, "schedule.model", { maxLength: 200 }).trim();
  if (value.thinking !== undefined) {
    const thinking = requireString(value.thinking, "schedule.thinking", { maxLength: 20 }).trim();
    if (!THINKING_LEVELS.has(thinking)) throw new Error("schedule.thinking is not supported");
    result.thinking = thinking as ThinkingLevel;
  }
  if (value.max_turns !== undefined) {
    if (!Number.isInteger(value.max_turns) || (value.max_turns as number) < 0) {
      throw new Error("schedule.max_turns must be a non-negative integer");
    }
    result.max_turns = value.max_turns as number;
  }
  if (value.isolated !== undefined) result.isolated = requireBoolean(value.isolated, "schedule.isolated");
  if (value.isolation !== undefined) {
    if (value.isolation !== "worktree") throw new Error('schedule.isolation must be "worktree"');
    result.isolation = "worktree";
  }
  return result;
}

export function parseAgentSystemBlueprint(raw: string, requestedName: string): AgentSystemBlueprint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonPayload(raw));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Architect")) throw error;
    throw new Error(`Architect returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isRecord(parsed)) throw new Error("Blueprint root must be a JSON object");
  if (!Array.isArray(parsed.agents) || parsed.agents.length === 0) {
    throw new Error("Blueprint must contain at least one agent");
  }
  if (parsed.agents.length > MAX_AGENT_FILES) throw new Error(`Blueprint may contain at most ${MAX_AGENT_FILES} agents`);

  const seenAgents = new Set<string>();
  const agents: AgentBlueprintFile[] = parsed.agents.map((item, index) => {
    if (!isRecord(item)) throw new Error(`agents[${index}] must be an object`);
    const name = requireSafeName(item.name, `agents[${index}].name`);
    if (seenAgents.has(name)) throw new Error(`Duplicate agent name: ${name}`);
    seenAgents.add(name);
    return {
      name,
      content: requireAgentDefinitionFile(item.content, `agents[${index}].content`),
      primary: item.primary === true,
    };
  });

  const requested = agents.find((agent) => agent.name === requestedName);
  if (!requested) throw new Error(`Blueprint must contain the requested primary agent "${requestedName}"`);
  const markedPrimary = agents.filter((agent) => agent.primary);
  if (markedPrimary.length === 0) requested.primary = true;
  else if (markedPrimary.length !== 1 || markedPrimary[0].name !== requestedName) {
    throw new Error(`"${requestedName}" must be the only primary agent`);
  }
  if (agents[0].name !== requestedName) throw new Error(`"${requestedName}" must be first in agents execution order`);

  for (const agent of agents) {
    const inspection = inspectAgentDefinition(agent.content, `agent ${agent.name}`);
    for (const validator of inspection.validators) {
      if (validator.agentId === agent.name) throw new Error(`Agent "${agent.name}" cannot validate itself`);
      if (!seenAgents.has(validator.agentId)) {
        throw new Error(`Agent "${agent.name}" references unknown validator agent "${validator.agentId}"`);
      }
    }
  }

  const rawSkills = parsed.skills ?? [];
  if (!Array.isArray(rawSkills)) throw new Error("skills must be an array");
  if (rawSkills.length > MAX_SKILL_FILES) throw new Error(`Blueprint may contain at most ${MAX_SKILL_FILES} skills`);
  const seenSkills = new Set<string>();
  const skills: SkillBlueprintFile[] = rawSkills.map((item, index) => {
    if (!isRecord(item)) throw new Error(`skills[${index}] must be an object`);
    const name = requireSafeName(item.name, `skills[${index}].name`);
    if (seenSkills.has(name)) throw new Error(`Duplicate skill name: ${name}`);
    seenSkills.add(name);
    return {
      name,
      content: requireSkillDefinitionFile(item.content, name, `skills[${index}].content`),
    };
  });

  const warnings = parsed.warnings === undefined
    ? []
    : Array.isArray(parsed.warnings)
      ? parsed.warnings
        .filter((warning): warning is string => typeof warning === "string")
        .map((warning) => warning.trim())
        .filter(Boolean)
        .slice(0, 20)
      : (() => { throw new Error("warnings must be an array of strings"); })();

  return {
    summary: parsed.summary === undefined
      ? `Generated ${agents.length} agent(s) and ${skills.length} skill(s)`
      : requireString(parsed.summary, "summary", { maxLength: 2_000 }).trim(),
    warnings,
    agents,
    skills,
    schedule: parseSchedule(parsed.schedule, requestedName),
  };
}

export function validateBlueprintForSelections(
  blueprint: AgentSystemBlueprint,
  selection: BlueprintSelectionContext,
): string | undefined {
  if (selection.architecture === "single" && blueprint.agents.length !== 1) {
    return "Single-agent mode must produce exactly one agent.";
  }
  if (selection.architecture === "skill" && blueprint.skills.length === 0) {
    return "Agent + skills mode must produce at least one skill.";
  }
  if (selection.architecture === "chain") {
    if (blueprint.agents.length < 2) return "Handoff-chain mode must produce at least two agents.";
    const missingHandoff = blueprint.agents
      .slice(0, -1)
      .find((agent) => !inspectAgentDefinition(agent.content, agent.name).handoff);
    if (missingHandoff) return `Chain stage "${missingHandoff.name}" must set handoff: true.`;
  }
  if (selection.architecture === "loop") {
    const primary = blueprint.agents.find((agent) => agent.primary);
    if (!primary || inspectAgentDefinition(primary.content, primary.name).validators.length === 0) {
      return "Agentic-loop mode requires adversarial validators on the primary agent.";
    }
  }
  if (selection.skillPolicy === "always" && blueprint.skills.length === 0) {
    return "The selected skill policy requires at least one generated skill.";
  }
  if (selection.skillPolicy === "never" && blueprint.skills.length > 0) {
    return "The selected skill policy forbids generated skills.";
  }

  const { scheduleRequest } = selection;
  if (scheduleRequest.mode === "none" && blueprint.schedule) {
    return "On-demand activation forbids a generated schedule.";
  }
  if ((scheduleRequest.mode === "required" || scheduleRequest.mode === "exact") && !blueprint.schedule) {
    return "The selected activation mode requires a schedule.";
  }
  if (
    scheduleRequest.mode === "exact"
    && blueprint.schedule?.schedule !== scheduleRequest.expectedExpression?.trim()
  ) {
    return `Generated schedule must exactly match "${scheduleRequest.expectedExpression}".`;
  }
  if (selection.architecture === "scheduled" && !blueprint.schedule) {
    return "Scheduled-agent mode must produce a schedule.";
  }

  if (selection.autonomy === "read-only") {
    for (const agent of blueprint.agents) {
      const inspection = inspectAgentDefinition(agent.content, agent.name);
      if (!inspection.tools) return `Read-only agent "${agent.name}" must declare an explicit tools allowlist.`;
      if (inspection.tools.includes("edit") || inspection.tools.includes("write")) {
        return `Read-only agent "${agent.name}" may not grant edit or write.`;
      }
      if (!inspection.disallowedTools.includes("edit") || !inspection.disallowedTools.includes("write")) {
        return `Read-only agent "${agent.name}" must explicitly disallow edit and write.`;
      }
      if (inspection.extensions !== false) {
        return `Read-only agent "${agent.name}" must set extensions: false.`;
      }
      if (inspection.isolated !== true) {
        return `Read-only agent "${agent.name}" must set isolated: true.`;
      }
    }
    if (blueprint.schedule && blueprint.schedule.isolated !== true) {
      return "A schedule for a read-only system must set isolated: true.";
    }
  }

  return undefined;
}

const ARCHITECTURE_GUIDANCE: Record<AgentArchitectureMode, string> = {
  auto: "Choose the smallest architecture that fully satisfies the goal. Add supporting agents, skills, validation, or scheduling only when operationally justified.",
  single: "Create one specialist agent. Do not create companion agents.",
  skill: "Create one primary agent plus one or more reusable Agent Skills.",
  chain: "Create a bounded multi-agent handoff chain. Every non-final stage must set handoff: true and define explicit inputs, outputs, stop conditions, and failure behavior.",
  loop: "Create a closed self-validating agentic loop. The primary must declare adversarial validators, bounded retries, success criteria, and failure escalation.",
  scheduled: "Create an agent intended for autonomous timed execution and include a concrete schedule object.",
  full: "Create a production-grade autonomous system with only necessary agents, reusable skills, validators, handoffs, worktree isolation for writes, and scheduling when required.",
};

const AUTONOMY_GUIDANCE: Record<AgentAutonomyProfile, string> = {
  safe: "Use least privilege. Prefer read-only tools and isolated extensions unless writes or external tools are essential.",
  "read-only": "Every agent must use an explicit read-only tools allowlist, disallowed_tools: write, edit, extensions: false, and isolated: true. Any schedule must also set isolated: true.",
  implementation: "Implementation agents may use read, bash, grep, edit, write. Use worktree isolation for mutation and add a read-only reviewer when useful.",
  full: "Allow autonomous implementation, validation, and handoff while keeping hard budgets, bounded retries, and worktree isolation for code changes.",
};

const SKILL_GUIDANCE: Record<SkillGenerationPolicy, string> = {
  auto: "Create skills only for stable, reusable procedures or domain knowledge shared across agents.",
  always: "Create at least one reusable skill and preload it explicitly from the relevant agent frontmatter.",
  never: "Do not create skill files. Keep all required behavior in agent definitions.",
};

export function buildAgentSystemPrompt(input: GenerationPromptInput): string {
  return `You are the agent-system architect for @groeponline/pi-agent-orchestrator.

Design a complete executable custom-agent system.

REQUESTED PRIMARY AGENT NAME: ${input.requestedName}
USER GOAL:
${input.description}

ARCHITECTURE MODE:
${ARCHITECTURE_GUIDANCE[input.architecture]}

AUTONOMY PROFILE:
${AUTONOMY_GUIDANCE[input.autonomy]}

SKILL POLICY:
${SKILL_GUIDANCE[input.skillPolicy]}

ACTIVATION REQUIREMENT:
${input.scheduleRequest.hint}

TARGETS:
- Agent definitions: ${input.targetAgentDir}/<name>.md
- Skills: ${input.targetSkillDir}/<name>/SKILL.md
- You may inspect existing agents and skills with read, grep, and read-only bash.
- You must NOT call write/edit or create files yourself.

SUPPORTED AGENT FRONTMATTER:
- display_name, description, tools, disallowed_tools, extensions, skills, model
- thinking: off|minimal|low|medium|high|xhigh|max
- max_turns, prompt_mode: replace|append, inherit_context, run_in_background
- isolated, memory: user|project|local, isolation: worktree, handoff
- prompt_compression: minimal|balanced|aggressive, validators, enabled

RUNTIME RULES:
1. The first agent and only primary must be exactly "${input.requestedName}".
2. Use only supported frontmatter. Scheduling belongs only in the separate schedule object.
3. Reuse existing skills when appropriate; do not generate duplicates.
4. Every definition must contain parseable YAML frontmatter plus a substantial body.
5. Write-capable agents use isolation: worktree unless the goal explicitly requires the live checkout.
6. Obey the autonomy profile literally; host validation rejects broader permissions.
7. Chains and loops are bounded. No recursive self-spawn without a hard depth/task budget.
8. The agents array is execution order. The wizard runs explicit chains in that order.
9. Non-final chain stages set handoff: true and emit a concrete structured handoff.
10. Loop primaries declare adversarial validators and never validate themselves.
11. Scheduled prompts are self-contained. A schedule launches only the primary agent.
12. Use 1-3 agents where possible; maximum 6 agents and 8 skills.
13. Return strict JSON only: no markdown fence, commentary, or trailing text.

JSON SCHEMA:
{
  "summary": "short architecture summary",
  "warnings": ["real operational caveats only"],
  "agents": [
    {
      "name": "${input.requestedName}",
      "primary": true,
      "content": "---\\ndescription: ...\\ntools: ...\\nprompt_mode: replace\\n---\\n\\nComplete system prompt..."
    }
  ],
  "skills": [
    {
      "name": "safe-skill-name",
      "content": "---\\nname: safe-skill-name\\ndescription: ...\\n---\\n\\nComplete reusable skill instructions..."
    }
  ],
  "schedule": null
}

When scheduling is required, replace schedule:null with:
{
  "name": "${input.requestedName}-schedule",
  "description": "one line",
  "schedule": "cron, interval, +duration, or ISO timestamp exactly as requested",
  "prompt": "self-contained execution prompt",
  "model": "optional provider/modelId",
  "thinking": "optional level",
  "max_turns": 20,
  "isolated": true,
  "isolation": "worktree"
}`;
}
