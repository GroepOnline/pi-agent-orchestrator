# Pre-vNext orchestration behavior matrix

Status: characterization baseline for CHE-131. This document describes **current behavior**, not the desired vNext contract.

## Agent tool cardinality

| Global orchestration mode | One `Agent()` call currently creates | Join assigned by dispatcher |
| --- | ---: | --- |
| `single` | 1 worker | caller/default join path |
| `auto` → single | 1 worker | caller/default join path |
| `auto` → swarm | 2 workers by default | `swarm` |
| `auto` → crew | 3 workers | `group` |
| `swarm` | 2 workers by default | `swarm` |
| `crew` | 3 workers | `group` |

This is the hidden-fan-out behavior CHE-135 will intentionally replace.

## Crew mismatch

Current `crew` planning text describes `planner → executor → reviewer`, but runtime materialization is fan-out:

1. all three members are created as background agents in one loop;
2. all member promises are collected;
3. foreground execution waits with `Promise.allSettled`;
4. planner output is not injected into executor input;
5. executor output/artifacts are not injected into reviewer input.

The reviewer prompt currently says the executor "has just completed" even though no runtime dependency enforces that statement. CHE-133 intentionally replaces this behavior with dependency-aware Workflow execution.

## Join/batch behavior

- orchestration `crew` hard-assigns `joinMode=group`;
- orchestration `swarm` hard-assigns `joinMode=swarm`;
- `smart` and `group` are handled by the same GroupJoinManager batch path;
- batch capture is debounce-based (default 100 ms in the production BatchOrchestrator path);
- foreground orchestrated fan-out flushes the batch before waiting for member completion;
- consumed results are suppressed from later completion delivery.

The current JOIN and ORCH settings therefore do **not** form a clean independent matrix.

## Auto routing

The current resolver is deterministic keyword/shape analysis:

- planning/review signal → crew;
- refactor + test/multiple-files → crew;
- implementation + multiple-files → crew;
- long multi-step implementation → crew;
- parallel/comparison signal → swarm;
- otherwise → single.

This baseline is intentionally retained until CHE-134 introduces typed vNext strategy reasons.

## Parallel/swarm behavior

Current orchestration `swarm` means repeated independent attempts:

- default size: 2;
- each member receives the same prompt;
- member descriptions differ only by `(1/N)`, `(2/N)`, ...;
- it is not task decomposition;
- it does not, by itself, guarantee agent-to-agent collaboration.

## Compatibility classification

| Current behavior | vNext disposition |
| --- | --- |
| direct Agent hidden fan-out | intentionally removed by CHE-135 |
| crew parallel fan-out | intentionally removed by CHE-133 |
| `single` one-worker behavior | preserve |
| deterministic auto routing | migrate into Adaptive with reason codes |
| same-prompt swarm fan-out | migrate as Parallel `same-task` variant |
| `smart` / `group` user-facing distinction | remove unless semantics diverge |
| low-level group/swarm IDs | retain under diagnostics only |
| result-consumed notification suppression | preserve |
| foreground cancellation of all fan-out members | preserve at Run level |

## Existing test anchors

- `test/orchestration-dispatch.test.ts` — prompt analysis, resolver, swarm size, crew plan shape.
- `test/orchestration-dispatch-integration.test.ts` — Agent tool cardinality, actual group/swarm registration, aggregation, cancellation and partial failure.
- `test/batch-orchestrator.test.ts` — debounce/finalization, consumed-result suppression and coordinator routing.
- `test/vnext-current-contract.test.ts` — explicit KNOWN_MISMATCH assertions used as the vNext migration checklist.

When a vNext issue intentionally changes one of these behaviors, the corresponding characterization assertion must be replaced by a desired-contract test in the same change; it must not simply disappear.
