# // API REFERENCE

> PUBLIC API SURFACE FOR `@onlinechefgroep/pi-agent-orchestrator`. INTERNAL STRUCTURES (`AgentFieldParser`, `PermissionUtils`) EXPLICITLY OMITTED. USE EXPOSED FUNCTIONS ONLY.

---

## // EXTENSION ENTRY POINT

### `registerCommands(api: ExtensionAPI): void`

**FILE:** `src/index.ts`

Registers the `/agents` command and hooks into the `pi-coding-agent` lifecycle. Executes exactly once during extension load.

### `initSubagents(api: ExtensionAPI): void`

**FILE:** `src/index.ts`

Initializes subsystem constraints: custom agent loads, widget setup, lifecycle hook registration.

---

## // AGENT REGISTRY

### `reloadCustomAgents(projectDir: string): void`

**FILE:** `src/agent-registry.ts`

Reloads `.pi/agents/*.md` definitions from local project and global directories. Execute subsequent to filesystem mutations.

```ts
reloadCustomAgents(process.cwd());
```

### `getAgentConfig(name: string): AgentConfig | undefined`

**FILE:** `src/agent-types.ts`

Returns resolved configuration tree, including inherited constraints. Override sequence: Custom profiles → Built-in defaults.

### `getAllTypes(): string[]`

**FILE:** `src/agent-types.ts`

Returns array of all registered type identifiers.

---

## // AGENT RUNNER

### `createSubagent(options: SubagentOptions): Promise<AgentSession>`

**FILE:** `src/agent-runner.ts`

Spawns new execution session. Primary programmatic invocation method.

```ts
interface SubagentOptions {
  type: string;              // Type identifier (e.g., "general-purpose", "Explore")
  description: string;       // Telemetry descriptor
  parentSession?: AgentSession; // Context inheritance reference
  model?: string;            // Model override identifier
  maxTurns?: number;         // Hard turn constraint
  joinMode?: JoinMode;       // "await" | "fire-and-forget" | "notify"
  contextMode?: boolean;     // Sandbox toggle
  level?: number;            // Depth integer (default 0)
}
```

### `steerAgent(session: AgentSession, instruction: string): void`

**FILE:** `src/agent-runner.ts`

Injects mid-flight execution steering instruction.

### `getAgentConversation(sessionId: string): CompactableMessage[]`

**FILE:** `src/agent-runner.ts`

Retrieves immutable conversation log for specified session.

### `getDefaultMaxTurns(): number | undefined`

**FILE:** `src/agent-runner.ts`

Retrieves default depth constraint (undefined = infinite).

### `getGraceTurns(): number`

**FILE:** `src/agent-runner.ts`

Retrieves wrap-up iteration allowance prior to forced kill sequence.

---

## // SCHEDULING

### `SubagentScheduler`

**FILE:** `src/schedule.ts`

Cron-engine manager for recurring autonomous jobs.

```ts
const scheduler = new SubagentScheduler(api, manager);

// Register execution
scheduler.schedule({
  agentType: "Explore",
  description: "Daily codebase scan",
  cron: "0 9 * * *",
  enabled: true,
});

// Enumerate registry
const jobs = scheduler.listJobs();

// Terminate execution cycle
scheduler.cancel(jobId);
```

---

## // HOOKS

### `registerHook(event: HookEvent, handler: HookHandler): () => void`

**FILE:** `src/hooks.ts`

Registers lifecycle interrupt handler. Returns execution terminator function.

```ts
import { registerHook } from "@onlinechefgroep/pi-agent-orchestrator";

const unsubscribe = registerHook("subagent:start", async (payload) => {
  console.log(`Execution spawn: ${payload.agentId}`);
  return "allow"; // "allow" | "block" | "modify" | { action: "block", feedback?: string }
});
```

**EVENT REGISTRY:**
- `subagent:start` — Pre-execution interrupt
- `subagent:end` — Post-execution quality gate. May return `"block"` or `{ action: "block", feedback }` to reject the output. With `maxEndHookRevisions > 0`, the runner re-prompts in the same session (bounded); with `0` (default) a block fails closed.
- `subagent:error` — Uncaught fault interrupt
- `subagent:spawn` — Sub-process fork interrupt
- `subagent:steer` — Instruction injection interrupt
- `tool:call` — Pre-tool execution
- `tool:result` — Post-tool execution
- `compaction:start` / `compaction:end` — observational only; payloads are `{ reason }` and `{ reason, tokensBefore }` from upstream Pi events. Local `src/compaction.ts` pruning is not on the runtime path (#325).
- `turn:start` / `turn:end`

---

## // CONTEXT MANAGEMENT

### `buildParentContext(parentSession: AgentSession): Message[]`

**FILE:** `src/context.ts`

Compiles context payload from parent log. Enforces chain-of-thought transmission.

### `extractText(content: unknown): string`

**FILE:** `src/context.ts`

Extracts raw text primitive from message block structures.

---

## // CONFIGURATION SETTINGS

### `SubagentsSettings`

**FILE:** `src/settings.ts`

```ts
interface SubagentsSettings {
  maxConcurrent?: number;              // Max concurrently running agents (default 3)
  maxAgentsPerSession?: number;         // Hard cap on total agents spawned per session
  maxTotalTurnsPerSession?: number;     // Hard cap on cumulative turns across the session
  defaultMaxTurns?: number;             // Max turns per agent (0 = unlimited)
  graceTurns?: number;                // Wrap-up turns before forced kill (default 5)
  maxEndHookRevisions?: number;       // Revision turns after blocking subagent:end (default 0 = fail closed)
  defaultJoinMode?: JoinMode;          // Agent join topology (default: "smart")
  schedulingEnabled?: boolean;         // Master switch for cron scheduling (default: true)
  tracingEnabled?: boolean;           // Master switch for OpenTelemetry span emission in agent-runner (default: true). When false, every span helper in telemetry-otel.ts short-circuits to a shared no-op span.
  posthog?: { key?: string; host?: string; distinctId?: string };  // Optional PostHog product-analytics bridge. Inert unless `key` is persisted in `.pi/subagents.json` (ambient `POSTHOG_KEY`/`POSTHOG_HOST`/`POSTHOG_DISTINCT_ID` env vars are read only once on first run to seed that config), so a default install ships zero outbound analytics. When enabled, agent lifecycle events (spawned, completed, dispatch decisions, validation failures, unknown-tool telemetry) are captured to your own PostHog project.
  animationStyle?: "braille" | "dots" | "lines" | "classic" | "none";  // Spinner style (default: "braille")
  uiStyle?: "premium" | "retro" | "plain";  // UI theme (default: "premium")
  showActivityStream?: boolean;        // Show real-time activity stream in widget (default: true)
  showTokenUsage?: boolean;            // Show token usage and context fill percentage (default: true)
  showTurnProgress?: boolean;          // Show turn progress (current/max) for running agents (default: true)
  orchestrationMode?: "auto" | "single" | "swarm" | "crew";  // Execution topology (default: "single"; multi-agent modes are opt-in)
  dashboardRefreshInterval?: number;   // Dashboard refresh interval in ms (default: 750, min: 100, max: 60000)
  sessionMaxSpawns?: number;           // Guardrail: max agents spawned per session
  sessionMaxTurns?: number;            // Guardrail: max cumulative turns across the session
  promptCompressionLevel?: PromptCompressionLevel;  // "minimal" | "balanced" | "aggressive" (default: "balanced")
  debugCapture?: boolean;               // **OFF BY DEFAULT.** Master switch for the offline capture sink (default: false). Captures agent events, errors + stacks, schedule executions, RPC audit, and per-agent metrics to a local folder. See the `### DEBUG CAPTURE` section below.
  debugCapturePaths?: DebugCapturePathOverrides;  // Override the two capture roots (default: `<cwd>/.pi/subagent-debug` + `<agent-dir>/subagent-debug`). Absolute paths only; failed validation is silently dropped at enable-time (does not crash startup).
}
```

### `PromptCompressionLevel`

**FILE:** `src/types.ts`

Selects one of three static instruction variants. This setting does not summarize conversation history, compact inherited context, rewrite task prompts, or compress custom-agent prompt bodies.

| Level | Behavior |
|---|---|
| `"minimal"` | Minimal compression: the most explicit read-only and handoff guidance. |
| `"balanced"` | Concise guidance with examples and field descriptions. Default. |
| `"aggressive"` | The shortest read-only guidance and a minimal handoff schema. |

**SCOPE:**
- Regenerates the read-only warning and tool-usage sections for the built-in `Explore`, `Plan`, and `Analysis` agents.
- Changes the handoff instruction block for agents with `handoff: true`.
- Does not change built-in additional workflow sections, parent context, inherited system prompts, task prompts, memory, skills, tool schemas, or custom-agent prompt bodies.
- For a custom agent with the default `handoff: false`, `prompt_compression` currently has no effect on its body.
- For append-mode agents, only an enabled handoff block varies.

**PRECEDENCE:** Per-agent frontmatter `prompt_compression` > global `promptCompressionLevel` setting > default `"balanced"`.

**MEASUREMENT:** Character tables elsewhere compare isolated templates only. They are not exact tokenizer measurements and must not be interpreted as a fixed percentage reduction for a complete request. Measure real workloads with provider-reported input usage or runner telemetry.

**PERSISTENCE:** Stored in `.pi/subagents.json` and managed via `SettingsAppliers.setPromptCompressionLevel`.

See [`prompt-compression.md`](prompt-compression.md) for the scope matrix, quality/safety trade-offs, and measurement guidance.

### `saveAndEmitChanged(settings: SubagentsSettings): void`

**FILE:** `src/settings.ts`

Persists configuration map to block storage and triggers state reload.

### `SettingsGetters`

**FILE:** `src/settings.ts`

Read-side accessors for the settings that the `/agents` menu can change at runtime. The menu uses these to display "current:" labels and `buildSettingsSnapshot` reads from them when persisting the next state. Mirrors the runtime contract that `index.ts` exposes to the menu — keep the two in sync when adding a new menu-editable setting.

```ts
interface SettingsGetters {
  getDefaultMaxTurns: () => number | undefined;
  getGraceTurns: () => number;
  getDefaultJoinMode: () => JoinMode;
  isSchedulingEnabled: () => boolean;
  isTracingEnabled: () => boolean;
}
```

### `SettingsSetters`

**FILE:** `src/settings.ts`

Write-side counterpart to `SettingsGetters`. The `/agents` menu calls these after each user mutation. The setter shape diverges slightly from `SettingsAppliers` because the menu accepts a wider input (e.g. `undefined` for defaultMaxTurns to mean "unmark the default" — a value that `applySettings` would never feed in).

```ts
interface SettingsSetters {
  setDefaultMaxTurns: (n: number | undefined) => void;
  setGraceTurns: (n: number) => void;
  setDefaultJoinMode: (mode: JoinMode) => void;
  setSchedulingEnabled: (b: boolean) => void;
  setTracingEnabled: (b: boolean) => void;
}
```

**USAGE:** The `registerAgentsCommand` factory in `src/commands/agents.ts` builds a single `SettingsGetters` and a single `SettingsSetters` object at module load and passes both via `AgentsMenuDeps`. `showSettings(ctx, manager, pi, scheduler, getters, setters)` and `notifyApplied(ctx, pi, manager, getters, successMsg)` consume them — adding a new menu-editable setting is now a 3-place change (interface + applier object + handler call) instead of threading a new arg through 5 function signatures.

### DEBUG CAPTURE

**FILE:** `src/debug-capture.ts`

**OFF BY DEFAULT.** Opt-in local capture of agent lifecycle events, error stacks, schedule firings, cross-extension RPC audit entries, and per-agent metrics snapshots to a writable folder on the local filesystem. When `debugCapture` is `false`, every public `append*` function in this module is a strict no-op — no directories created, no files written, zero runtime cost beyond one boolean check per event.

**ACTIVATION:** Set `debugCapture: true` in `.pi/subagents.json`. The sink activates on `session_start` for both the project cwd root and the agent dir root (unless one or both are overridden via `debugCapturePaths`). `disable()` runs on `session_shutdown` and writes `index.json` next to `manifest.json` so the two roots are cross-checkable offline.

**CAPTURE FOLDER LAYOUT:**

```
<root>/
├── manifest.json            # enable-time snapshot: paths, sessionUuid, options.maxBytesPerFile
├── agents/<agent-id>/
│   ├── events.jsonl         # append-only JSONL: each hook event + payload
│   ├── errors.log           # append-only JSONL: {name, message, stack} per error
│   └── metrics.json         # atomic JSON upsert: latest metrics snapshot per agent
├── schedules/<job-name>/
│   └── executions.jsonl     # append-only JSONL: schedule firings + errors
└── rpc/
    └── audit.jsonl          # append-only JSONL: cross-extension RPC audit trail
```

**DEFAULT ROOTS** (in priority order — both attempted, both kept):

| Key | Default path | Override via |
|---|---|---|
| `project` | `<cwd>/.pi/subagent-debug` | `debugCapturePaths.project` |
| `personal` | `<getAgentDir()>/subagent-debug` | `debugCapturePaths.personal` |

Both paths are **validated at enable-time**: must be **absolute**, contain no `..` traversal segments, no NUL bytes, and ≤ 4 KiB. Invalid overrides are silently dropped (capture activates for the remaining valid root, or stays disabled if both fail validation) — a malformed setting never crashes startup.

**ROTATION:** Per-file ceiling is **25 MiB**. When a JSONL file exceeds it, the tail half (≈ 12.5 MiB) is preserved and the head dropped. Append-then-rotate is atomic via temp+rename so a crash mid-rotation cannot leave a half-truncated file. `metrics.json`, `manifest.json`, and `index.json` are atomic upserts and are NOT subject to rotation (size stays bounded by the schema).

**GUARANTEES:**

- **OFF BY DEFAULT** — `debugCapture: false` ships. The no-op path costs one boolean check per event.
- **LOCAL ONLY** — the module writes only to the paths the user/extension explicitly bound. **No network egress.** Ever.
- **BEST-EFFORT** — every filesystem operation is wrapped in try/catch; a capture failure logs to `logger.debug` and the runtime proceeds. A capture error never breaks the agent, the dashboard, or the scheduler.

**PII WARNING.** Captured content includes full agent prompts, error stacks with absolute source paths, and tool arguments — tool args frequently contain user-pasted clipboard secrets, API tokens, or session-scoped credentials. **Enable only on workloads where you trust the local filesystem with the captured content.** Review the contents of `<root>/agents/` before sharing or committing anything from these folders.

**EXPOSED API:** `enable`, `disable`, `isDebugCaptureEnabled`, `getDebugCaptureManifest`, `resetDebugCapture`, `appendAgentEvent`, `appendError`, `upsertAgentMetrics`, `appendScheduleEvent`, `appendRpcAudit`, plus the `__test_rotateIfNeeded` test-only helper. The module is a pure sink — wiring lives in `src/index.ts` so the public DSL stays dependency-free (testable in isolation without a `HookRegistry` / `HookRuntime`).

**ACTIVATION FLOW:**

1. `applyAndEmitLoaded` reads `debugCapture` + `debugCapturePaths` from `.pi/subagents.json` at extension load.
2. Always-on hook handlers + telemetry listeners are registered against the `HookRegistry` at extension init (one per `HOOK_EVENTS_TO_CAPTURE`), but each handler short-circuits on `!isDebugCaptureSinkOn()` so the disabled path is zero-cost.
3. On `session_start`, the wiring calls `enable({ projectPath, personalPath }, sessionId)` once. `disable(true)` runs on `session_shutdown` to write the closing `index.json`.

**TESTING:** `test/debug-capture.test.ts` covers all 12 describe-blocks: off-by-default, enable/disable lifecycle, append sinks (agent events, errors with stacks, metrics upserts, schedule firings, RPC audit), directory-name sanitization, rotation tail-keeps, FS-error resilience (mkdir fail swallowed), and `cloneSafe` payload scrubbing of non-JSON-safe values.

---

## // TYPE DEFINITIONS

### `AgentConfig`

**FILE:** `src/types.ts`

```ts
interface AgentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  builtinToolNames: string[];
  disallowedTools?: string[];
  extensions?: boolean;
  contextMode?: boolean;
  allowedTools?: string[];
  model?: string;
  temperature?: number;
  parentType?: string;
  handoff?: boolean;          // Produce structured JSON handoff at end of response
  promptCompressionLevel?: PromptCompressionLevel;  // Per-agent compression override
  memory?: "user" | "project" | "local";       // State persistence scope
  isolation?: "worktree";    // Isolation mode
}
```

### `AgentRecord`

**FILE:** `src/types.ts`

Runtime state memory map:

```ts
interface AgentRecord {
  id: string;
  type: string;
  description: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  completedAt?: number;
  toolUses: number;
  level: number;
  compactionCount: number;
}
```

### `JoinMode`

**FILE:** `src/types.ts`

- `"async"` — Asynchronous fork, detached execution (default).
- `"group"` — Synchronous barrier: waits for all agents in the group to finish, then emits a single grouped notification.
- `"smart"` — Smart selection: automatically chooses the best join strategy based on context.
- `"swarm"` — Swarm mode: dynamic collaborative multi-agent processing with runtime join/leave.

---

## // CUSTOM AGENT INGESTION

### `loadCustomAgents(dir: string): Map<string, AgentConfig>`

**FILE:** `src/custom-agents.ts`

Ingests markdown definitions, parsing YAML frontmatter into memory constraints. Validates identifiers and nullifies injection primitives.

**FRONTMATTER DIRECTIVES** (parsed in `src/custom-agents.ts`):

| Directive | Type | Default | Effect |
|---|---|---|---|
| `display_name` | string | filename | UI label override |
| `description` | string | filename | Telemetry description |
| `tools` | CSV / `none` | all built-in tools | Authorized tool subset |
| `disallowed_tools` | CSV | none | Explicit denylist (partition floor) |
| `extensions` | bool / CSV | `true` | Extension module access |
| `skills` | bool / CSV | `true` | Skill module access |
| `model` | string | host default | Model override (e.g. `anthropic/claude-sonnet-4-5`) |
| `thinking` | string | null | Inference effort: `low` / `medium` / `high` |
| `max_turns` | number | null | Hard execution turn limit |
| `prompt_mode` | `replace` / `append` | `replace` | System prompt integration strategy |
| `inherit_context` | bool (or string `"true"`/`"false"`) | null | Parent conversation context |
| `run_in_background` | bool (or string) | null | Non-blocking execution |
| `isolated` | bool (or string) | null | Strict context isolation |
| `memory` | `user` / `project` / `local` | null | State persistence scope |
| `isolation` | `worktree` | null | Physical directory isolation |
| `handoff` | bool (or string) | `false` | Produce structured JSON handoff at end of response |
| `prompt_compression` | `minimal` / `balanced` / `aggressive` | inherits global | Per-agent compression override |
| `enabled` | bool (or string) | `true` | Profile activation state |

All boolean fields accept either native YAML booleans or string-encoded booleans
(`"true"` / `"false"`, case-insensitive). They are parsed via `parseBooleanOptional`
and `parseBooleanWithDefault` in `src/custom-agents.ts`, which throw on any
unrecognised input (numbers, arbitrary strings) so YAML schema errors surface
at load time rather than being silently coerced.

**FRONTMATTER EXAMPLE (handoff):**

```markdown
---
display_name: "Chain Reviewer"
description: "Code review that hands off structured findings"
tools: read, grep, find
handoff: true
prompt_compression: minimal
---

Perform a thorough code review and produce a structured handoff JSON
with your findings for downstream agents.
```

When `handoff: true` is set, the agent produces a structured JSON handoff at the end of its response, enabling chain-of-agents workflows where one agent's output feeds directly into the next.

**SECURITY DIRECTIVE:** Symlinks are explicitly ignored to prevent LFI vulnerabilities.

### // HANDOFF V2 — TYPED ARTIFACTS

**FILE:** `src/handoff.ts`

Handoff v2 replaces the loose `artifacts: HandoffArtifact[]` shape with a
strict discriminated union on `type`. Parsed handoffs expose the v2 shape
regardless of what older agents emit; legacy loose artifacts are coerced
best-effort.

```ts
type HandoffArtifactV2 =
  | HandoffFileArtifact
  | HandoffBranchArtifact
  | HandoffUrlArtifact
  | HandoffNoteArtifact;

interface HandoffFileArtifact {
  type: "file";
  path: string;            // required, ≤ 4096 chars
  mimeType?: string;       // ≤ 200 chars
  title?: string;          // ≤ 200 chars
}

interface HandoffBranchArtifact {
  type: "branch";
  branch: string;          // required, ≤ 256 chars
  base?: string;           // ≤ 256 chars
  commits?: string[];      // ≤ 100 entries, each ≤ 64 chars
  title?: string;          // ≤ 200 chars
}

interface HandoffUrlArtifact {
  type: "url";
  url: string;             // required, ≤ 2048 chars
  title?: string;          // ≤ 200 chars
  description?: string;    // ≤ 500 chars
}

interface HandoffNoteArtifact {
  type: "note";
  title: string;           // required, ≤ 200 chars
  value: string;           // required, ≤ 50000 chars
  mimeType?: string;       // ≤ 200 chars
}
```

**JSON EXAMPLE:**

```json
{
  "type": "handoff",
  "status": "success",
  "summary": "Fixed token bucket refill in rate-limiter.ts",
  "findings": ["Refill interval was 0ms"],
  "artifacts": [
    { "type": "file", "path": "src/rate-limiter.ts", "title": "Fix", "mimeType": "text/typescript" },
    { "type": "branch", "branch": "fix/rate-limiter", "base": "main" },
    { "type": "url", "url": "https://example.com/spec", "title": "Spec" },
    { "type": "note", "title": "Follow-up", "value": "Investigate the backoff curve" }
  ]
}
```

**LEGACY COERCION:**

Older agents that emit loose artifacts (e.g. `{type: "design", path, title, value, mimeType}`) continue to work. The parser runs `coerceLegacyArtifact` on every artifact that fails strict v2 validation, mapping first-match-wins to a v2 shape:

| Loose shape | Coerced to |
|---|---|
| `{path}` (any type string) | `HandoffFileArtifact` |
| `{title, value}` | `HandoffNoteArtifact` |
| `{branch, ...}` | `HandoffBranchArtifact` |
| `{url, ...}` | `HandoffUrlArtifact` |
| anything else | dropped with `logger.warn` |

**EXPORTS:** `HandoffFileArtifact`, `HandoffBranchArtifact`, `HandoffUrlArtifact`, `HandoffNoteArtifact`, `HandoffArtifactV2` (the discriminated union), `HandoffArtifact` (kept as a loose structural alias for source-level backwards compat), `HANDOFF_ARTIFACT_TYPES`, `HandoffArtifactType`, `parseHandoff`, `renderHandoffForParent`, `buildHandoffPrompt`.

---

## // INTERACTIVE UI

### Footer status bar (`setStatus`)

**FILE:** `src/ui/agent-widget.ts`, wired from `src/index.ts`

The orchestrator occupies Pi's footer status slot `"subagents"`:

```ts
ctx.ui.setStatus("subagents", "2 running, 1 queued agents");
ctx.ui.setStatus("subagents", undefined); // clear when idle
```

Binding happens on `session_start` and `tool_execution_start` via `bindWidgetUiCtx()`.

### Editor widget (`setWidget`)

**FILE:** `src/ui/agent-widget.ts`

```ts
ctx.ui.setWidget("agents", (tui, theme) => ({
  render: () => [] as string[],
  invalidate: () => {},
}), { placement: "aboveEditor" });
```

### Logging in interactive sessions

**FILE:** `src/logger.ts`

| Environment | Default level | Override |
|---|---|---|
| TTY (interactive Pi) | silent | `PI_SUBAGENTS_LOG_LEVEL=debug\|info\|warn\|error` |
| Non-TTY (CI, pipes) | `warn` | same env var |

### Telemetry emission

**FILE:** `src/telemetry.ts`

`emitTelemetry(event)` forwards to registered handlers only. Unsubscribed events are dropped silently in TTY mode so stdout is never polluted.

---

## // TELEMETRY VIEWER

### `ConversationViewer`

**FILE:** `src/ui/conversation-viewer.ts`

TUI rendering block for real-time log stream tracking.

```ts
const viewer = new ConversationViewer(tui, session, record, activity, theme);
viewer.render(width, height); // Returns string[] display buffer
```

---

## // USAGE METRICS

### `getLifetimeTotal(usage?: LifetimeUsage): number`

**FILE:** `src/usage.ts`

Retrieves global token execution count.

### `getSessionContextPercent(session?: SessionLike): number`

**FILE:** `src/usage.ts`

Retrieves saturation metric (0-100) of context window.

---

## // PUBLIC TYPED API

Single entry point for peer extensions and tests that want a stable, typed
contract against the orchestrator. Re-exports the RPC + hook types from one
place and adds Symbol-based discovery for the runtime handle.

**FILE:** `src/public-api.ts`

### // SYMBOL DISCOVERY

The orchestrator publishes its typed API on two well-known `globalThis` keys:

| Symbol | Returns | Notes |
|---|---|---|
| `Symbol.for("pi-subagents:api")` | `SubagentsPublicApi \| undefined` | New — typed RPC + typed event subscription |
| `Symbol.for("pi-subagents:hooks")` | `HookRegistry \| undefined` | Documented but previously unimplemented; now published |

Use the safe accessors `getSubagentsApi()` / `getSubagentsHooks()` (both return
`undefined` when the extension is not loaded). Clear with `clearSubagentsApi()`
in test teardown.

### // REGISTRATION

Called once by the extension on load. **Idempotent** — last registration wins,
matching the contract documented for `registerRpcHandlers` in
`src/cross-extension-rpc.ts`.

```ts
import {
  registerSubagentsApi,
  HookRegistry,
  type SubagentsPublicApi,
} from "@onlinechefgroep/pi-agent-orchestrator/public-api";

export function init(api: ExtensionAPI): SubagentsPublicApi {
  const hooks = new HookRegistry();
  // ... register pi-extension handlers on the hook registry ...
  return registerSubagentsApi(api.events, hooks, { extensionId: "my-extension" });
}
```

### // TYPED EVENT SUBSCRIPTION

The `TypedEventSubscription` returned via `api.hooks` gives handlers a
discriminated payload — `data` is shaped by the subscribed event name, not
the previous `Record<string, unknown>` black box.

```ts
import {
  getSubagentsApi,
  type TypedHookPayload,
} from "@onlinechefgroep/pi-agent-orchestrator/public-api";

const api = getSubagentsApi();
if (!api) throw new Error("pi-agent-orchestrator extension is not loaded");

// Single typed event — handler gets the exact data shape for "subagent:start"
const off = api.hooks.on("subagent:start", async (payload) => {
  //    ^? TypedHookPayload<"subagent:start"> → { event, agentId, data: AgentStartData, ... }
  console.log(payload.data.type, payload.data.description);
  return "allow";
});

// Every event with a union payload
const offAll = api.hooks.onAll((payload) => {
  if (payload.event === "subagent:end" && payload.data.status === "completed") {
    // ... payload.data is narrowed to AgentEndData here
  }
});
```

`TYPED_HOOK_PAYLOAD_MAP` maps every `HookEvent` to its specific data shape
(`AgentStartData`, `AgentEndData`, `ToolCallData`, etc.) and is exhaustiveness-
checked against the `HookEvent` union via `satisfies Record<HookEvent, unknown>`
— adding a new event without a row in the map fails the build.

### // TYPED RPC

The `api.rpc` field is a `SubagentsRpcClient` (same shape as the existing
`createSubagentsRpcClient` factory), with the four supported operations:

- `ping()` → `{ version: number }`
- `spawn({ type, prompt, options? })` → `{ id: string }`
- `stop({ agentId })` → `void`
- `sessionUsage()` → `{ usage, limits }`

The rate-limit, authentication, and audit-trail guarantees documented in
`// CROSS-EXTENSION RPC` below apply unchanged.

### // MANAGER HANDLE

`api.manager` is a read-only `SubagentManagerHandle` over the orchestrator's
`AgentManager`. It is also published under `Symbol.for("pi-subagents:manager")`
and exposed via the safe accessor `getSubagentsManager()`.

The handle exposes four observation methods only — every mutating surface
(`spawn`, `stop`, `abort`, `clearCompleted`, etc.) is intentionally **not**
exposed, so peer extensions can monitor agents without gaining the ability
to create or stop them.

```ts
import {
  getSubagentsApi,
  getSubagentsManager,
  type SubagentManagerHandle,
  type SubagentManagerRecord,
} from "@onlinechefgroep/pi-agent-orchestrator/public-api";

// Via the typed API
const api = getSubagentsApi();
if (api) {
  await api.manager.waitForAll();
  const rec: SubagentManagerRecord | undefined = api.manager.getRecord("agent-123");
  const exploreIds: string[] = api.manager.listAgentIds("Explore");
}

// Or via the safe accessor
const mgr: SubagentManagerHandle | undefined = getSubagentsManager();
if (mgr) {
  const running = mgr.hasRunning();
}
```

**METHOD SHAPE (`SubagentManagerHandle`):**

| Method | Returns | Purpose |
|---|---|---|
| `waitForAll()` | `Promise<void>` | Resolve when every currently-running agent reaches a terminal state |
| `hasRunning()` | `boolean` | Whether any agent is currently running |
| `getRecord(id)` | `SubagentManagerRecord \| undefined` | Sanitized record for an agent, or `undefined` if absent |
| `listAgentIds(type)` | `string[]` | All known agent ids of the given type |

**SANITIZATION CONTRACT (`SubagentManagerRecord`):**

The record returned by `getRecord(id)` is a *projection* of the internal
`AgentRecord`. Only `id`, `type`, `status`, and a truncated `description`
are exposed. Sensitive fields (full prompt, result, error stack, internal
flags) are intentionally omitted — consumers that need the full record
should use the `Agent` tool or RPC instead.

The `description` field is truncated to
`SUBAGENT_MANAGER_MAX_DESCRIPTION_CHARS` (currently `200`) characters
to avoid leaking long context (full file contents, transcripts, etc.) to
peer extensions in the process.

### // RE-EXPORTS

For convenience, the following types and helpers are re-exported from a
single import path:

- **RPC:** `PROTOCOL_VERSION`, `createSubagentsRpcClient`, `EventBus`,
  `SubagentsRpcClient`, `RpcReply`, `SpawnRpcRequest`, `StopRpcRequest`,
  `PingRpcReply`, `SessionUsageRpcReply`, `SpawnCapable`, `SessionCapable`,
  `SwarmCapable`, `AuthContext`, `RateLimitConfig`
- **Hooks:** `HookRegistry`, `HookEvent`, `HookPayload`, `HookHandler`,
  `HookResponse`, `composeHandlers`
- **This module:** `TYPED_HOOK_PAYLOAD_MAP`, `TypedHookPayload`,
  `TypedHookHandler`, `TypedEventSubscription`, `SubagentsPublicApi`,
  `SUBAGENTS_API_SYMBOL`, `SUBAGENTS_HOOKS_SYMBOL`, `SUBAGENTS_MANAGER_SYMBOL`,
  `SUBAGENT_MANAGER_MAX_DESCRIPTION_CHARS`, all event-payload
  data interfaces (`AgentStartData`, `AgentEndData`, `ToolCallData`, etc.),
  `registerSubagentsApi`, `getSubagentsApi`, `getSubagentsHooks`,
  `getSubagentsManager`, `clearSubagentsApi`, `SubagentManagerHandle`,
  `SubagentManagerRecord`, `SubagentManagerLike`

---

## // CROSS-EXTENSION RPC

### // PROTOCOL DEFINITION

**FILE:** `src/cross-extension-rpc.ts`

Standardized request-reply event structure over the `pi.events` bus. Designed for decoupled multi-extension operation.

**PROTOCOL VERSION:** `2`

Mutating parameters (`spawn`, `stop`) are hardware-authenticated when `authProvider` is defined. Unauthenticated requests strictly rejected unless legacy fallback is enabled.

### // RPC PAYLOAD ENVELOPE

Conforms to structural guarantees:

```ts
type RpcReply<T = void> =
  | { success: true; data?: T }
  | { success: false; error: string };
```

### // RPC ENDPOINTS

#### `subagents:rpc:ping`

System health check and protocol discovery.

**REQUEST:** `{ requestId: string }`
**REPLY:** `{ success: true; data: { version: number } }`

#### `subagents:rpc:spawn`

Fork detached process from alternate module.

**REQUEST:**
```ts
{
  requestId: string;
  type: string;
  prompt: string;
  options?: {
    model?: string;
    maxTurns?: number;
    isolated?: boolean;
    inheritContext?: boolean;
  };
}
```

**REPLY:** `{ success: true; data: { id: string } }`

**RATE LIMITING:** 10 forks/minute per authenticated module ID.

#### `subagents:rpc:stop`

Force execution interrupt on specified PID.

**REQUEST:** `{ requestId: string; agentId: string }`
**REPLY:** `{ success: true }`

**RATE LIMITING:** 10 interrupts/minute per authenticated module ID.

### // SYMBOL REGISTRY

Exposes read-only telemetry by passing globally registered symbols.

#### `Symbol.for("pi-subagents:manager")`

```ts
const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];

await manager.waitForAll();
const record = manager.getRecord("agent-123");
const ids = manager.listAgentIds("Explore");
```

> **Status:** published via `registerSubagentsApi(...)` (see `// PUBLIC TYPED API` above). Peer extensions should prefer the safe accessor `getSubagentsManager()` or `api.manager` over the raw symbol read.

**SECURITY DIRECTIVE:** Write functions physically detached from registry pointer.

#### `Symbol.for("pi-subagents:hooks")`

```ts
const hooks = (globalThis as any)[Symbol.for("pi-subagents:hooks")];
const handlers = hooks.getHandlers();
```

### // LIFECYCLE BROADCASTS

Event bus emission standards for external monitoring.

- **`subagents:ready`** — Boot sequence complete.
- **`subagents:scheduler_ready`** — Job registry loaded.
- **`subagents:started`** — Execution unblocked.
- **`subagents:completed`** — Clean termination.
- **`subagents:failed`** — Unclean fault.
- **`subagents:compacted`** — Upstream Pi compaction observed (`reason`, `tokensBefore`, `compactionCount` on the agent record).
- **`subagents:record`** — Persistent memory write.

### // SECURITY CONSTRAINTS

- **Rate execution limits:** Hard throttle at 10/min per ID for destructive parameters.
- **Authentication checks:** `authProvider` overrides explicit payload identifiers.
- **Read-only execution:** Symbol mapping provides immutable pointers to memory maps.
- **Model boundary enforcement:** String resolution blocks external credential injections.
