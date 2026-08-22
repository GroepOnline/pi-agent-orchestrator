# Orchestra vNext execution strategies

The user-facing strategy vocabulary is deliberately small and unambiguous.

## Focused

Exactly one worker executes one Run.

Focused is authoritative when selected explicitly. Adaptive signals in the task do not override an explicit Focused choice.

## Adaptive

A deterministic resolver chooses Focused, Parallel or Workflow and records:

- requested strategy (`adaptive`)
- effective strategy
- structured reason codes
- resolver version

The v1 resolver intentionally mirrors the current routing precedence so terminology/domain migration does not silently change dispatch behavior at the same time.

Current reason catalog:

- `explicit_strategy`
- `planning_required`
- `review_required`
- `refactor_validation`
- `multi_file_implementation`
- `multi_step_implementation`
- `comparison_requested`
- `explicit_parallelism`
- `narrow_task`

A later model-assisted resolver, if introduced, must be a separate observable contract rather than silently replacing deterministic routing.

## Parallel

Parallel means concurrent **independent** workers. It does not imply agent-to-agent collaboration.

Three variants are explicit:

### `same-task`

Multiple independent attempts receive the same prompt. This is the vNext name for the useful part of the current orchestration `swarm` behavior.

### `perspectives`

Workers receive the same underlying task with distinct role/perspective framing, for example security, architecture and testing.

### `split`

The caller supplies independent subtasks. Each worker receives the original task plus exactly one assigned subtask.

A synthesis step is separate from Parallel itself. If synthesis depends on all worker outputs, model it explicitly as a Workflow step.

### Partial failure

Parallel aggregation preserves member order and reports one of:

- `completed` — all members completed
- `partial` — at least one completed and at least one did not
- `failed` — no completion and at least one failure
- `cancelled` — every member cancelled (or no successful/failed result remains)

Partial success is never disguised as full success.

## Workflow

Workflow is dependency-aware execution. CHE-133 implements the runner using RunManager's step dependency primitives.

Canonical example:

```text
Plan → Implement → Review
                  ├─ PASS → Complete
                  └─ FAIL → Revision → Review
```

Workflow is categorically different from Parallel: downstream steps consume outputs/artifacts from completed dependencies.

## Legacy mapping

During migration only:

- `single` → Focused
- `auto` → Adaptive
- `swarm` orchestration → Parallel `same-task`
- `crew` → Workflow

The legacy names are compatibility aliases, not the final operator vocabulary.
