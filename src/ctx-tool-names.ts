/**
 * ctx-tool-names.ts — Canonical list of @groeponline/context-mode tool names.
 *
 * This is the **single source of truth** for the `CTX_TOOL_NAMES` constant.
 * Both `agent-types.ts` (which appends them to the agent's tool allowlist when
 * `useContextMode: true`) and `context-mode-bridge.ts` (which returns them via
 * `getCtxToolNames()` for the runtime injection) import from here.
 *
 * Extracted into a third module to break a previously detected circular import:
 *
 *     agent-types.ts        → context-mode-bridge.ts        (for isContextModeAvailable)
 *     context-mode-bridge.ts → agent-types.ts              (for CTX_TOOL_NAMES)  ← cycle!
 *
 * After this extraction the relationship becomes a DAG:
 *
 *     agent-types.ts         → ctx-tool-names.ts
 *     context-mode-bridge.ts → ctx-tool-names.ts
 *     agent-types.ts         → context-mode-bridge.ts      (one-way runtime check)
 *
 * Keeping the constant in its own module also matches the convention used by
 * `readonly-helpers.ts` for `READ_ONLY_TOOLS` — small, pure, dependency-free
 * leaves of the import graph that everything else safely depends on.
 */

/** List of `ctx_*` sandbox tool names provided by the optional `@groeponline/context-mode` peer dependency. */
export const CTX_TOOL_NAMES: readonly string[] = [
  "ctx_execute",
  "ctx_execute_file",
  "ctx_search",
  "ctx_index",
  "ctx_batch_execute",
  "ctx_stats",
];
