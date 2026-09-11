<p align="center">
  <img src="https://raw.githubusercontent.com/GroepOnline/pi-agent-orchestrator/main/docs/images/dashboard_preview.gif" alt="Pi Agent Orchestrator live agent dashboard" width="100%">
</p>

<h1 align="center">Pi Agent Orchestrator</h1>

<p align="center"><strong>Turn one Pi session into a visible team of agents.</strong><br>Run parallel research, isolated implementation, swarms, schedules and handoffs without losing control of who is doing what.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@groeponline/pi-agent-orchestrator"><img src="https://img.shields.io/npm/v/@groeponline/pi-agent-orchestrator" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@groeponline/pi-agent-orchestrator"><img src="https://img.shields.io/npm/dm/@groeponline/pi-agent-orchestrator" alt="npm downloads"></a>
  <a href="https://pi.dev/packages/@groeponline/pi-agent-orchestrator"><img src="https://img.shields.io/badge/Pi-package-9b59b6.svg" alt="Pi package"></a>
  <a href="https://github.com/GroepOnline/pi-agent-orchestrator/actions/workflows/ci.yml"><img src="https://github.com/GroepOnline/pi-agent-orchestrator/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-yellow.svg" alt="MIT License"></a>
</p>

## Start in 10 seconds

```bash
pi install npm:@groeponline/pi-agent-orchestrator
```

Then run:
```text
/orchestra-audit src
/agents
```

That gives you a first useful run immediately: read-only agents fan out over the codebase, results come back into one synthesis, and `/agents` shows the live queue while it happens.

## See the operator surface

This is the actual terminal UI, not a mockup. The dashboard stays in the same Pi process as the agents it is supervising.

<table>
<tr>
<td width="50%"><img src="https://raw.githubusercontent.com/GroepOnline/pi-agent-orchestrator/main/docs/images/showcase_dashboard.gif" alt="Pi Agent Orchestrator live dashboard with agent queue and status" width="100%"><br><sub>Live agent queue, state and results.</sub></td>
<td width="50%"><img src="https://raw.githubusercontent.com/GroepOnline/pi-agent-orchestrator/main/docs/images/showcase_top_view.gif" alt="Pi Agent Orchestrator resource top view" width="100%"><br><sub>Resource and performance view while work is running.</sub></td>
</tr>
</table>

Prefer a one-off session first?

```bash
pi -e npm:@groeponline/pi-agent-orchestrator
```

## Three things to try first

### 1. Audit a codebase in parallel

```text
/orchestra-audit src
```

Use this when one agent would otherwise spend several turns walking the tree serially. Explore agents stay read-only, work in parallel and return evidence to one parent.

### 2. Implement without agents stepping on each other
```text
/orchestra-implement "Fix the scheduler race and verify it"
```

The packaged workflow discovers first, plans the change, gives implementation to one bounded writer and verifies the result independently. Implementation agents can use git worktrees so parallel work does not share one mutable checkout.

### 3. Keep recurring agent work visible

Open the daemon view from `/agents` with `z`, or schedule a bounded recurring job. Schedules persist, expose next-run state and stay inspectable from the same operator surface.

## What you see while it runs

`/agents` is the live operator view for the current Pi process:

- running and queued agents;
- current task and agent type;
- resource usage and performance metrics;
- schedules and daemon state;
- multi-select, steering and termination;
- structured results and handoff state.

Common controls:

| Key | Action |
| --- | --- |
| `j` / `k` or arrows | Navigate |
| `Space` | Multi-select |
| `t` | Resource top view |
| `z` | Daemon schedules |
| `Shift+K` | Terminate selected agents |
| `?` | Help |
| `/perf` | Performance metrics |

[Watch the full product film](https://raw.githubusercontent.com/GroepOnline/pi-agent-orchestrator/main/docs/images/product_film.mp4) · [Open the showcase](https://orchestrator.chefgroep.online/showcase)

## Why this exists

Pi deliberately keeps the core small. That is useful until a job needs several independent lines of work at once.

Pi Agent Orchestrator adds that execution layer without replacing Pi itself. The host still owns the session, tools and model path. The orchestrator adds bounded child agents, isolation, coordination, schedules and one place to watch the whole run.

| When you need to… | Use |
| --- | --- |
| inspect several areas at once | parallel Explore agents |
| plan before editing | read-only Plan agents |
| make changes without checkout collisions | isolated implementation worktrees |
| coordinate several workers | crew or swarm orchestration |
| continue work on a cadence | persistent schedules |
| pass explicit state between workers | structured handoffs |
| stop or steer work mid-run | `/agents` controls |

## Core capabilities

- **Interactive TUI dashboard** — inspect agents, queues, schedules, resources, health and performance while work is live.
- **Subagent lifecycle** — spawn, queue, steer, stop, inspect and collect structured results.
- **Permission inheritance** — child agents can only become more restricted than their parent.
- **Worktree isolation** — give implementation agents separate branches and filesystems when parallel writes would collide.
- **Persistent scheduling** — cron, interval and one-shot jobs with daemon visibility.
- **Structured handoffs** — pass machine-readable state between agents instead of relying on hidden chat context.
- **Swarm coordination** — coordinate dynamic membership and completion across several workers.
- **Prompt compression profiles** — reduce static system-prompt overhead with global and per-agent profiles.
- **Cross-extension RPC** — authenticated peer-extension calls with a strict spawn allowlist and mutation rate limits.

## Built-in agent types

| Type | Mode | Best for |
| --- | --- | --- |
| Explore | read-only | Fast parallel codebase discovery and evidence gathering |
| Plan | read-only | Architecture and implementation planning before edits |
| Analysis | read-only + `ctx_*` | Sandboxed data or compute with optional `@groeponline/context-mode` |
| general-purpose | full tools | Bounded implementation and multi-step execution |

Project-specific agents can live in `.pi/agents/*.md` with their own tools, models and limits. See [Custom agents](docs/custom-agents.md).

## How a run is bounded

Autonomy is explicit, not just a prompt convention. Before a child runs, the orchestrator resolves inherited tool restrictions, partition filters, explicit disallow rules, depth limits, turn limits, token budgets and optional worktree isolation.

A child cannot silently regain a tool or scope removed by its parent.

The package does not automatically merge, publish, tag or deploy unless the workflow you run explicitly asks for those actions.
## How orchestration fits together

<p align="center">
  <img src="https://raw.githubusercontent.com/GroepOnline/pi-agent-orchestrator/main/docs/images/orchestration_flow.svg" alt="Pi Agent Orchestrator execution flow" width="100%">
</p>

The dispatcher supports `single`, `crew`, `swarm` and `auto` strategies. Multi-agent execution is opt-in; the default remains `single`.

Use the packaged workflows when you want a good default:

| Entry point | What it does |
| --- | --- |
| `/orchestra-audit [scope]` | Parallel read-only inspection followed by ranked synthesis |
| `/orchestra-plan <goal>` | Evidence gathering followed by a mechanically verifiable plan |
| `/orchestra-implement <goal>` | Discover, plan, implement with one writer and independently verify |
| `/skill:pi-orchestra` | Operating model for evidence-first orchestration |
| `/skill:pi-typescript-extension-engineering` | Pi extension engineering and review guidance |
| `/skill:real-product-showcase` | Real terminal/browser/app capture and media verification |

You can also install the packaged Agent Skills into another compatible client:

```bash
npx skills add https://github.com/GroepOnline/pi-agent-orchestrator --skill real-product-showcase
npx skills add https://github.com/GroepOnline/pi-agent-orchestrator --skill pi-typescript-extension-engineering
```

## Where it fits in the GroepOnline Pi stack
| Stage | Package | Owns |
| --- | --- | --- |
| Capture | [`pi-wishcraft`](https://github.com/GroepOnline/pi-wishcraft) | Operator cockpit and lightweight ideas |
| Persist | [`pi-missions`](https://github.com/GroepOnline/pi-missions) | Durable plan, queue, evidence, recovery and mission handoff state |
| Execute | **pi-agent-orchestrator** | Agents, worktrees, swarms, schedules and execution handoffs |

A common path is `idea → mission → orchestration run`, but the orchestrator also works standalone.

## Documentation

- [Getting started](docs/getting-started.md)
- [Architecture](docs/architecture.md)
- [Execution strategies](docs/execution-strategies.md)
- [Tool calling](docs/tool-calling.md)
- [API reference](docs/api-reference.md)
- [Custom agents](docs/custom-agents.md)
- [Prompt compression](docs/prompt-compression.md)
- [Performance](docs/PERFORMANCE.md)
- [Troubleshooting](docs/troubleshooting.md)
- [v0.19.2 release notes](docs/releases/v0.19.2.md)

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run verify:package
```
For the canonical repository gate in cloud environments:

```bash
npm run verify:cloud
npm run cloud:smoke
```

## Privacy

The extension runs inside the Pi host process. There is no package-owned hosted control plane and no package-owned telemetry backend. Optional telemetry is inert until explicitly configured by the operator.

## License

MIT © GroepOnline
