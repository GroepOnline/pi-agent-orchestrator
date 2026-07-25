/**
 * context-mode-bridge.ts — Bridge between pi-subagents and @onlinechef/context-mode.
 *
 * Provides optional ctx_* tool injection for sub-agents. When context-mode is
 * installed, sub-agents gain sandboxed code execution and BM25 FTS5 search.
 * When not installed, all functions gracefully return null/empty — no errors.
 */

// Import from `./ctx-tool-names.js` rather than from `./agent-types.js`.
// This breaks the circular dependency: `agent-types.ts` already pulls in
// `isContextModeAvailable` from this file, so the only way to avoid the cycle
// is to keep CTX_TOOL_NAMES in a third, dependency-free module that both sides
// import from. See `src/ctx-tool-names.ts` for the canonical definition.
import { CTX_TOOL_NAMES } from "./ctx-tool-names.js";

/** Cached availability check — lazy, checked once per process lifetime. */
let _contextModeAvailable: boolean | null = null;

/**
 * Check if @onlinechef/context-mode is installed in the runtime.
 * Uses synchronous module resolution — pi's runtime provides `require`.
 * Cached after first call for zero-cost repeat checks.
 */
export function isContextModeAvailable(): boolean {
  if (_contextModeAvailable !== null) return _contextModeAvailable;

  try {
    // Synchronous resolution works in pi's ESM+CJS hybrid runtime
    require.resolve("@onlinechef/context-mode");
    _contextModeAvailable = true;
  } catch {
    _contextModeAvailable = false;
  }

  return _contextModeAvailable;
}

/**
 * Get the list of ctx_* tool names provided by context-mode.
 * Pure function — always returns the same constant array.
 */
export function getCtxToolNames(): string[] {
  return [...CTX_TOOL_NAMES];
}

/**
 * Build a markdown routing block instructing sub-agents to use ctx_* tools.
 * Mirrors context-mode's AGENTS.md routing rules.
 * Pure function — same input always produces same output.
 */
export function buildCtxRoutingBlock(): string {
  return `# Context Mode Sandbox Tools

You have access to sandboxed code execution and knowledge base tools via @onlinechef/context-mode. These save context by running data analysis in an isolated sandbox instead of flooding the LLM context window.

## Available Tools

- **ctx_execute** — Execute code in a sandboxed environment. Supports JavaScript, TypeScript, Python, Go, Rust, Shell, and 9+ other languages. Use for any data processing, analysis, computation, or transformation tasks.
- **ctx_execute_file** — Load a file into the sandbox without flooding context. The file contents are injected directly into the sandbox filesystem, keeping your context window clean.
- **ctx_search** — BM25 FTS5 search over indexed documents in the knowledge base. Use to find prior context, documentation, or indexed files.
- **ctx_index** — Index markdown or JSON content into the knowledge base for later retrieval via ctx_search.
- **ctx_batch_execute** — Execute multiple commands in sequence within the sandbox. Results are auto-indexed for future ctx_search retrieval.
- **ctx_stats** — Display session token and cost statistics.

## Routing Rules

- Use ctx_execute for ANY data computation, analysis, or processing — never do math or data transforms in your own context window.
- Use ctx_execute_file to read large files into the sandbox instead of using the read tool.
- Use ctx_search before starting work to discover prior context and indexed results.
- Use ctx_index to persist important results for future reference.
- Use ctx_batch_execute for workflows with multiple sequential steps.
- Prefer ctx_* tools over built-in tools when processing data or searching indexes.`;
}

/** Result shape for buildCtxInjection — only returned when context-mode is available. */
export interface CtxInjection {
  /** Markdown block to append to the sub-agent's system prompt. */
  systemPromptAddition: string;
  /** Tool names to add to the sub-agent's tool allowlist. */
  toolAllowList: string[];
}

/**
 * Build the context-mode injection payload for a sub-agent.
 * Returns null when context-mode is not installed (early exit — no errors).
 *
 * When available, returns the system prompt addition and ctx_* tool names
 * that should be injected into the sub-agent's configuration.
 */
export function buildCtxInjection(): CtxInjection | null {
  if (!isContextModeAvailable()) return null;

  return {
    systemPromptAddition: buildCtxRoutingBlock(),
    toolAllowList: getCtxToolNames(),
  };
}

/**
 * Resolve context-mode injection for a specific agent.
 * Returns null unless the agent opted in via `useContextMode` AND the peer is installed.
 * Callers must still intersect `toolAllowList` with the agent's effective allowlist so
 * parent permission inheritance is not bypassed.
 */
export function resolveCtxInjectionForAgent(
  useContextMode: boolean | undefined,
): CtxInjection | null {
  if (!useContextMode) return null;
  return buildCtxInjection();
}
