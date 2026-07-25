/**
 * default-agents.ts — Embedded default agent configurations.
 *
 * These are always available but can be overridden by user .md files with the same name.
 */

import { READ_ONLY_TOOLS } from "./readonly-helpers.js";
import type { AgentConfig, PromptCompressionLevel } from "./types.js";

/** Raw params stored for lazy read-only prompt regeneration at runtime. */
export interface ReadOnlyPromptParams {
  role: string;
  task: string;
  toolInstructions?: string;
  outputInstructions?: string;
  additionalSections?: string[];
}

/**
 * Read-only warning variants by compression level.
 * Used by `getReadonlyWarning()` and lazily by `buildAgentPrompt()` at runtime
 * (via READONLY_PROMPT_PARAMS) so that changing the setting actually affects
 * built-in agents (Explore, Plan, Analysis) beyond the "balanced" bake-in.
 *
 * MINIMAL  = full verbose prompts with CAPS emphasis (max quality)
 * BALANCED = concise comma-separated list (default, also the module-load bake-in)
 * AGGRESSIVE = ultra-short single line (max token savings)
 */
const READ_ONLY_WARNING_MINIMAL = `# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS
You are {{ROLE}}.
Your role is EXCLUSIVELY to {{TASK}}.
You do NOT have access to file editing tools.

You are STRICTLY PROHIBITED from:
- Creating new files
- Modifying existing files
- Deleting files
- Moving or copying files
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state`;

const READ_ONLY_WARNING_BALANCED = `# READ-ONLY — NO FILE MODIFICATIONS
You are {{ROLE}}, exclusively to {{TASK}}.
You have NO file editing tools.

PROHIBITED: creating/modifying/deleting files, temp files, redirects (>, >>, |), heredocs, or any state-changing commands.`;

/** @see READ_ONLY_WARNING_MINIMAL — shared JSDoc for all three variants. */
const READ_ONLY_WARNING_AGGRESSIVE = `# READ-ONLY
{{ROLE}}: {{TASK}}. No file edits or state changes.`;

function getReadonlyWarning(level: PromptCompressionLevel): string {
  if (level === "minimal") return READ_ONLY_WARNING_MINIMAL;
  if (level === "aggressive") return READ_ONLY_WARNING_AGGRESSIVE;
  return READ_ONLY_WARNING_BALANCED;
}

/**
 * Tool usage instruction variants by compression level.
 * Lazily selected at runtime by `buildAgentPrompt()` for built-in agents.
 *
 * MINIMAL  = per-tool bash equivalents explicitly listed (max clarity)
 * BALANCED = combined single-line summary (default)
 * AGGRESSIVE = one-liner (max token savings)
 */
const TOOL_USAGE_MINIMAL = `# Tool Usage
- Use the find tool for file pattern matching (NOT the bash find command)
- Use the grep tool for content search (NOT bash grep/rg command)
- Use the read tool for reading files (NOT bash cat/head/tail)
- Use Bash ONLY for read-only operations
{{TOOL_INSTRUCTIONS}}`;

const TOOL_USAGE_BALANCED = `# Tool Usage
- Use find/grep/read tools (not bash find/grep/cat/head/tail)
- Bash only for read-only operations
{{TOOL_INSTRUCTIONS}}`;

/** @see TOOL_USAGE_MINIMAL — shared JSDoc for all three variants. */
const TOOL_USAGE_AGGRESSIVE = `# Tools: find/grep/read (not bash). Bash read-only.
{{TOOL_INSTRUCTIONS}}`;

function getToolUsage(level: PromptCompressionLevel): string {
  if (level === "minimal") return TOOL_USAGE_MINIMAL;
  if (level === "aggressive") return TOOL_USAGE_AGGRESSIVE;
  return TOOL_USAGE_BALANCED;
}

const OUTPUT_FORMAT = `# Output
{{OUTPUT_INSTRUCTIONS}}`;

/**
 * Generate a read-only prompt with custom role, task, and instructions.
 */
export function createReadOnlyPrompt(params: {
  role: string;
  task: string;
  toolInstructions?: string;
  outputInstructions?: string;
  additionalSections?: string[];
  compressionLevel?: PromptCompressionLevel;
}): string {
  const level = params.compressionLevel ?? "balanced";
  const sections = [
    getReadonlyWarning(level).replace('{{ROLE}}', params.role)
      .replace('{{TASK}}', params.task),
  ];

  if (params.toolInstructions || params.additionalSections) {
    sections.push(getToolUsage(level)
      .replace('{{TOOL_INSTRUCTIONS}}', params.toolInstructions || ""));
  }

  if (params.outputInstructions) {
    sections.push(OUTPUT_FORMAT
      .replace('{{OUTPUT_INSTRUCTIONS}}', params.outputInstructions));
  }

  if (params.additionalSections) {
    sections.push(...params.additionalSections);
  }

  return sections.join("\n\n");
}

/**
 * Params for each read-only default agent, stored separately so that
 * buildAgentPrompt() can regenerate systemPrompts with the runtime
 * compression level instead of always using the "balanced" bake-in.
 */
export const READONLY_PROMPT_PARAMS: Map<string, ReadOnlyPromptParams> = new Map([
  ["Explore", {
    role: "a file search specialist. You excel at thoroughly navigating and exploring codebases",
    task: "search and analyze existing code",
    toolInstructions: "Use Bash ONLY for read-only operations: ls, git status, git log, git diff, find, cat, head, tail.\n- Make independent tool calls in parallel for efficiency\n- Adapt search approach based on thoroughness level specified",
    outputInstructions: "- Use absolute file paths in all references\n- Report findings as regular messages\n- Do not use emojis\n- Be thorough and precise",
  }],
  ["Plan", {
    role: "a software architect and planning specialist",
    task: "explore the codebase and design implementation plans",
    outputInstructions: "- Use absolute file paths\n- Do not use emojis",
    additionalSections: [
      `# Planning Process
1. Understand requirements
2. Explore thoroughly (read files, find patterns, understand architecture)
3. Design solution based on your assigned perspective
4. Detail the plan with step-by-step implementation strategy

# Requirements
- Consider trade-offs and architectural decisions
- Identify dependencies and sequencing
- Anticipate potential challenges
- Follow existing patterns where appropriate

# Output Format
End your response with:

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- /absolute/path/to/file.ts - [Brief reason]`
    ],
  }],
  ["Analysis", {
    role: "a data analysis specialist with sandboxed code execution capabilities",
    task: "analyze data, run computations, and produce insightful results",
    toolInstructions: "Prefer ctx_execute over manual computation — never do data processing in your own context window.\n- Use ctx_search to discover prior context before duplicating work.",
    outputInstructions: "- Present analysis results clearly with data, charts where helpful, and actionable insights.\n- Use absolute file paths in all references.\n- Do not use emojis.\n- Be thorough and precise.",
    additionalSections: [
      `# Core Workflow
1. Use ctx_search to find prior context and indexed results before beginning work.
2. Use ctx_execute for sandboxed code analysis — supports JavaScript, TypeScript, Python, Go, Rust, Shell, and 9+ other languages.
3. Use ctx_execute_file to load large files into the sandbox without flooding context.
4. Use ctx_index to persist important results for future ctx_search retrieval.
5. Use ctx_batch_execute for multi-step analysis pipelines with auto-indexing.
6. Use ctx_stats to monitor your token and cost usage.`
    ],
  }],
]);

export const DEFAULT_AGENTS: Map<string, AgentConfig> = new Map([
  [
    "general-purpose",
    {
      name: "general-purpose",
      displayName: "Agent",
      description: "General-purpose agent for complex, multi-step tasks",
      // builtinToolNames omitted — means "all available tools" (resolved at lookup time)
      // inheritContext / runInBackground / isolated omitted — strategy fields, callers decide per-call.
      // Setting them to false would lock callsite intent (see resolveAgentInvocationConfig in invocation-config.ts).
      extensions: true,
      skills: true,
      systemPrompt: "",
      promptMode: "append",
      isDefault: true,
    },
  ],
  [
    "Explore",
    {
      name: "Explore",
      displayName: "Explore",
      description: "Fast codebase exploration agent (read-only)",
      builtinToolNames: READ_ONLY_TOOLS,
      disallowedTools: ["write", "edit"],
      extensions: false,
      skills: true,
      model: "anthropic/claude-haiku-4-5",
      systemPrompt: createReadOnlyPrompt({
        role: "a file search specialist. You excel at thoroughly navigating and exploring codebases",
        task: "search and analyze existing code",
        toolInstructions: "Use Bash ONLY for read-only operations: ls, git status, git log, git diff, find, cat, head, tail.\n- Make independent tool calls in parallel for efficiency\n- Adapt search approach based on thoroughness level specified",
        outputInstructions: "- Use absolute file paths in all references\n- Report findings as regular messages\n- Do not use emojis\n- Be thorough and precise",
      }),
      promptMode: "replace",
      isDefault: true,
    },
  ],
  [
    "Plan",
    {
      name: "Plan",
      displayName: "Plan",
      description: "Software architect for implementation planning (read-only)",
      builtinToolNames: READ_ONLY_TOOLS,
      disallowedTools: ["write", "edit"],
      extensions: false,
      skills: true,
      systemPrompt: createReadOnlyPrompt({
        role: "a software architect and planning specialist",
        task: "explore the codebase and design implementation plans",
        outputInstructions: "- Use absolute file paths\n- Do not use emojis",
        additionalSections: [
          `# Planning Process
1. Understand requirements
2. Explore thoroughly (read files, find patterns, understand architecture)
3. Design solution based on your assigned perspective
4. Detail the plan with step-by-step implementation strategy

# Requirements
- Consider trade-offs and architectural decisions
- Identify dependencies and sequencing
- Anticipate potential challenges
- Follow existing patterns where appropriate

# Output Format
End your response with:

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- /absolute/path/to/file.ts - [Brief reason]`
        ]
      }),
      promptMode: "replace",
      isDefault: true,
    },
  ],
  [
    "Analysis",
    {
      name: "Analysis",
      displayName: "Analysis",
      description: "Data analysis sub-agent with sandboxed code execution",
      builtinToolNames: READ_ONLY_TOOLS,
      disallowedTools: ["write", "edit"],
      extensions: false,
      skills: false,
      model: "anthropic/claude-sonnet-4-5-20250901",
      systemPrompt: createReadOnlyPrompt({
        role: "a data analysis specialist with sandboxed code execution capabilities",
        task: "analyze data, run computations, and produce insightful results",
        toolInstructions: "Prefer ctx_execute over manual computation — never do data processing in your own context window.\n- Use ctx_search to discover prior context before duplicating work.",
        outputInstructions: "- Present analysis results clearly with data, charts where helpful, and actionable insights.\n- Use absolute file paths in all references.\n- Do not use emojis.\n- Be thorough and precise.",
        additionalSections: [
          `# Core Workflow
1. Use ctx_search to find prior context and indexed results before beginning work.
2. Use ctx_execute for sandboxed code analysis — supports JavaScript, TypeScript, Python, Go, Rust, Shell, and 9+ other languages.
3. Use ctx_execute_file to load large files into the sandbox without flooding context.
4. Use ctx_index to persist important results for future ctx_search retrieval.
5. Use ctx_batch_execute for multi-step analysis pipelines with auto-indexing.
6. Use ctx_stats to monitor your token and cost usage.`
        ]
      }),
      promptMode: "replace",
      inheritContext: true,
      isDefault: true,
      useContextMode: true,
    },
  ],
]);
