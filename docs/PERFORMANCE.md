# Performance Architecture

## Overview

This document describes the key performance architecture decisions in pi-agent-orchestrator. It explains _why_ certain patterns were chosen, so future contributors can make the same trade-offs without having to analyze the code in detail.

---

## 1. Agent Cleanup TTL (AgentManager)

### Decision
- **Configurable cleanup TTL** via constructor parameter (default: 60 seconds)
- Periodic cleanup interval: 30 seconds
- Minimum TTL: 10 seconds (clamped via `setCleanupTtl()`)
- `clearCompleted()` removes _all_ completed/stopped/errored records immediately

### Why
- **Memory pressure**: during long sessions with many agent spawns, hundreds of `AgentRecord` objects can accumulate. Each record contains session objects, lifetime usage data, and result text.
- **Trade-off**: a short TTL means users cannot look up old agent results via `/agents`. `clearCompleted()` on session boundaries (`session_start`, `session_before_switch`) provides a hard reset.
- **30s interval** is a compromise: frequent enough to keep memory low, but not so frequent that the O(n) iterate over the agents map becomes noticeable.

### When to adjust
- For sessions with extremely many spawns (>1000): lower TTL to 30s
- For debug sessions where history must be preserved: raise TTL to 5min or avoid calling `clearCompleted()`

### Key code
```typescript
// src/agent-manager.ts
constructor(
  onComplete?: OnAgentComplete,
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  onStart?: OnAgentStart,
  onCompact?: OnAgentCompact,
  cleanupTtlMs = 60_000, // ← default 60s
) { ... }

setCleanupTtl(ms: number): void {
  this.cleanupTtlMs = Math.max(10_000, ms); // ← minimum floor
}
```text

---

## 2. Dirty Checking (Dashboard + Widget)

### Decision
Both UI components use a **lightweight structural snapshot** to detect whether the agent list has actually changed:

- **Snapshot**: a string hash of `id:status,` for each agent
- **Only status transitions** trigger `dirty = true` — toolUses/turnCount changes do not
- **Faster than deep-compare**: O(n) string concatenation vs O(n) object comparison

### Why toolUses/turnCount are not in the snapshot
ToolUses and turnCount change within a turn (every tool call). If we tracked those, the snapshot would _continuously_ change during active agent execution, so the dirty flag would never become false and the optimization would be pointless. Status transitions (queued → running → completed) are the only _structural_ changes that affect the UI layout.

### Dashboard specific
```typescript
// src/ui/agent-dashboard.ts — refreshAgents()
const snapshot = this.buildSnapshot();
if (snapshot !== this.agentSnapshot) {
  this.agentSnapshot = snapshot;
  this.dirty = true;
  // clamp selection, purge selectedIds
}
```

### Widget specific
```typescript
// src/ui/agent-widget.ts — update()
const snapshot = this.buildSnapshot(allAgents);
if (snapshot !== this.agentSnapshot) {
  this.agentSnapshot = snapshot;
  this.dirty = true;
  // adapt refresh interval
}
if (!this.dirty && this.widgetRegistered) {
  return; // skip TUI re-render
}
```text

### Trade-offs
- **Pro**: prevents ~90% of `requestRender()` calls during idle/stable periods
- **Con**: misses incremental progress (tool counts, token burn rate) until the next turn boundary or status transition. This is acceptable because the UI is an overview, not a real-time monitor.

---

## 3. Adaptive Refresh Intervals

### Dashboard (agent-dashboard.ts)

| Agent count | Status | Interval | fps |
|---|---|---|---|
| ≥ 100 | any | 100ms (TURBO) | 10 |
| 50–99 | any | 150ms (HIGH_LOAD) | 6.7 |
| any | running/queued | 200ms (ACTIVE) | 5 |
| < 50 | idle | 750ms (configurable via settings) | 1.3 |

The interval is adjusted dynamically: each timer tick checks `computeRefreshInterval()` and restarts the timer if the value has changed.

### Widget (agent-widget.ts)

| Status | Interval | fps |
|---|---|---|
| Agents running/queued | 200ms | 5 |
| All agents finished | 1000ms | 1 |

The widget adjusts its interval when the snapshot changes (and thus a status transition has occurred). This happens via `currentIntervalMs` tracking: the timer is only restarted if the target interval actually differs from the current one.

### Why these intervals
- **200ms** is fast enough for smooth spinner animation and quick status updates
- **1000ms** idle is slow enough to save CPU, but frequent enough to show a new spawn within 1 second
- **100ms/150ms** for large agent lists because status transitions are more frequent with many agents

---

## 4. Debounced requestRender (Conversation Viewer)

### Decision
Instead of calling `this.tui.requestRender()` directly on every session event, we use a **three-phase debounce**:

1. **Rate limit check**: if a render occurred within the last 16ms, skip
2. **Coalesce fallback**: if the rate limit is active, schedule a `setTimeout` for when the window expires
3. **queueMicrotask**: if the rate limit is not active, schedule a microtask (coalesces all events in the current synchronous burst)

### Why not direct requestRender
The session subscription fires on every session event: text deltas, turn ends, compaction, etc. During streaming this can happen dozens of times per second. Without debounce the TUI would render ~60+ times per second — all identical (the content has not changed yet because the microtask updates state only after the burst).

### Why not fixed requestAnimationFrame
The TUI is terminal-based and has no `requestAnimationFrame`. `queueMicrotask` is the closest equivalent: it fires after the current synchronous call stack, but before any I/O callbacks.

### Pattern (also used in dashboard)
```typescript
private requestRender(): void {
  // 1. Rate limit
  if (lastRenderTime > 0 && elapsed < MIN_RENDER_GAP_MS) {
    if (!this.coalesceTimer && !this.renderPending) {
      this.coalesceTimer = setTimeout(() => {
        this.coalesceTimer = null;
        this.lastRenderTime = 0;
        this.requestRender(); // retry after window
      }, MIN_RENDER_GAP_MS - elapsed);
    }
    return;
  }
  // 2. Pending guard
  if (this.renderPending) return;
  this.renderPending = true;
  // 3. Microtask
  queueMicrotask(() => {
    this.renderPending = false;
    this.lastRenderTime = Date.now();
    this.tui.requestRender();
  });
}
```

---

## 5. Memoized Theme (Dashboard)

### Decision
Dashboard theme (colors + box chars) is cached and only recomputed when the UI style changes.

### Why
`getThemeColors()` and `getBoxChars()` perform ANSI string construction. On every render (every 200ms) this would add overhead. With caching it is an O(1) lookup.

```typescript
private getTheme(): DashboardTheme {
  const currentStyle = getUiStyle();
  if (this.cachedTheme && this.lastUiStyle === currentStyle) {
    return this.cachedTheme;
  }
  this.cachedTheme = getThemeColors();
  this.lastUiStyle = currentStyle;
  return this.cachedTheme;
}
```text

The cache is invalidated in the `invalidate()` method (called by the TUI on style changes).

---

## 6. Dynamic chromeLines (Dashboard)

### Decision
Chrome lines (number of lines for headers, footers, borders) adapt to terminal height:

| Terminal height | Chrome lines |
|---|---|
| < 30 rows | 10 |
| 30–50 | 13 |
| 50–80 | 16 |
| > 80 | 19 |

### Why
On small terminals (laptops, split screens) every line is costly. Less chrome = more room for agent data. On large terminals extra chrome is acceptable for a richer UI.

---

## 7. AgentActivity Cleanup

### Decision
`AgentActivity` entries are cleaned up via a callback chain:

```
AgentManager.removeRecord() 
  → onRecordRemoved(id) 
  → index.ts: agentActivity.delete(id)
```text

This happens at three moments:
1. **Periodic cleanup** (every 30s, after TTL)
2. **`clearCompleted()`** (session start/switch)
3. **Agent completion** (via `sendIndividualNudge`, `groupJoin.onAgentComplete`, `swarmJoin.onAgentComplete`)

### Why no extra GC
The `AgentActivity` map only grows while agents are active or just completed. After completion the entry is removed within 1-2 turn boundaries. The callback chain ensures removal always goes together with activity cleanup — no separate sweep is needed.

---

## 8. RequestRender Strategy Overview

| Component | Timer | Debounce | Dirty check | Interval |
|---|---|---|---|---|
| Dashboard | Adaptive | Yes (16ms + microtask + coalesce) | Yes (snapshot) | 100–750ms |
| AgentWidget | Adaptive (`AdaptiveTick`) | Spawn-batch 16ms | Yes (snapshot) | 160–1000ms |
| AgentTopWidget | Adaptive (`AdaptiveTick`) | No | Yes (`buildSnapshotHash`) | 200–1000ms |
| ConversationViewer | Event-driven | Yes (16ms + microtask + coalesce) | No | — |

### Why conversation-viewer has no dirty check
The conversation viewer shows the _full_ agent conversation. Every session event (text delta, tool call, tool result) changes the visible state. A dirty check would always be true during streaming. The rate limit alone is sufficient.

### Why AgentTopWidget has no separate debounce
The strip shares `LiveWidgets` fan-out with `AgentWidget` and rate-limits via `AdaptiveTick`. Structural changes use `buildSnapshotHash`; idle ticks keep running as long as there is UI context so settings toggles without registry callbacks are picked up.

---

---

## 9. Spawn Batching (Phase 3.1)

### Decision
For bulk spawns (multiple background agents started at once), we use a **two-stage debounce** to coalesce widget updates:

1. **First spawn**: `debouncedUpdate()` calls `update()` directly for immediate feedback
2. **Timer (16ms)**: a short setTimeout is started to catch any subsequent spawns within 16ms
3. **Timer callback**: a second `update()` runs with the full batch
4. **Intermediate calls**: all `debouncedUpdate()` calls during the 16ms window are skipped

### Compact batch rendering
When there are 3+ agents of the same type in "queued" status, they are shown as a compact line:
```
├── ◦ 5× Explore queued
```text
instead of 5 individual lines. This saves vertical space and reduces render overhead.

### Why no strict batching at spawn level
Unlike the batch orchestrator (which debounces completions), spawns do not need a separate buffer because:
- `AgentManager.spawn()` is synchronous — all records are added in the same call stack
- The widget timer (200ms active) sees all records at once
- The dashboard requestRender is already rate limited at 16ms

The debounce in `debouncedUpdate()` only prevents `widget.update()` from being called 20 times for 20 spawns — snapshot build and `listAgents()` sort are reduced from 20 to 2 calls.

### Key code
```typescript
// src/ui/agent-widget.ts
debouncedUpdate(): void {
  if (this.updateTimer) return;          // timer pending → skip
  this.update();                          // immediate: first spawn
  this.updateTimer = setTimeout(() => {    // coalesce subsequent spawns
    this.updateTimer = undefined;
    this.update();
  }, AgentWidget.SPAWN_BATCH_MS);          // 16ms
}
```

### Trade-offs
- **Pro**: `listAgents()` and snapshot build are called 10-20x less often during bulk spawns
- **Con**: first render shows 1 agent, second render 16ms later shows the full batch — brief visual flash
- **Con**: compact display hides individual descriptions for batches of 3+ agents

---

## 10. Render Metrics Architecture (Phase 3.3)

### Overview

Since Phase 3.3 the entire UI has a **unified render performance tracking system** via the `RenderMetrics` class. This class is instantiated by both `AgentWidget` and `AgentDashboard` and tracks real-time metrics on how long renders take, how effective debounce is, and how many agents are processed per render on average.

The data can be viewed live via the `/perf` command in the dashboard.

---

### 10.1 RenderMetrics Class (`src/ui/render-metrics.ts`)

```typescript
const metrics = new RenderMetrics(label: string, slowThresholdMs?: number);
```text

#### Public API

| Method | Description |
|---|---|
| `record(durationMs, activeAgents?)` | Record a render execution. Optional agent count. Returns `true` if the render was slower than `slowThresholdMs`. |
| `recordRequested()` | Record a _request_ to render (before debounce/dirty filtering). Returns the net requested count. |
| `setFirstSpawnTimestamp(ts)` | Set the timestamp of the first agent spawn (earliest wins). |
| `reset()` | Reset all counters. |
| `snapshot()` | Returns a `RenderMetricsSnapshot` with all current values. |

#### Full Snapshot Fields

```typescript
interface RenderMetricsSnapshot {
  label: string;                          // "widget-update" or "dashboard-render"

  // ── Render duration stats ──
  renderCount: number;                    // How often record() was called
  meanMs: number;                         // Average render duration
  minMs: number;                          // Fastest render
  maxMs: number;                          // Slowest render
  lastMs: number;                         // Last render duration

  // ── Request vs actual (debounce effectiveness) ──
  requestedRenderCount: number;           // How often render was requested
  skippedRenderCount: number;             // request - actual (debounced)
  requestToActualRatio: number;           // Ratio (e.g. 2.5x)

  // ── Agent context ──
  activeAgentCount: number;               // How often activeAgents was provided
  activeAgentMin: number;                 // Minimum agents during a render
  activeAgentMax: number;                 // Maximum agents during a render
  activeAgentMean: number;                // Average number of agents per render

  // ── Time to first visible ──
  firstRenderTimestamp: number;           // Timestamp of first render
  firstSpawnTimestamp: number;            // Timestamp of first spawn
  timeToFirstVisibleMs: number;           // Difference (perceived lag)

  // ── Render rate ──
  startedAt: number;                      // Timestamp of start/last reset
  elapsedMs: number;                      // Elapsed time since startedAt
  rendersPerSecond: number;               // Current render frequency
  rendersPerMinute: number;               // Current render frequency (minute)
}
```

---

### 10.2 Instrumentation Points

#### AgentWidget — `renderWidget()` (src/ui/agent-widget.ts)

- **Label**: `"widget-update"`
- **Slow threshold**: 16ms (~60fps budget)
- **What is measured**: the actual line-building time in `renderWidget()`
- **When `record()` is called**: in the `finally` of `renderWidget()`, so timing is always recorded, even on errors
- **activeAgents**: `allAgents.filter(a => a.status === "running" || a.status === "queued").length`
- **recordRequested()**: called in `update()` when the dirty-skip path (snapshot is unchanged) is taken — these are renders skipped by debounce
- **setFirstSpawnTimestamp()**: called in `update()` on the first active agent

**Flow:**
```text
update()
  ├─ snapshot changed? ─► set dirty = true
  ├─ first spawn? ──────► setFirstSpawnTimestamp()
  ├─ dirty + registered? ─► requestRender()
  └─ NOT dirty + registered? ─► recordRequested()  ← skipped render

renderWidget()
  ├─ performance.now() start
  ├─ build lines (renderAgentWidget)
  └─ finally: performance.now() - start → record(duration, activeAgents)
```

#### AgentDashboard — `render()` (src/ui/agent-dashboard.ts)

- **Label**: `"dashboard-render"`
- **Slow threshold**: 50ms (dashboard has more work than widget)
- **What is measured**: the full `render()` method (header + body + detail panel + footer)
- **When `record()` is called**: at the end of `render()`, just before return
- **recordRequested()**: called in `requestRender()` before debounce/rate-limit checks — counts ALL requests, including rate-limited ones
- **setFirstSpawnTimestamp()**: called in `render()` on the first agent

**Flow:**
```text
requestRender()
  ├─ recordRequested()                    ← counts all requests
  ├─ rate limit check?
  │   ├─ still in window? ─► coalesce via setTimeout
  │   └─ window expired? ─► queueMicrotask → tui.requestRender()
  └─ renderPending guard

render(width)
  ├─ performance.now() start
  ├─ renderDashboardHeader()
  ├─ body / help / perf / top view
  ├─ renderDashboardDetailPanel()
  ├─ renderDashboardFooter()
  └─ performance.now() - start → record(duration, activeAgents)
```

---

### 10.3 `/perf` Debug Command

Since command mode was implemented, the `/perf` command is available in the agent dashboard.

#### Usage

| Action | Key |
|---|---|
| Open command mode | `/` |
| Toggle perf panel | `/perf` + Enter |
| Reset counters | `/perf reset` + Enter |
| Cancel command | Esc |
| Close perf panel | `q` or Esc |

#### What the perf panel shows

```text
▸ Render Duration
  last                   2.34ms
  mean                   1.87ms
  min                    0.52ms
  max                    15.20ms

▸ Debounce Effectiveness
  requested renders      245
  actual renders         89
  skipped (debounced)    156
  request/actual ratio   2.75x

▸ Agent Context
  current agents         89
  mean agents/render     8.30
  min agents             0
  max agents             48

▸ Timing
  time to first visible  320.00ms
  renders/sec            2.40
  renders/min            144.00
  elapsed                2m 34s

  [/perf reset]          [q/esc] close perf panel
```

#### How to interpret

| Metric | Healthy | Warning | Action |
|---|---|---|---|
| **lastMs / meanMs** | < 16ms (widget), < 50ms (dashboard) | > 50ms (widget), > 100ms (dashboard) | Reduce agent count, optimize render code |
| **maxMs** | < 50ms | > 200ms | Find the outlier: which agent/config causes the spike? |
| **requestToActualRatio** | 1.0–3.0x | > 10x | Debounce is too aggressive or too many unnecessary requests are being made |
| **skippedRenderCount** | ≈ request - actual | Very high vs actual | Check whether dirty detection works (snapshot hash collision?) |
| **timeToFirstVisibleMs** | < 500ms | > 2000ms | Dashboard/widget becomes visible too slowly — check init code |
| **rendersPerSecond** | 3–10 (dashboard), 1–5 (widget) | > 60 | Rate limit is being bypassed — check debounce logic |
| **activeAgentMax vs mean** | Max ≈ 2× mean | Large spread | Some renders process many more agents than average — check virtual scrolling |

---

### 10.4 Debug Logging

Render metrics log at `debug` level via the existing `logger` utility. This is **disabled by default** and must be enabled:

```bash
# Enable debug logging for render metrics
PI_SUBAGENTS_LOG_LEVEL=debug npm start
```text

When `record()` detects that render duration exceeds `slowThresholdMs`, a structured log message is emitted:

```json
{
  "level": "debug",
  "msg": "render-metrics: slow dashboard-render",
  "durationMs": 67.32,
  "thresholdMs": 50,
  "renderCount": 42,
  "requested": 156,
  "skipped": 114,
  "activeAgents": 12,
  "meanMs": 23.45
}
```

This is useful for:
- **Performance regression hunting**: compare meanMs over time
- **CI monitoring**: detect whether a code change significantly slows renders
- **User reports**: ask for a `PI_SUBAGENTS_LOG_LEVEL=debug` log when users report slow UI

---

### 10.5 Render Rate and Elapsed Time

- `startedAt` is set on construction or after `reset()`
- `elapsedMs` = `Date.now() - startedAt`
- `rendersPerSecond` = `renderCount / (elapsedMs / 1000)`
- `rendersPerMinute` = `renderCount / (elapsedMs / 60000)`

The rates are **instantaneous**: they reflect average frequency since the last reset. During a long session with much idle time the rates will be low, even if renders themselves were fast. Reset counters with `/perf reset` for a fresh measurement during a specific workload.

---

### 10.6 Time to First Visible

`timeToFirstVisibleMs` measures the time between the first `setFirstSpawnTimestamp()` call (usually in `update()` or `render()` when the first agent is detected) and the first `record()` call (the first actual render).

This is a proxy for **perceived startup lag**: how long until a user sees the first agent in the UI after spawn?

**Note**: this is not an exact measurement of spawn-to-display latency, because:
- The spawn timestamp is set in the next `update()` or `render()` cycle, not at the exact moment of spawn
- The TUI framework has its own render scheduling that is not included in this measurement
- It is still a good indicator for regressions in perceived performance

---

### 10.7 Widget Render Metrics

In addition to dashboard metrics, `AgentWidget` has its own `RenderMetrics` instance, accessible via `getRenderMetrics()`.

**Differences from dashboard metrics:**

| Aspect | Widget | Dashboard |
|---|---|---|
| Threshold | 16ms | 50ms |
| What is measured | Line-building in `renderWidget()` only | Full `render()` (incl. header, footer, detail panel) |
| `recordRequested()` | Only in dirty-skip path (snapshot unchanged) | In `requestRender()` before all debounce checks |
| `activeAgents` | All agents (`this.manager.listAgents()` filtered on running/queued) | All agents (dashboard shows everything) |
| Rate limiting | Via timer interval (200ms active / 1000ms idle) | Via debounce in `requestRender()` + microtask |

---

### 10.8 Benchmark Tests

All benchmark tests use the shared helper `test/helpers/benchmark-log.ts`. Internal values are always milliseconds (`performance.now()`); sub-ms work is shown as `µs` (×1000). CI runs `node scripts/check-benchmark-thresholds.mjs` as a **blocking** required gate with `--retry=0`.

There are **14 render performance benchmarks** in `test/widget-render-perf.test.ts`:

| Group | Tests | What is measured |
|---|---|---|
| renderAgentWidget pure throughput | 4 | 10/50/200/all-running agents render time |
| renderAgentWidget with activity data | 2 | 50/200 agents + activity heatmap entries |
| buildSnapshot dirty checking | 3 | 10/50/200 agents snapshot hash speed |
| getVisibleWindow virtual scrolling | 3 | 200/1000 agents, scroll latency |
| debouncedUpdate coalescing | 1 | 100 rapid calls → 1 immediate + 1 timer |
| Sustained update throughput | 1 | 50 ticks × 20 agents < 2ms per tick |

There are also **11 RenderMetrics unit tests** in `test/render-metrics.test.ts`:

| Group | Tests | What is tested |
|---|---|---|
| Basic tracking | 4 | Zero state, single record, min/mean/max, reset |
| Requested vs actual | 6 | recordRequested, skippedCount, ratio, edge cases |
| Active agents tracking | 2 | Agents per render, without agent data |
| Time to first visible | 4 | Without spawn, with spawn, earliest timestamp, ignore later |
| Render rate | 3 | Zero state, elapsed time, increasing time |
| Getters | 3 | count, requestedCount, mean/min/max/last |

```bash
# Run all render metrics + widget tests
npx vitest run test/render-metrics.test.ts test/agent-widget.test.ts test/widget-render-perf.test.ts

# Expected: 64 tests passing
```text

---

### 10.9 Best Practices

1. **Reset before measurements**: use `/perf reset` before testing a specific workload so rates and averages reflect only that workload
2. **Look at mean, not max**: max can be a one-off JIT compilation or GC pause. Mean is more representative for steady-state performance
3. **Debounce ratio > 10x is suspicious**: if there are 10+ requests per actual render, check for a render request storm somewhere without rate limiting
4. **Time to first visible > 2s**: this points to a startup bottleneck. Check dashboard and widget init code
5. **Renders/sec > 60**: MIN_RENDER_GAP_MS (16ms) is being bypassed. Check whether `requestRender()` is called directly instead of via debounce

---

## 11. Recommended Benchmarks

For validating performance changes:

```bash
# Baseline: typecheck + lint + test suite
npm run typecheck && npm run lint && npm test

# Dashboard rendering performance (existing test)
npm test -- test/dashboard-components.test.ts

# Render metrics + widget + benchmark tests
npx vitest run test/render-metrics.test.ts test/agent-widget.test.ts test/widget-render-perf.test.ts

# Compaction benchmarks
node --experimental-specifier-resolution=node test/compaction.benchmark.ts
```

### Critical metrics
- **`listAgents()` time**: should be < 1ms for < 500 agents
- **`buildSnapshot()` time**: should be < 0.1ms for < 100 agents
- **Actual TUI renders per second**: dashboard typically 5–10fps; the 16ms `MIN_RENDER_GAP_MS` coalesces nested `tui.requestRender()` work. Note that `requestRender()` *invocations* may exceed 60/s (the counter increments before the gap check); use the render metrics / actual paint rate when diagnosing bypassed rate limits.
- **Widget render mean**: < 5ms for < 50 agents
- **Dashboard render mean**: < 50ms for < 200 agents
- **Memory per `AgentRecord`**: ~2-5KB (excluding session messages)
