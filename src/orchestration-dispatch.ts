/**
 * orchestration-dispatch.ts — Heuristic auto / single / swarm / crew dispatch
 *
 * Decides how to fan out a fresh agent spawn:
 * - `single`  → spawn one agent (current behavior, default for most prompts)
 * - `swarm`   → spawn N agents with the same prompt in parallel (live strategy)
 * - `crew`    → spawn 3 role-specialized agents (planner, executor, reviewer) and
 *               join their results into one group
 * - `auto`    → run `analyzePrompt` + `heuristicPickMode` to pick a concrete mode
 *
 * Heuristic signals (cheap, keyword-based — not LLM-driven, no extra latency):
 * - planner keyword (e.g. "plan", "design")            → crew
 * - parallel keyword (e.g. "compare", "benchmark")     → swarm
 * - review keyword (e.g. "review", "audit")            → crew
 * - refactor + (test or multiple-files)                → crew
 * - implement + multiple-files                         → crew
 * - long prompt (> 800 chars) with implementation key  → crew
 * - otherwise                                          → single
 *
 * Note: multiple file paths alone do NOT trigger crew — they require an
 * accompanying implementation signal. Read-only prompts that mention
 * multiple files (e.g. "explore ./src/a.ts and ./src/b.ts") resolve to single.
 *
 * The dispatcher is pure (no I/O, no side effects) so it's cheap to unit-test
 * and safe to call inline from the Agent tool's execute path.
 */

import type { OrchestrationMode } from "./agent-registry.js";
import type { SubagentType } from "./types.js";

// ---- Decision types ----

export type OrchestrationKind = "single" | "swarm" | "crew";

export interface SwarmAgentPlan {
  /** Short (3-5 word) description shown in the UI. */
  description: string;
  /** Prompt for this swarm member. */
  prompt: string;
}

export type CrewRole = "planner" | "executor" | "reviewer";

export interface CrewRolePlan {
  role: CrewRole;
  description: string;
  prompt: string;
}

export type OrchestrationDecision =
  | { kind: "single" }
  | { kind: "swarm"; agents: SwarmAgentPlan[]; joinMode: "swarm" }
  | { kind: "crew"; roles: CrewRolePlan[]; joinMode: "group" };

// ---- Prompt analysis ----

export interface PromptAnalysis {
  /** Prompt length in characters. */
  length: number;
  /** Number of "step" or numbered list items detected (rough). */
  estimatedSteps: number;
  /** Detected file paths (rough absolute or relative path match). */
  hasMultipleFiles: boolean;
  /** True if prompt mentions reviewing/auditing/validating. */
  hasReviewKeyword: boolean;
  /** True if prompt mentions parallel/compare/benchmark. */
  hasParallelKeyword: boolean;
  /** True if prompt mentions planning/designing/architecting. */
  hasPlanKeyword: boolean;
  /** True if prompt mentions implementing/building/writing. */
  hasImplementKeyword: boolean;
  /** True if prompt mentions refactoring/restructuring. */
  hasRefactorKeyword: boolean;
  /** True if prompt mentions testing/test suite. */
  hasTestKeyword: boolean;
}

const REVIEW_KEYWORDS = [
  /\breview\b/i,
  /\baudit\b/i,
  /\bvalidate\b/i,
  /\bverif(?:y|ies)\b/i,
  /\binspect\b/i,
  /\bcritique\b/i,
];

const PARALLEL_KEYWORDS = [
  /\bcompar(?:e|ison|ing)\b/i,
  /\bbenchmark\b/i,
  /\bin\s+parallel\b/i,
  /\bparallel(?:ly)?\b/i,
  /\bsimultaneously\b/i,
  /\bat\s+the\s+same\s+time\b/i,
];

const PLAN_KEYWORDS = [
  /\bplan\b/i,
  /\bdesign\b/i,
  /\barchitecture\b/i,
  /\barchitecting\b/i,
  /\barchitect\b/i,
  /\bpropos(?:e|al)\b/i,
  /\boutlin(?:e|ing)\b/i,
];

const IMPLEMENT_KEYWORDS = [
  /\bimplement\b/i,
  /\bbuild\b/i,
  /\bcreate\b/i,
  /\bwrite\b/i,
  /\badd\b/i,
  /\bdevelo(?:p|ing)\b/i,
];

const REFACTOR_KEYWORDS = [
  /\brefactor\b/i,
  /\brestructur(?:e|ing)\b/i,
  /\breorgani[sz]e\b/i,
  /\bmigrat(?:e|ing|ion)\b/i,
];

const TEST_KEYWORDS = [
  /\btest(?:s|ing)?\b/i,
  /\bspec(?:s|ification)?\b/i,
  /\bcoverage\b/i,
];

/** Path-like: starts with `./` `/` `~/` or contains a `.ts`/`.js`/etc. extension segment. */
const PATH_PATTERN = /(?:^|\s)(?:\.{0,2}\/|~?\/|\.{1,2}\b)\S*\.\w{1,6}\b/g;

function anyMatches(prompt: string, patterns: RegExp[]): boolean {
  for (const p of patterns) {
    if (p.test(prompt)) return true;
  }
  return false;
}

/**
 * Score a prompt for orchestration signals. Pure / side-effect free.
 */
export function analyzePrompt(prompt: string): PromptAnalysis {
  const length = prompt.length;
  // Rough step count: numbered list items + lines starting with `-` or `*`.
  const numbered = (prompt.match(/(?:^|\n)\s*\d+[.)]\s/g) ?? []).length;
  const bulleted = (prompt.match(/(?:^|\n)\s*[-*]\s/g) ?? []).length;
  const estimatedSteps = numbered + bulleted;
  // File paths — dedupe-ish via Set.
  const pathMatches = prompt.match(PATH_PATTERN) ?? [];
  const hasMultipleFiles = new Set(pathMatches).size >= 2;
  return {
    length,
    estimatedSteps,
    hasMultipleFiles,
    hasReviewKeyword: anyMatches(prompt, REVIEW_KEYWORDS),
    hasParallelKeyword: anyMatches(prompt, PARALLEL_KEYWORDS),
    hasPlanKeyword: anyMatches(prompt, PLAN_KEYWORDS),
    hasImplementKeyword: anyMatches(prompt, IMPLEMENT_KEYWORDS),
    hasRefactorKeyword: anyMatches(prompt, REFACTOR_KEYWORDS),
    hasTestKeyword: anyMatches(prompt, TEST_KEYWORDS),
  };
}

// ---- Heuristic mode selection ----

/**
 * Pick a concrete dispatch kind from a prompt analysis.
 *
 * Order of precedence (most specific signal wins):
 * 1. planner / review → crew (always)
 * 2. refactor + (test or multiple-files) → crew
 * 3. implement + multiple-files → crew (implementation across files)
 * 4. long + multi-step implementation → crew
 * 5. parallel keyword → swarm
 * 6. otherwise → single
 *
 * Note: `hasMultipleFiles` alone does NOT trigger crew — it requires an
 * accompanying implementation signal. Read-only prompts that mention
 * multiple files (e.g. "explore ./src/a.ts and ./src/b.ts") correctly
 * resolve to single.
 */
export function heuristicPickMode(a: PromptAnalysis): OrchestrationKind {
  // 1. Always crew: planning or review tasks
  if (a.hasPlanKeyword || a.hasReviewKeyword) {
    return "crew";
  }
  // 2. Crew: refactor + (test or multiple files)
  if (a.hasRefactorKeyword && (a.hasTestKeyword || a.hasMultipleFiles)) {
    return "crew";
  }
  // 3. Crew: implementation across multiple files
  if (a.hasImplementKeyword && a.hasMultipleFiles) {
    return "crew";
  }
  // 4. Crew: long + multi-step implementation (conservative threshold)
  //    (~800 chars ≈ 130–180 words of detail) to avoid triggering on
  //    intentionally short directives like "implement X".
  if (a.hasImplementKeyword && a.length > 800 && a.estimatedSteps >= 3) {
    return "crew";
  }
  // 5. Swarm: parallel/compare keywords (after crew checks to avoid misrouting)
  if (a.hasParallelKeyword) {
    return "swarm";
  }
  // 6. Otherwise: single agent
  return "single";
}

// ---- Plan builders ----

/** Fresh-install swarm size: two members keeps concurrent work in the 1–3 band. */
const SWARM_DEFAULT_SIZE = 2;

function shortLabel(s: string, max = 5): string {
  const words = s.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, max).join(" ");
}

/**
 * Build a swarm plan: N copies of the same prompt with distinct descriptions.
 * Defaults to 2 parallel members; capped at 5 to avoid runaway fan-out.
 */
export function buildSwarmPlan(prompt: string, description: string, n = SWARM_DEFAULT_SIZE): SwarmAgentPlan[] {
  const size = Math.max(2, Math.min(5, n));
  const label = shortLabel(description) || "Swarm member";
  const agents: SwarmAgentPlan[] = [];
  for (let i = 0; i < size; i++) {
    agents.push({
      description: `${label} (${i + 1}/${size})`,
      prompt,
    });
  }
  return agents;
}

/**
 * Build a 3-role crew plan from a single user prompt.
 *
 * - planner  → reads the request, drafts an implementation plan + files to touch
 * - executor → implements the plan end-to-end
 * - reviewer → audits the executor's output against the original request
 *
 * The user prompt is passed verbatim to the executor; the planner and reviewer
 * get role-specific framing that quotes the user request.
 */
export function buildCrewPlan(
  prompt: string,
  description: string,
  _subagentType: SubagentType,
): CrewRolePlan[] {
  const label = shortLabel(description) || "Crew task";
  return [
    {
      role: "planner",
      description: `${label} — plan`,
      prompt:
        `You are the PLANNER in a 3-agent crew. Read the user's request below and produce a concrete ` +
        `implementation plan. Do NOT edit any files — output only the plan.\n\n` +
        `## User request\n${prompt}\n\n` +
        `## Output format\n` +
        `1. Goal (1 sentence)\n` +
        `2. Files to touch (absolute paths)\n` +
        `3. Step-by-step plan (numbered, each step ≤ 1 sentence)\n` +
        `4. Acceptance criteria (bulleted, testable)\n` +
        `5. Risks / unknowns (bulleted)`,
    },
    {
      role: "executor",
      description: `${label} — execute`,
      prompt:
        `You are the EXECUTOR in a 3-agent crew. Implement the user's request end-to-end. ` +
        `A separate reviewer will audit your work after you finish — keep your changes minimal, ` +
        `well-named, and reversible.\n\n` +
        `## User request\n${prompt}`,
    },
    {
      role: "reviewer",
      description: `${label} — review`,
      prompt:
        `You are the REVIEWER in a 3-agent crew. The executor has just completed the user's request. ` +
        `Audit their work against the original request. Do NOT edit any files — output only the review.\n\n` +
        `## User request\n${prompt}\n\n` +
        `## Output format\n` +
        `1. Verdict: PASS or FAIL\n` +
        `2. What was done well (bulleted)\n` +
        `3. Issues found (bulleted, each with file:line where applicable)\n` +
        `4. Suggested fixes (numbered, ≤ 1 sentence each)`,
    },
  ];
}

// ---- Top-level resolver ----

export interface ResolveOpts {
  mode: OrchestrationMode;
  prompt: string;
  description: string;
  subagentType: SubagentType;
  /** When true, the orchestrator will run agents in the background. */
  runInBackground: boolean;
  /** Optional override for the swarm member count. */
  swarmSize?: number;
}

/**
 * Resolve the orchestrator mode for a fresh agent spawn.
 * Pure / synchronous — no I/O, no manager calls. The caller is responsible for
 * materializing the decision into actual `manager.spawn(...)` calls.
 */
export function resolveOrchestrationMode(opts: ResolveOpts): OrchestrationDecision {
  if (opts.mode === "single") return { kind: "single" };
  if (opts.mode === "swarm") {
    return {
      kind: "swarm",
      agents: buildSwarmPlan(opts.prompt, opts.description, opts.swarmSize),
      joinMode: "swarm",
    };
  }
  if (opts.mode === "crew") {
    return {
      kind: "crew",
      roles: buildCrewPlan(opts.prompt, opts.description, opts.subagentType),
      joinMode: "group",
    };
  }
  // mode === "auto"
  const analysis = analyzePrompt(opts.prompt);
  const picked = heuristicPickMode(analysis);
  if (picked === "swarm") {
    return {
      kind: "swarm",
      agents: buildSwarmPlan(opts.prompt, opts.description, opts.swarmSize),
      joinMode: "swarm",
    };
  }
  if (picked === "crew") {
    return {
      kind: "crew",
      roles: buildCrewPlan(opts.prompt, opts.description, opts.subagentType),
      joinMode: "group",
    };
  }
  return { kind: "single" };
}

// ---- Mid-fanout failure reporting (R5) ----

/**
 * Format the synchronous partial report returned to the Agent-tool caller
 * when a fan-out fails mid-spawn. Names the error, the spawned IDs, the
 * spawned/total count, and the missing count, so the caller learns about the
 * failure immediately — never only through later background notifications.
 */
export function formatMidFanoutFailureReport(opts: {
  error: unknown;
  spawnedIds: string[];
  totalMembers: number;
}): string {
  const message = opts.error instanceof Error ? opts.error.message : String(opts.error);
  const missing = Math.max(0, opts.totalMembers - opts.spawnedIds.length);
  const cancelNote = opts.spawnedIds.length > 0
    ? " Spawned agents are being cancelled and the group will finalize as partial."
    : "";
  return (
    `Orchestration dispatch failed mid-fanout: ${message}\n` +
    `Spawned ${opts.spawnedIds.length}/${opts.totalMembers} before failure: ${opts.spawnedIds.join(", ")}\n` +
    `Missing ${missing} member(s).${cancelNote}`
  );
}

/**
 * Label for a batch-group completion notification whose fan-out failed
 * mid-spawn: the surviving group finalizes with an explicit partial status
 * naming spawned/missing counts — never as an unqualified success while a
 * member is missing.
 */
export function formatPartialFinalizationLabel(
  finished: number,
  spawned: number,
  missing: number,
  noun = "agent(s)",
): string {
  return `${finished} ${noun} finished (partial — ${spawned} spawned, ${missing} missing: spawn failed mid-fanout)`;
}
