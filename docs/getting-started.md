# Getting started

Pi Agent Orchestrator adds bounded multi-agent execution to Pi. This guide covers the shortest path from installation to a useful run, then explains the execution boundaries that matter before you enable more concurrency.

## 1. Requirements

- Node.js 22.22.3 or newer.
- `@earendil-works/pi-coding-agent` 0.81.1 or newer.
- A working Pi installation.
- Git only when you want worktree isolation for implementation agents.

The extension runs inside the Pi host process. It does not require a package-owned server or database.

## 2. Install

Global Pi install:

```bash
pi install npm:@groeponline/pi-agent-orchestrator
```

One-session trial:

```bash
pi -e npm:@groeponline/pi-agent-orchestrator
```

Project-local install:

```bash
pi install npm:@groeponline/pi-agent-orchestrator -l
```

Use `pi install`. A plain `npm install` does not register the package resources with Pi.

## 3. Run a bounded audit first

The packaged audit workflow is the safest first demonstration because it uses parallel read-only work and then synthesizes the result:

```text
/orchestra-audit src
```

Open the operator surface while it runs:

```text
/agents
```

You should see running or queued agents and their lifecycle state. The Pi footer can also expose a compact `subagents` status summary.

## 4. Mental model

The Orchestrator separates four concerns:

```text
request
  │
  ▼
dispatch strategy
  │
  ├── read-only discovery / planning
  ├── optional sandboxed analysis
  └── bounded implementation
             │
             ▼
    permissions + limits
             │
             ▼
       execution state
             │
             ▼
      structured handoff
             │
             ▼
       parent/operator
```

The parent remains authoritative. A child does not silently regain tools or scopes that the parent did not have.

## 5. Agent types

| Type | Typical access | Use it for |
| --- | --- | --- |
| Explore | read-only | Codebase discovery, evidence collection, independent inspection |
| Plan | read-only | Architecture, sequencing and implementation planning |
| Analysis | read-only plus optional `ctx_*` | Sandboxed computation or data-oriented analysis |
| general-purpose | bounded full toolset | Changes, multi-step implementation and verification |

Custom project agents are Markdown files under `.pi/agents/*.md`. See [Custom agents](./custom-agents.md) before widening tools or limits.

## 6. Dispatch strategies

The default orchestration mode is `single`. Multi-agent strategies are opt-in.

| Strategy | Shape | Best fit |
| --- | --- | --- |
| `single` | One bounded execution path | Small or sequential work |
| `crew` | Several role-oriented agents | Work that benefits from distinct responsibilities |
| `swarm` | Coordinated parallel membership | Broad work that can be decomposed safely |
| `auto` | Heuristic strategy selection | Requests where the orchestrator should choose among supported plans |

More concurrency is not automatically better. Prefer the smallest strategy that gives useful independent evidence or parallelism.

See [Execution strategies](./execution-strategies.md) for the exact dispatcher behavior.

## 7. What bounds execution

Before an agent starts, the effective toolset and limits are resolved from several layers:

1. The agent's declared tools.
2. Parent restrictions.
3. Partition/context-mode filtering.
4. Explicit disallowed tools.
5. Turn, budget and depth limits.
6. Optional filesystem/branch isolation through a git worktree.

These constraints only narrow as execution descends into child agents. They are not merely instructions inside a prompt.

For lifecycle ordering and cancellation behavior, see [Tool calling](./tool-calling.md).

## 8. Handoffs

Structured handoffs are the preferred way to transfer work between agents. They make the transfer explicit and machine-readable instead of relying on invisible conversation history.

A handoff can carry conclusions and typed artifacts such as files, branches, URLs and notes. The receiving parent or next agent can render and validate that payload before continuing.

v0.19.1 includes a bounded Explore handoff demo and a deterministic parse check for this path. See [v0.19.1 release notes](./releases/v0.19.1.md).

## 9. Operator controls

Open the dashboard with:

```text
/agents
```

Common controls:

| Control | Action |
| --- | --- |
| `j` / `k` or arrow keys | Navigate agent rows |
| `Space` | Multi-select |
| `t` | Resource top view |
| `z` | Daemon schedules |
| `Shift+K` | Terminate selected agents |
| `?` | Help |
| `/perf` | Performance metrics |

Use the dashboard to observe first, then steer or terminate when a run no longer matches the intended boundary.

## 10. Packaged workflows

Three templates cover common operating patterns:

```text
/orchestra-audit [scope]
/orchestra-plan <goal>
/orchestra-implement <goal>
```

`/orchestra-audit` and `/orchestra-plan` are useful when you want evidence before edits. `/orchestra-implement` adds one isolated writer followed by independent verification.

The templates deliberately avoid merge, publish, tag or deploy actions unless those actions are explicitly part of the request.

## 11. Optional capabilities

- Git worktrees for isolated implementation.
- Persistent schedules and daemon schedule view.
- Prompt-compression profiles for static system-prompt guidance.
- Swarm coordination.
- Cross-extension RPC with capability-token authentication and mutation limits.
- OpenTelemetry/PostHog integration when explicitly configured.

Optional telemetry is inert by default.

## 12. Verify a development checkout

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run verify:package
```

Cursor Cloud has one canonical repository gate plus a Pi host smoke test:

```bash
npm run verify:cloud
npm run cloud:smoke
```

## 13. Next documents

- [Architecture](./architecture.md) for the runtime topology and permission flow.
- [API reference](./api-reference.md) for commands, settings and schemas.
- [Tool calling](./tool-calling.md) for execution and cancellation semantics.
- [Custom agents](./custom-agents.md) for project agent definitions.
- [Troubleshooting](./troubleshooting.md) when installation or runtime behavior differs from this guide.
- [Performance](./PERFORMANCE.md) before tuning concurrency or UI refresh behavior.
