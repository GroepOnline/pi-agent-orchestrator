# WorkflowRunner contract

`WorkflowRunner` is the execution-local dependency engine for Orchestra vNext. It replaces the current `crew` fan-out behavior with runtime-enforced ordering and explicit artifact flow.

It is **not** a durable mission engine. Cross-restart checkpoints, replay and mission-level retries remain owned by `pi-missions`.

## Dependency invariant

A workflow step can start only when every declared dependency is `completed`.

```text
waiting_dependency → ready → running → completed
```

The dependency graph lives in `RunManager`; prompt text is not used as a substitute for sequencing.

Independent `ready` steps may run concurrently. Dependent steps cannot race ahead.

## Dependency output contract

Every worker receives structured output from its completed dependencies:

- dependency step id
- textual result
- artifact references

Downstream prompts are built from this real completed state.

## Canonical Plan → Implement → Review workflow

```text
Plan
  ↓
Implement
  ↓
Review
  ├─ PASS → Complete
  └─ FAIL → Revision → Review
```

### Plan

The planner receives the original task and returns an implementation plan plus useful artifact/file references.

### Implement

The executor cannot start before Plan completes. It receives the original task plus the planner's actual result and artifacts.

### Review

The reviewer cannot start before Implement completes. It receives the original task plus the executor's actual result and artifacts.

The reviewer returns a structured verdict:

```json
{
  "verdict": "PASS",
  "findings": [],
  "summary": "Implementation satisfies the request"
}
```

An unparseable review fails closed rather than being treated as success.

## Bounded revision loop

A failed review may create a bounded revision cycle. The first vNext implementation supports 0–3 revisions, default 1.

A Revision step depends on both:

1. the implementation/revision it is changing; and
2. the review that rejected it.

That guarantees the revision worker receives both the prior implementation artifacts and the reviewer findings.

The next Review depends on the completed Revision and therefore reviews the revised output, not stale artifacts.

If the review remains `FAIL` after the configured revision budget, the Run fails with `workflow_review_failed`.

## Cancellation

Cancellation is execution-local and idempotent:

- active worker transports receive best-effort cancel;
- RunManager marks the Run cancelled;
- active/waiting steps become cancelled;
- dependency-waiting steps can never start afterward.

Durable cancellation intent after restart belongs to `pi-missions`.

## Generic workflows

`WorkflowRunner.run()` supports an arbitrary ordered DAG defined by step metadata:

- id / title / role
- worker agent type
- dependency ids
- failure policy
- prompt builder consuming real dependency outputs

Multiple independent ready nodes can execute in the same wave.

## Migration from legacy crew

Legacy `crew` currently means three parallel workers with planner/executor/reviewer labels. vNext `Workflow` is materially different: the dependency graph is executable state.

The `KNOWN_MISMATCH` characterization for parallel crew execution must be replaced by dependency-order tests when the runtime entry path switches to WorkflowRunner.