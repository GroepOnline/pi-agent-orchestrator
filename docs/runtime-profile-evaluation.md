# Runtime profile evaluation

This document records the profile-first evaluation requested by issue #73. The decision is based on reproducible package and cold-import measurements rather than package-count optics.

## Reproduce

From a clean checkout with dependencies installed:

```bash
npm ci
npm run bench:profile
```

`bench:profile` builds the package, runs `npm pack --dry-run`, inspects the lockfile/runtime engines, and measures cold ESM imports in fresh Node processes. Set `BENCH_RUNS=N` to change the sample count (minimum 3).

Reference measurement:

- source: hardening working tree based on `main` at `b43a334e34e4c60aa9070c927303b7faf2f70cf8`
- host: `chef-control-az-01`, Linux x64
- Node: `v26.8.1`
- samples: 5 cold processes per import group
- package: `@groeponline/pi-agent-orchestrator@0.19.0`

## Package surface

| Metric | Measured |
| --- | ---: |
| npm tarball | 728,209 bytes (711.1 KiB) |
| unpacked package | 2,746,535 bytes (2.62 MiB) |
| packed files | 390 |
| production lock packages | 11 |
| direct runtime dependencies | 6 |

The package does not ship `showcase/`, `site/`, or `docs/images/`; showcase media therefore contributes zero bytes to the npm tarball.

### Unpacked bytes by feature

| Feature | Bytes | Share |
| --- | ---: | ---: |
| subagent/core runtime | 1,048,695 | 38.2% |
| TUI + commands | 836,499 | 30.5% |
| swarms/groups/workflows | 223,159 | 8.1% |
| observability/debug capture | 123,349 | 4.5% |
| scheduling | 70,264 | 2.6% |
| worktrees | 17,113 | 0.6% |
| docs/skills/prompts/other | 427,456 | 15.6% |

This is file-size attribution, not an additive runtime-memory model. The benchmark classifies both `src/` and `dist/` copies consistently because both are intentionally shipped today.

## Cold-load attribution

Each row imports only the named feature group in a new process. Results overlap because modules share the Pi host and are intentionally not additive.

| Import group | Median cold import | Median RSS delta |
| --- | ---: | ---: |
| Pi coding-agent host only | 747.96 ms | 102.41 MiB |
| core agent path | 839.42 ms | 124.12 MiB |
| worktrees | 14.37 ms | 11.88 MiB |
| swarms/groups/workflows | 4.47 ms | 5.88 MiB |
| scheduling | 25.24 ms | 13.38 MiB |
| observability | 796.83 ms | 108.18 MiB |
| TUI | 755.71 ms | 103.70 MiB |
| full extension entry point | 841.04 ms | 110.63 MiB |

The dominant cold-load cost is the Pi host itself. The full entry point adds roughly 93 ms over importing the host alone on this machine; splitting orchestration features into a second npm package would not remove that host floor.

## Dependency and Node-floor attribution

The direct runtime graph is small:

- core: `@sinclair/typebox`, `nanoid`
- worktrees: `proper-lockfile` (+ `graceful-fs`, `retry`, `signal-exit`)
- scheduling: `croner`
- observability: `@opentelemetry/api`, `posthog-node` (+ `@posthog/core`, `@posthog/types`)

The Pi execution peers (`pi-ai`, `pi-agent-core`, `pi-coding-agent`) declare Node `>=22.19.0`. `posthog-node@5.51.4` declares `^20.20.0 || >=22.22.0`. The package/release floor remains `>=22.22.3` because release-critical CI deliberately pins that operational runtime.

Therefore the `22.22.3` floor is not required by core subagent execution. It is stricter than the Pi core floor and is currently justified by the opt-in PostHog path plus one release-runtime SSOT. Lowering it independently would make package metadata disagree with release-critical `.nvmrc` policy, so this evaluation does not introduce a split runtime floor.

## Decision: profile first, no package split

Do **not** create `pi-agent-orchestrator-core` in the 0.19 train.

A second package would require another public API/version/security/release surface, while the measured install graph is 11 production packages and the unavoidable Pi-host cold-start floor dominates runtime cost. The largest removable tarball category is TUI code, but the entire package is only 711.1 KiB compressed and the showcase assets are not packed at all.

A `core` runtime profile is therefore not enabled yet. With the current static module graph it would mostly suppress initialization after modules are loaded, while retaining the same Pi-host import cost. That is not enough measured benefit to justify a new user-facing mode in a stabilization patch.

## Revisit threshold

Re-run this decision before splitting packages if one of these becomes true:

- compressed npm size exceeds 2 MiB because optional feature code grows;
- non-core direct runtime dependencies exceed 20 packages;
- a lazy-import prototype removes at least 20% of full-extension cold-import time or RSS after subtracting the Pi-host baseline;
- consumers need a different security/permission boundary that cannot be expressed by existing settings and tool permissions.

Until then, optimize inside the package and keep one compatibility surface.

## 0.19.1.2 hardening closure matrix

The runtime defects grouped with this evaluation are already corrected on `main` and are protected by regression tests:

| Issue | Current contract | Regression evidence |
| --- | --- | --- |
| #5 partial crew fan-out | spawned survivors are cancelled; the batch/swarm is explicitly partial with missing-member count | `orchestration-dispatch-integration.test.ts` |
| #6 budget-cut empty/plan-only | terminal outcome is `executed`, `blocked_budget`, or `not_executed`; budget cuts cannot masquerade as successful empty output | `task-budget.test.ts`, `tools-get-result.test.ts` |
| #7 stale/inconsistent limits | session limits apply live, warning ratios use the actual used/cap pair, and thresholds are deduplicated/re-armed on changes | `task-budget.test.ts`, `agent-manager-spend.test.ts`, `settings.test.ts` |
| #40 Done + empty output | empty completion is surfaced as `not_executed` with a reason; default agents are instructed to emit end reports | `task-budget.test.ts`, `tools-get-result.test.ts`, `agent-runner.test.ts` |
| #73 package split evaluation | measured here; no split/profile without a quantified threshold crossing | `npm run bench:profile` |

On current `main`, the focused six-file regression run passes 182/182 tests.
