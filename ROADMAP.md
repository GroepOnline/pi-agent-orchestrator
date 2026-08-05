# Roadmap

Steering document for **what ships next**. Completed feature narratives live in
[`CHANGELOG.md`](CHANGELOG.md) and [`docs/architecture.md`](docs/architecture.md).
The guarded 0.18 release-train machinery is documented in
[`docs/releases/v0.18.0.md`](docs/releases/v0.18.0.md) but is **not** the active
ship target until after **0.17.5**.

Last rebuilt: **2026-07-16**.

---

## Current snapshot

| Field | Value |
|-------|--------|
| Published / package baseline | **0.17.5** (this cut; was 0.17.1) |
| **Next ship target** | Soak **0.17.5**, then reopen 0.18 publish only when ready |
| 0.18.x train | Infrastructure already on `main` via [#282](https://github.com/GroepOnline/pi-agent-orchestrator/pull/282); **parked** until 0.17.5 is cut and soaked. Do not bump/publish 0.18.0 yet. |
| Validation scale | **~1.8k+** tests (CI on #282: **1,839**; local suite grows with follow-ups) |
| Product shape | Local **Pi extension** — no hosted control plane, multi-tenancy, K8s, or external queues |

**Fresh-install defaults (light, for 0.17.5):** `orchestrationMode: single`, `maxConcurrent: 3`, swarm default size **2** (clamp [2, 5]). Crew / swarm / auto remain opt-in.

---

## Now — 0.17.5 full sweep

Goal: one deliberate minor that makes 0.17.x **boringly trustworthy** before any 0.18 publish. Heavy by design — not “ship the release train early.”

### A. Unblock and stabilize CI

1. Merge **[#286](https://github.com/GroepOnline/pi-agent-orchestrator/pull/286)** (Windows `gh.exe` stub argv) — release-finalize tests green on Windows Node 22/24.
2. Fix remaining suite flakes/failures (e.g. `test/task-budget.test.ts` parentId race seen locally) until `npm run typecheck && npm run lint && npm test` is clean on Linux + documented Windows/macOS CI lanes.
3. Treat **#286 stub as SSOT** for `test/release-finalize-exec.test.ts` — do not land competing Jules stub variants.

### B. Curate open PR noise into 0.17.5 (do not merge the pile)

Open Jules/micro-PRs (#287–#299) overlap heavily. For 0.17.5:

| Take | Drop / close |
|------|----------------|
| Abort dedup (#287 source) | Micro-perf without product signal (#288, #289, #292, #293) |
| `randomUUID` for RPC + hook IDs (#290 / #291 **source only**) | Lockfile / `pr_description.md` / stub pollution |
| Logger TTY memoize (#294) if still wanted | Broad console→stdout rewrite (#295) unless separately reviewed |
| Async `loadCustomAgents` (#296 source + perf test) | Low-quality coverage dump (#297) |
| Madge pin / import-graph CI time (#299) if verified | Anything that rewrites the Windows gh stub differently than #286 |

Prefer **one curated PR** (or this working-tree batch) over sequential merges.

### C. Product hardening already in flight (land in 0.17.5)

- Bounded **`subagent:end` revision gate** (`maxEndHookRevisions`, default `0` = fail closed; object-form `{ action: "block", feedback }`).
- Lighter defaults: concurrent **3**, swarm size **2**, mode **single**.
- Roadmap / api-reference / settings surface for the new setting.

### D. 0.17.5 exit criteria

- [ ] Version **0.17.5** in `package.json` + lockfile root metadata + CHANGELOG section
- [ ] Full verification suite green (typecheck, lint, tests, package contents as required by CI)
- [ ] Windows release-finalize path green (#286 or equivalent on main)
- [ ] Open PR queue pruned (merged curated set / closed superseded)
- [ ] No 0.18.0 version bump and no 0.18 npm publish in this cut

Publish 0.17.5 as a normal patch/minor on the **0.17 line**. Keep the 0.18 transactional publisher idle.

---

## Next (after 0.17.5 soaks)

1. **Host integration documentation** — `TracerProvider`, exporters, public API / hooks / RPC discovery.
2. **Examples gallery** — short spawn / crew / swarm / hooks recipes.
3. **Agent Ready / catalog polish** — install → first orchestration stays reliable (feeds later 0.18 distribution story).

---

## Later — 0.18.0 and platform depth

### 0.18.0 (only after 0.17.5)

- Execute the **transactional** bump/publish/tag/GitHub Release on the reviewed merged commit (`docs/releases/v0.18.0.md`).
- Catalog / tarball verification for Pi discovery metadata, skill, and prompts.
- Unlock other release lines only via deliberate `.release-policy.json` PR — never casually.

### Observability
- ✅ Structured JSON logging (`src/logger.ts`).
- ✅ Tracing master switch + `correlation.id` on agent lifecycle spans; `/agents → Health check`.
- ⏳ Prometheus-format metrics export.
- ⏳ Package-owned local trace exporter (host configures `TracerProvider` today).
- ⏳ Correlation id on **every** runner log line.

### Security & governance
- ✅ RPC audit foundations: caller identity, unauthorized / rate-limited outcomes, per-extension rate limits, session agent/turn caps.
- ⏳ Durable / immutable audit log (today: clearable in-memory ring buffer).
- ⏳ Settings-based RBAC matrix.
- ⏳ Token / cost budget guards (turn/spawn caps ≠ dollar/token ceilings).
- ⏳ Generic secrets redaction layer.

### Reliability
- ✅ Partial: circuit breaker; schedule-store hardening; dirty-worktree preservation; agent-ID canonicalization; `subagent:end` revision gate (0.17.5).
- ⏳ First-class retry / DLQ+replay / saga compensation.
- ⏳ Idle-stream timeout (independent of `maxDurationMs`).
- ⏳ Auto commit / push / draft-PR after background worktree runs.

### Testing & operations
- ✅ Benchmarks; cross-platform CI; package/release gates; interactive health check.
- ⏳ Continuous monitoring; chaos suite.

---

## Recently shipped (pointers only)

| Area | Pointer |
|------|---------|
| Orchestration dispatch + histogram | CHANGELOG v0.14.x; `docs/architecture.md` |
| OSS / npmjs readiness | CHANGELOG v0.17.0 / v0.17.1 |
| Pi catalog + Orchestra skill/prompts | #277, #279 |
| Worktree / schedule-store hardening | #275, #261 |
| Motion / showcase / Pages | motion docs; #281 |
| Transactional 0.18 **machinery** (not yet published) | #282; `docs/releases/v0.18.0.md` |

---

## Out of scope

- Multi-tenancy / horizontal worker pools
- Redis, RabbitMQ, or other external message queues
- Bundled Jaeger/Tempo backends (host may attach exporters)
- External OAuth/OIDC as a product dependency
- Kubernetes / container orchestration of this extension

This remains a **Pi extension** that runs inside the Pi coding agent host, not a standalone service.
