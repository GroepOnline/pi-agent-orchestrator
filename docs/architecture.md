# // ARCHITECTURE

> HIGH-LEVEL SUBSYSTEM OVERVIEW FOR `@groeponline/pi-agent-orchestrator`. STRUCTURAL TOPOLOGY AND DATA FLOW DEFINITIONS.

---

## // SYSTEM DIAGRAM

![Pi Agent Orchestrator Architecture](./images/orchestrator_architecture.png)

```text
┌─────────────────────────────────────────────────────────────┐
│                    pi-coding-agent host                     │
│  (loads this extension, provides ExtensionAPI + AgentMgr)   │
└────────────────────┬────────────────────────────────────────┘
                     │
        ┌────────────┴────────────┐
        │    Extension Entry      │
        │    src/index.ts         │
        │  - registerCommands()   │
        │  - initSubagents()      │
        └────────────┬────────────┘
                     │
        ┌────────────┴────────────┐
        │     Agent Registry      │
        │   src/agent-registry.ts │
        │  - load default agents    │
        │  - load custom agents     │
        │  - settings getters       │
        └────────────┬────────────┘
                     │
        ┌────────────┴────────────┐
        │      Agent Types        │
        │   src/agent-types.ts    │
        │  - builtinToolNames     │
        │  - PermissionUtils      │
        │  - partition filtering  │
        └────────────┬────────────┘
                     │
        ┌────────────┴────────────┐
        │      Agent Runner       │
        │   src/agent-runner.ts   │
        │  - createSubagent()     │
        │  - runAgent()           │
        │  - Pi compaction hooks  │
        │  - permission inherit   │
        └────────────┬────────────┘
                     │
    ┌────────────────┼────────────────┐
    │                │                │
┌───┴────┐    ┌─────┴──────┐  ┌─────┴────────┐
│ Hooks  │    │  Context   │  │   Handoff    │
│hooks.ts│    │ context.ts │  │  handoff.ts  │
└────────┘    └────────────┘  └──────────────┘
    │                │                │
    └────────────────┴────────────────┘
                     │
        ┌────────────┴────────────┐
        │         Usage           │
        │     src/usage.ts        │
        │  - token tracking       │
        │  - session context %    │
        └────────────┬────────────┘
                     │
        ┌────────────┴────────────┐
        │     Output Handler      │
        │  src/output-handler.ts  │
        │  - /agents menu         │
        │  - settings UI          │
        │  - conversation viewer  │
        └────────────┬────────────┘
                     │
         ┌───────────┴───────────┐
         │                       │
   ┌─────┴──────┐        ┌──────┴──────┐
   │   Agent    │        │  Schedule   │
   │ Dashboard  │        │    Menu     │
   │ui/agent-   │        │ui/schedule- │
   │dashboard.ts│        │menu.ts      │
   └────────────┘        └─────────────┘
```

---

## // CORE MODULES

### `src/agent-types.ts` — Permission Model

Execution constraints enforce rigid boundaries:

1. **Base primitive array:** Declared in config (`builtinToolNames`).
2. **Parent restriction intersection:** Child agents strictly inherit parent constraint matrices.
3. **Memory partition filtration:** Isolation boundary filter rules applied.
4. **Disallow floor:** Absolute nullification list; constraints scale downward only.

```ts
// Structural execution constraint logic
function resolveAgentTools(config, parentConfig) {
  const base = config.builtinToolNames;
  const filtered = applyPartitionFilter(base, config.contextMode);
  const restricted = PermissionUtils.applyParentRestrictions(filtered, parentConfig);
  const final = subtract(restricted, config.disallowedTools);
  return final;
}
```

### `src/agent-runner.ts` — Lifecycle Execution

```text
spawn → build context → create session → run loop
  │          │              │              │
  │          │              │              └── tool calls, compaction, hooks
  │          │              └── ExtensionAPI.createAgentSession()
  │          └── extractText, buildParentContext, buildCtxInjection
  └── resolveModel, getConfig, apply partition + parent restrictions
```

### `src/context.ts` + `src/context-mode-bridge.ts` — Context Pipeline

- **Phase 1:** Aggregation of parent execution log (`buildParentContext`).
- **Phase 2:** Sandbox boundary injection (`buildCtxInjection`).
- **Phase 3:** Deferred calculation blocks. Generates 15-48% token reduction by executing precisely at session spawn point.

### `src/schedule.ts` + `src/schedule-store.ts` — Temporal Processing

- `SubagentScheduler`: Core chronometer engine.
- `ScheduleStore`: File-backed block persistence (`.pi/subagent-schedules/<sessionId>.json`).
- Disabled blocks isolated; completed blocks explicitly pruned.

### `src/ui/agent-dashboard.ts` — Telemetry Dashboard

High-density interactive metrics overlay:
- **Vim primitives**: `j/k` traversal, `Enter` intervene, `K` terminate, `?` overlay.
- **Visual multiselection**: `v` operator block operations.
- **Permission inspection**: `p` execution matrix view.
- **Swarm topology**: `w` real-time dynamic node join/leave view.
- **Telemetry rendering**: 5 rendering modes (`dots`, `pulse`, `wave`, `bar`, `clock`).
- **Refresh interval**: Programmable MS delay.

### `src/swarm-join.ts` — Swarm Protocol

Dynamic cluster topology control:
- Runtime dynamic node join/leave operations.
- State telemetry surfaced via `w` operator.
- Parallel processing state machine.
- Registry persistence bound to agent lifecycle memory.

### `src/ui/agent-widget.ts` — Above-Editor Widget + Footer Status Bar

The persistent widget above the editor shows running/queued/finished agents with:
- Virtual scrolling with pagination
- Thinking level display (🧠)
- Compact batch rendering (3+ queued agents of same type)
- Activity heatmap indicator
- Adaptive refresh (200ms active / 1000ms idle)

**Footer status bar:** `AgentWidget.update()` calls `ctx.ui.setStatus("subagents", text)` with a live summary such as `2 running, 1 queued agents`. The status key is always `"subagents"` so it coexists with other extensions' footer slots.

**UI context binding:** On `session_start` and every `tool_execution_start`, `src/index.ts` calls `bindWidgetUiCtx()` — `setUICtx`, `ensureTimer`, and `update`. This ensures the footer status bar and editor widget work immediately after a Pi reload without waiting for the next tool call.

**Cleanup:** `dispose()` and `setUICtx()` on context switch clear both the widget (`setWidget("agents", undefined)`) and footer status (`setStatus("subagents", undefined)`).

### `src/logger.ts` + `src/telemetry.ts` — Interactive Terminal Safety

- **`logger`**: Silent in TTY sessions unless `PI_SUBAGENTS_LOG_LEVEL` is set. Non-interactive processes (CI, pipes) default to `warn`.
- **`emitTelemetry`**: Events without registered handlers are dropped silently — no fail-open `console.warn` that would corrupt Pi's chat input or scrollback.

---

## // EXECUTION DATA FLOW

```text
Input command / temporal trigger
  │
  ▼
ExtensionCommand (src/index.ts)
  │
  ▼
resolveModel() ──→ createSubagent() ──→ runAgent()
  │                      │                  │
  │                      │                  ├── Tool invoke matrix
  │                      │                  │      └── Runtime boundary validation
  │                      │                  ├── Pi upstream auto-compaction hooks (#325)
  │                      │                  ├── Interrupt hooks
  │                      │                  └── Handoff JSON payload struct
  │                      │
  │                      └── Context payload construction
  │                            ├── Parent vector stack
  │                            └── Sandbox primitives
  │
  └── Hardware identifier → ExtensionAPI.createAgentSession(model)
```

---

## // FILE MAP

| Module Path | Structural Responsibility |
|---|---|
| `src/index.ts` | Execution bootstrap, hook registration |
| `src/agent-types.ts` | Matrix resolution, capability scaling, partitioning |
| `src/agent-runner.ts` | Process instantiation, lifecycle loop |
| `src/agent-manager.ts` | Abstraction envelope for host AgentManager |
| `src/agent-registry.ts` | Definition ingestion, memory lookup, in-memory settings state (incl. `getPromptCompressionLevel` / `setPromptCompressionLevel`) |
| `src/custom-agents.ts` | Markdown frontmatter extraction and validation |
| `src/default-agents.ts` | Built-in primitive definitions + lazy prompt regeneration via `READONLY_PROMPT_PARAMS` (compression levels) |
| `src/compaction.ts` | Local prune helpers (not wired into `runAgent`; live compaction is Pi upstream auto-compaction — see #325) |
| `src/context.ts` | Vector stack payload creation |
| `src/context-mode-bridge.ts` | Sandbox execution primitives |
| `src/handoff.ts` | Unstructured data to JSON state boundary; `buildHandoffPrompt(level)` selects one of 3 prompt variants (full/balanced/aggressive) matching the compression level |
| `src/hooks.ts` | Execution interrupt bus |
| `src/memory.ts` | Physical boundary isolation definitions |
| `src/model-resolver.ts` | Identifier normalization layer |
| `src/output-handler.ts` | CLI standard output routines |
| `src/schedule.ts` | Chronometric execution pipeline |
| `src/schedule-store.ts` | Temporal persistent state blocks |
| `src/settings.ts` | Parameter dictionary |
| `src/swarm-join.ts` | Swarm node linkage state |
| `src/types.ts` | Type primitives (`AgentConfig`, `AgentRecord`) |
| `src/usage.ts` | Cost and threshold metrics |
| `src/validators.ts` | Adversarial output logic checks |
| `src/worktree.ts` | Disk partition handling |
| `src/cross-extension-rpc.ts` | Inter-module bus interface |
| `src/env.ts` | Target platform capability detection |
| `src/group-join.ts` | Batch synchronization protocol |
| `src/invocation-config.ts` | Override context definition |
| `src/output-file.ts` | Physical report generation |
| `src/prompts.ts` | Template block constants, prompt assembly with `compressionLevel` parameter (handoff variant + lazy read-only regen for default agents) |
| `src/skill-loader.ts` | External module ingestion |
| `src/telemetry.ts` | Activity datalogging pipeline |
| `src/telemetry-otel.ts` | OpenTelemetry span export bridge (agent lifecycle spans, turn/tool/compaction sub-spans, `correlation.id` attribute) |
| `src/orchestration-dispatch.ts` | Heuristic dispatch resolver — `single` / `swarm` / `crew` / `auto` with keyword-based prompt analysis and plan builders |
| `src/dispatch-history.ts` | FIFO ring buffer recording every orchestration decision for the `/agents → Health check` histogram (by kind, by source, auto picks) |
| `src/health-report.ts` | Structured runtime health snapshot builder for `/agents → Health check` (process, tracing, circuit breaker, schedule, swarm, agents, settings, recent errors, dispatch histogram) |
| `src/agent-templates.ts` | Agent templates registry — list, install, update, remove versioned templates from `.agents/templates/` with installed manifest tracking |
| `src/ctx-tool-names.ts` | Context-mode sandbox tool name constants (`ctx_read`, `ctx_write`, `ctx_list`) |
| `src/batch-orchestrator.ts` | Manages smart/group/swarm batch finalization and update debouncing |
| `src/agent-tree.ts` | Mermaid chart and JSON tree visualization for agent swarms |
| `src/audit-logger.ts` | Structured RPC audit logging with in-memory ring buffer and telemetry emission |
| `src/estimate.ts` | Token estimation for agent prompts (char/4 heuristic) |
| `src/globals.ts` | Typed `Symbol.for()` contracts for cross-extension `globalThis` access (hooks, manager, widget metrics, telemetry) |
| `src/logger.ts` | Structured logging — silent in TTY by default; `PI_SUBAGENTS_LOG_LEVEL` enables stderr output in interactive sessions |
| `src/readonly-helpers.ts` | Consolidated read-only tool constants (`READ_ONLY_TOOLS`, `READONLY_MEMORY_TOOL_NAMES`) |
| `src/template-registry.ts` | Agent template indexing, filtering, and search over loaded custom agents |
| `src/tool-result-helpers.ts` | Shared tool result formatting and notification helpers used by `/agents` commands |
| `src/events.ts` | Typed event catalog for `pi.events` lifecycle contracts (started, completed, failed, compacted, budget_warning, scheduler_ready) |
| `src/commands/agents.ts` | `/agents` command registration and argument parsing |
| `src/commands/hooks.ts` | `/hooks` command registration and argument parsing |
| `src/commands/templates.ts` | `/agents templates` command — interactive menu to browse, install, update, and remove agent templates |
| `src/tools/agent.ts` | Sub-agent tool implementations (spawn, get result, steer, list, history) |
| `src/tools/context.ts` | Context mode sandbox tools (`ctx_read`, `ctx_write`, `ctx_list`) |
| `src/tools/get-result.ts` | Sub-agent result retrieval with telemetry cancellation |
| `src/tools/steer.ts` | Agent steering tool — send messages to running sub-agents |
| `src/ui/agent-actions.ts` | Action button handlers for agent lifecycle operations |
| `src/ui/agent-detail.ts` | Individual agent detail view with status, tokens, and duration |
| `src/ui/agent-file-helpers.ts` | File operation helpers for agent outputs and logs |
| `src/ui/agent-list-views.ts` | List view rendering variants (compact, expanded, sorted) |
| `src/ui/agent-viewer.ts` | Agent details viewer with full metadata display |
| `src/ui/agent-wizards.ts` | Agent creation wizard UI with step-by-step configuration |
| `src/ui/settings-snapshot.ts` | Settings snapshot builder for UI rendering and persistence |
| `src/ui/agent-dashboard.ts` | Primary interactive telemetry view with list and top modes |
| `src/ui/agent-top-renderer.ts` | Columns rendering, sorting, and pagination logic for resource top view |
| `src/ui/agent-widget.ts` | Running subagents widget above the editor + footer status bar (`setStatus("subagents", ...)`) |
| `src/ui/conversation-viewer.ts` | Stream block trace |
| `src/ui/schedule-menu.ts` | Temporal task list view |
| `src/ui/animation.ts` | Execution feedback visual primitives |
| `src/ui/theme.ts` | Constant mapping for visual output |
| `src/ui/agent-format.ts` | Standard output data formatting |
| `src/ui/agent-ui-types.ts` | Display constraints definition |
| `src/ui/agent-widget-renderer.ts` | Widget render sequence with virtual scrolling and batch safety caps |
| `src/ui/agent-dashboard-renderer.ts` | Dashboard render sequence with details panel, help, and empty states |
| `src/ui/agent-tree-renderer.ts` | Execution tree TUI renderer (status-colored nodes, Mermaid/text/JSON export via `/agents tree`) |
| `src/ui/health-view.ts` | Health check view — renders `HealthReport` as a read-only editor buffer from `/agents → Health check` |
| `src/ui/notification-renderer.ts` | State change visual logic |
| `src/ui/dashboard/` | Directory containing modular dashboard components (compact rows, progress bars, etc.) |

---

## // SYNCHRONIZATION STATE MACHINE

Batched telemetry protocol avoids execution-thread blockages when concurrent children terminate.

### Components

- **pendingNudges** (`src/index.ts`): Pointer array with 200ms flush boundary.
- **GroupJoinManager** (`src/group-join.ts`): Sync barrier block. Emits single matrix on resolve.
- **SwarmCoordinator** (`src/swarm-join.ts`): Dynamic runtime node state logic.
- **currentBatchAgents** (`src/index.ts`): Execution window buffer array.

### State Diagram

```text
Agent completes
  │
  ├─→ Result already consumed?
  │    └─ Yes → Halt propagation
  │
  ├─→ Existing in currentBatchAgents window?
  │    └─ Yes → Hold for finalizeBatch
  │
  ├─→ Member of GroupJoinManager barrier?
  │    └─ Yes → Execute barrier logic
  │              ├─ Full clear? → Emit immediately
  │              └─ Partial? → Reset 30s hardware timeout
  │
  ├─→ Member of SwarmCoordinator topology?
  │    └─ Yes → Execute node check
  │
  └─→ Else → scheduleNudge(200ms) → Flush single payload
```

### Debounce Pipeline

1. **Parallel tool invokes**: Rapid-fire instructions bind to `currentBatchAgents`.
2. **Buffer lock**: Return block forces a 100ms `batchFinalizeTimer`.
3. **Retroactive dispatch**: `finalizeBatch()` computes diff against pending results and pushes single unified object.
4. **Latency bleed handling**: Process completion post-buffer hits fallback paths.

### Telemetry Interruption

Calling `get_subagent_result` triggers explicit `cancelNudge(agentId)`. Telemetry object explicitly deleted before 200ms tick executes. Prevents state-feedback loop on manual read operations.

