# Documentation

This directory is the canonical documentation set for `@groeponline/pi-agent-orchestrator`.

If you are new to the project, start with [Getting started](./getting-started.md), then use [Architecture](./architecture.md) and [Tool calling](./tool-calling.md) when you need the execution contracts behind the UI.

## Start here

| Document | Use it for |
| --- | --- |
| [Getting started](./getting-started.md) | Install, first run, core mental model, safe operating patterns |
| [Architecture](./architecture.md) | Runtime topology, permission resolution, lifecycle and module map |
| [Tool calling](./tool-calling.md) | Tool schemas, execution ordering, cancellation, steering, concurrency and result ownership |
| [API reference](./api-reference.md) | Commands, settings, tools, handoffs and scheduler details |
| [Custom agents](./custom-agents.md) | `.pi/agents/*.md` frontmatter, custom definitions and examples |

## Orchestration and execution

| Document | Use it for |
| --- | --- |
| [Execution strategies](./execution-strategies.md) | `single`, `crew`, `swarm` and `auto` dispatch behavior |
| [Agentic loop spec](./agentic-loop-spec.md) | Dispatch → execute → validate → handoff loop model |
| [Orchestra execution contract](./orchestra-execution-contract.md) | Higher-level workflow guarantees and evidence expectations |
| [Prompt compression](./prompt-compression.md) | Static prompt compression profiles and exact scope |
| [Motion profiles](./motion-profiles.md) | UI motion and rendering behavior |
| [Handoff docs](./handoff/) | Structured transfer formats and handoff-specific notes |

## Operations and diagnostics

| Document | Use it for |
| --- | --- |
| [Performance](./PERFORMANCE.md) | Performance budgets, benchmarks and render/spawn behavior |
| [Performance how-to](./HOWTO-perf.md) | Reproduce profiling and interpret performance gates |
| [Runtime profile evaluation](./runtime-profile-evaluation.md) | Reproduce package/load-cost attribution and the profile-first package decision |
| [Overdrive patterns](./overdrive-patterns.md) | Performance optimization patterns and linter rules |
| [Troubleshooting](./troubleshooting.md) | Environment checks and common operator fixes |
| [Assets layout](./assets-layout.md) | Source-controlled visuals, generated media and external binary asset ownership |
| [Repository layout](./repository.md) | Source tree and repository structure |

## Releases

| Release | Notes |
| --- | --- |
| [v0.19.1](./releases/v0.19.1.md) | Bounded Explore handoff demo, install helper and hardened capture preflight |

The full version history remains in [`../CHANGELOG.md`](../CHANGELOG.md).

## Skills and packaged workflows

The npm package ships progressive-disclosure skills and prompt templates. Their full source is in the repository so the execution contract is reviewable.

| Resource | Purpose |
| --- | --- |
| [`../skills/pi-orchestra/SKILL.md`](../skills/pi-orchestra/SKILL.md) | Evidence-first multi-agent operating model |
| [`../skills/pi-typescript-extension-engineering/SKILL.md`](../skills/pi-typescript-extension-engineering/SKILL.md) | Strict TypeScript and Pi extension engineering |
| [`../skills/real-product-showcase/SKILL.md`](../skills/real-product-showcase/SKILL.md) | Real product capture and media verification |

Packaged templates:

- `/orchestra-audit [scope]`
- `/orchestra-plan <goal>`
- `/orchestra-implement <goal>`

## Project and contributor references

| File | Purpose |
| --- | --- |
| [`../README.md`](../README.md) | Public product overview and install path |
| [`../AGENTS.md`](../AGENTS.md) | Repository invariants for coding agents and contributors |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | Development and pull-request workflow |
| [`../SECURITY.md`](../SECURITY.md) | Vulnerability reporting |
| [`../ROADMAP.md`](../ROADMAP.md) | Public scope and roadmap |
| [`../CHANGELOG.md`](../CHANGELOG.md) | Version history |
| [`../RELEASE.md`](../RELEASE.md) | Release and post-publish verification |

## Visual sources

The README and architecture overview use [`images/orchestration_flow.svg`](./images/orchestration_flow.svg), a small source-controlled SVG. Generated social cards, posters and video remain separate showcase outputs; see [Assets layout](./assets-layout.md). This keeps the primary documentation visual reviewable in diffs instead of coupling basic documentation to a large generated image.
