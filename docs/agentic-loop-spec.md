# Agentic Loop Specification — @groeponline/pi-agent-orchestrator

> **Status:** Living specification — v0.16.0+
> **Scope:** Fully autonomous agent loop without human in the loop. Covers spawn → execute → validate → handoff → repeat, plus scheduling and self-healing.

---

## 1. Overview

The pi-agent-orchestrator implements a **closed autonomous agentic loop**: once triggered (by a user, a schedule, or a prior agent's handoff), agents spawn, execute, self-validate, and produce structured handoffs that can chain into subsequent agents — all without human intervention.

This document formalizes the loop architecture, its phases, the decision heuristics, the failure recovery paths, and the design invariants that keep the system correct under autonomous operation.

### Loop diagram

```
┌───────────────────────────────────────────────────────────────┐
│                       AGENTIC LOOP                            │
│                                                               │
│  TRIGGER                                                      │
│  ├─ User command ("implement X")                              │
│  ├─ Scheduler (cron / interval / one-shot)                    │
│  └─ Handoff chain (prior agent's JSON handoff)                │
│         │                                                     │
│         ▼                                                     │
│  DISPATCH (orchestration-dispatch.ts)                         │
│  ├─ analyzePrompt → keyword signals                           │
│  ├─ heuristicPickMode → single / swarm / crew                 │
│  └─ buildPlan → swarm plan / crew roles                       │
│         │                                                     │
│         ▼                                                     │
│  SPAWN (agent-manager.ts + agent-runner.ts)                   │
│  ├─ Permission inheritance (parent→child)                     │
│  ├─ Partition filtering                                       │
│  ├─ Context building (parent log + sandbox)                   │
│  ├─ Model resolution + circuit breaker                        │
│  ├─ Deferred context (15-48% token savings)                   │
│  └─ Worktree isolation (optional, git worktree sandbox)       │
│         │                                                     │
│         ▼                                                     │
│  BATCH (batch-orchestrator.ts)                                │
│  ├─ 100ms debounce captures parallel spawns                   │
│  ├─ Partition by joinMode → swarm / group / individual        │
│  └─ Foreground flush ensures swarm exists before awaits       │
│         │                                                     │
│         ▼                                                     │
│  EXECUTE (agent-runner.ts runAgent)                           │
│  ├─ Turn loop with quota enforcement                          │
│  │   ├─ maxTurns + graceTurns soft/hard limit                 │
│  │   ├─ Token budget (default 500k)                           │
│  │   ├─ Duration budget (default 10min)                       │
│  │   └─ Tool call budget (default 100)                        │
│  ├─ Compaction (Pi upstream AgentSession auto-compaction; local prune helpers unwired — #325) │
│  ├─ OTel tracing (spans: agent → turn → tool)                 │
│  ├─ Swarm heartbeat + inter-agent messaging                   │
│  └─ Mid-run steering (steer_subagent queue injection)         │
│         │                                                     │
│         ▼                                                     │
│  VALIDATE (agent-runner.ts validators + validators.ts)        │
│  ├─ Adversarial validators (sandboxed, RO, levelLimit=0)      │
│  ├─ Up to 2 retry rounds with feedback                        │
│  └─ Self-healing: fixPrompt → resumeAgent → re-validate       │
│         │                                                     │
│         ▼                                                     │
│  HANDOFF (handoff.ts)                                         │
│  ├─ v2 typed artifacts (file / branch / url / note)           │
│  ├─ Legacy coercion for backward compat                       │
│  └─ Rendered for parent consumption                           │
│         │                                                     │
│         ▼                                                     │
│  REPEAT                                                       │
│  ├─ Handoff triggers next agent in chain                      │
│  ├─ Scheduler fires next cron job                             │
│  └─ Swarm members deliver results to parent                   │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

---

## 2. Trigger Phase

The loop starts from one of three entry points:

### 2.1 User command
A user types a prompt. The `Agent` tool's `execute()` path runs `resolveOrchestrationMode(...)` and fans out.

### 2.2 Scheduler (autonomous)
The `SubagentScheduler` fires cron/interval/one-shot jobs from `.pi/subagent-schedules/<sessionId>.json`. Jobs specify agent type, prompt, and recurrence. No human needed after initial job creation.

### 2.3 Handoff chain (autonomous)
When an agent configured with `handoff: true` finishes, its structured JSON handoff can be consumed by a parent orchestrator to spawn a follow-up agent. This enables fully autonomous multi-step chains.

---

## 3. Dispatch Phase

`src/orchestration-dispatch.ts` — the heuristic brain of the loop.

### 3.1 Orchestration modes

| Mode | Behavior | Human needed? |
|------|----------|---------------|
| `single` | One agent, standard execution | No (but initially triggered) |
| `swarm` | N parallel agents with same prompt (default 3, max 5), live strategy | No |
| `crew` | 3 role-specialized agents (planner → executor → reviewer) | No |
| `auto` | Heuristic analyzes prompt → picks single/swarm/crew | No |

### 3.2 Heuristic rules (`heuristicPickMode`)

```
plan/review/multiple-files keyword          → crew
refactor + (test OR multiple-files)         → crew
parallel keyword                             → swarm
long (>800 chars) + multi-step implement    → crew
otherwise                                    → single
```

### 3.3 Crew roles

| Role | Type | Permissions | Prompt |
|------|------|-------------|--------|
| Planner | Plan/Explore | Read-only | Draft implementation plan + files to touch |
| Executor | general-purpose | Full tools | Implement end-to-end |
| Reviewer | Explore/Analysis | Read-only | PASS/FAIL verdict against original request |

### 3.4 Dispatch history

Every decision is recorded in `src/dispatch-history.ts` (FIFO ring buffer, default cap 200). The `/agents → Health check` report surfaces a histogram:

```
total       : 47 (last 47 of 200-slot ring)
by kind     :
  single    : 38
  swarm     : 4
  crew      : 5
by source   :
  explicit  : 12 (user pinned single/swarm/crew)
  auto      : 35 (heuristic picked under auto mode)
auto picks  :
  →single   : 29
  →swarm    : 3
  →crew     : 3
```

This audit trail lets users tune the heuristic without reading code.

---

## 4. Spawn Phase

`src/agent-manager.ts` + `src/agent-runner.ts`

### 4.1 Permission inheritance (invariant)

The permission model enforces **directional, non-escapable restriction**:

1. **Base tools:** Agent config declares `builtinToolNames`
2. **Parent restriction:** Child tools = child ∩ parent (RO parent → RO child)
3. **Partition filter:** Memory partition boundary rules applied
4. **Disallow floor:** Absolute exclusion list (cannot be overridden)
5. **EXCLUDED_TOOL_NAMES:** Agent, get_subagent_result, steer_subagent are NEVER inherited

This invariant is critical for autonomous safety: a handoff-chain agent cannot accidentally gain write access if its parent was read-only.

### 4.2 Context injection

| Component | Source | Purpose |
|-----------|--------|---------|
| Parent execution log | `buildParentContext(ctx)` | Agent knows what happened before |
| Sandbox tools | `buildCtxInjection()` | Optional `ctx_*` tools for context-mode |
| Skills | `preloadSkills(config.skills)` | Pre-loaded skill blocks |
| Memory blocks | `buildMemoryBlock(...)` | Persistent memory partitions |
| System prompt | `buildAgentPrompt(...)` | Compression-level-appropriate prompt |

### 4.3 Model resolution

1. Agent config's `model` field (if set)
2. Host-configured `parentModel` (inherit from parent)
3. Circuit breaker validates model availability (5 consecutive failures → OPEN)

---

## 5. Execute Phase

### 5.1 Resource quotas (hard limits)

| Quota | Default | Behavior on exceed |
|-------|---------|--------------------|
| maxTurns | unlimited / configurable | Soft steer then abort after graceTurns |
| maxTokens | 500,000 | Hard abort |
| maxDurationMs | 600,000 (10 min) | Hard abort |
| maxToolCalls | 100 | Hard abort |
| depthLimit | 5 | Error before spawn |

### 5.2 Compaction (autonomous context management)

Live compaction is **Pi upstream `AgentSession` auto-compaction only** (#325). Local prune helpers in `src/compaction.ts` exist but are **not wired** into `runAgent` / `resumeAgent`.

When the upstream session compacts, the runner forwards:

- `onCompaction({ reason, tokensBefore })`
- hook events `compaction:start` (`{ reason }`) and `compaction:end` (`{ reason, tokensBefore }`)
- bus event `subagents:compacted` (`reason`, `tokensBefore`, `compactionCount`)

No human intervention needed. The agent continues after compaction seamlessly.

### 5.3 Turn lifecycle with OTel tracing

```
agent.run:Explore
├── agent.turn:1
│   ├── tool.call:read
│   └── tool.call:search
├── agent.turn:2
│   └── tool.call:write
└── agent.compaction
```

The `correlation.id` attribute (8 hex chars, generated at spawn via v4 UUID) ties all spans together and survives `resumeAgent`.

### 5.4 Swarm integration (autonomous)

When `enableHeartbeat: true`:
- Agent sends heartbeat every 10s to `SwarmCoordinator`
- Other swarm members can poll messages
- Swarm continues autonomously until all members complete

---

## 6. Validation Phase (Self-healing)

### 6.1 Adversarial validators

Agents configured with `validators: [...]` run post-completion validation:

- Validators are spawned as **sandboxed, read-only** agents (`isolated=true, levelLimit=0, skipValidators=true`)
- Each validator gets the agent's full response text + criteria
- Validators return `{ passed: boolean, criteria: [...] }`
- All validators run in parallel (`Promise.all`)

### 6.2 Self-healing retry loop

```
runAgent → validators → all passed?
  ├─ YES → done
  └─ NO  → format failed criteria as fixPrompt
           → resumeAgent(session, fixPrompt)
           → re-run validators (up to 2 retries)
           → still failing? accept result anyway
```

This self-healing loop runs autonomously — no human reviews validator output.

### 6.3 Validator sandbox invariants

| Property | Value | Rationale |
|----------|-------|-----------|
| `isolated` | `true` | Cannot access extensions/skills |
| `levelLimit` | `0` | Cannot spawn sub-agents |
| `skipValidators` | `true` | Cannot recurse infinitely |
| `maxTokens` | 50,000 | Budget cap |
| `maxDurationMs` | 120,000 | Time cap |
| `maxToolCalls` | 10 | Tool cap |

---

## 7. Handoff Phase

### 7.1 v2 typed artifacts

```json
{
  "agentType": "general-purpose",
  "summary": "Implemented feature X",
  "artifacts": [
    { "type": "file", "path": "src/feature.ts", "title": "Feature X implementation" },
    { "type": "branch", "branch": "feat/x", "base": "main", "commits": ["abc123"] },
    { "type": "url", "url": "https://example.com/docs", "description": "API reference" },
    { "type": "note", "title": "Next steps", "value": "Add tests for edge cases" }
  ]
}
```

### 7.2 Chain continuation

When an agent with `handoff: true` completes:
1. Handoff JSON is parsed from response text
2. Parent orchestrator reads `artifacts` and `summary`
3. Parent can spawn follow-up agent with handoff context
4. This can continue indefinitely (gated only by `levelLimit`)

### 7.3 Legacy coercion

Older agents emitting loose artifacts are auto-coerced to v2 shape via `coerceLegacyArtifact()`. No agent is stranded.

---

## 8. Scheduling (Fully Autonomous)

### 8.1 Job types

| Type | Trigger | Persists across sessions? |
|------|---------|---------------------------|
| `cron` | Cron expression (`0 9 * * 1-5`) | Yes (in schedule store) |
| `interval` | Fixed interval (`3600000` = 1h) | Yes |
| `one-shot` | Single future execution | Yes (auto-removed after run) |

### 8.2 Autonomous lifecycle

1. Scheduler loads jobs from `.pi/subagent-schedules/<sessionId>.json`
2. Timer fires → `schedule.ts` spawns agent via `manager.spawn()`
3. Agent runs through the full loop (execute → validate → handoff)
4. Results logged; job rescheduled for next cron/interval
5. One-shot jobs auto-remove after execution

### 8.3 Daemon integration

Four autonomous daemons ship as reference implementations:
- `github-activity-digest` — daily PR/issue summary
- `js-ts-dependency-upgrades` — weekly dependency audit
- `linear-issue-labeler` — auto-label incoming issues
- `pr-check-repair` — CI failure detection + auto-fix

---

## 9. Recovery & Resilience

### 9.1 Circuit breaker

`ModelCircuitBreaker` in `agent-runner.ts`:
- 5 consecutive model call failures → OPEN (rejects all calls)
- 30s timeout → HALF-OPEN (allows one trial call)
- Success → CLOSED (normal operation)

### 9.2 Error classification

`AgentRunnerError` codes:

| Code | Meaning | Loop behavior |
|------|---------|---------------|
| `depth_exceeded` | Agent tree too deep | Abort this branch; parent continues |
| `model_unavailable` | No model or CB open | Fatal; reported to parent |
| `quota_exceeded` | Token/duration/tool budget | Hard abort; results so far lost |
| `aborted` | External abort signal | Clean shutdown |
| `timeout` | Duration quota exceeded | Hard abort |

### 9.3 Span cleanup invariant

Even on error paths, all OTel spans are ended in `finally` blocks:

```typescript
finally {
  unsubTurns();
  collector.unsubscribe();
  cleanupAbort();
  if (currentTurnSpan) { endTurnSpan(currentTurnSpan); }
  for (const ts of activeToolSpans.values()) { endToolSpan(ts); }
  activeToolSpans.clear();
}
```

---

## 10. Observability

### 10.1 Health check (`/agents → Health check`)

Snapshots the full runtime state:
- Process (node version, memory, uptime)
- Tracing (enabled, tracer name)
- Circuit breaker (state, failures)
- Scheduler (active, job count)
- Swarm (coordinator, agents, deliveries)
- Agents (counts by status, recent errors with correlation ids)
- Settings (complete surface)
- Dispatch histogram (auto-heuristic audit)

### 10.2 Telemetry events

`emitTelemetry(...)` fires on:
- `agent:spawned`, `agent:completed`
- `subagent:start`, `subagent:end`, `subagent:error`
- `subagent:dispatch_decision`
- Hook lifecycle events
- Budget warnings at 90%

### 10.3 Tracing

OpenTelemetry spans with `correlation.id` attribute. The `tracingEnabled` master switch short-circuits all span creation to a shared no-op when disabled (one flag check per span lifecycle call).

---

## 11. Design Invariants

These must hold for the autonomous loop to be safe:

| # | Invariant | Enforced by |
|---|-----------|-------------|
| 1 | Child tools ⊆ parent tools | `PermissionUtils.applyParentRestrictions` |
| 2 | RO parent → RO child | Partition filter checks |
| 3 | Agent/spawn tools NEVER inherited | `EXCLUDED_TOOL_NAMES` set |
| 4 | Validators are sandboxed (no spawn, no write) | `isolated=true, levelLimit=0, skipValidators=true` |
| 5 | Handoff chain depth bounded | `levelLimit` (default 5) |
| 6 | Max 2 validation retries | `VALIDATION_MAX_RETRIES = 2` |
| 7 | Circuit breaker prevents model thrashing | 5 failures → OPEN, 30s cooldown |
| 8 | All OTel spans ended (even on error) | `finally` blocks |
| 9 | Handoff JSON size/depth/count bounded | `safeJsonParse` limits |
| 10 | Scheduling enabled via settings toggle | `schedulingEnabled` switch |

---

## 12. Autonomous Operation Example

### Scenario: "Research and implement a new caching layer"

**No human intervention after initial prompt.**

```
TRIGGER: User → "Research and implement a new caching layer for the API"

DISPATCH: auto → analyze → heuristicPickMode
  ├─ length: 52 (short)
  ├─ implement keyword: yes
  ├─ no review/plan/parallel keywords
  └─ → single (not enough steps for crew)

SPAWN: single general-purpose agent
  ├─ Permission: full tools
  ├─ Context: parent execution log
  └─ Model: claude-sonnet-4

EXECUTE:
  ├─ Turn 1: search codebase for existing caching → read files
  ├─ Turn 2: implement CacheManager class → write file
  ├─ Turn 3: integrate into API routes → edit files
  └─ Turn 4: final response

VALIDATE: (if agent has validators)
  ├─ Validator 1 (security): PASS — no secrets in code
  └─ Validator 2 (architecture): PASS — follows patterns

HANDOFF:
  └─ artifacts: [{ type: "file", path: "src/cache.ts" }, ...]

RESULT: Delivered to user as text + structured handoff.
```

### Scenario: "Review all PRs and fix them" (autonomous chain)

```
TRIGGER: Scheduler fires "PR review" job (cron: 0 9 * * 1-5)

DISPATCH: auto → crew (review keyword + multiple files)

SPAWN 3 agents as crew:
  ├─ planner (Explore, RO): "List all open PRs, categorize by risk"
  ├─ executor (general-purpose): "Fix the high-risk PRs identified"
  └─ reviewer (Explore, RO): "Audit the fixes against original issues"

EXECUTE (sequential per role):
  planner → produces plan JSON
  executor → implements fixes
  reviewer → PASS/FAIL verdict

VALIDATE: Each agent independently validated

HANDOFF: planner's plan feeds executor; executor's results feed reviewer

RESULT: 3-agent crew report delivered; no human touched it.
```

### Scenario: "Research competitor APIs across 5 services" (parallel swarm)

**No human intervention after initial prompt.** Shows swarm coordination with live strategy, multi-wave delivery, and batch orchestration.

```
TRIGGER: User → "Research the REST APIs of Stripe, Square, Adyen, Braintree, and Paddle.
Compare their payment flow, idempotency, webhook signatures, and SDK quality."

DISPATCH: auto → analyze → heuristicPickMode
  ├─ length: 132 (medium)
  ├─ parallel keyword: no (but 5 services listed = multi-topic)
  ├─ no review/plan/implement/refactor keywords
  └─ → single (heuristic doesn't auto-swarm — user must set orchestrationMode: "swarm")

── User overrides to swarm mode ──

DISPATCH: explicit swarm (3 agents, live strategy)

BATCH: 3 Agent tool calls in one turn
  ├─ addToBatch("agent-1", "swarm")
  ├─ addToBatch("agent-2", "swarm")
  ├─ addToBatch("agent-3", "swarm")
  └─ 100ms debounce → finalizeBatch()
      └─ createSwarm({ name: "Research Swarm", strategy: "live" })
         ├─ agent-1 → addAgentToSwarm (priority: 0)
         ├─ agent-2 → addAgentToSwarm (priority: 0)
         └─ agent-3 → addAgentToSwarm (priority: 0)

SPAWN (3 parallel general-purpose agents):
  ├─ agent-1: "Research Stripe API — payment flow, idempotency, webhook signatures, SDK"
  ├─ agent-2: "Research Square + Adyen APIs — same criteria"
  └─ agent-3: "Research Braintree + Paddle APIs — same criteria"

EXECUTE (parallel, each in isolated worktree):
  agent-1:
    ├─ Turn 1: search web for Stripe API docs → read docs
    ├─ Turn 2: search for Stripe SDK examples → read code
    ├─ Turn 3: produce structured report
    └─ Turn 4: onAgentComplete → SwarmCoordinator
         ├─ strategy: "live"
         ├─ 1 of 3 complete → quorum not met (need 2 = ceil(3 × 0.5))
         └─ → "held" (start 30s timeout)

  agent-2:
    ├─ Turn 1-4: research Square + Adyen → complete
    └─ onAgentComplete → quorum met! (2 of 3)
         ├─ deliverBatch(partial=true, quorumMet=true)
         └─ parent receives: "2/3 agents complete (partial delivery)"

  agent-3:
    ├─ Turn 1-5: research Braintree + Paddle → complete
    └─ onAgentComplete → all 3 complete
         └─ deliverBatch(partial=false, quorumMet=true)
              └─ parent receives: "3/3 agents complete (final delivery)"

HANDOFF:
  ├─ agent-1: artifacts: [{ type: "url", url: "https://stripe.com/docs/api" }, ...]
  ├─ agent-2: artifacts: [{ type: "url", url: "https://developer.squareup.com" }, ...]
  └─ agent-3: artifacts: [{ type: "url", url: "https://developer.paypal.com/braintree" }, ...]

RESULT: Parent aggregates 3 structured reports into one comparison matrix.
No human monitored the swarm — live delivery kept parent informed as results
streamed in.
```

### Scenario: "Daily dependency audit with auto-upgrade" (user-triggered autonomous crew)

**One user prompt → fully autonomous multi-agent upgrade pipeline.** Shows scheduler-agnostic crew dispatch with planner/executor/reviewer, worktree isolation, validator self-healing, and batch orchestration.

> **Note on daemon context:** This scenario shows a user-triggered crew for clarity. When run as a scheduled daemon (`.agents/daemons/js-ts-dependency-upgrades/DAEMON.md`), the scheduler spawns a single audit agent via `manager.spawn()`, and that agent internally uses the `Agent` tool in `crew` mode to fan out the planner/executor/reviewer — same loop, one extra nesting level.

```
TRIGGER: User → "Run a full dependency audit on this project.
For each outdated package: check the changelog for breaking changes,
estimate upgrade effort, and if safe, apply the upgrade. Report with verdict."

DISPATCH: auto → heuristicPickMode
  ├─ prompt: "Audit all dependencies for outdated packages.
  │          For each outdated package: check changelog for breaking changes,
  │          estimate upgrade effort, and if safe, apply the upgrade."
  ├─ length: 165 (long)
  ├─ implement keyword: yes ("apply the upgrade")
  ├─ multi-step (numbered): yes ("For each..." implies multiple)
  └─ → crew (multi-step implement)

SPAWN 3 agents as crew (via orchestrated dispatch):
  ├─ planner (Explore, RO):
  │   "Audit package.json + package-lock.json for all outdated dependencies.
  │    For each: check npm registry for latest version, read changelog,
  │    classify as 'safe' (patch), 'risky' (minor), or 'breaking' (major).
  │    Output: JSON plan with per-package upgrade recommendation."
  │
  ├─ executor (general-purpose):
  │   "For each 'safe' and 'risky' package in the plan:
  │    - npm install <package>@latest
  │    - Run npm test
  │    - If tests pass: commit with 'chore(deps): upgrade <package>'
  │    - If tests fail: revert and note in plan
  │    Output: updated package.json + list of applied/reverted upgrades."
  │
  └─ reviewer (Explore, RO):
      "Review the executor's changes:
       - Verify all safe upgrades were applied correctly
       - Check that reverted packages have a clear failure reason
       - Verify test suite still passes
       - PASS if: no test regressions, all safe upgrades applied, revert reasons clear
       - FAIL if: broken tests, unexplained reverts, or missing safe upgrades"

EXECUTE:
  planner:
    ├─ Turn 1: read package.json → parse dependencies
    ├─ Turn 2: for each dep, fetch latest version from npm registry
    ├─ Turn 3: read changelogs for breaking changes
    └─ Turn 4: produce JSON plan:
         { "safe": ["lodash", "zod"], "risky": ["nanoid"], "breaking": ["@sinclair/typebox"] }

  executor:
    ├─ Turn 1: npm install lodash@latest → test → pass → commit
    ├─ Turn 2: npm install zod@latest → test → pass → commit
    ├─ Turn 3: npm install nanoid@latest → test → FAIL (API change)
    │          → revert → note: "nanoid 6.x breaks custom alphabet API"
    └─ Turn 4: final response with upgrade summary

  reviewer:
    ├─ Turn 1: read executor's changes → check commits
    ├─ Turn 2: run npm test → all pass
    ├─ Turn 3: verify revert reason for nanoid is clear
    └─ Turn 4: PASS — "2 safe/risky packages upgraded, 1 correctly reverted"

VALIDATE: (each agent independently)
  ├─ planner: PASS (plan is valid JSON, all packages checked)
  ├─ executor: PASS (tests pass, reverts documented) ← if validator exists
  └─ reviewer: PASS (no false positives, revert explanations clear)

HANDOFF:
  ├─ planner: artifacts: [{ type: "note", title: "Upgrade Plan", value: "..." }]
  ├─ executor: artifacts: [
  │     { type: "branch", branch: "chore/deps-upgrade-2026-06-19", base: "main" },
  │     { type: "file", path: "package.json" },
  │     { type: "file", path: "package-lock.json" }
  │   ]
  └─ reviewer: artifacts: [{ type: "note", title: "Review Verdict", value: "PASS" }]

BATCH: crew dispatched foreground → await flush() → await all 3 record.promises
  └─ formatOrchestratedAggregate() → single text block with planner/executor/reviewer

RESULT: 3-agent crew delivers:
  "Crew completed (3 members, join mode: group).
  
   ### Audit all dependencies... (planner)
   { safe: [lodash, zod], risky: [nanoid], breaking: [@sinclair/typebox] }
  
   ### For each 'safe' and 'risky' package... (executor)
   Applied: lodash@4.17.22, zod@3.24.2
   Reverted: nanoid@6.0.0 (API change in custom alphabet)
  
   ### Review the executor's changes (reviewer)
   PASS — 2 upgraded, 1 correctly reverted, no test regressions"

Scheduler: (not used — user triggered). When daemon-driven, the scheduler
fires next Monday 8am and spawns a single agent that internally uses the
Agent tool in crew mode, producing the same 3-agent fan-out.
```

### Scenario: "Model circuit breaker triggers during multi-agent workflow" (failure + recovery)

**Shows how the autonomous loop handles model unavailability, circuit breaker state transitions, and graceful degradation.**

```
TRIGGER: User → "Run a full security audit on the codebase — dependency scan,
SAST analysis, and secret detection."

DISPATCH: auto → crew (review keyword + multiple analysis steps)

SPAWN 3 agents as crew:
  ├─ planner (Plan, RO): "Plan the security audit: identify all source directories,
  │                        list dependencies, locate config files with secrets."
  ├─ executor (general-purpose): "Run the audit: npm audit, scan for secrets,
  │                              check for unsafe patterns."
  └─ reviewer (Explore, RO): "Review the audit report for false positives."

── Background: model provider has intermittent failures ──

EXECUTE:
  planner:
    ├─ Turn 1: search codebase → list src/ directories
    ├─ Turn 2: read package.json → list deps
    ├─ Turn 3: model call → FAIL (network timeout)
    ├─ Turn 4: model call → FAIL (503 Service Unavailable)
    ├─ Turn 5: model call → FAIL (connection reset)
    ├─ Turn 6: model call → FAIL (timeout)
    ├─ Turn 7: model call → FAIL (5th consecutive failure)
    │          └─ 🔴 CIRCUIT BREAKER: CLOSED → OPEN
    │             "Model unavailable after 5 consecutive failures.
    │              Circuit breaker is OPEN. All model calls rejected for 30s."
    └─ agent.status → "error"
       AgentRunnerError { code: "model_unavailable" }

  executor:
    ├─ Turn 1: npm audit → tool call succeeds (no model needed)
    ├─ Turn 2: search for secret patterns → tool call succeeds
    ├─ Turn 3: attempt model call → REJECTED (circuit breaker OPEN)
    │          └─ "Circuit breaker is OPEN — model call skipped.
    │             Waiting 30s for HALF-OPEN transition..."
    ├─ ... 30s cooldown ...
    ├─ Turn 4: 🔶 CIRCUIT BREAKER: OPEN → HALF-OPEN
    │          → trial model call sent
    │          → model call → SUCCESS (provider recovered)
    │          └─ 🟢 CIRCUIT BREAKER: HALF-OPEN → CLOSED
    ├─ Turn 5: analyze scan results with model → produce report
    └─ agent.status → "completed"

  reviewer:
    ├─ Turn 1: read executor's report
    ├─ Turn 2: model call → succeeds (circuit breaker is CLOSED)
    └─ agent.status → "completed"
    └─ verdict: PASS (no false positives found)

── Recovery path ──

planner failed (model_unavailable):
  ├─ Orchestration dispatch detects planner failure
  │   └─ planner's record.promise → rejected
  ├─ formatOrchestratedAggregate handles:
  │   "### Plan the security audit (planner)
  │    Error: model_unavailable"
  ├─ Parent agent notified: "1 of 3 crew members failed."
  └─ Parent can: (a) retry with a different model, or
                 (b) accept partial result from executor + reviewer

RESULT: 3-agent crew delivers partial result:
  "Crew completed (3 members, join mode: group).
  
   ### Plan the security audit (planner)
   Error: model_unavailable
  
   ### Run the audit (executor)
   npm audit: 0 critical, 2 high, 5 moderate
   Secret scan: 0 secrets found
   Unsafe pattern scan: 2 uses of eval() in src/legacy/
  
   ### Review the audit report (reviewer)
   PASS — executor's findings confirmed, 0 false positives"

Circuit breaker state log:
  ├─ T+0s:  CLOSED (normal)
  ├─ T+7s:  OPEN (5 consecutive failures, planner)
  ├─ T+37s: HALF-OPEN (30s cooldown expired)
  └─ T+38s: CLOSED (trial call succeeded, executor)

The circuit breaker prevented 30s of wasted retries for executor + reviewer
while allowing recovery once the provider was healthy again.
```

---

## 13. Future Extensions (not yet implemented)

These are on the roadmap and would extend the autonomous loop:

| Feature | Impact on autonomous loop |
|---------|--------------------------|
| Exponential backoff retry | Self-healing on transient failures |
| Dead letter queue | Failed agents replayable later |
| Saga compensation | Multi-agent transactional rollback |
| Cost guards | Token/cost budgets with hard stops |
| Immutable audit logging | Full autonomous decision trail |
| Prometheus metrics export | External monitoring of autonomous loop |
| Structured JSON logging | Machine-parseable autonomous logs |

---

## 14. Batch Orchestration

`src/batch-orchestrator.ts` — the **debounced batch finalizer** that groups parallel agent spawns.

### 14.1 The problem it solves

When a parent agent spawns multiple background agents in rapid succession (e.g. 5 `run_in_background: true` calls in one turn), each spawn fires synchronously. These calls arrive in the same microtask queue — without batching, each would register a separate group/swarm/individual notification, causing a storm of UI updates and missed collaboration opportunities.

### 14.2 Debounce mechanism

```
Tool call 1 → manager.spawn() → addToBatch("agent-1", "swarm")
                                    │  reset 100ms timer
Tool call 2 → manager.spawn() → addToBatch("agent-2", "swarm")
                                    │  reset 100ms timer
Tool call 3 → manager.spawn() → addToBatch("agent-3", "smart")
                                    │  reset 100ms timer
                                    │
                              ... 100ms idle ...
                                    │
                                    ▼
                              finalizeBatch()
                              ├─ partition by joinMode
                              ├─ smartAgents → GroupJoinManager group
                              ├─ swarmAgents → SwarmCoordinator swarm
                              └─ leftovers → individual nudges
```

### 14.3 Partitioning logic

| Agent `joinMode` | Routed to | Threshold |
|------------------|-----------|-----------|
| `smart` / `group` | `GroupJoinManager.registerGroup()` | ≥ 2 agents |
| `swarm` | `SwarmCoordinator.createSwarm()` + `addAgentToSwarm()` | ≥ 1 agent |
| `async` / `null` | Individual `onAgentHandled(record)` | — |

### 14.4 Foreground vs background flush

- **Background mode:** Fire-and-forget `flush().catch()` — the batch is finalized asynchronously. Parent gets agent IDs immediately.
- **Foreground mode (crew/swarm dispatch):** `await flush()` synchronously before awaiting any `record.promise`. This guarantees the swarm/group is fully registered before any member can complete, preventing a fast-finishing member from missing the swarm and being delivered as an individual nudge.

### 14.5 Fallback safety

If `finalizeBatch()` throws, ALL agents in the batch are individually nudged via `onAgentHandled` to prevent deadlock. No agent is silently lost.

### 14.6 Dashboard introspection

The `getPendingBatch()` method exposes the current batch state to the TUI dashboard: pending agent IDs, join modes, and `timeUntilFlushMs` (countdown to finalization). This lets the dashboard show "3 agents pending batch finalization (flush in 47ms)" without polling.

### 14.7 Key invariants

| # | Invariant | Rationale |
|---|-----------|----------|
| B1 | Duplicate agent IDs in the same batch are merged (latest joinMode wins) | Prevents double-registration |
| B2 | `isFinalizing` guard prevents re-entrant finalization | Timer race safety |
| B3 | Fallback delivers every agent individually on error | No deadlock |
| B4 | Foreground dispatch MUST `await flush()` before awaiting members | Swarm must exist before completions |

---

## 15. Swarm Coordination (Deep Dive)

`src/swarm-join.ts` — the **enterprise SwarmCoordinator** for dynamic, collaborative agent groups.

### 15.1 Swarm vs Group: dynamic vs fixed

| Property | SwarmCoordinator | GroupJoinManager |
|----------|-----------------|------------------|
| Membership | Dynamic — agents join/leave at runtime | Fixed at spawn time |
| Delivery strategies | live / quorum / vote / merge / batch | All-or-nothing / progressive |
| Leader election | Yes (bully algorithm) | No |
| Health monitoring | Heartbeat every 10s, 3 missed = timeout | No (timeout on first completion only) |
| Inter-agent messaging | Broadcast + unicast with message queue | No |
| Rate limiting | 10 deliveries/sec sliding window | No |
| Retry on delivery failure | No (error boundary only) | Exponential backoff (max 3) |

### 15.2 Delivery strategies

| Strategy | Behavior | Use case |
|----------|----------|----------|
| `live` | Stream results as agents complete (streaming collaboration) | Real-time feedback, dashboard |
| `quorum` | Deliver only when quorum reached (default 50%) | Critical consensus |
| `vote` | Hold until ALL complete, deliver aggregated votes | Decision-making |
| `merge` | Hold until ALL complete, deliver merged results | Data aggregation |
| `batch` | Hold until all complete or timeout | Traditional batch processing |

### 15.3 Leader election (bully algorithm)

When `enableLeader: true`:
- Highest `priority` wins; tie-break by lexicographically last `agentId`
- Re-election triggers on every join/leave
- Leader lost event fires when no eligible candidates remain
- Delivery metadata includes `leaderId` for observability

### 15.4 Health monitoring loop

```
every 10s: checkHealth(swarm)
  for each agent:
    if status is "completed" or "left": skip
    if now - lastHeartbeatAt > 30s (3 missed × 10s):
      mark agent as "timeout"
      emit "agent:failed" with reason "heartbeat timeout"
```

Agents self-heal: if a heartbeat arrives after a timeout, the agent is re-marked `"running"` (recovered).

### 15.5 Inter-agent messaging

- `sendMessage(fromAgentId, toAgentId | "*", payload)` — unicast or broadcast
- Cross-swarm messaging is **blocked** (agents must be in the same swarm to message each other)
- `pollMessages(agentId, since?)` returns messages directed to that agent (including broadcasts `"*"`)
- Messages older than 5 minutes are auto-pruned

### 15.6 Multi-wave timeouts

Swarms support **multi-wave delivery** (the swarm persists — it is NOT disposed between waves):
1. First wave: timeout fires → deliver partial results → remaining agents become "stragglers"
2. Straggler wave: shorter timeout (15s) → deliver straggler results
3. Repeat until all agents complete, fail, or leave

The same swarm instance is reused across all waves; agents don't need to re-join.

### 15.7 Rate limiting (backpressure)

- Sliding window: max 10 deliveries per second
- `live` strategy respects rate limit — if at capacity, delivery is deferred to the next completion
- Prevents notification storms when many agents complete simultaneously

### 15.8 Auto-cleanup

- Empty swarms (all agents failed/left) are auto-disposed
- Fully delivered swarms have a 5-second grace period (for post-delivery queries) then auto-dispose

---

## 16. Fixed Groups

`src/group-join.ts` — the **GroupJoinManager** for fixed-size background agent batches.

### 16.1 Delivery semantics

| Mode | Behavior |
|------|----------|
| **All-or-nothing** (default) | Deliver only when ALL agents complete |
| **Progressive** (`progressiveDelivery: true`) | Deliver partial results as each agent completes |

### 16.2 Retry with exponential backoff

If the delivery callback throws:
- Retry up to 3 times (configurable via `maxRetries`)
- Backoff: 500ms × 2^(attempt-1) → 500ms, 1s, 2s
- On final failure: group is disposed, agents are individually nudged

### 16.3 Straggler handling

Same multi-wave pattern as swarms:
- First timeout: 30s after first agent completes
- Straggler timeout: 15s for remaining agents
- Completed agents are removed from the group after each wave

### 16.4 Choosing Swarm vs Group

| Use swarm when... | Use group when... |
|-------------------|-------------------|
| Agents collaborate dynamically | Agents are independent workers |
| Need leader election / voting | Simple all-done notification needed |
| Agents may join/leave at runtime | Agent set is fixed at spawn |
| Need inter-agent messaging | Each agent works in isolation |
| Need health monitoring | Simple timeout is sufficient |

---

## 17. Worktree Isolation

`src/worktree.ts` — Git worktree sandboxing for safe parallel file modifications.

### 17.1 Isolation model

```
Main repo (cwd)                    Worktree (tmpdir)
─────────────────                  ─────────────────
  src/                               src/        ← detached HEAD copy
  package.json                       package.json
  ...                                ...
  .git/                              .git        ← separate working tree

Agent runs in worktree → changes isolated from main repo.
On completion: changes committed to branch, worktree pruned.
```

### 17.2 Lifecycle

1. **Create:** `createWorktree(cwd, agentId)`
   - Verifies git repo + HEAD exists
   - Creates detached worktree at `HEAD` in `tmpdir/pi-agent-{id}-{suffix}`
   - Returns `{ path, branch }` or `undefined` (not a git repo)
2. **Execute:** Agent runs with `cwd = worktreePath`
3. **Cleanup:** `cleanupWorktree(cwd, worktree, description)`
   - **No changes:** `git worktree remove --force` + prune
   - **Changes exist:** `git add -A` → commit (sanitized message, CVE-001) → branch creation → worktree removal

### 17.3 Branch naming

- Default: `pi-agent-{agentId}`
- Collision: `pi-agent-{agentId}-{timestamp}` (if branch already exists from a previous run)
- Branch persists in the main repo after worktree is removed

### 17.4 Safety features

| Feature | Detail |
|---------|--------|
| **CVE-001 fix** | Commit message sanitized: no newlines, control chars, shell metacharacters |
| **Crash recovery** | `pruneWorktrees(cwd)` called at session start to clean orphaned worktrees |
| **Graceful degradation** | If worktree creation fails, agent runs in normal cwd (no isolation) |
| **Branch collision** | Append timestamp suffix if branch name already exists |

### 17.5 When to use

| Trigger via | Effect |
|------------|--------|
| Agent tool `isolation: "worktree"` | Agent gets an isolated copy |
| Agent config `isolation: "worktree"` | All agents of that type are isolated |

### 17.6 Limitations

- Requires a git repository (non-git cwd → agent runs normally)
- Requires at least one commit (HEAD must exist)
- Worktree is at `HEAD` — changes in progress on the main branch are not visible

---

## 18. Agent Lifecycle State Machine

### 18.1 States

```
                  ┌──────────┐
                  │  queued  │  ← spawn called, waiting for concurrency slot
                  └────┬─────┘
                       │ slot available
                       ▼
                  ┌──────────┐
          ┌───────│ running  │───────┐
          │       └────┬─────┘       │
          │            │             │
          │   ┌────────┼────────┐    │
          │   ▼        ▼        ▼    ▼
          │ completed steered stopped error
          │            │             │
          │            │  (abort)    │
          │            ▼             │
          │         aborted ◄────────┘
          │
          └─── steer_subagent tool
               sends mid-run message
               (agent stays "running")
```

### 18.2 State transitions

| From | To | Trigger |
|------|----|---------|
| — | `queued` | `manager.spawn()` when ≥ `maxConcurrent` agents running |
| `queued` | `running` | Concurrency slot freed |
| `running` | `completed` | Agent finishes normally |
| `running` | `steered` | `maxTurns` exceeded → `graceTurns` wrap-up → soft stop |
| `running` | `stopped` | User aborts via dashboard (`s` key / kill) |
| `running` | `error` | Unhandled error in `runAgent` (catch block) |
| `running` | `aborted` | Hard limit: token/duration/tool budget exceeded |
| `steered` | — | Terminal (results preserved, delivered as "wrapped up") |
| `completed` | — | Terminal (results delivered) |
| `stopped` | — | Terminal (no results) |
| `error` | — | Terminal (error message surfaced) |
| `aborted` | — | Terminal (partial results lost) |

### 18.3 The `steered` vs `aborted` distinction

| State | Cause | Results |
|-------|-------|---------|
| `steered` | Soft turn limit hit → grace turns → wrap-up | ✅ Preserved — agent was given time to finish |
| `aborted` | Hard quota exceeded (tokens/duration/tools) | ❌ Lost — agent was forcibly killed |

### 18.4 Concurrency queuing

```
maxConcurrent = 5

Agent 1-5: running (slots full)
Agent 6-8: queued  (waiting)

Agent 3 completes → slot opens → Agent 6 dequeued → running
Agent 7 completes → slot opens → Agent 7 dequeued → running
```

The queue is FIFO; `manager.spawn()` returns immediately with a `queued` record.

---

## 19. Mid-Run Steering

`src/tools/steer.ts` — the `steer_subagent` tool for redirecting running agents.

### 19.1 How steering works

```
Parent agent calls steer_subagent(agent_id, message)
  │
  ├─ Agent is "running" + has session?
  │   └─ YES → await steerAgent(session, message)
  │            → message injected as user turn after current tool completes
  │            → agent continues with new context
  │
  └─ Agent is "running" but session not yet initialized?
      └─ Queue message on record.pendingSteers
         → delivered once session exists
```

### 19.2 Steering constraints

- Only works on agents with `status === "running"`
- Message is injected **after** the current tool execution completes (non-disruptive)
- If session is not yet initialized, messages queue on `record.pendingSteers`
- Hook `subagent:steer` dispatched on successful steer
- Event `subagents:steered` emitted for cross-extension observation

### 19.3 Steering response

The `steer_subagent` tool returns the agent's current state:
- Token usage
- Tool use count
- Context window fullness (%)
- Compaction count

This gives the parent agent context to decide whether to steer further or wait.

### 19.4 Steering in the autonomous loop

Steering is the **only injection point for human (or parent-agent) mid-run intervention** in the otherwise autonomous loop. It is NOT required — steering is opt-in. The autonomous loop functions fully without any steering calls.

---

## 20. Agent Execution Tree

`src/agent-tree.ts` — hierarchical agent tracking via `parentId`.

### 20.1 Tree structure

Every `AgentRecord` has a `parentId` field that creates a tree:

```
Session
├─ agent-1 (general-purpose) [completed]  ← parentId = undefined (root)
│  ├─ agent-2 (Explore) [completed]       ← parentId = "agent-1"
│  │  └─ agent-4 (Explore) [running]       ← parentId = "agent-2"
│  └─ agent-3 (Plan) [queued]             ← parentId = "agent-1"
└─ agent-5 (Analysis) [completed]         ← parentId = undefined (root)
```

### 20.2 Visualization formats

| Format | Function | Output | Dashboard hotkey |
|--------|----------|--------|-----------------|
| **Mermaid** | `buildAgentTreeMermaid(records)` | Mermaid `flowchart TD` — nodes with agent info, solid parent edges, dashed group edges | `y` (tree view) |
| **Text** | `buildAgentTreeText(records)` | Unicode box-drawing (`├─`, `└─`, `│`) tree | `y` then select |
| **JSON** | `buildAgentTreeJson(records)` | Recursive `{ id, type, status, description, children[] }` structure | API export |

### 20.3 Mermaid diagram features

- Solid arrows (`-->`) for parent→child relationships
- Dashed arrows (`-.->`) for group/swarm membership (when different from parent)
- Virtual "Session" root node when multiple root agents exist
- IDs sanitized (hyphens replaced with underscores for Mermaid compatibility)

### 20.4 Tree building algorithm

```
buildTree(records):
  1. Index all records by id (nodeMap)
  2. For each record:
     - If parentId exists AND parent is in nodeMap → add to childrenMap[parentId]
     - Otherwise → add to roots[]
  3. Return { roots, childrenMap, nodeMap }
```

Group membership (`groupId`) is tracked separately as a property on `AgentRecord`, NOT as part of the tree hierarchy — groups are flat collections, trees are parent-child chains.

---

## 21. TUI Dashboard Observer Pattern

### 21.1 Architecture principle

The dashboard is a **read-only observer** of the autonomous loop. It reads state from the `AgentManager`, `SwarmCoordinator`, `GroupJoinManager`, `BatchOrchestrator`, and `SubagentScheduler` — but NEVER modifies loop state (except through user-initiated actions like abort/steer).

```
┌──────────────────────────────────────┐
│         AUTONOMOUS LOOP              │
│  (manager, swarm, batch, scheduler)  │
│              │                       │
│              │ read-only queries     │
│              ▼                       │
│     ┌────────────────┐              │
│     │  TUI DASHBOARD  │              │
│     │  (agent-dash-   │              │
│     │   board.ts)     │              │
│     │                 │              │
│     │  Views:         │              │
│     │  /agents list   │              │
│     │  /agents top    │              │
│     │  /agents sched  │              │
│     │  /agents perf   │              │
│     │  /agents health │              │
│     │  /agents set-   │              │
│     │    tings        │              │
│     └────────────────┘              │
└──────────────────────────────────────┘
```

### 21.2 Dashboard views

Hotkeys below match `DEFAULT_DASHBOARD_KEYBINDINGS` in `src/ui/dashboard-keybindings.ts`. Override via `dashboardKeybindings` in `.pi/subagents.json`.

| View | Hotkey | Reads from |
|------|--------|-----------|
| **Agent list** (default) | `/agents` | `manager.listAgents()` → records by status |
| **Top view** (resource usage) | `t` | Agent records sorted by tokens/duration/turns/tools |
| **Schedules** | `z` | `scheduler.listJobs()` + `scheduleStore` |
| **Performance** | `/agents perf` | Render metrics, benchmark thresholds |
| **Health check** | `/agents health` | `buildHealthReport(manager, scheduler, coordinator, getters)` (no single-letter dashboard binding) |
| **Settings** | `/agents settings` | `buildSettingsSnapshot(manager, getters)` → editable TUI menu |
| **Execution tree** | `y` | `buildAgentTreeMermaid(manager.listAgents())` |
| **Swarm view** | `w` | Swarm coordinator state |
| **Agent detail** | `Enter` | `manager.getRecord(id)` + conversation viewer |
| **Help** | `?` | Dashboard help overlay |

### 21.3 Refresh strategy

- **Adaptive refresh:** Widget re-renders when `agentActivity` map changes (spawn, complete, steer)
- **Batch debounce:** `onWidgetUpdate()` called after batch finalization to prevent flicker during rapid spawns
- **Top view polling:** 500ms interval for live resource usage updates
- **Scheduled view:** Lazy-load on view switch

### 21.4 User actions (state-modifying)

These are the ONLY dashboard interactions that modify loop state:

| Action | Hotkey | Effect |
|--------|--------|--------|
| Steer agent | `s` | Prompt the selected agent with a steer message |
| Kill agent | `Shift+k` / `K` | Force kill via abort controller |
| Permissions | `p` | Open permissions UI for the selection |
| Refresh | `r` | Force dashboard refresh |
| Open conversation | `Enter` | Read-only viewer (no state change) |
| Settings mutate | `Enter` on setting | Applies setting immediately via getters/setters |

---

## 22. Anti-Patterns & Pitfalls

### 22.1 Permission escalation via handoff chains

**Mistake:** Assuming a handoff-chain agent inherits the parent's permissions.

**Reality:** The permission model enforces directional restriction (invariant #1). A read-only parent spawns read-only children. The handoff chain CANNOT escalate permissions.

**Still wrong:** Creating a custom agent with `handoff: true` and `type: general-purpose` thinking it will gain write access. It inherits from its parent.

### 22.2 Batch orchestration race: foreground mode without flush

**Mistake:** In foreground crew/swarm dispatch, awaiting `record.promise` without first calling `await batchOrchestrator.flush()`.

**Reality:** If a swarm/group member completes before the 100ms debounce timer fires, `onAgentComplete` will not find the swarm/group (not yet created) and deliver the result as an individual nudge. The parent agent sees a fragmented result.

**Fix:** Always `await batchOrchestrator.flush()` before awaiting any `record.promise` in foreground orchestrated dispatch.

### 22.3 Swarm delivery callback throwing silently

**Mistake:** Assuming a thrown error in the swarm delivery callback will be surfaced to the parent.

**Reality:** The callback is wrapped in a try/catch with error boundary logging. The swarm is NOT retried — the error is logged and the swarm continues. Unlike `GroupJoinManager`, swarms do NOT retry failed deliveries.

**Fix:** Make delivery callbacks idempotent and defensive. If retry is needed, use a `GroupJoinManager` group instead.

### 22.4 Validator sandbox bypass

**Mistake:** Configuring a validator agent with `levelLimit > 0` or `skipValidators: false`.

**Reality:** The validator sandbox invariants (section 6.3) are enforced at spawn time. Validators ALWAYS get `isolated=true, levelLimit=0, skipValidators=true`. A validator that could spawn sub-agents would risk infinite recursion.

### 22.5 Worktree branch collisions

**Mistake:** Assuming `pi-agent-{agentId}` is always a unique branch name.

**Reality:** If an agent is resumed, the same `agentId` produces the same branch name. The worktree module handles this (timestamp suffix fallback), but if you're querying branches by name, be aware of the collision resolution.

### 22.6 Compaction: tool results lost

**Mistake:** Expecting an agent to remember tool outputs from 10 turns ago.

**Reality:** Upstream Pi auto-compaction may summarize or drop older context when the session window fills (#325). Local tool-output prune helpers are unwired — do not assume a fixed “last 5 turns” retention policy. The agent must either re-read files or preserve key findings in its assistant messages.

### 22.7 Steering during compaction

**Mistake:** Sending a `steer_subagent` message while the agent is compacting.

**Reality:** The steering message is queued and delivered when the agent finishes its current tool execution. Compaction is not a tool execution — it's internal to the agent runner. The message arrives after compaction completes.

---

## 23. Testing the Autonomous Loop

### 23.1 Testing pyramid

```
     ┌──────────────┐
     │  E2E Chains  │  ← test/e2e-chain.test.ts (full multi-agent chains)
     │  Integration │  ← test/orchestration-dispatch-integration.test.ts
     │  Unit        │  ← test/orchestration-dispatch.test.ts, test/agent-runner.test.ts, ...
     │  Benchmarks  │  ← test/*.benchmark.test.ts (performance regression guards)
     └──────────────┘
```

### 23.2 Mocking strategy

All loop tests mock `runAgent` (the actual LLM call) and `createWorktree` (git isolation):

```typescript
vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn().mockResolvedValue({
    status: "completed",
    result: "Mock result",
    toolUses: 3,
    // ...
  }),
}));
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn().mockResolvedValue(undefined),
}));
```

This lets tests verify the entire orchestration pipeline without making actual LLM API calls.

### 23.3 Key test files

| Test file | What it validates |
|-----------|-------------------|
| `test/orchestration-dispatch.test.ts` | Heuristic rules, plan builders, mode resolver (35 tests) |
| `test/orchestration-dispatch-integration.test.ts` | End-to-end dispatch → spawn → batch → await (5 dispatch paths) |
| `test/e2e-chain.test.ts` | Multi-agent handoff chains with validators |
| `test/dispatch-history.test.ts` | FIFO ring buffer, histogram calculation (13 tests) |
| `test/batch-orchestrator.test.ts` | Batch debounce, partitioning, fallback delivery |
| `test/swarm-join.test.ts` | Swarm creation, membership, delivery strategies |
| `test/group-join.test.ts` | Group registration, retry backoff, progressive delivery |
| `test/agent-runner.test.ts` | Turn lifecycle, quotas, compaction triggers |
| `test/agent-manager.test.ts` | Spawn lifecycle, concurrency queuing, resume |
| `test/validators.test.ts` | Validator prompt building, result parsing |
| `test/compaction.test.ts` | Tool output pruning, token estimation |

### 23.4 Invariant tests

| Invariant | Test file |
|-----------|----------|
| Permission inheritance (child ⊆ parent) | `test/backward-compat.test.ts`, `test/e2e-chain.test.ts` |
| Span cleanup (finally blocks) | `test/agent-runner-otel.test.ts` |
| Batch fallback (no deadlock) | `test/batch-orchestrator.test.ts` |
| Validator sandbox (isolated/levelLimit=0) | `test/e2e-chain.test.ts` |
| Handoff parse bounds (safeJsonParse) | `test/handoff.test.ts`, `test/error-chaos-handoff.test.ts` |
| Dispatch decision recording | `test/dispatch-history.test.ts`, `test/orchestration-dispatch-integration.test.ts` |

### 23.5 Benchmark suite

71+ performance benchmarks across dedicated test files guard against regression:

- `test/widget-render-perf.test.ts` — Widget virtual scrolling + debounce
- `test/dashboard-render-perf.test.ts` — Dashboard render throughput
- `test/dashboard.benchmark.test.ts` — Dashboard body render at 50k agents
- `test/spawn-latency-bench.test.ts` — Spawn pipeline latency
- `test/spawn-latency-e2e-bench.test.ts` — End-to-end spawn + run latency
- `test/handoff-v2.test.ts` — Handoff parse time

All benchmarks emit structured `[BENCHMARK]` lines via `test/helpers/benchmark-log.ts` and gate with `expect(perBuild).toBeLessThan(threshold)` (or the file-local measured alias). CI runs `scripts/check-benchmark-thresholds.mjs` as a **required** gate (`--retry=0`).

---

## Appendix A: Key Source Files

| File | Role in loop |
|------|-------------|
| `src/orchestration-dispatch.ts` | Heuristic dispatch (single/swarm/crew/auto) |
| `src/agent-manager.ts` | Spawn + record lifecycle + concurrency queuing |
| `src/agent-runner.ts` | Execute + validate + handoff + OTel tracing |
| `src/agent-types.ts` | Permission inheritance model + CTX tool names |
| `src/batch-orchestrator.ts` | Debounced batch finalizer (groups parallel spawns) |
| `src/swarm-join.ts` | Dynamic swarm coordinator (live/quorum/vote/merge/batch) |
| `src/group-join.ts` | Fixed group join manager (retry + progressive delivery) |
| `src/handoff.ts` | Structured handoff parse/render + legacy coercion |
| `src/validators.ts` | Adversarial validator prompt/parse |
| `src/schedule.ts` | Autonomous cron/interval scheduler |
| `src/compaction.ts` | Local prune helpers (unwired; live compaction is Pi upstream auto-compaction — #325) |
| `src/worktree.ts` | Git worktree isolation (safe parallel file edits) |
| `src/tools/steer.ts` | Mid-run agent steering (steer_subagent tool) |
| `src/agent-tree.ts` | Execution tree visualization (Mermaid/text/JSON) |
| `src/dispatch-history.ts` | Dispatch decision audit trail (FIFO ring buffer) |
| `src/health-report.ts` | Runtime health snapshot |
| `src/telemetry-otel.ts` | OTel span lifecycle + no-op short-circuit |
| `src/agent-templates.ts` | Agent template install/update/remove registry |
| `src/ctx-tool-names.ts` | Canonical CTX tool name definitions |

## Appendix B: Configuration Surface

```typescript
interface SubagentsSettings {
  maxConcurrent?: number;            // Max parallel agents (default 5)
  defaultMaxTurns?: number;          // Turn limit per agent
  graceTurns?: number;               // Wrap-up turns before hard kill (5)
  defaultJoinMode?: JoinMode;        // Agent join topology (smart)
  schedulingEnabled?: boolean;       // Master switch for cron (true)
  tracingEnabled?: boolean;          // Master switch for OTel spans (true)
  orchestrationMode?: OrchestrationMode; // default: "single" (auto/swarm/crew are opt-in)
  promptCompressionLevel?: "minimal" | "balanced" | "aggressive"; // balanced
  maxAgentsPerSession?: number;      // Session spawn limit
  maxTotalTurnsPerSession?: number;  // Session turn limit
  animationStyle?: "braille" | "dots" | "lines" | "classic" | "none";
  uiStyle?: "premium" | "retro" | "plain" | "cinematic";
}
```

---

*This specification is versioned alongside the codebase. When the dispatch heuristic, permission model, or validation loop changes, update this document.*
