# @groeponline/pi-agent-orchestrator

> Multi-agent orchestration for the Pi coding agent: autonomous subagents,
> isolated worktrees, swarms, schedules, structured handoffs, prompt compression,
> and live terminal observability.

[![npm version](https://img.shields.io/npm/v/@groeponline/pi-agent-orchestrator)](https://www.npmjs.com/package/@groeponline/pi-agent-orchestrator)
[![npm downloads](https://img.shields.io/npm/dm/@groeponline/pi-agent-orchestrator)](https://www.npmjs.com/package/@groeponline/pi-agent-orchestrator)
[![CI](https://github.com/GroepOnline/pi-agent-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/GroepOnline/pi-agent-orchestrator/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

## Install or try it immediately

Install globally in Pi:

```bash
pi install npm:@groeponline/pi-agent-orchestrator
```

Try the published package for one session without changing your settings:

```bash
pi -e npm:@groeponline/pi-agent-orchestrator
```

For a project-local install:

```bash
pi install npm:@groeponline/pi-agent-orchestrator -l
```

Requires Node.js 22.19.0 or newer and `@earendil-works/pi-coding-agent` 0.81.1 or newer.
Use `pi install`; running `npm install` alone does not register the package resources with Pi.

## Why this package

| Capability | What it gives you |
| --- | --- |
| Autonomous subagents | Explore, Plan, Analysis, general-purpose, and custom agents with bounded execution |
| Parallel orchestration | Background groups, swarms, structured handoffs, and controlled concurrency |
| Safe isolation | Permission inheritance, partition filtering, budgets, depth limits, and optional git worktrees |
| Operator control | Interactive `/agents` dashboard, live status, steering, termination, schedules, and performance views |
| Ready-made workflows | Progressive-disclosure orchestration and Pi TypeScript engineering skills plus audit, plan, and implementation prompt templates |
| Local execution | No hosted control plane, no package-owned telemetry backend, and no package-owned data service |

The extension runs inside the Pi host process. It does not make outbound network calls of its own and does not store user data on a hosted service.

## Real terminal showcase

The preview is rendered from the compiled dashboard, resource top view, and widget implementation. Remotion supplies the framing and encoding; the terminal content comes from the actual product renderers.

[![Pi Agent Orchestrator terminal preview](https://raw.githubusercontent.com/GroepOnline/pi-agent-orchestrator/main/docs/images/dashboard_preview.svg)](https://groeponline.github.io/pi-agent-orchestrator/assets/product_film.mp4)

- [Watch the product film](https://groeponline.github.io/pi-agent-orchestrator/assets/product_film.mp4) — the full Remotion-rendered showcase
- [Watch the dashboard preview](https://groeponline.github.io/pi-agent-orchestrator/assets/dashboard_preview.mp4)
- [Open the agent-readable project site](https://groeponline.github.io/pi-agent-orchestrator/)
- [Read the Pi package documentation](https://pi.dev/docs/latest/packages)

## First useful run

Start Pi with the package, then run the packaged audit template:

```text
/orchestra-audit src
```

Open the control surface while the agents run:

```text
/agents
```

Useful controls:

- `j` / `k` or arrows: navigate agents
- `Space`: multi-select
- `t`: resource top view
- `z`: daemon schedules
- `Shift+K`: terminate selected agents
- `?`: help
- `/perf`: performance metrics

The Pi footer can expose live running and queued counts through the `subagents` status slot.

## Packaged skills and Orchestra workflows

The npm package includes three skills and three prompt templates. Pi loads only each skill description into the system prompt; the full workflow is read on demand.

| Command | Use |
| --- | --- |
| `/skill:pi-orchestra` | Load the complete evidence-first orchestration operating model |
| `/skill:pi-typescript-extension-engineering` | Engineer and review strict TypeScript across Pi tools, sessions, TUI, persistence, tests, and package boundaries |
| `/skill:real-product-showcase` | Record real terminal, browser, or app demos and check framing plus media gates |
| `/orchestra-audit [scope]` | Run three parallel read-only audits and synthesize ranked findings |
| `/orchestra-plan <goal>` | Gather evidence in parallel and produce a mechanically verifiable plan |
| `/orchestra-implement <goal>` | Discover, plan, implement in one isolated writer, and independently verify |

Install skills into Cursor, Codex, Claude Code, or another Agent Skills-compatible client:

```bash
npx skills add https://github.com/GroepOnline/pi-agent-orchestrator --skill real-product-showcase
npx skills add https://github.com/GroepOnline/pi-agent-orchestrator --skill pi-typescript-extension-engineering
```

The templates deliberately avoid automatic merge, publish, tag, or deploy actions unless those actions are explicitly part of the request.

## Built-in agent types

| Type | Mode | Use when |
| --- | --- | --- |
| Explore | read-only | Parallel codebase discovery and evidence collection |
| Plan | read-only | Architecture and implementation planning before edits |
| Analysis | read-only + `ctx_*` | Sandboxed data or compute through optional `@onlinechef/context-mode` |
| general-purpose | full tools | Bounded implementation and multi-step execution |

Create project agents in `.pi/agents/*.md`. See [Custom Agents](docs/custom-agents.md) for the complete frontmatter schema.

## Core capabilities

- **Interactive TUI dashboard** — agent list, resource top, daemon schedules, performance metrics, help, and settings.
- **Subagent lifecycle** — spawn, queue, steer, stop, inspect, and collect structured results.
- **Permission inheritance** — children cannot silently regain tools or scopes removed by a parent.
- **Worktree isolation** — optional branch and filesystem isolation for implementation agents.
- **Prompt compression profiles** — static system-prompt guidance with global defaults and per-agent overrides; this does not compact conversation history.
- **Persistent scheduling** — cron, interval, and one-shot jobs with a daemon schedule view.
- **Structured handoffs** — machine-readable transfer between agents and chained workflows.
- **Swarm coordination** — dynamic membership and coordinated completion.
- **Cross-extension RPC** — capability-based integration for trusted peer extensions.

Default orchestration mode is `single`; multi-agent modes are opt-in.

## Documentation

- [Architecture](docs/architecture.md) — module map and data flow.
- [Tool calling and execution contract](docs/tool-calling.md) — schemas, lifecycle ordering, cancellation, steering, concurrency, result ownership, telemetry, and test invariants.
- [API reference](docs/api-reference.md) — tools, settings, handoffs, and scheduler.
- [Custom agents](docs/custom-agents.md) — frontmatter schema and examples.
- [Prompt compression](docs/prompt-compression.md) — exact scope and impact.
- [Performance](docs/PERFORMANCE.md) — render budgets and benchmarks.
- [Troubleshooting](docs/troubleshooting.md) — common operator fixes.
- [Orchestra skill](skills/pi-orchestra/SKILL.md) — evidence-first multi-agent operating model.
- [Pi TypeScript extension engineering skill](skills/pi-typescript-extension-engineering/SKILL.md) — strict host-compatible TypeScript for extensions and SDK orchestration.
- [Real product showcase skill](skills/real-product-showcase/SKILL.md) — real terminal/browser/app capture, post, and media checks. No fake hero UI.
- [AGENTS.md](AGENTS.md) — repository invariants for contributors and coding agents.
- [CHANGELOG.md](CHANGELOG.md) — release history.
- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution workflow.
- [SECURITY.md](SECURITY.md) — private vulnerability reporting.

## Development

```bash
npm ci
npm run setup:hooks   # optional local git hooks
npm run typecheck
npm run lint
npm test
npm run build
npm run verify:package
```

### Cursor Cloud

The repository ships a deterministic [Cursor Cloud](https://cursor.com/docs/cloud-agent/setup)
environment in `.cursor/environment.json` + `.cursor/Dockerfile`. The Dockerfile
pins Node to the `.nvmrc` version (`node:22.19.0-bookworm`) so bare shells use a
compliant Node by default; it installs with `scripts/cursor-cloud-install.sh` and
exposes one canonical gate:

```bash
npm run verify:cloud   # typecheck + lint + test + build + verify:package + release policy
npm run cloud:smoke    # load the built extension through the real Pi host (no API key)
```

## License

MIT © GroepOnline
