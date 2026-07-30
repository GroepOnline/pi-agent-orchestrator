# Performance Architecture

## Overzicht

Dit document beschrijft de belangrijkste performance-architectuur beslissingen in de pi-agent-orchestrator. Het legt uit _waarom_ bepaalde patronen zijn gekozen, zodat toekomstige contributors dezelfde afwegingen kunnen maken zonder de code tot in detail te hoeven analyseren.

---

## 1. Agent Cleanup TTL (AgentManager)

### Beslissing
- **Configurable cleanup TTL** via constructor parameter (default: 60 seconden)
- Periodic cleanup interval: 30 seconden
- Minimum TTL: 10 seconden (clamped via `setCleanupTtl()`)
- `clearCompleted()` verwijdert _alle_ completed/stopped/errored records direct

### Waarom
- **Memory pressure**: tijdens lange sessies met veel agent spawns kunnen honderden `AgentRecord` objecten accumuleren. Elk record bevat o.a. sessie-objecten, lifetime usage data, en result text.
- **Trade-off**: een korte TTL betekent dat gebruikers geen oude agent resultaten kunnen terugzien via `/agents`. `clearCompleted()` op sessie-grenzen (`session_start`, `session_before_switch`) zorgt voor een harde reset.
- **30s interval** is een compromis: frequent genoeg om geheugen laag te houden, maar niet zo frequent dat de O(n) iterate over de agents map merkbaar wordt.

### Wanneer aanpassen
- Voor sessies met extreem veel spawns (>1000): verlaag TTL naar 30s
- Voor debug sessies waar historie bewaard moet blijven: verhoog TTL naar 5min of gebruik `clearCompleted()` niet

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
```

---

## 2. Dirty Checking (Dashboard + Widget)

### Beslissing
Beide UI-componenten gebruiken een **lightweight structural snapshot** om te detecteren of de agent lijst echt veranderd is:

- **Snapshot**: een string hash van `id:status,` voor elke agent
- **Alleen status-transities** triggeren een `dirty = true` — toolUses/turnCount wijzigingen niet
- **Sneller dan deep-compare**: O(n) string concatenatie vs O(n) object vergelijking

### Waarom geen toolUses/turnCount in de snapshot
ToolUses en turnCount veranderen binnen een turn (elke tool call). Als we die zouden tracken, zou de snapshot _continu_ veranderen tijdens actieve agent-executie, waardoor de dirty flag nooit false wordt en de optimalisatie zinloos is. Status-transities (queued → running → completed) zijn de enige _structurele_ veranderingen die de UI layout beïnvloeden.

### Dashboard specifiek
```typescript
// src/ui/agent-dashboard.ts — refreshAgents()
const snapshot = this.buildSnapshot();
if (snapshot !== this.agentSnapshot) {
  this.agentSnapshot = snapshot;
  this.dirty = true;
  // clamp selection, purge selectedIds
}
```

### Widget specifiek
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
```

### Trade-offs
- **Pro**: voorkomt ~90% van de `requestRender()` calls tijdens idle/stabiele periodes
- **Con**: mist incrementele progress (tool counts, token burn rate) tot de volgende turn boundary of status transitie. Dit is acceptabel omdat de UI een overview geeft, geen real-time monitor.

---

## 3. Adaptive Refresh Intervals

### Dashboard (agent-dashboard.ts)

| Aantal agents | Status | Interval | fps |
|---|---|---|---|
| ≥ 100 | any | 100ms (TURBO) | 10 |
| 50–99 | any | 150ms (HIGH_LOAD) | 6.7 |
| any | running/queued | 200ms (ACTIVE) | 5 |
| < 50 | idle | 750ms (configurable via settings) | 1.3 |

Het interval wordt dynamisch aangepast: elke timer tick checkt `computeRefreshInterval()` en herstart de timer als de waarde veranderd is.

### Widget (agent-widget.ts)

| Status | Interval | fps |
|---|---|---|
| Agents running/queued | 200ms | 5 |
| Alle agents finished | 1000ms | 1 |

De widget past zijn interval aan wanneer de snapshot verandert (en dus een status-transitie heeft plaatsgevonden). Dit gebeurt via `currentIntervalMs` tracking: de timer wordt alleen herstart als de target interval echt verschilt van de huidige.

### Waarom deze intervallen
- **200ms** is snel genoeg voor vloeiende spinner-animatie en snelle status-updates
- **1000ms** idle is langzaam genoeg om CPU te sparen, maar frequent genoeg om een nieuwe spawn binnen 1 seconde te tonen
- **100ms/150ms** voor grote agent lijsten omdat status-transities frequenter zijn bij veel agents

---

## 4. Debounced requestRender (Conversation Viewer)

### Beslissing
In plaats van direct `this.tui.requestRender()` aan te roepen bij elke session event, gebruiken we een **drie-fasen debounce**:

1. **Rate limit check**: als er binnen de laatste 16ms een render is geweest, skip
2. **Coalesce fallback**: als de rate-limit actief is, plan een `setTimeout` voor als de window verloopt
3. **queueMicrotask**: als de rate-limit niet actief is, plan een microtask (coalesceert alle events in de huidige synchrone burst)

### Waarom geen directe requestRender
De session subscription vuurt op elk session event: text deltas, turn ends, compaction, etc. Tijdens streaming kan dit tientallen keren per seconde zijn. Zonder debounce zou de TUI ~60+ renders per seconde doen — allemaal identiek (de content is nog niet veranderd omdat de microtask de state pas na de burst update).

### Waarom geen vaste requestAnimationFrame
De TUI is terminal-gebaseerd en heeft geen `requestAnimationFrame`. `queueMicrotask` is het dichtste equivalent: het vuurt na de huidige synchrone call stack, maar voor eventuele I/O callbacks.

### Pattern (ook gebruikt in dashboard)
```typescript
private requestRender(): void {
  // 1. Rate limit
  if (lastRenderTime > 0 && elapsed < MIN_RENDER_GAP_MS) {
    if (!this.coalesceTimer && !this.renderPending) {
      this.coalesceTimer = setTimeout(() => {
        this.coalesceTimer = null;
        this.lastRenderTime = 0;
        this.requestRender(); // retry na window
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

### Beslissing
Dashboard theme (colors + box chars) wordt gecached en alleen herberekend als de UI style verandert.

### Waarom
`getThemeColors()` en `getBoxChars()` doen ANSI-string constructie. Voor elke render (elke 200ms) zou dit overhead geven. Met caching is het O(1) lookup.

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
```

Cache wordt geïnvalideerd in de `invalidate()` methode (aangeroepen door de TUI bij style changes).

---

## 6. Dynamische chromeLines (Dashboard)

### Beslissing
Chrome lines (aantal regels voor headers, footers, borders) past zich aan aan terminal hoogte:

| Terminal hoogte | Chrome lines |
|---|---|
| < 30 rijen | 10 |
| 30–50 | 13 |
| 50–80 | 16 |
| > 80 | 19 |

### Waarom
Op kleine terminals (laptops, gesplitste schermen) is elke regel kostbaar. Minder chrome = meer ruimte voor agent data. Op grote terminals is extra chrome acceptabel voor een rijkere UI.

---

## 7. AgentActivity Cleanup

### Beslissing
`AgentActivity` entries worden opgeruimd via een callback chain:

```
AgentManager.removeRecord() 
  → onRecordRemoved(id) 
  → index.ts: agentActivity.delete(id)
```

Dit gebeurt op drie momenten:
1. **Periodieke cleanup** (elke 30s, na TTL)
2. **`clearCompleted()`** (sessie start/switch)
3. **Agent completion** (via `sendIndividualNudge`, `groupJoin.onAgentComplete`, `swarmJoin.onAgentComplete`)

### Waarom geen extra GC
De `AgentActivity` map groeit alleen als agents actief zijn of net voltooid. Na voltooiing wordt de entry binnen 1-2 turn boundaries verwijderd. De callback chain zorgt dat verwijdering altijd gepaard gaat met activity cleanup — er is geen aparte sweep nodig.

---

## 8. Overzicht RequestRender Strategie

| Component | Timer | Debounce | Dirty check | Interval |
|---|---|---|---|---|
| Dashboard | Adaptief | Ja (16ms + microtask + coalesce) | Ja (snapshot) | 100–750ms |
| AgentWidget | Adaptief (`AdaptiveTick`) | Spawn-batch 16ms | Ja (snapshot) | 160–1000ms |
| AgentTopWidget | Adaptief (`AdaptiveTick`) | Nee | Ja (`buildSnapshotHash`) | 200–1000ms |
| ConversationViewer | Event-driven | Ja (16ms + microtask + coalesce) | Nee | — |

### Waarom conversation-viewer geen dirty check heeft
De conversation viewer toont de _volledige_ agent conversation. Elke session event (text delta, tool call, tool result) verandert de visible state. Een dirty check zou altijd true zijn tijdens streaming. De rate limit alleen is voldoende.

### Waarom AgentTopWidget geen aparte debounce heeft
De strip deelt `LiveWidgets` fan-out met `AgentWidget` en rate-limiteert via `AdaptiveTick`. Structurele changes gebruiken `buildSnapshotHash`; idle ticks blijven lopen zolang er UI-context is zodat settings-toggles zonder registry-callback worden opgepikt.

---

---

## 9. Spawn Batching (Phase 3.1)

### Beslissing
Bij bulk spawns (meerdere achtergrond agents die tegelijk worden gestart), gebruiken we een **tweetraps debounce** om de widget-updates te coalesceren:

1. **Eerste spawn**: `debouncedUpdate()` roept `update()` direct aan voor onmiddellijke feedback
2. **Timer (16ms)**: een korte setTimeout wordt gestart om eventuele volgende spawns binnen 16ms op te vangen
3. **Timer callback**: een tweede `update()` wordt uitgevoerd met de volledige batch
4. **Tussentijdse calls**: alle `debouncedUpdate()` calls tijdens de 16ms window worden overgeslagen

### Compacte batch rendering
Wanneer er 3+ agents van hetzelfde type in "queued" status zijn, worden ze getoond als een compacte regel:
```
├── ◦ 5× Explore queued
```
in plaats van 5 individuele regels. Dit bespaart verticale ruimte en vermindert render overhead.

### Waarom geen strict batching op spawn-niveau
Anders dan de batch orchestrator (die completions debounced), hebben spawns geen aparte buffer nodig omdat:
- De `AgentManager.spawn()` is synchroon — alle records worden in dezelfde call stack toegevoegd
- De widget timer (200ms actief) ziet alle records in één keer
- De dashboard requestRender is al rate gelimiteerd op 16ms

De debounce in `debouncedUpdate()` voorkomt alleen dat `widget.update()` 20x wordt aangeroepen voor 20 spawns — de snapshot build en `listAgents()` sort worden zo teruggebracht van 20 naar 2 calls.

### Key code
```typescript
// src/ui/agent-widget.ts
debouncedUpdate(): void {
  if (this.updateTimer) return;          // timer pending → skip
  this.update();                          // immediate: eerste spawn
  this.updateTimer = setTimeout(() => {    // coalesce volgende spawns
    this.updateTimer = undefined;
    this.update();
  }, AgentWidget.SPAWN_BATCH_MS);          // 16ms
}
```

### Trade-offs
- **Pro**: `listAgents()` en snapshot build worden 10-20x minder aangeroepen bij bulk spawns
- **Con**: eerste render toont 1 agent, tweede render 16ms later toont de volledige batch — korte visuele flits
- **Con**: compacte weergave verbergt individuele descriptions voor batches van 3+ agents

---

## 10. Render Metrics Architecture (Phase 3.3)

### Overzicht

Sinds Phase 3.3 beschikt de gehele UI over een **unified render performance tracking system** via de `RenderMetrics` class. Deze class wordt geïnstantieerd door zowel de `AgentWidget` als de `AgentDashboard` en trackt real-time metrics over hoe lang renders duren, hoe effectief de debounce is, en hoeveel agents er gemiddeld per render worden verwerkt.

De data is live te bekijken via de `/perf` command in de dashboard.

---

### 10.1 RenderMetrics Class (`src/ui/render-metrics.ts`)

```typescript
const metrics = new RenderMetrics(label: string, slowThresholdMs?: number);
```

#### Publieke API

| Methode | Beschrijving |
|---|---|
| `record(durationMs, activeAgents?)` | Registreer een render execution. Optioneel aantal agents. Returnt `true` als de render langzamer was dan `slowThresholdMs`. |
| `recordRequested()` | Registreer een _request_ om te renderen (vóór debounce/dirty filtering). Returnt het netto requested count. |
| `setFirstSpawnTimestamp(ts)` | Zet de timestamp van de eerste agent spawn (earliest wint). |
| `reset()` | Reset alle counters. |
| `snapshot()` | Returnt een `RenderMetricsSnapshot` met alle huidige waarden. |

#### Volledige Snapshot Velden

```typescript
interface RenderMetricsSnapshot {
  label: string;                          // "widget-update" of "dashboard-render"

  // ── Render duration stats ──
  renderCount: number;                    // Hoe vaak record() is aangeroepen
  meanMs: number;                         // Gemiddelde render duur
  minMs: number;                          // Snelste render
  maxMs: number;                          // Langzaamste render
  lastMs: number;                         // Laatste render duur

  // ── Request vs actual (debounce effectiveness) ──
  requestedRenderCount: number;           // Hoe vaak render is gevraagd
  skippedRenderCount: number;             // request - actual (gedebounced)
  requestToActualRatio: number;           // Verhouding (bv. 2.5x)

  // ── Agent context ──
  activeAgentCount: number;               // Hoe vaak activeAgents is meegegeven
  activeAgentMin: number;                 // Minimum agents tijdens een render
  activeAgentMax: number;                 // Maximum agents tijdens een render
  activeAgentMean: number;                // Gemiddeld aantal agents per render

  // ── Time to first visible ──
  firstRenderTimestamp: number;           // Timestamp van eerste render
  firstSpawnTimestamp: number;            // Timestamp van eerste spawn
  timeToFirstVisibleMs: number;           // Verschil (perceived lag)

  // ── Render rate ──
  startedAt: number;                      // Timestamp van start/laatste reset
  elapsedMs: number;                      // Verstreken tijd sinds startedAt
  rendersPerSecond: number;               // Huidige render frequentie
  rendersPerMinute: number;               // Huidige render frequentie (minuut)
}
```

---

### 10.2 Instrumentatie Punten

#### AgentWidget — `renderWidget()` (src/ui/agent-widget.ts)

- **Label**: `"widget-update"`
- **Slow threshold**: 16ms (~60fps budget)
- **Wat er wordt gemeten**: de daadwerkelijke line-building tijd in `renderWidget()`
- **Wanneer `record()` wordt aangeroepen**: in de `finally` van `renderWidget()`, zodat de timing altijd wordt geregistreerd, zelfs bij fouten
- **activeAgents**: `allAgents.filter(a => a.status === "running" || a.status === "queued").length`
- **recordRequested()**: wordt aangeroepen in `update()` wanneer de dirty-skip path (snapshot is unchanged) wordt genomen — dit zijn de renders die door debounce zijn overgeslagen
- **setFirstSpawnTimestamp()**: wordt aangeroepen in `update()` bij de eerste actieve agent

**Flow:**
```
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
- **Slow threshold**: 50ms (dashboard heeft meer werk dan widget)
- **Wat er wordt gemeten**: de volledige `render()` methode (header + body + detail panel + footer)
- **Wanneer `record()` wordt aangeroepen**: aan het einde van `render()`, vlak voor return
- **recordRequested()**: wordt aangeroepen in `requestRender()` vóór de debounce/rate-limit checks — telt ALLE requests, ook rate-limited
- **setFirstSpawnTimestamp()**: wordt aangeroepen in `render()` bij de eerste agent

**Flow:**
```
requestRender()
  ├─ recordRequested()                    ← telt alle requests
  ├─ rate limit check?
  │   ├─ nog in window? ─► coalesce via setTimeout
  │   └─ window verlopen? ─► queueMicrotask → tui.requestRender()
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

Sinds de implementatie van command mode is de `/perf` command beschikbaar in de agent dashboard.

#### Gebruik

| Actie | Toets |
|---|---|
| Open command mode | `/` |
| Toggle perf panel | `/perf` + Enter |
| Reset counters | `/perf reset` + Enter |
| Annuleer command | Esc |
| Sluit perf panel | `q` of Esc |

#### Wat de perf panel toont

```
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

#### Hoe te interpreteren

| Metric | Gezond | Waarschuwing | Actie |
|---|---|---|---|
| **lastMs / meanMs** | < 16ms (widget), < 50ms (dashboard) | > 50ms (widget), > 100ms (dashboard) | Verminder aantal agents, optimaliseer render code |
| **maxMs** | < 50ms | > 200ms | Zoek de outlier: welke agent/config veroorzaakt de piek? |
| **requestToActualRatio** | 1.0–3.0x | > 10x | Debounce is te agressief of er worden te veel onnodige requests gedaan |
| **skippedRenderCount** | ≈ request - actual | Zeer hoog t.o.v. actual | Check of dirty detection goed werkt (snapshot hash collision?) |
| **timeToFirstVisibleMs** | < 500ms | > 2000ms | Dashboard/widget wordt te langzaam zichtbaar — check init code |
| **rendersPerSecond** | 3–10 (dashboard), 1–5 (widget) | > 60 | Rate limit wordt omzeild — check debounce logic |
| **activeAgentMax vs mean** | Max ≈ 2× mean | Grote spreiding | Sommige renders verwerken veel meer agents dan gemiddeld — check virtual scrolling |

---

### 10.4 Debug Logging

Render metrics logt op `debug` level via de bestaande `logger` utility. Dit is standaard **uitgeschakeld** en moet worden geactiveerd:

```bash
# Activeer debug logging voor render metrics
PI_SUBAGENTS_LOG_LEVEL=debug npm start
```

Wanneer `record()` detecteert dat de render duur de `slowThresholdMs` overschrijdt, wordt een gestructureerd log bericht uitgezonden:

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

Dit is nuttig voor:
- **Performance regression hunting**: vergelijk meanMs over tijd
- **CI monitoring**: detecteer of een code change renders significant vertraagt
- **User reports**: vraag een `PI_SUBAGENTS_LOG_LEVEL=debug` log bij klachten over trage UI

---

### 10.5 Render Rate en Elapsed Time

- `startedAt` wordt gezet bij constructie of na `reset()`
- `elapsedMs` = `Date.now() - startedAt`
- `rendersPerSecond` = `renderCount / (elapsedMs / 1000)`
- `rendersPerMinute` = `renderCount / (elapsedMs / 60000)`

De rates zijn **instantaneous**: ze reflecteren de gemiddelde frequentie sinds de laatste reset. Bij een lange sessie met veel idle tijd zullen de rates laag zijn, ook als de renders zelf snel waren. Reset de counters met `/perf reset` voor een frisse meting tijdens een specifieke workload.

---

### 10.6 Time to First Visible

`timeToFirstVisibleMs` meet de tijd tussen de eerste `setFirstSpawnTimestamp()` call (meestal in `update()` of `render()` bij detectie van de eerste agent) en de eerste `record()` call (de eerste daadwerkelijke render).

Dit is een proxy voor **perceived startup lag**: hoelang duurt het voordat een gebruiker de eerste agent ziet in de UI na spawn?

**Noot**: dit is geen exacte meting van spawn-to-display latency, omdat:
- De spawn timestamp wordt gezet in de eerstvolgende `update()` of `render()` cyclus, niet op het exacte moment van spawn
- De TUI framework heeft zijn eigen render scheduling die niet in deze meting zit
- Het is desondanks een goede indicator voor regressies in perceived performance

---

### 10.7 Widget Render Metrics

Naast de dashboard metrics heeft de `AgentWidget` ook zijn eigen `RenderMetrics` instantie, toegankelijk via `getRenderMetrics()`.

**Verschillen met dashboard metrics:**

| Aspect | Widget | Dashboard |
|---|---|---|
| Threshold | 16ms | 50ms |
| Wat wordt gemeten | Alleen line-building in `renderWidget()` | Volledige `render()` (incl. header, footer, detail panel) |
| `recordRequested()` | Alleen in dirty-skip path (snapshot unchanged) | In `requestRender()` vóór alle debounce checks |
| `activeAgents` | Alle agents (`this.manager.listAgents()` gefilterd op running/queued) | Alle agents (dashboard toont alles) |
| Rate limiting | Via timer interval (200ms actief / 1000ms idle) | Via debounce in `requestRender()` + microtask |

---

### 10.8 Benchmark Tests

Alle benchmark tests gebruiken de gedeelde helper `test/helpers/benchmark-log.ts`. Interne waarden zijn altijd milliseconden (`performance.now()`); sub-ms werk wordt als `µs` weergegeven (×1000). CI draait `node scripts/check-benchmark-thresholds.mjs` als **blocking** required gate met `--retry=0`.

Er zijn **14 render performance benchmarks** in `test/widget-render-perf.test.ts`:

| Groep | Tests | Wat wordt gemeten |
|---|---|---|
| renderAgentWidget pure throughput | 4 | 10/50/200/all-running agents render tijd |
| renderAgentWidget met activity data | 2 | 50/200 agents + activity heatmap entries |
| buildSnapshot dirty checking | 3 | 10/50/200 agents snapshot hash snelheid |
| getVisibleWindow virtual scrolling | 3 | 200/1000 agents, scroll latency |
| debouncedUpdate coalescing | 1 | 100 rapid calls → 1 immediate + 1 timer |
| Sustained update throughput | 1 | 50 ticks × 20 agents < 2ms per tick |

Daarnaast zijn er **11 RenderMetrics unit tests** in `test/render-metrics.test.ts`:

| Groep | Tests | Wat wordt getest |
|---|---|---|
| Basic tracking | 4 | Zero state, single record, min/mean/max, reset |
| Requested vs actual | 6 | recordRequested, skippedCount, ratio, edge cases |
| Active agents tracking | 2 | Agents per render, zonder agent data |
| Time to first visible | 4 | Zonder spawn, met spawn, earliest timestamp, ignore later |
| Render rate | 3 | Zero state, elapsed time, increasing time |
| Getters | 3 | count, requestedCount, mean/min/max/last |

```bash
# Run all render metrics + widget tests
npx vitest run test/render-metrics.test.ts test/agent-widget.test.ts test/widget-render-perf.test.ts

# Expected: 64 tests passing
```

---

### 10.9 Best Practices

1. **Reset voor metingen**: gebruik `/perf reset` voordat je een specifieke workload test, zodat de rates en averages alleen die workload reflecteren
2. **Kijk naar mean, niet max**: de max kan een eenmalige JIT-compilatie of GC-pauze zijn. De mean is representatiever voor steady-state performance
3. **Debounce ratio > 10x is verdacht**: als er 10+ requests per daadwerkelijke render zijn, check of er ergens een render request storm is zonder rate limiting
4. **Time to first visible > 2s**: dit wijst op een startup bottleneck. Check de init code van dashboard en widget
5. **Renders/sec > 60**: de MIN_RENDER_GAP_MS (16ms) wordt omzeild. Check of `requestRender()` direct wordt aangeroepen in plaats van via de debounce

---

## 11. Aanbevolen Benchmarks

Voor het valideren van performance veranderingen:

```bash
# Basislijn: typecheck + lint + test suite
npm run typecheck && npm run lint && npm test

# Dashboard rendering performance (bestaande test)
npm test -- test/dashboard-components.test.ts

# Render metrics + widget + benchmark tests
npx vitest run test/render-metrics.test.ts test/agent-widget.test.ts test/widget-render-perf.test.ts

# Compaction benchmarks
node --experimental-specifier-resolution=node test/compaction.benchmark.ts
```

### Kritische metrics
- **`listAgents()` tijd**: zou < 1ms moeten zijn voor < 500 agents
- **`buildSnapshot()` tijd**: zou < 0.1ms moeten zijn voor < 100 agents
- **`requestRender()` calls per seconde**: dashboard max 5-10fps, max 60fps met debounce
- **Widget render mean**: < 5ms voor < 50 agents
- **Dashboard render mean**: < 50ms voor < 200 agents
- **Geheugen per `AgentRecord`**: ~2-5KB (excl. session messages)
