# // TROUBLESHOOTING

> COMMON FAULT CONDITIONS, CAUSAL ANALYSIS, AND RECOVERY PROCEDURES.

---

## // INSTALLATION

### `npm install` fails with peer dependency errors

**CAUSE:** Hard peer constraints on `@earendil-works/pi-*` packages. (`@earendil-works/pi-tui` is no longer declared — it resolves transparently as a transitive of `pi-coding-agent`.)

**RECOVERY:** Execute installation inside pi-coding-agent environment boundary, or override constraint checks:

```bash
npm install --legacy-peer-deps
```

---

## // AGENT SUBSYSTEM

### Custom definition absent from `/agents` enumeration

**SYMPTOM:** Target `.pi/agents/my-agent.md` fails injection logic.

**VALIDATION MATRIX:**
1. Extension strict match: `.md` (not `.txt` or `.markdown`).
2. Placement constraint: Top-level `.pi/agents/` (recursive search disabled).
3. YAML boundary 1: `---` at line 1.
4. YAML boundary 2: `---` on isolated line.
5. Identifier rules: alphanumeric + hyphens, zero whitespace.
6. YAML syntax: Well-formed.

**FORCED RELOAD:** Execute `/agents` → "Reload custom agents".

**TELEMETRY:** Review extension output log for deterministic parse exceptions (includes trace lines).

---

### Agent faults with "tool not allowed"

**SYMPTOM:** Capability requested, constraint enforced, execution denied.

**CAUSAL VECTORS:**
1. Capability absent from `tools` array.
2. Capability present in `disallowed_tools` nullification list.
3. Parent hierarchy enforces strict inheritance limitation.
4. Memory partition filters dropped capability via `contextMode`.

**RECOVERY:** Audit configuration matrix and parent hierarchy. Programmatic inspection via `getAgentConfig(name)`.

---

### Infinite loop state execution

**SYMPTOM:** Agent cycles capabilities without objective termination.

**CAUSAL VECTORS & RECOVERY:**

| Vector | Recovery Protocol |
|---|---|
| Unbounded `maxTurns` limit | Enforce `defaultMaxTurns` or parameterize `maxTurns` explicitly. |
| Boundary definition failure | Refine `description` prompt telemetry. |
| Opaque tool payloads | LLM lacks state feedback. Inject validation blocks. |
| Compaction engine halted | Audit `compactionCount` integer increment in session record. |

**EMERGENCY INTERRUPT:** Execute `/agents` → "Running agents" → Select PID → "Cancel".

---

## // SCHEDULING ENGINE

### Temporal triggers fail execution

**SYMPTOM:** Scheduled cron definition silently skips trigger.

**VALIDATION MATRIX:**
1. `schedulingEnabled` == true.
2. Target `enabled` == true.
3. Cron definition string mathematically valid.
4. Core chronometer process active (`SubagentScheduler` initialized).
5. Error bus silent.

**PERSISTENCE NOTICE:** Jobs require active PI session. Memory persistence strictly requires `schedule-store.ts` file-backed storage flag active.

---

### Storage locks stall on Windows OS

**SYMPTOM:** `ENOENT`, stale lock handle, or atomic rename fault in `schedule.ts`.

**CAUSE:** Project-local atomic writes use same-dir temp + rename execution. Abrupt termination strands `.lock` physical files.

**RECOVERY:** Wait for stale recovery interval trigger, or manually unlink `.lock` artifacts in `.pi/subagent-schedules/` if target process is verified dead.

---

## // UI / TELEMETRY VIEWS

### Dashboard / AGENT TOP view squashed with Pi header text

**SYMPTOM:** Opening `/agents` top view or pressing `t` shows `AGENT TOP` mixed with Pi startup lines (`Upd`, `New`, `Changelog`) — columns and borders overlap.

**CAUSE:** The dashboard overlay was centered at 80–92% height, so Pi's header/footer rendered underneath and TUI compositing merged both layers.

**RECOVERY:** Use a build with fullscreen overlay (`anchor: top-left`, `width/maxHeight: 100%`). Rebuild (`npm run build`), `pi install` the local path, then `/reload`.

### Footer status bar missing after Pi reload

**SYMPTOM:** No `N running agents` text in the Pi footer (top bar) after extension reload or `/resume`, even when subagents are active.

**CAUSE:** UI context was previously bound only on `tool_execution_start`. After reload the widget had no `ctx.ui` reference until the next tool ran.

**RECOVERY:** Fixed in `src/index.ts` — `bindWidgetUiCtx()` runs on `session_start` and `tool_execution_start`. Reload Pi or run `/agents` once to confirm. If still absent, verify agents are actually `running` or `queued` (completed agents clear the status bar after linger turns).

### JSON telemetry lines in chat input or scrollback

**SYMPTOM:** Raw `{"type":"agent:loaded",...}` lines appear in the Pi input bar or conversation history.

**CAUSE:** Extension logging or unsubscribed telemetry events writing to stdout/stderr in TTY mode.

**RECOVERY:** Use a build with silent TTY logging (`src/logger.ts`) and silent telemetry drop (`src/telemetry.ts`). Optional debug: `export PI_SUBAGENTS_LOG_LEVEL=debug` (writes to stderr only, not the chat buffer).

### Unexpected multi-agent fan-out (16+ agents from one Agent call)

**SYMPTOM:** One `Agent` tool invocation spawns a crew or swarm without explicit configuration.

**CAUSE:** `orchestrationMode` was previously default `"auto"` / `"crew"`. Default is now `"single"` — one Agent call spawns one agent unless you opt into `auto`, `swarm`, or `crew` in `.pi/subagents.json` or `/agents → Settings`.

**RECOVERY:** Set `orchestrationMode` to `"single"` in `.pi/subagents.json`, or use `"auto"` only when heuristic dispatch is intended.

### Model/thinking params ignored

**SYMPTOM:** Spawned agent uses profile default model despite explicit `model` or `thinking` in the Agent tool call (or vice versa).

**CAUSE:** `resolveAgentInvocationConfig` precedence — explicit tool `params` override agent profile; omitted params fall back to profile.

**RECOVERY:** Pass `model` / `thinking` in the Agent tool call to override. Omit them to use the agent profile from `.pi/agents/*.md`.

### Widget block fails render

**SYMPTOM:** Telemetry overlay absent.

**VALIDATION MATRIX:**
1. Agent session minimum: >= 1 (running or cached).
2. Configuration state: `getUiStyle() !== "plain"` when agents = 0.
3. Terminal geometry: Check column width minimum constraint.
4. Event bus silent on `agent-widget.ts` faults.

---

## // TEST SUITE

### Persistence test faults on Windows (`schedule.test.ts`)

**SYMPTOM:** Lock contention, atomic rename lag, or temporal jitter in suite execution.

**STATE:** Execution writes utilize same-dir temp buffering. Treat consistent failures as structural regressions. Capture physical `.lock` state.

**RECOVERY:** Isolate target sequence (`npm test -- test/schedule-store.test.ts`) to bisect temporal vs. storage faults.

---

### Test framework faults on module import

**SYMPTOM:** `Cannot find module '@earendil-works/pi-coding-agent'`

**RECOVERY:** Target package represents a peer constraint. Vitest runs via `deps.inline`. Run framework strictly within PI extension envelope, or inject mock dependencies.

---

## // PERFORMANCE METRICS

### Token consumption over thresholds

**SYMPTOM:** Saturation metric significantly exceeds projection.

**VALIDATION MATRIX:**
1. `compactionCount` incrementing (upstream Pi auto-compaction fired)? Check `lastCompaction.tokensBefore` / `tokensAfter`.
2. Parent payload injection excessive? Enforce `levelLimit`.
3. Host compaction settings in `.pi/settings.json` (`compaction.enabled`, `reserveTokens`, `keepRecentTokens`) — not the inactive local prune helper / `DEFAULT_KEEP_TURNS`.
4. Concurrency limit saturated? Validate `maxConcurrent`.

**MITIGATION DIRECTIVES:**
- Clamp `maxTurns` parameter.
- Toggle `contextMode` for payload reduction logic.
- Route detached tasks via `fire-and-forget` join topology (strips parent injection).

---

## // SOURCE CONTROL

### Worktree isolation faults

**SYMPTOM:** Shell exception executing `git worktree`.

**CAUSE:** Target topology conflict (path exists) or base directory lacks `.git` subsystem.

**RECOVERY:** System defaults to in-place mutation. Parse `src/worktree.ts` telemetry logs for state analysis.

---

## // SUBSYSTEM DOCUMENTATION

1. **Topology & Vectors**: `docs/architecture.md`
2. **Interface Definitions**: `docs/api-reference.md`
3. **Configuration Schema**: `docs/custom-agents.md`
4. **State Deltas**: `CHANGELOG.md`
5. **Deep Trace**: Enable verbose telemetry in PI settings block.
