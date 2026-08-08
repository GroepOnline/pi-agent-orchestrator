/**
 * agent-types.ts — Unified agent type registry.
 *
 * Merges embedded default agents with user-defined agents from .pi/agents/*.md.
 * User agents override defaults with the same name. Disabled agents are kept but excluded from spawning.
 */

import { isContextModeAvailable } from "./context-mode-bridge.js";
// `CTX_TOOL_NAMES` is intentionally imported (and re-exported below) from its
// canonical home `./ctx-tool-names.ts` — NOT defined locally here. That breaks
// the historical agent-types.ts ↔ context-mode-bridge.ts circular import:
// the bridge no longer needs to import from this file, so the agent-types.ts
// dependency on `isContextModeAvailable` becomes one-way.
import { CTX_TOOL_NAMES as CTX_TOOL_NAMES_SRC } from "./ctx-tool-names.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import { getReadOnlyMemoryToolNames, READ_ONLY_TOOLS } from "./readonly-helpers.js";
import type { AgentConfig } from "./types.js";

/**
 * Resolve which tool names are allowed for given partitions.
 * Pure function — no side effects, same input = same output.
 *
 * - No membership configured → returns empty (feature disabled at boundary)
 * - Partitions specified → union of all tool names from matching partition memberships
 * - Partition name not in membership → contributes nothing (isolated)
 */
function resolvePartitionTools(
  membership: Record<string, readonly string[]> | undefined,
  partitions: readonly string[],
): string[] {
  // No membership configured → empty (no restriction — feature not enabled)
  if (!membership) return [];

  // Union of all tool names from matching partition memberships
  const tools = new Set<string>();
  for (const partition of partitions) {
    const partitionTools = membership[partition];
    if (partitionTools) {
      for (const tool of partitionTools) {
        tools.add(tool);
      }
    }
    // Else: partition name not in membership → contributes nothing (isolated)
  }

  return [...tools];
}

/**
 * Resolve which tools are allowed based on partition memberships.
 * Pure function — no side effects, same input = same output.
 *
 * - Early exit: no partitions → all of config's built-in tools (no filtering)
 * - Early exit: no partitionMembership on config → feature disabled, all tools
 * - Partitions specified → union of all tool names from matching partition memberships
 * - Empty partitionMembership ({}) → empty set = isolated
 */
export function filterByPartitions(config: AgentConfig, partitions?: readonly string[]): string[] {
  // Expand `*` in the agent's own tool list (audit A1). Partition membership
  // is already a concrete allowlist, so it is never re-expanded.
  const baseTools = normalizeBuiltinToolNames(config.builtinToolNames) ?? [...BUILTIN_TOOL_NAMES];

  // Early exit: no partitions → all tools (no filtering)
  if (!partitions || partitions.length === 0) {
    return baseTools;
  }

  // Early exit: no partition membership configured → feature disabled
  if (!config.partitionMembership) {
    return baseTools;
  }

  return resolvePartitionTools(config.partitionMembership, partitions);
}

/**
 * All known built-in tool names.
 *
 * Subset of the official opencode/pi tool list. `find` and `ls` were
 * removed in audit B8 — they are Claude Code carry-over, not real pi
 * tools, and would never be invoked successfully by this extension.
 */
export const BUILTIN_TOOL_NAMES: string[] = ["read", "bash", "edit", "write", "grep"];

/**
 * Minimal-safe tool allowlist for the general-purpose / unknown-type
 * fallback path (audit A2).
 *
 * Read-only — no file modifications, no extension or skills exposure.
 * Aliased from {@link READ_ONLY_TOOLS} for semantic clarity in the
 * fallback context, where the value is identical but the purpose differs
 * from the standard Explore/Plan/Analysis read-only toolset.
 */
const SAFE_FALLBACK_TOOL_NAMES: readonly string[] = READ_ONLY_TOOLS;

/**
 * Normalize a custom agent's `builtinToolNames` array.
 *
 * Agents may declare `"*"` to mean "all built-in tools" (audit A1). This helper
 * expands the wildcard to a copy of {@link BUILTIN_TOOL_NAMES}, preserving any
 * non-wildcard entries alongside it (deduplicated via Set). The caller's input
 * array is never mutated — a fresh array is always returned.
 *
 * Choice: normalization is applied at read-time in this module rather than at
 * load-time in {@link custom-agents.ts}. Reasons:
 *   1. The source AgentConfig keeps the user's literal request intact, which
 *      keeps frontmatter round-tripping honest and makes the wildcard a pure
 *      resolution-layer concern.
 *   2. There is one canonical expansion site, so adding a new built-in tool
 *      or changing wildcard semantics only requires editing this file.
 *   3. Default agents and absolute fallbacks use the bare `BUILTIN_TOOL_NAMES`
 *      constant directly, bypassing this function — no risk of double expansion.
 *
 * @param names - The raw `builtinToolNames` array from an AgentConfig
 * @returns A fresh, normalized array; `undefined` if the input was undefined
 */
export function normalizeBuiltinToolNames(names: readonly string[] | undefined): string[] | undefined {
  if (!names) return names;
  if (names.includes("*")) {
    // Wildcard expands to the full built-in list, unioned with any concrete
    // names so users can keep custom tools alongside `*` without losing them.
    const concrete = names.filter((n) => n !== "*");
    return [...new Set([...BUILTIN_TOOL_NAMES, ...concrete])];
  }
  // No wildcard — shallow clone so callers cannot mutate the source array.
  return [...names];
}

/**
 * Context-mode sandbox tool names from @groeponline/context-mode (optional dependency).
 *
 * Re-exported here from `./ctx-tool-names.ts` for back-compat — pre-existing
 * consumers (notably `test/e2e-chain.test.ts`) import `CTX_TOOL_NAMES` from
 * `./agent-types.js`. The canonical definition lives in `src/ctx-tool-names.ts`;
 * treat this export as a stable alias, not as the source of truth.
 */
export const CTX_TOOL_NAMES: readonly string[] = CTX_TOOL_NAMES_SRC;

/** Unified runtime registry of all agents (defaults + user-defined). */
const agents = new Map<string, AgentConfig>();

/**
 * Register default + user agents in the unified registry.
 *
 * Starts with {@link DEFAULT_AGENTS}, then overlays user agents. User agents with
 * the same name as a default override the default. Disabled agents (`enabled === false`)
 * are kept in the registry for UI listing but excluded from spawning.
 *
 * @param userAgents - Map of user-defined agent configs from {@link loadCustomAgents}
 */
export function registerAgents(userAgents: Map<string, AgentConfig>): void {
  agents.clear();

  // Start with defaults
  for (const [name, config] of DEFAULT_AGENTS) {
    agents.set(name, config);
  }

  // Overlay user agents (overrides defaults with same name)
  for (const [name, config] of userAgents) {
    agents.set(name, config);
  }
}

/** Case-insensitive key resolution. */
function resolveKey(name: string): string | undefined {
  if (agents.has(name)) return name;
  const lower = name.toLowerCase();
  for (const key of agents.keys()) {
    if (key.toLowerCase() === lower) return key;
  }
  return undefined;
}

/** Resolve a type name case-insensitively. Returns the canonical key or undefined. */
export function resolveType(name: string): string | undefined {
  return resolveKey(name);
}

/** Get the agent config for a type (case-insensitive). */
export function getAgentConfig(name: string): AgentConfig | undefined {
  const key = resolveKey(name);
  return key ? agents.get(key) : undefined;
}

/** Get all enabled type names (for spawning and tool descriptions). */
export function getAvailableTypes(): string[] {
  return [...agents.entries()]
    .filter(([_, config]) => config.enabled !== false)
    .map(([name]) => name);
}

/** Get all type names including disabled (for UI listing). */
export function getAllTypes(): string[] {
  return [...agents.keys()];
}

/** Get names of default agents currently in the registry. */
export function getDefaultAgentNames(): string[] {
  return [...agents.entries()]
    .filter(([_, config]) => config.isDefault === true)
    .map(([name]) => name);
}

/** Get names of user-defined agents (non-defaults) currently in the registry. */
export function getUserAgentNames(): string[] {
  return [...agents.entries()]
    .filter(([_, config]) => config.isDefault !== true)
    .map(([name]) => name);
}

/** Check if a type is valid and enabled (case-insensitive). */
export function isValidType(type: string): boolean {
  const key = resolveKey(type);
  if (!key) return false;
  return agents.get(key)?.enabled !== false;
}

/** Tool names required for memory management. */
const MEMORY_TOOL_NAMES = ["read", "write", "edit"];

/**
 * Get memory tool names (read/write/edit) not already in the provided set.
 */
export function getMemoryToolNames(existingToolNames: Set<string>): string[] {
  return MEMORY_TOOL_NAMES.filter(n => !existingToolNames.has(n));
}

// Re-export for backward compatibility — the canonical definition lives in readonly-helpers.ts.
export { getReadOnlyMemoryToolNames };

/** Get built-in tool names for a type (case-insensitive). */
export function getToolNamesForType(type: string): string[] {
  const key = resolveKey(type);
  const raw = key ? agents.get(key) : undefined;
  const config = raw?.enabled === false ? undefined : raw;
  // Expand `*` to the full built-in list (audit A1). Falls back to a fresh
  // copy of BUILTIN_TOOL_NAMES when the agent omits the field entirely.
  const names = config?.builtinToolNames?.length
    ? normalizeBuiltinToolNames(config.builtinToolNames) ?? [...BUILTIN_TOOL_NAMES]
    : [...BUILTIN_TOOL_NAMES];
  return names;
}

/**
 * Intersect two permission values using directional inheritance.
 * Parent overrides child: if parent has a restriction, the child cannot exceed it.
 */
function intersectPermission(
  child: true | readonly string[] | false,
  parent: true | readonly string[] | false,
): true | string[] | false {
  // Early returns for common cases
  if (parent === false) return false;
  if (parent === true) return child === true || child === false ? child : [...child];
  if (child === false) return false;
  if (child === true) return [...parent];
  
  // Both are arrays - return intersection
  const parentSet = new Set(parent);
  return child.filter((item) => parentSet.has(item));
}

/**
 * Intersect tool names: child can only use tools the parent also has access to.
 */
function intersectToolNames(childNames: string[], parentNames: string[]): string[] {
  const parentSet = new Set(parentNames);
  return childNames.filter((t) => parentSet.has(t));
}

/**
 * Apply parent restrictions to a raw effective config.
 */
function applyParentRestrictions(
  raw: { builtinToolNames: string[]; extensions: true | string[] | false; skills: true | string[] | false },
  parentConfig?: EffectiveConfig
) {
  if (!parentConfig) return raw;
  return {
    builtinToolNames: intersectToolNames(raw.builtinToolNames, parentConfig.builtinToolNames),
    extensions: intersectPermission(raw.extensions, parentConfig.extensions),
    skills: intersectPermission(raw.skills, parentConfig.skills),
  };
}

/** Effective config shape used for permission inheritance. Distinct from the full return type. */
export interface EffectiveConfig {
  builtinToolNames: string[];
  extensions: true | string[] | false;
  skills: true | string[] | false;
}

/**
 * Apply partition filtering to builtinToolNames — must run after
 * parent permission inheritance to produce the final intersection.
 * Partition restrictions never expand tool access; only further narrow it.
 * Hoisted to module level to avoid recreating on every getConfig() call.
 */
function applyPartitionFilter(
  membership: Record<string, readonly string[]> | undefined,
  partitions: readonly string[] | undefined,
  toolNames: string[],
): string[] {
  // Early exit: no partitions specified → no filtering (backward compat)
  if (!partitions || partitions.length === 0) return toolNames;
  const allowed = resolvePartitionTools(membership, partitions);
  // If partition membership is not configured (allowed is empty), feature is
  // disabled → intersection returns everything (no restriction)
  if (allowed.length === 0 && !membership) return toolNames;
  return intersectToolNames(toolNames, allowed);
}

/**
 * Resolve the effective configuration for an agent type.
 *
 * This is the main entry point for agent config resolution. It performs:
 * 1. Lookup of the agent config (custom agents override defaults)
 * 2. Parent permission inheritance via {@link PermissionUtils.applyParentRestrictions}
 * 3. Context-mode tool injection when `useContextMode` is set (skipped under a RO parent floor)
 * 4. Partition-based tool filtering via {@link applyPartitionFilter}
 *
 * Falls back to "general-purpose" config if the type is unknown or disabled.
 *
 * @param type - Agent type name (case-insensitive)
 * @param parentConfig - Optional parent agent config for permission inheritance
 * @param partitions - Optional partition names for tool filtering
 * @returns Effective config with resolved tools, extensions, skills, and prompt mode
 */
export function getConfig(
  type: string,
  parentConfig?: EffectiveConfig,
  partitions?: readonly string[],
): {
  displayName: string;
  description: string;
  builtinToolNames: string[];
  extensions: true | string[] | false;
  skills: true | string[] | false;
  promptMode: "replace" | "append";
} {
  const key = resolveKey(type);
  const config = key ? agents.get(key) : undefined;


  if (config && config.enabled !== false) {
    // Expand `*` before parent restrictions so wildcards intersect correctly.
    const baseTools = normalizeBuiltinToolNames(config.builtinToolNames) ?? BUILTIN_TOOL_NAMES;

    const restricted = applyParentRestrictions({
      builtinToolNames: baseTools,
      extensions: config.extensions === true || config.extensions === false ? config.extensions : [...config.extensions],
      skills: config.skills === true || config.skills === false ? config.skills : [...config.skills],
    }, parentConfig);

    // Context-mode tools are additive for opted-in agents, but a read-only
    // parent floor must still be able to deny them (do not append under RO parents).
    const parentIsReadOnlyFloor = Boolean(
      parentConfig?.builtinToolNames.every((t) => (READ_ONLY_TOOLS as readonly string[]).includes(t))
      && !parentConfig.builtinToolNames.some((t) => (CTX_TOOL_NAMES as readonly string[]).includes(t)),
    );
    // When the parent explicitly lists some (but not all) ctx_* tools, only the
    // parent-approved subset is additive — otherwise a parent allowing just
    // `ctx_search` would leak `ctx_execute` et al. to the child. A parent that
    // lists none (undefined parent or a full parent, since ctx_* are additive
    // and never part of the base allowlist) still grants the full set.
    const parentContextTools = parentConfig?.builtinToolNames.filter((t) =>
      (CTX_TOOL_NAMES as readonly string[]).includes(t),
    );
    const contextTools = parentContextTools?.length ? parentContextTools : CTX_TOOL_NAMES;
    const builtinToolNames = config.useContextMode && isContextModeAvailable() && !parentIsReadOnlyFloor
      ? [...restricted.builtinToolNames, ...contextTools]
      : restricted.builtinToolNames;

    return {
      displayName: config.displayName ?? config.name,
      description: config.description,
      builtinToolNames: applyPartitionFilter(config.partitionMembership, partitions, builtinToolNames),
      extensions: restricted.extensions,
      skills: restricted.skills,
      promptMode: config.promptMode,
    };
  }

  // Fallback for unknown/disabled types — minimal-safe config (audit A2).
  //
  // The previous implementation inherited general-purpose's full permissions
  // (BUILTIN_TOOL_NAMES plus extensions: true and skills: true). That granted
  // unrestricted tool access to any caller that triggered the fallback with a
  // malicious or unknown agent type name — a security regression. The new
  // fallback is a hard-coded read-only allowlist with extensions and skills
  // explicitly disabled, then intersected with the caller's parentConfig so
  // permission inheritance still works on this path.
  const restricted = applyParentRestrictions({
    builtinToolNames: [...SAFE_FALLBACK_TOOL_NAMES],
    extensions: false,
    skills: false,
  }, parentConfig);
  return {
    displayName: "Agent",
    description: "Safe fallback agent with minimal read-only permissions",
    builtinToolNames: applyPartitionFilter(undefined, partitions, restricted.builtinToolNames),
    extensions: restricted.extensions,
    skills: restricted.skills,
    promptMode: "append",
  };
}

