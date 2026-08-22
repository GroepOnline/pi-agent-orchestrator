# Orchestra Run model

`OrchestraRun` is the execution-local representation of one user task inside `pi-agent-orchestrator`.

It is deliberately **not** a durable mission/checkpoint engine. `pi-missions` remains authoritative for cross-restart mission state, replay and logical retry attempts.

## Hierarchy

```text
Session
└── OrchestraRun
    ├── RunStep
    │   └── Agent worker(s)
    └── RunStep
        └── Agent worker(s)
```

The Run owns task-level execution state. `AgentManager` continues to own individual worker lifecycle.

## Core state

A Run stores:

- requested and effective execution strategy
- structured decision reasons
- run-level delivery policy
- dependency-aware steps
- all worker IDs owned by the run
- execution correlation from an upstream caller
- usage, artifacts, result/error and timing
- an execution-local event timeline

## Correlation and idempotency

If a durable caller supplies the CHE-142 mission/task/attempt correlation envelope, `RunManager.create()` validates it and deduplicates duplicate deliveries of the same idempotency key **within the current process**.

This protects one live execution from transport duplicates. It does not replace durable replay/idempotency state in `pi-missions`.

## Dependency state

A step with no dependencies starts as `ready`.

A dependent step starts as `waiting_dependency`. It becomes `ready` only when every declared dependency has completed successfully. `startStep()` refuses to run a step whose dependencies are not complete.

This is the primitive CHE-133 will use for a real Plan → Implement → Review WorkflowRunner.

## Cancellation

Run cancellation is idempotent:

- active worker IDs are passed to an optional worker-controller adapter;
- non-terminal steps become cancelled;
- waiting steps can no longer start;
- one `run:cancelled` event is emitted.

RunManager itself does not persist durable cancellation intent.

## Event timeline

The initial event contract includes:

- run created / strategy resolved / started / status changed
- run agent attached / artifact added
- step created / status changed / worker attached / artifact added
- run completed / failed / cancelled

CHE-138 will extend this event vocabulary into the full operator timeline and tracing surface.

## Separation from AgentManager

`RunManager` does not import or construct `AgentManager`. It accepts only an optional minimal cancellation adapter. This keeps the existing one-worker lifecycle primitive independently usable and prepares CHE-135 to remove hidden multi-agent fan-out from the Agent tool without entangling the domain model.
