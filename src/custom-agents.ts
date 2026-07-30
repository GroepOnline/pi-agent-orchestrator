/**
 * custom-agents.ts — Load user-defined agents from project (.pi/agents/) and global ($PI_CODING_AGENT_DIR/agents/, default ~/.pi/agent/agents/) locations.
 */

import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES, getDefaultAgentNames } from "./agent-types.js";
import { emitTelemetry, hashContentSync } from "./telemetry.js";
import { type AgentConfig, type MemoryScope, type PromptCompressionLevel, parseThinkingLevel, } from "./types.js";

// CVE-002 FIX: Validation patterns for agent configs
const UNSAFE_NAME_PATTERN = /[/\\]|\.\.|[\x00-\x1F]/;
const MAX_NAME_LENGTH = 100;


function truncateUnicode(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  let count = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) i++;
    count++;
    if (count >= maxLength) return str.slice(0, i + 1);
  }
  return str;
}



const MAX_PROMPT_LENGTH = 100000;  // 100KB
const MAX_TOOLS_COUNT = 100;
/**
 * Validate an agent config for security issues.
 * Returns array of error messages (empty if valid).
 * 
 * Security model: allowlist approach — only embedded defaults and .md files from
 * .pi/agents/ are trusted sources. No regex blacklist for prompt injection
 * (trivially bypassed with Unicode, base64, whitespace variations).
 */
function validateAgentConfig(name: string, config: Partial<AgentConfig>): string[] {
  const errors: string[] = [];
  // Validate name
  if (!name || typeof name !== 'string') {
    errors.push('Agent name is required');
  } else if (name.length > MAX_NAME_LENGTH) {
    errors.push(`Agent name exceeds maximum length of ${MAX_NAME_LENGTH} characters`);
} else if (UNSAFE_NAME_PATTERN.test(name)) errors.push(`Agent name contains unsafe characters: ${name}`);
  // Prevent overriding built-in agents with wildcard tools
  const builtinNames = new Set(getDefaultAgentNames());
  if (builtinNames.has(name) && config.builtinToolNames?.includes('*')) {
    errors.push(`Cannot override built-in agent "${name}" with wildcard (*) tools`);
  }
  // Validate system prompt length only (no injection pattern check)
  if (config.systemPrompt && config.systemPrompt.length > MAX_PROMPT_LENGTH) {
    errors.push(`System prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters`);
  }
  // Validate description length
  if (config.description && config.description.length > MAX_PROMPT_LENGTH) {
    errors.push(`Description exceeds maximum length of ${MAX_PROMPT_LENGTH} characters`);
  }
  // Validate display name length
  if (config.displayName && config.displayName.length > MAX_NAME_LENGTH) {
    errors.push(`Display name exceeds maximum length of ${MAX_NAME_LENGTH} characters`);
  }
  // Validate tool names
  if (config.builtinToolNames) {
    if (config.builtinToolNames.length > MAX_TOOLS_COUNT) {
      errors.push(`Too many tools specified (max ${MAX_TOOLS_COUNT})`);
    }
    const hasLongTool = config.builtinToolNames.some(t => t.length > MAX_NAME_LENGTH);
    if (hasLongTool) {
      errors.push(`Tool name exceeds maximum length of ${MAX_NAME_LENGTH} characters`);
    }
    // CVE-011 FIX: Emit telemetry for unknown tool names (don't block, just log)
    const knownTools = new Set([...BUILTIN_TOOL_NAMES, '*']);
    const unknownTools = config.builtinToolNames.filter(t => !knownTools.has(t));
    if (unknownTools.length > 0) {
      // Redact potentially sensitive tool names to prevent logging secrets
      // We limit to 50 characters to prevent DOS, and use a safe substring approach
      const sanitizedTools = unknownTools.map(t =>
        typeof t === 'string' ? (t.length > 50 ? `${truncateUnicode(t, 50)}...` : t) : '[INVALID_TYPE]'
      );
      const safeName = typeof name === 'string' ? truncateUnicode(name, MAX_NAME_LENGTH) : String(name);
      emitTelemetry("agent:unknown-tools", { name: safeName, tools: sanitizedTools });
    }
  }
  if (config.disallowedTools) {
    if (config.disallowedTools.length > MAX_TOOLS_COUNT) {
      errors.push(`Too many disallowed tools specified (max ${MAX_TOOLS_COUNT})`);
    }
    const hasLongDisallowedTool = config.disallowedTools.some(t => t.length > MAX_NAME_LENGTH);
    if (hasLongDisallowedTool) {
      errors.push(`Disallowed tool name exceeds maximum length of ${MAX_NAME_LENGTH} characters`);
    }
  }
  return errors;
}
/**
 * Scan for custom agent .md files from multiple locations.
 *
 * Discovery hierarchy (higher priority wins):
 *   1. Project: `<cwd>/.pi/agents/*.md`
 *   2. Global:  `$PI_CODING_AGENT_DIR/agents/*.md` (default: `~/.pi/agent/agents/*.md`)
 *
 * Project-level agents override global ones with the same name.
 * Any name is allowed — names matching defaults (e.g. "Explore") override them.
 *
 * Security: symlinks are skipped to prevent directory traversal.
 *
 * @param cwd - Current working directory (project root) for agent discovery
 * @returns Map of agent name → parsed {@link AgentConfig}
 */
export async function loadCustomAgents(cwd: string): Promise<Map<string, AgentConfig>> {
  const globalDir = join(getAgentDir(), "agents");
  const projectDir = join(cwd, ".pi", "agents");
  const agents = new Map<string, AgentConfig>();
  await loadFromDir(globalDir, agents, "global");   // lower priority
  await loadFromDir(projectDir, agents, "project");  // higher priority (overwrites)
  return agents;
}
/** Load agent configs from a directory into the map. */
async function loadFromDir(dir: string, agents: Map<string, AgentConfig>, source: "project" | "global"): Promise<void> {
  if (!existsSync(dir)) return;
  let files: string[];
  try {
    const dirents = readdirSync(dir, { withFileTypes: true });
    files = dirents
      .filter(f => !f.isDirectory() && !f.isSymbolicLink() && f.name.endsWith(".md"))
      .map(f => f.name);
  } catch {
    return;
  }
  const fileContents = await Promise.all(files.map(async (file) => {
    try {
      return { file, content: await readFile(join(dir, file), "utf-8") };
    } catch {
      return null;
    }
  }));

  for (const result of fileContents) {
    if (!result) continue;
    const { file, content } = result;
    const name = basename(file, ".md");
    const { frontmatter: fm, body } = parseFrontmatter<Record<string, unknown>>(content);
    const config: AgentConfig = {
      name,
      displayName: parseString(fm.display_name),
      description: parseString(fm.description) ?? name,
      builtinToolNames: parseCsvList(fm.tools, BUILTIN_TOOL_NAMES),
      disallowedTools: parseCsvListOptional(fm.disallowed_tools),
      extensions: parseInheritField(fm.extensions ?? fm.inherit_extensions),
      skills: parseInheritField(fm.skills ?? fm.inherit_skills),
      model: parseString(fm.model),
      thinking: parseThinkingLevel(parseString(fm.thinking)),
      maxTurns: parseNonNegativeInt(fm.max_turns),
      systemPrompt: body.trim(),
      promptMode: fm.prompt_mode === "append" ? "append" : "replace",
      inheritContext: parseBooleanOptional(fm.inherit_context),
      runInBackground: parseBooleanOptional(fm.run_in_background),
      isolated: parseBooleanOptional(fm.isolated),
      memory: parseMemory(fm.memory),
      isolation: fm.isolation === "worktree" ? "worktree" : undefined,
      handoff: parseBooleanWithDefault(fm.handoff, false),
      promptCompressionLevel: parseCompressionLevel(fm.prompt_compression),
      validators: parseValidators(fm.validators),
      enabled: parseBooleanWithDefault(fm.enabled, true),
      version: parseString(fm.version),
      template: parseBooleanWithDefault(fm.template, false),
      source,
    };
    // CVE-002 FIX: Validate agent config before adding
    const validationErrors = validateAgentConfig(name, config);
    if (validationErrors.length > 0) {
      const safeName = typeof name === 'string' ? truncateUnicode(name, MAX_NAME_LENGTH) : String(name);
      // Redact sensitive payload content from error messages
      // We log the type of error, but redact any appended untrusted data
      const redactedErrors = validationErrors.map(e => {
        // Strip out the user data which is typically appended after a colon
        const colonIndex = e.indexOf(': ');
        if (colonIndex !== -1) {
          return `${e.substring(0, colonIndex)}: [REDACTED]`;
        }
        return e;
      });
      emitTelemetry("agent:validation-failed", { name: safeName, errors: redactedErrors });
      // Disable agent with validation errors (don't skip entirely - let user see it)
      config.enabled = false;
    }

    // Emit telemetry for every loaded agent with content hash
    const contentHash = hashContentSync(content);
    const safeNameLoaded = typeof name === 'string' ? truncateUnicode(name, MAX_NAME_LENGTH) : String(name);
    emitTelemetry("agent:loaded", { 
      name: safeNameLoaded,
      source, 
      hash: contentHash, 
      enabled: config.enabled ?? true 
    });

    agents.set(name, config);
  }
}

// ---- Field Parsers ----

/**
 * Parse a boolean from frontmatter that may be a native boolean OR a string.
 * Returns `undefined` for "no value" (null / undefined / empty string).
 * Returns the parsed boolean for: `true`, `false`, `"true"`, `"false"` (case-insensitive).
 * Throws on any other input (numbers, unrecognized strings, objects) —
 * YAML schema must be one of the accepted forms, otherwise it's a parse error
 * that the user should see at load time, not a silent fallback.
 */
export function parseBooleanOptional(val: unknown): boolean | undefined {
  if (val === undefined || val === null || val === "") return undefined;
  if (val === true) return true;
  if (val === false) return false;
  if (typeof val === "string") {
    const lower = val.toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  throw new Error(
    `Invalid boolean value for frontmatter field: ${JSON.stringify(val)}. Expected boolean or "true"/"false" string.`,
  );
}

/**
 * Parse a boolean with an explicit default for missing values.
 * null / undefined / empty string → defaultValue.
 * Throws on any other unparsable input (numbers, unrecognized strings, objects).
 */
export function parseBooleanWithDefault(val: unknown, defaultValue: boolean): boolean {
  return parseBooleanOptional(val) ?? defaultValue;
}

/**
 * Parse a CSV field value from frontmatter.
 */
function parseCsvField(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  const s = String(val).trim();
  if (!s || s === "none") return undefined;
  const items = s.split(",").map(t => t.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function parseString(val: unknown): string | undefined {
  return typeof val === "string" ? val : undefined;
}

function parseNonNegativeInt(val: unknown): number | undefined {
  return typeof val === "number" && val >= 0 ? val : undefined;
}

function parseCsvList(val: unknown, defaults: string[]): string[] {
  if (val === undefined || val === null) return defaults;
  return parseCsvField(val) ?? [];
}

function parseCsvListOptional(val: unknown): string[] | undefined {
  return parseCsvField(val);
}

function parseMemory(val: unknown): MemoryScope | undefined {
  return (val === "user" || val === "project" || val === "local") ? val : undefined;
}

/**
 * Parse the `validators` frontmatter field. Returns an array of
 * `{ agentId, criteria }` objects, or `undefined` if the input is missing,
 * empty, or malformed.
 *
 * **Strict-reject policy:** if *any* item in the array is malformed (non-object,
 * non-string agentId, empty agentId, non-array criteria, or empty criteria
 * after filtering), the entire array is dropped. This is a conscious choice:
 * hand-edited YAML frontmatter is error-prone, and silently keeping partially
 * valid chains would hide misconfigurations from the user. Better to fail the
 * whole chain and let `validateAgentConfig` flag the agent as needing review.
 */
function parseValidators(
  val: unknown,
): readonly { agentId: string; criteria: readonly string[] }[] | undefined {
  if (val === undefined || val === null) return undefined;
  if (!Array.isArray(val)) return undefined;
  const result: { agentId: string; criteria: string[] }[] = [];
  for (const item of val) {
    if (typeof item !== "object" || item === null) return undefined;
    const obj = item as Record<string, unknown>;
    if (typeof obj.agentId !== "string" || obj.agentId === "") return undefined;
    if (!Array.isArray(obj.criteria)) return undefined;
    const criteria = obj.criteria.filter((c): c is string => typeof c === "string" && c.length > 0);
    if (criteria.length === 0) return undefined;
    result.push({ agentId: obj.agentId, criteria });
  }
  return result.length > 0 ? result : undefined;
}

function parseInheritField(val: unknown): true | string[] | false {
  if (val === undefined || val === null || val === true) return true;
  if (val === false || val === "none") return false;
  const items = parseCsvList(val, []);
  return items.length > 0 ? items : false;
}

const VALID_COMPRESSION_LEVELS = new Set(["minimal", "balanced", "aggressive"]);

function parseCompressionLevel(val: unknown): PromptCompressionLevel | undefined {
  if (typeof val === "string" && VALID_COMPRESSION_LEVELS.has(val)) return val as PromptCompressionLevel;
  return undefined;
}
