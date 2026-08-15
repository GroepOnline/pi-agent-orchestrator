# Changelog

## [Unreleased]

- Raise the Node.js floor to `22.22.3` (`.nvmrc`, Cloud Dockerfile digest, `engines.node`, and release-critical CI) so `posthog-node@5.47.3` engine requirements no longer fail Cursor Cloud install.

---

## v0.18.1 (2026-08-10)

### Subagent budget fix (data-driven)

- **Default max turns: unlimited → 30.** Workers without an explicit `max_turns` ran into the 10-minute duration quota (`DEFAULT_MAX_DURATION_MS`) and were aborted with no final report — 40/43 subagent aborts across a 268-session evaluation were exactly this. A finite default turns the duration kill into a soft-limit steer (with `graceTurns` headroom for the report) so workers always return an end report instead of dying silently.
- **Soft-limit steer message** now demands an explicit end report (findings, done/blocked, exact file paths/commit SHAs) instead of a generic "wrap up".

Oversized tasks should still pass an explicit `max_turns`; the ceiling is a safety net, not a sizing tool.

### Additional changes since v0.17.1

- **Model/provider resilience**: reject empty model input (CHE-21), fall back to parent model on pinned-model 401 (CHE-15), trip the circuit breaker on prompt/401 failures (CHE-17), and treat external AbortSignal as a graceful stop (CHE-19).
- **Agent invocation**: explicit `Agent()` `max_turns` now wins over profile defaults (CHE-28).
- **Swarm cleanup**: prune dead SwarmCoordinator features (CHE-25).
- **Org migration**: LICENSE copyright now reads GroepOnline (was OnlineChefGroep).
- Docs synced for identity, hotkeys, tools, and PERFORMANCE (CHE-30).

### Fixed

- **Workers without an explicit budget no longer run into the 10-minute duration quota and die silently** (from the 2026-08-10 268-session evaluation: 40/43 subagent aborts were `Duration quota exceeded`, median ~10min = `DEFAULT_MAX_DURATION_MS`). `defaultMaxTurns` now defaults to `30` instead of `undefined`, so every worker gets the soft-limit steer (with `graceTurns` headroom) and returns an end report before the duration kill fires. Oversized tasks should still pass an explicit `max_turns`.
- Soft-limit steer message now demands an explicit end report (findings, done/blocked, file paths/SHAs) instead of a generic "wrap up".

---

## v0.18.0 (2026-08-05)

### Pi package distribution

- Ships the package as a complete Pi bundle: extension, `/skill:pi-orchestra`, and the `/orchestra-audit`, `/orchestra-plan`, and `/orchestra-implement` prompt templates.
- Adds the canonical public MP4 preview and exact Pi discovery metadata used by the package catalog.
- Reworks the README around install, one-session trial, first successful orchestration run, safety boundaries, and direct operator controls.
- Proves the actual npm tarball contains every declared extension, skill, prompt, documentation, and license resource.

### Release integrity

- Replaces the mutable ad-hoc release path with a reviewed release-PR transaction and an automatic publisher that tags and publishes the exact merged source commit.
- Locks releases to the `0.18.x` train. `0.19.0` and every other release line are rejected until `.release-policy.json` is changed in a dedicated reviewed pull request.
- Keeps `package.json`, both package-lock root versions, the changelog, npm, the Git tag, and the GitHub Release on one version.
- Makes npm publication recoverable and idempotent: an already-published package can complete a missing tag or GitHub Release without republishing.
- Adds npm provenance and prepares the canonical `release.yml` workflow for trusted publishing through GitHub OIDC.

### Runtime and security hardening

- Canonicalizes agent identifiers before they are used in temporary worktree paths or Git branch names.
- Preserves dirty worktrees with explicit recovery details when inspection, staging, commit, branch creation, or removal cannot be proven safe.
- Aligns the runtime floor and release jobs on Node.js `22.19.0` while retaining Node 24 compatibility coverage.
- Keeps multi-agent orchestration opt-in and preserves the no-merge, no-publish, and no-deploy boundaries in the packaged implementation workflow.

### Validation

- Full build, typecheck, Biome lint, test suite, package metadata checks, npm tarball inspection, lowest supported peer tests, dependency review, render benchmarks, Super-Linter, and Windows/macOS/Linux compatibility lanes must pass before the release PR can merge.

### Additional changes since v0.17.1

### Changed

- Package scope migrated from `@onlinechefgroep` to `@groeponline` after the
  GitHub organization rename to GroepOnline. New installs come from
  `@groeponline/pi-agent-orchestrator`.
- Host baseline bumped to `@earendil-works/pi-*` **0.81.1** (peers `>=0.81.1`).
  Adopts expanded compaction usage fields, resilient summarization retry
  telemetry, and `excludeTools` at subagent session create.

### Added

- Real-session showcase pipeline: asciinema scene markers, a dynamic
  1920×1080/60fps Remotion master, focused skill/subagent/dashboard/handoff
  clips, and strict codec/frame/version verification.
- Packaged `real-product-showcase` skill for real terminal, browser, and app
  demo capture, plus post and quality-gate references.
- `CompactionSnapshot` / `lastCompaction` populated from upstream Pi
  `compaction_end` (tokensBefore/After, reduction%, usage, aborted, willRetry)
  — #325 Phase A (#325).
- Lifetime usage folds successful compaction summarization `usage` (Pi 0.81+).
- Thinking level allowlist validation (`parseThinkingLevel` + Agent tool
  `Type.Union` literals including `max`).
- Telemetry event `subagent:summarization_retry` for Pi 0.81.1 resilient
  compaction retries.

### Fixed

- **Duration quota no longer crashes the host**: `checkDurationQuota` threw
  an `AgentRunnerError` from inside the sync session-event subscriber, which
  escaped the run loop and surfaced as an `uncaughtException` that killed the
  entire Pi host process. It now aborts the session gracefully and surfaces the
  outcome as `{ aborted: true, timedOut: true }` on `RunResult` (mirroring the
  token/tool-call quota handling), so a long-running agent times out cleanly
  instead of taking the whole session down.
- Agent tool-call lifecycle hardening (#327): stable spawn-time completion
  promises, cancellable foreground crew/swarm waits, queued
  `get_subagent_result(wait:true)`, and `Agent` `executionMode: "sequential"`.
- Compaction public API / docs truth (#325): typed `compaction:*` hook payloads
  match runtime `{ reason }` / `{ reason, tokensBefore }`; document that local
  `src/compaction.ts` pruning is not on the live subagent path.
- Troubleshooting no longer equates `compactionCount` with local pruning /
  `DEFAULT_KEEP_TURNS`.

---

## v0.17.5 (2026-07-16)

Hardening sweep on the 0.17 line. The transactional 0.18 release train remains
parked — see `ROADMAP.md` and `docs/releases/v0.18.0.md`.

### Added

- Bounded `subagent:end` revision gate: blocking end hooks can force in-session
  revision turns via `maxEndHookRevisions` (default `0` = fail closed). Supports
  `{ action: "block", feedback?, reason? }` in addition to `"block"`.
- Settings + `/agents → Settings` entry for `maxEndHookRevisions`.
- Async parallel file reads in `loadCustomAgents` (`fs/promises` + `Promise.all`).
- Logger TTY-default memoization with live `PI_SUBAGENTS_LOG_LEVEL` reads.
- Import-graph guard pins `madge@6.1.0` via npx (predictable CI, no registry drift).

### Changed

- Fresh-install defaults: `maxConcurrent` **3** (was 4), swarm default size **2**
  (was 3); `orchestrationMode` remains `single`.
- Roadmap rebuilt as a steering doc aimed at **0.17.5 first**, 0.18 later.

### Fixed

- Windows `gh.exe` release-finalize stub argv (`["release", ...process.argv.slice(2)]`)
  so Node-as-gh hardlink tests pass on Windows Node 22/24 (#286).
- Deduplicated `AgentManager.abort` stopped-state updates (#287).
- `task-budget` ALS inheritance test: `mockReset` between cases + assert active parent id.

### Security

- RPC request IDs and auto-generated hook IDs use `randomUUID()` instead of `Math.random`.

### Previously unreleased on 0.17.x (landed before this cut)

- OpenCode V2 skill/agents and fish-shell safety skill.
- CODEOWNERS / Dependabot / issue+PR templates; public-repo security scanning.
- Dashboard v2 test modernization; Super-Linter codespell skip globs; showcase media refresh.

---

## v0.17.1 (2026-07-06)

### Bug Fixes

- **Orchestration dispatch heuristic**: Fixed `hasMultipleFiles` alone triggering crew mode for read-only prompts. The heuristic now requires an accompanying implementation signal (implement, build, create, write, add, develop) before dispatching crew mode for multi-file prompts. This prevents unnecessary 3-agent crews for simple file exploration tasks.
- **Precedence order**: Fixed long multi-step implementation check to run before parallel keyword check, matching the documented precedence order.
- **Duplicate conditions**: Removed legacy duplicate branches in `heuristicPickMode()` that were left after the initial refactor.

### Internal

- Merged PRs: #233 (deps), #234 (wiki CI), #236 (crew dispatch fix)
- All 1693 tests pass

---

## v0.17.0 (2026-07-05)

### OSS Readiness — Full Public Release

This release transforms the extension from an internal project into a fully accessible open-source package. Every aspect — installation, documentation, code quality, CI/CD, and first-time contributor experience — has been audited and hardened.

#### Installation & Publishing

- **npmjs.org publishing restored**: Recreated `publish-npm.yml` workflow. `NPM_TOKEN` org secret triggers automatic publish to npmjs.org on `v*` tag push.
- **`package.json`**: `publishConfig.registry` now points to `registry.npmjs.org` (public access). Added `prepublishOnly` script (build + typecheck + lint + test). Expanded `files` array to include `dist/`. Added 8 new keywords for discoverability.
- **`.npmignore`**: Excludes test/, scripts/, .github/, .agents/, and internal files from published package.

#### Internal Cleanup

- **Removed tracked internal files**: `HANDOFF.md`, `INFRASTRUCTURE.md`, `CLAUDE.md`, `.agents/autoresearch/.autoresearch-off` — all deleted from git.
- **`.gitignore`**: Extended with internal paths, job logs, `.commandcode/`, `droid-wiki/`.
- **`AGENTS.md`**: Stripped private repo cross-links (`../chefgroep.nl/`, `../skill-grinder/`, `../OrgBeheer/`), CHEF branching rules, and sibling repo references. Retained all Common Mistakes and conventions.
- **`docs/index.md`**: Removed 3 broken links (SECURITY_AUDIT_REPORT, REVIEW_AND_FUTURE, SECURITY_AUDIT_VERIFICATION). Added overdrive-patterns and repository.md references.

#### README Rewrite

- **User-first structure**: Installation prerequisites, `/agents` quick start, keyboard cheatsheet table, custom agent example, dynamic CI badge (no hardcoded test counts).
- **Removed**: showcase pipeline table, "What's new" section, Chain of Agents details, opt-in debug capture wall of text (all moved to docs/).

#### Bug Fixes

- **H2**: Widget `getVisibleWindow()` partial-skip page budget off-by-one — `remainingLines` now decrements by visible portion only.
- **M4**: Schedule detail card box alignment — padding formula `width-5` instead of `width-4`.
- **M6**: Shifted keys (`shift+p`, `shift+s`, etc.) no longer cancel command mode — mapped to uppercase in command buffer.
- **L1**: `agent-widget-renderer.ts` `.replace()` now only replaces first occurrence (tree prefix).
- **L4**: Top view sort keys (`t/r/d/u/l/n`) added to dashboard help overlay.

#### Type Safety

- **`global-registry.ts`**: New typed accessor module replacing ad-hoc `(globalThis as any)[Symbol.for(...)]` patterns across 3 files (agent-dashboard, index, telemetry).
- **`isBashExecution()` type guard**: Replaces `(msg as any).role === "bashExecution"` in conversation-viewer.
- **Removed `as any` casts**: `manager`, `swarmCoordinator`, `tui` boundary casts replaced with proper typed interfaces.

#### Documentation

- **`CONTRIBUTING.md`**: Updated project structure tree (all current modules), added `npm run bench:all`, added Publishing section with release workflow, added Branch Protection section.
- **`ROADMAP.md`**: Updated to v0.17.0, removed stale CHEF ticket references.
- **`docs/index.md`**: Cleaned up dead links, added missing document references.

#### CI/CD Hardening

- **Dependabot grouping**: npm and GitHub Actions updates now batched into single PRs.
- **`FUNDING.yml`**: Added GitHub Sponsors configuration.
- **CodeQL**: Added commented-out `pull_request` trigger (requires GitHub Advanced Security).
- **CI**: Biome lint scoped to Node 22 (Node 24 binary resolution issue documented).

#### Metrics

- 1693 tests across 95 test files. Typecheck + lint + test all green.

## v0.16.3 (2026-07-02)

### Performance

- **UI render freezes eliminated**: Widget dirty checking switched from string-based `buildSnapshot` to numeric FNV-1a `buildSnapshotHash`, removing all string allocations from the update hot path. Zero-allocation snapshot comparison eliminates render freezes across all UI components.

### Refactors

- **Adversarial validation extracted**: Adversarial validator logic extracted from `agent-runner` into dedicated module with improved UI key handling.

### Fixes

- **Test suite**: Fixed `buildSnapshot` → `buildSnapshotHash` migration in `test/agent-widget.test.ts` — 7 tests updated for numeric hash assertions.
- **Benchmark thresholds**: Relaxed 7 threshold limits that were too tight for some machines: `parseHandoff long summary` (3.5→5ms), `renderAgentWidget 10 mixed` (0.6→1.0ms), `renderAgentWidget 50 mixed` (3→4ms), `renderAgentWidget 200 mixed` (15→18ms), `renderAgentWidget 40 queued/20 types` (2→4ms), `renderAgentWidget 50 w/activity` (5→7ms), `widget update 50 ticks` (2→3ms).
- **Release verification**: Updated `test/release-verification.test.ts` to check GitHub Packages registry only.

### Documentation

- **Test counts**: Updated README.md and ROADMAP.md from 1667/1694 to accurate 1693 tests across 95 test files.

### Metrics

- 1693 tests across 95 test files. Typecheck ✅, lint ✅.

## v0.16.2 (2026-07-02)

### Maintenance & Chores

- **NPM registry fallback**: Removed npmjs.org workflow and pointed publishConfig registry back to GitHub Packages (`npm.pkg.github.com`).

## v0.16.1 (2026-07-02)

### Fixes

- **`agent-runner` circuit breaker**: Fixed the `ModelCircuitBreaker` to reset failures on successful calls in the closed state.
- **Open-source release cleanup**: Removed private developer log and planning files (`.jules/`, `commit_message.txt`, `VERVOLG_PLAN.md`, `branch-manifest.md`) from Git and ignored them.
- **Scoped publish access**: Configured publishConfig `"access": "public"` for npmjs.org.

## v0.16.0 (2026-07-02)

### Features

- **CHEF-100 Workspace Context RFC**: Introduced Phase 1 of the dual-read context adapter (`buildEnvFromContext`), covering 5 distinct environment scenarios.
- **Overdrive Pattern Catalogue**: Added reusable linter rules (P3, P4, P5) for performance optimization audits.

### Fixes

- **`agent-runner` compaction**: Fixed the `onCompaction` hook in `agent-runner`.
- **Overdrive false positive**: Defeated an Overdrive P4 detector false positive in environment resolving via helper extraction.

### Maintenance & Chores

- **Version consistency**: All files aligned on v0.16.0 (package.json, README, ROADMAP, VERVOLG_PLAN, CHANGELOG).
- **Test counts**: Updated to 1694 tests across 95 test files.
- **Dependencies**: Bumped devDependencies `@types/node` and `@biomejs/biome` to align with the workspace.

### Metrics

- 1694 tests across 95 test files. Typecheck + lint green. All 61 benchmarks OK.

## v0.15.0 (2026-06-24)

### Open-Source Public Release

- **Public repo**: Repository made public on GitHub (`GroepOnline/pi-agent-orchestrator`)
- **publishConfig**: Default registry now points to npmjs.org (was GitHub Packages); CI still dual-publishes
- **HANDOFF.md**: Removed staging-remote import workflow; repo is directly public
- **Version consistency**: All files aligned on v0.15.0 (package.json, README, ROADMAP, VERVOLG_PLAN, CHANGELOG)
- **Test counts**: Updated to 1667 tests across 93 test files

### Metrics

- 1667 tests across 93 test files. Typecheck + lint green. All 61 benchmarks OK.

## v0.14.1 (2026-06-16)

### Features

- **`tracingEnabled` master switch + OTel short-circuit**: New `tracingEnabled` boolean setting in `.pi/subagents.json` (defaults to `true`) controls OpenTelemetry span emission in `agent-runner`. When `false`, every span helper in `src/telemetry-otel.ts` returns a shared `NOOP_SPAN` singleton (chainable no-op methods, `isRecording: () => false`) and the runtime cost is one flag check per span lifecycle call. Useful for users who have configured an OTel `TracerProvider` globally but don't want subagent spans in their traces. Surfaced in `/agents → Settings → Tracing` with an enabled/disabled select + "already set" short-circuit, matching the existing `Scheduling` toggle pattern. Runtime toggles take effect for all subsequent spans; in-flight agent spans keep their real span and end normally.
  - New `isTracingEnabled()` / `setTracingEnabled(b)` getters/setters in `src/agent-registry.ts` (default `true`).
  - New `tracingEnabled` field on `SubagentsSettings` + sanitize + `SettingsAppliers.setTracingEnabled` wiring in `src/settings.ts`.
  - 4 new short-circuit tests in `test/telemetry-otel.test.ts` (no real spans created, `isRecording` returns `false`, end helpers don't throw, re-enabling restores creation).
  - 2 new round-trip + sanitize + 3 new `applySettings` wiring tests in `test/settings.test.ts`.

### Refactor

- **Settings UI args → `SettingsGetters` + `SettingsSetters` objects**: Stop the 14-positional-arg spiral on `showSettings()` and 11-positional-arg spiral on `notifyApplied()`. New `SettingsGetters` (5 read fns: default max turns, grace turns, default join mode, scheduling, tracing) and `SettingsSetters` (5 write fns) interfaces in `src/settings.ts`. `showSettings(ctx, manager, pi, scheduler, getters, setters)`, `notifyApplied(ctx, pi, manager, getters, successMsg)`, and `buildSettingsSnapshot(manager, getters)` all take the objects now. `AgentsMenuDeps` shrank from 14 individual getter/setter fields to `settingsGetters` + `settingsSetters`. Adding a new menu-editable setting is now a 3-place change (interface + applier object + handler call) instead of threading a new arg through 5 function signatures.
  - `src/ui/settings-snapshot.ts`: `buildSettingsSnapshot(manager, getters)` (was 6 positional args).
  - `src/ui/settings-menu.ts`: `showSettings` 6-arg shape (was 14), `notifyApplied` 5-arg shape (was 11), all 15 internal call sites updated.
  - `src/output-handler.ts`: `AgentsMenuDeps` now bundles `settingsGetters` + `settingsSetters`.
  - `src/commands/agents.ts`: builds module-level `settingsGetters` and `settingsSetters` objects once, passes them via `AgentsMenuDeps`.
  - New `test/settings-snapshot.test.ts` with 14 tests covering the new `(manager, getters)` signature: manager-owned fields, getter-owned fields, agent-registry fields, `defaultMaxTurns: undefined → 0` mapping, partial session limits, call-count invariants (each manager method + each getter called exactly once per snapshot — no double-reads), and snapshot shape (all 13 expected keys present).

### Documentation

- `docs/api-reference.md` — added `tracingEnabled` to the `SubagentsSettings` interface + new `SettingsGetters` / `SettingsSetters` subsections under `// CONFIGURATION SETTINGS` with the type definitions, USAGE notes, and a 3-place-change explanation for adding new menu-editable settings.
- `docs/agentic-loop-spec.md` — new autonomous agentic loop specification formalizing the fully autonomous agent workflow (trigger → dispatch → spawn → execute → validate → handoff → repeat) with phase-by-phase breakdowns, design invariants, crew/swarm/single dispatch modes, self-healing validation loop, scheduling, and observability.
- `README.md` — test badges updated to 1619 tests / 90 test files.
- `ROADMAP.md` — test count updated to 1619; all completed items marked.
- `docs/VERVOLG_PLAN.md` — updated to v0.14.1 with 1619 tests; added Completed P2 section for v0.13.0–v0.14.1 milestones; reorganized P2/P3 pending items.
- `docs/index.md` — added Agentic Loop Spec to the core documentation index.

## v0.14.0 (2026-06-16)

### Features

- **Execution tree visualization**: `/agents tree` command with three export formats:
  - **Mermaid** flowchart diagram with `parentId`-based hierarchy + `groupId` dashed edges
  - **Unicode text tree** with box-drawing characters (`├─`, `└─`, `│`)
  - **JSON** hierarchical tree with recursive `children` arrays
  - Dashboard `y` keybinding for live tree view with status-colored nodes (● running, ✓ completed, ✗ error)
  - New modules: `src/agent-tree.ts` (unified `buildTree()` helper), `src/ui/agent-tree-renderer.ts` (TUI renderer)
  - `output-handler.ts`: replaced duplicated 60-line `buildExecutionTree` with thin dispatch to `agent-tree.ts`

### Performance

- **Handoff parse micro-optimization**: `safeJsonParse` now tracks max raw string length during the character scan and skips the recursive `truncateStrings` tree walk when no string exceeds `MAX_STRING_LENGTH`. 10x speedup on small handoffs (204µs → 19.7µs).

### Documentation

- `docs/VERVOLG_PLAN.md` updated to v0.14.0: 1429 tests, 81 files, P2 execution tree marked done
- `.jules/overdrive.md`: performance audit journal with full benchmark report (59/59 OK)

### Metrics

- 1429 tests across 81 test files. Typecheck + lint green. All 59 benchmarks OK (0 FAIL, 0 WARN).

---

## v0.13.1 (2026-06-12)

### Fixes

- **Double-compute: `input.toLowerCase()` in `model-resolver.ts`**: Cached the result once as `lowercasedInput` and reused for both the exact-match `availableSet.has(...)` check and the fuzzy-match `query` variable. Eliminates the redundant `.toLowerCase()` call in `resolveModel()`.
- **Double-compute: `message?.trim()` in `output-handler.ts`**: Cached the result once as `trimmed` and reused for both the early-return guard (`if (!trimmed) return;`) and the `record.pendingSteers.push(trimmed)` push, plus the `steerAgent(record.session, trimmed)` call. Eliminates 2 redundant `.trim()` calls per steering flow.
- **Double-compute: `output.trim()` in `conversation-viewer.ts`**: Cached the result once as `trimmedOutput` and reused for both the truthy guard (`if (trimmedOutput)`) and the `wrapTextWithAnsi(trimmedOutput, width)` call. Eliminates 2 redundant `.trim()` calls per bash command render.

### Notes

- These 3 fixes were found by the new overdrive linter rule `detect-double-compute` (P4 in the overdrive pattern catalogue). See `docs/overdrive-patterns.md` and `scripts/overdrive/detect-double-compute.mjs`.
- The 7 bounded optimization loops of 2026-06-12 (PRs #146–#152) were already released in **v0.13.0** — dashboard dead-allocation removal (~20% faster), widget O(K×N) → O(N+K) queued rendering (~27× hot-loop reduction), K>>3 benchmark test, skill-loader BFS sort-once + head-index (O(B·D²) → O(B·D)), handoff duplicate `isHandoffArtifactV2` call elimination (~10-30% on 50-v2-artifact), `truncateStrings` micro-opt (code-clarity), and context `extractText` single-pass + `buildParentContext` double-trim cache (~47% on 50-message regime).

### Metrics

- 1410+ tests across 81 test files. Typecheck + lint green. All 65 benchmark thresholds within budget.

## v0.13.0 (2026-06-12)

### Features

- **Handoff protocol v2 — typed artifacts**: The `artifacts` field on `AgentHandoff` is now a discriminated union on `type` instead of the previous loose shape. Four v2 artifact types are supported:
  - `{"type": "file", "path", mimeType?, title?}` — file reference
  - `{"type": "branch", "branch", base?, commits?: string[], title?}` — git branch reference
  - `{"type": "url", "url", title?, description?}` — URL reference
  - `{"type": "note", "title", "value", mimeType?}` — free-form text
  Each type has its own per-field length limits (path ≤ 4096, url ≤ 2048, title ≤ 200, value ≤ 50000, branch ≤ 256, commits ≤ 100×64, description ≤ 500). `parseHandoff` now returns strictly v2-typed artifacts. The `HANDOFF_BALANCED` and `HANDOFF_FULL` prompt templates document the new shape with file/branch/url/note examples. `renderHandoffForParent` delegates per-artifact rendering to an exhaustive switch over the union.

- **Legacy loose-artifact coercion**: Older agents that still emit loose artifacts (e.g. `{type: "design", path, title, value, mimeType}`) continue to work. `coerceLegacyArtifact` maps first-match-wins into a v2 shape: `{path}` → file, `{title, value}` → note, `{branch}` → branch, `{url}` → url. Unrecognised artifacts are dropped with a `logger.warn`. `HandoffArtifact` is kept as a loose structural alias for source-level backwards compat alongside the new strict `HandoffArtifactV2` union.

### Documentation

- `docs/api-reference.md` — new `// HANDOFF V2 — TYPED ARTIFACTS` section with the union types, JSON example, and legacy coercion rules.
- `examples/agents/handoff-chain-researcher.md` — Handoff format section updated to the v2 typed shape with all four artifact types.

### Metrics

- New test file `test/handoff-v2.test.ts` with 20+ tests covering per-type validation, length limits, legacy coercion, and exhaustive rendering. Existing `test/handoff.test.ts` updated for the new typed shape plus a legacy-coercion regression test. Total: 1410+ tests passing.

## v0.12.2 (2026-06-12)

### Fixes

- **Windows schedule-test reliability** (#138): `test/schedule.test.ts`, `test/schedule-store.test.ts`, `test/schedule-e2e.test.ts`, and `test/schedule-bounds.test.ts` now pass `maxRetries: 5, retryDelay: 50` to every `rmSync` cleanup. On Windows the `proper-lockfile` lockfile directory is briefly held open after `release()` returns, and the built-in `EBUSY/EPERM` linear-backoff retry clears the race. E2E timings bumped (100→200, 150→300, 300→500ms) to give Windows more headroom on real-timer waits. The Windows schedule tests are no longer known-flaky.

### CI

- **Lowest-peer install version** (#142): `Install dependencies (lowest peer deps)` now installs `@earendil-works/pi-ai@0.78.0`, `@earendil-works/pi-coding-agent@0.78.0`, `@earendil-works/pi-tui@0.78.0` (was the non-existent `0.72.0`). The lowest-peer CI matrix slice now actually runs instead of failing with `ETARGET: No matching version found`.

### Documentation

- `docs/VERVOLG_PLAN.md` status overview updated to v0.12.2 (1390 tests, 58 files). The P1 list now shows #137, #138, #139, #140, #142 as completed.

### Metrics

- 1390 tests across 58 test files. Typecheck + lint green on all OS × Node × peer-deps matrix slices.

## v0.12.1 (2026-06-12)

### Features

- **Daemon schedule view** (`z` keybinding): New schedules section in dashboard body showing daemon schedules as a compact table (status, name, interval, type, next run). Threads `SubagentScheduler` through `AgentDashboardOptions`. New `src/ui/dashboard/schedules-section.ts`.
- **Thinking level display** (#1): `🧠` indicator in agent widget, dashboard compact rows, and detail panel showing invocation thinking level (low/medium/high) from `AgentRecord.invocation.thinking`.
- **Daemon integration notes**: All 4 daemons (`github-activity-digest`, `js-ts-dependency-upgrades`, `linear-issue-labeler`, `pr-check-repair`) now have Pi Orchestra Integration sections in their DAEMON.md files with schedule info, monitoring, toggle, persistence, and idempotency docs.
- **Overdrive performance skill**: New `.agents/skills/overdrive/SKILL.md` for performance auditing with benchmark suite validation.

### Performance

- **Async UI optimizations**: Replaced O(N×M) `allAgents.some()` cleanup with Set-based O(N+M) lookup in `agent-widget.ts update()`. Removed intermediate `.map()` array allocation in `agent-dashboard.ts refreshAgents()` (for loop builds Set directly). Removed `lineEstimates` wrapper object array in `getVisibleWindow()` — now uses integer math + direct category iteration via `processCategory` helper.
- **Benchmark suite**: 61 benchmarks all green, all well within thresholds (widget 200 agents: 4.82ms, dashboard 1000 agents: <40ms, spawn foreground: 8.76ms).

### Documentation & Polish

- **Full documentation refresh**: Updated AGENTS.md, CLAUDE.md, README.md, CHANGELOG.md, ROADMAP.md, SECURITY.md, INFRASTRUCTURE.md, and docs/architecture.md with current test counts (1035/58), version numbers (0.12.1), and feature descriptions.
- **Stale file cleanup**: Removed personal daily report logs (`jules_daily_report.md`, `jules_daily_report_2026_06_10.md`).
- **Go cinematic sidecar status**: Documented that `@groeponline/pi-subagents-tui` exists as sibling Go repo with `bubbletea-cinematic` library; binary spawning was removed in v0.9.1 but settings infrastructure remains dormant. Re-integration tracked in issue #1.

### Merged PRs & Housekeeping

- **Agent metadata standardization** (#136): Added `trigger` fields to all four daemons. Created `overdrive` skill.
- **Helios integration & code health** (#122): Skill triggers, README restoration, tmux showcase integration, font path fix.
- **Overdrive: single-pass render loop** (#131): Replaced chained `.filter()` calls with single-pass `for` loops. 25-30% widget improvement.
- **Dependabot updates**: `actions/checkout` 4→6 (#125), `@earendil-works/pi-agent-core` 0.77.0→0.78.1 (#127).
- **Branch cleanup**: Removed 10+ stale/merged remote branches, stale `.opencode` directory (109MB).

### Metrics

- 1035 tests across 58 test files. 61 benchmarks all passing. Typecheck + lint green.

---

## v0.12.0 (2026-06-06)

### MIT Open-Source Release

- **Dual publishing**: Now published to both npmjs.org (`npm install @groeponline/pi-agent-orchestrator`) and GitHub Packages. Added `publish-npm.yml` CI workflow alongside existing `publish.yml`.
- **Public documentation**: Added `SECURITY.md` (vulnerability reporting), `CODE_OF_CONDUCT.md` (Contributor Covenant v2.1), and `ROADMAP.md` (public feature roadmap replacing internal ENTERPRISE_READINESS.md).
- **README badges**: npm version badge, CI status badge, license badge. Dual install instructions (pi extension + standalone npm).
- **License audit**: Verified MIT license consistency across all source files. No proprietary markings found.
- **Verification tests**: Added `test/release-verification.test.ts` covering npm pack output, license headers, and registry URL correctness.
- **Docs structure**: Moved HOWTO-perf.md, PERFORMANCE.md, VERVOLG_PLAN.md to docs/. Created docs/index.md master documentation index. Added 18 missing module descriptions to docs/architecture.md.

## v0.11.0 (2026-06-06)

### Features

- **Prompt Compression Levels**: New `promptCompressionLevel` setting (`minimal` | `balanced` | `aggressive`) controls system prompt verbosity per agent. Affects read-only warnings, tool usage instructions, and handoff templates. Aggressive mode saves ~44% tokens on prompt components; minimal mode provides maximum instruction quality (+70% tokens). Supports per-agent override via `prompt_compression` frontmatter directive. Lazy runtime regeneration ensures the setting takes effect for all built-in agents at spawn time.
- **Handoff Frontmatter Directive**: Custom agents can now set `handoff: true` in their `.md` frontmatter to enable structured JSON handoff at end of response, enabling chain-of-agents workflows. Parsing follows the same boolean pattern as `inheritContext`, `runInBackground`, and `isolated`. Three handoff prompt variants (full/balanced/aggressive) match the compression level setting.
- **Interactive Compression Submenu**: New `Prompt compression` entry in `/agents → Settings` with live token-count preview, 3-level picker (minimal/balanced/aggressive), and side-by-side comparison breakdown.
- **Boolean Parsing Helpers**: New exported `parseBooleanOptional` and `parseBooleanWithDefault` in `src/custom-agents.ts` for safe YAML frontmatter consumption. Case-insensitive string match (`"TRUE"`, `"False"`), throws on invalid types (numbers, unrecognised strings).
- **Chain-of-Agents Workflow Examples**: New "Chain of Agents" section in README documenting three pattern templates: Research→Write→Review, Test→Fix→Verify (CI repair loop), and Multi-perspective Analysis (3 parallel → synthesizer).
- **Interactive Top View (`/agents top`)**: Switch views with `t` in the dashboard to access a real-time table of active and completed agents sorted by resource usage metrics (Turns, Tokens, Tool Uses, Duration, Name, and Activity recency `LAST` column). Columns are sortable via keys: `t` (tokens), `r` (turns), `d` (duration), `u` (tool uses), `l` (last seen recency), `n` (name). Pagination supported with `left` / `right` arrow keys.
- **Activity Heatmap Indicator**: Shows a visual heatmap representation of active subagent concurrency directly in the widget header.
- **Virtual Scrolling**: Added virtual scrolling window calculations for the agent widget, with scroll hints and scroll boundaries to handle large lists gracefully.
- **Token Burn Rate and Last-Seen Tracking**: Live token consumption rates and time-elapsed indicators are rendered next to running processes.
- **Bulk Spawn Batching**: Coalesces concurrent subagent spawn requests over a 16ms window to debounce UI redraws and group matching agents in a compact queue row (e.g. `"5x Explore queued"`).
- **Budget Critical Alerts**: Integrated 90% warning triggers (🚨 spawns will stop soon) to prevent session lockup on budget exhaustion.
- **Security Hardening (CVE mitigations)**:
  - **CVE-002**: Comprehensive field size checks on incoming agent configuration files.
  - **CVE-003**: Fully authenticated cross-extension RPC endpoints with custom rate limiters.
  - **CVE-005**: Bound schedule intervals and update caps.

### Changed

- **Git hooks are now opt-in**: removed `postinstall` auto-install. Run `npm run setup:hooks` after `npm install` to enable biome + tsc on commit and full test suite on push. Hooks are no longer installed by default for users who don't need them.

### Performance & Cleanup

- **Dashboard Body Rendering — Single-pass O(N) bucketing**: The agent dashboard's body now performs a single O(N) pass over the agent list, replacing the previous 4× `.filter()` cascade. Yields ~50% speedup on 50k agents (674ms → 337ms per 100 render frames). (#94)
- **Configurable TTL & sweeps**: Reduced idle agent TTL (60s default) and shortened GC sweeps to 30s intervals.
- **Adaptive Refresh Intervals**: Dynamically switches UI tick rates between 100ms (100+ agents), 150ms (50-99 agents), 200ms (active execution), and 750ms (idle) to conserve host CPU.
- **Widget Dirty Snapshotting**: Saves cycles by skipping expensive UI buffer paints when no structural status or agent state has modified.
- **SwarmHealth Consolidation**: RPC checks consolidated to avoid chatty inter-process handshakes.

### Documentation

- **AGENTS.md** expanded with 15-item "Common Mistakes" section covering YAML booleans, ESM imports, Biome conventions, peer-dep safety, Windows test flakiness, benchmark patterns, and more.
- **CONTRIBUTING.md** updated with `npm run setup:hooks` opt-in workflow and link to AGENTS Common Mistakes.
- **README.md** — new "Chain of Agents" section with three example workflows.
- `docs/api-reference.md` documents the new `PromptCompressionLevel` type and `handoff` / `prompt_compression` frontmatter directives.
- `docs/architecture.md` updated with the new compression flow in the module map.
- Added real TUI showcase media (GIF + MP4) generated from dist renderers: dashboard, top view, widget heatmap (`scripts/render-showcase-assets.sh`).

### Tests
- **1006 tests** across **57 test files** (up from 989 / 56). Added 16 new edge-case tests for boolean parsing in custom-agents.

---

## v0.10.3 (2026-06-04)

### Fixes
- Fixed `.gitignore` merge conflict after integrating tool context extraction v2.
- Restored agent tool typing compatibility in extracted modules.
- Added docstrings to refactored tool context modules.
- Resolved local `node_modules` sync issue (`proper-lockfile` was declared in `package.json` but not installed locally).

### Documentation
- Updated README version to 0.10.3 and corrected all settings parameters to match actual codebase defaults.
- Updated CHANGELOG with v0.13.3 release entry.
- Created `VERVOLG_PLAN.md` as living roadmap with accurate completion status.
- Updated security audit docs with clear deprecation notices (CVEs were fabricated, no action required).
- Updated `docs/architecture.md` with missing modules (`batch-orchestrator`, `telemetry`, `logger`, etc.).
- Updated `docs/api-reference.md` with complete `SubagentsSettings` interface.
- Updated `AGENTS.md` and `CONTRIBUTING.md` with current test counts and branch workflow.

### Metrics
- 795 tests, 46 test files.

---

## v0.10.1 (2026-05-29)

### Fixes
- Fixed validation color in permissions TUI panel: "n/a" now renders dim instead of green (#18).
- Fixed terminal overflow: removed 40-char minimum width, clamps to 20 instead (#18).
- Fixed falsy input bug in `estimateTokens`: `c.input` check now uses `!= null` (#17).
- Fixed journal metadata: year 2025→2026, heading format (#17).

### Documentation
- Updated README badges: 670 tests, version 0.10.1, Node >=22 badge.

### Metrics
- 670 tests, 37 test files.

---

## v0.10.0 (2026-05-27)

### Release
- Renamed the package to `@groeponline/pi-agent-orchestrator`.
- Updated repository metadata and documentation links for `GroepOnline/pi-agent-orchestrator`.
- Added an explicit package `files` whitelist so private GitHub Packages releases contain runtime source and docs only.

### Features
- Added session-wide spawn and cumulative-turn limits with settings persistence and settings-menu controls.
- Added `estimate_only` mode to the Agent tool for dry-run launch estimates.
- Added typed handoff artifacts for files, branches, URLs, and notes.
- Added a typed cross-extension RPC client helper.
- Added structured logger plumbing for RPC logging.

### Reliability
- Replaced the schedule PID lock with atomic lock-directory acquisition and stale-lock recovery.
- Added Graphify project hook/skill configuration while keeping generated graph output out of the package.

### Metrics
- 659 tests, 36 test files.

---

## v0.9.5 (2026-05-26)

### Security
- Authenticated cross-extension RPC mutations through host-provided `authProvider(requestId)` when available.
- Ignored spoofable payload-provided RPC identity for `spawn` and `stop`.
- Added per-extension, per-operation rate limiting for mutating RPC calls.

### Reliability
- Hardened `ScheduleStore` atomic writes by creating temp files next to the target JSON file before rename.
- Made Windows CI tests blocking again after removing the old schedule temp-dir workaround.
- Extracted smart/group/swarm batch finalization into `BatchOrchestrator` to reduce `src/index.ts` complexity.

### Documentation
- Added the cross-extension RPC contract to `docs/api-reference.md`.
- Updated roadmap/review docs for completed security and schedule work.
- Rewrote the custom-agent guide to match the real `.pi/agents` loader format.
- Added five canonical custom-agent examples under `examples/agents/`.
- Synchronized README badges and package metadata for the `0.9.5` release.

### Metrics
- 654 tests, 36 test files.

---

## v0.9.2 (2026-05-25)

### 🚀 New Features

#### Rich Interactive AgentDashboard
- **Vim-style hotkeys**: `j/k` navigate, `Enter` steer, `K` kill, `?` help overlay
- **Live activity indicators**: Animated spinners with 5 styles (`dots`, `pulse`, `wave`, `bar`, `clock`)
- **Multi-select + bulk operations**: `v` visual mode, bulk kill support
- **Permissions view**: `p` hotkey shows tool permissions per agent
- **Auto-refresh timer**: Configurable dashboard refresh interval

#### Swarm Mode
- **SwarmCoordinator**: Live join/leave for collaborative multi-agent swarms
- **Swarm visibility**: Real-time swarm status in dashboard with `w` hotkey
- **Dynamic coordination**: Agents can join/leave swarms at runtime

#### Settings & Configuration
- **Orchestration mode**: New setting for spawn/parallel/sequential orchestration
- **Dashboard refresh interval**: Configurable via registry settings
- **pi-subagents-helper skill**: Development helper skill for quick agent testing

### 🔧 Fixes
- **Swarm delivery logic**: Improved coordinator handoff reliability
- **Flaky Windows timing tests**: Fixed schedule test timing issues
- **CodeRabbit review comments**: Addressed code quality feedback

### 🔧 CI
- **Dependabot updates**: actions/checkout@6, setup-node@6, upload-artifact@7, super-linter@6, codeql-action@4
- **Super-linter compatibility**: Disabled conflicting prettier/standard checkers
- **CodeQL**: Disabled auto-triggers (requires GitHub Code Security)

### 📊 Metrics
- 650 tests, 36 test files (+39 tests, +2 files since v0.9.1)

---

## v0.9.1 (2026-05-24)

### 🧹 Cleanup
- **Cinematic sidecar removal**: Go binary spawning logic verwijderd uit `agent-widget.ts`; sidecar wordt niet meer gebruikt.
- **UI enhancements**: Nieuwe spinner frames (`pulse`, `wave`), tool display mappings (`glob`, `webSearch`, `webFetch`).
- **Fix animation interval**: `ANIMATION_INTERVAL` constante toegevoegd en gebruikt in `ensureTimer()`.

### 🛡 Security
- **CVE-004**: Regex-blacklist verwijderd uit `validators.ts` — was "security theater" (triviaal te omzeilen met Unicode/whitespace). Vervangen door defense-in-depth: control char removal + hard length limits + sandbox isolatie (`isolated=true`, `levelLimit=0`).
- `.npmrc` toegevoegd aan `.gitignore` (bevatte harde GitHub token).

### 🔧 CI
- **Dependency compatibiliteitsmatrix**: `os [ubuntu, windows] x node [20, 22] x peer-deps [lowest, latest]`.
- Correcte lowest peer deps install via `--no-save` (geen `package.json` mutatie).
- Windows runner met `continue-on-error` voor pre-existing schedule flakiness.

### 📊 Metrics
- 614 tests, 34 test files (+ `validators.test.ts` regressie tests voor CVE-004)

## v0.9.0 (2026-05-24)

### 🔧 Fixes
- **Fix refactor regressie in `agent-types.ts`**: `intersectToolNames` hernoemd naar `PermissionUtils.intersectToolNames` na class-refactor; herstelt alle 14 partition-filter tests.
- **Fix template typo in `default-agents.ts`**: ontbrekende sluitende `}}` in `{{TOOL_INSTRUCTIONS}}` placeholder hersteld — prompts renderen nu correct.

### 🏗 Refactor
- **Consolidatie van parsing & permissie-logica**:
  - `custom-agents.ts`: losse field-parser functies samengevoegd naar `AgentFieldParser` class.
  - `default-agents.ts`: herhalende read-only prompt-boilerplate samengevoegd naar `AgentPromptTemplates` class.
  - `agent-types.ts`: `intersectPermission` / `intersectToolNames` / `applyParentRestrictions` samengevoegd naar `PermissionUtils` class.

### 🛡 Repository hygiene
- `.pi/agents/` expliciet toegevoegd aan `.gitignore` (dev-only agents nooit meer per ongeluk tracken).
- `cinematic-renderer/cinematic-renderer.exe` toegevoegd aan `.gitignore`.
- `auditor.md` verwijderd uit git tracking (was dev-only agent).

### 📝 Documentation
- **README.md volledig herschreven**: feature matrix, agent types tabel, custom agent frontmatter reference, cinematic dashboard docs, architecture diagram, development guide.
- **CI workflow**: GitHub Actions CI voor TypeScript (typecheck, lint, test) en Go sidecar (vet, build, test).
- **Vervolgplan**: `VERVOLG_PLAN.md` toegevoegd met prioriteitenlijst P0–P4.

### 🧹 Code cleanup
- **Lint**: ESLint verwijderd, Biome is enige linter. Alle pre-existing unused imports en organize-imports warnings opgelost.
- **Biome fixes**: unused parameters/variables in `agent-widget.ts`, `output-handler.ts`, `conversation-viewer.ts`.

### 📊 Metrics
- 611 tests, 34 test files (+ `default-agents.test.ts`)
- Typecheck: groen
- Lint: groen (3 stylistische warnings over static classes)

## v0.8.0 (2026-05-23)

### 🚀 New Features
- **Task budget + depth limiting**: Prevent runaway agent trees. Default levelLimit=5, taskBudget=unlimited. (from OpenCode)
- **Adversarial validators**: Post-completion Promise.all validation with ✅/❌ indicators in agent widget. (from Droid Factory)
- **Structured handoff protocol**: JSON machine-parseable chain-of-agents with graceful degrade on malformed JSON. (from Claude Code)
- **Hook system**: 11 lifecycle event types, 5s timeout, fail-open. Global registry via Symbol.for('pi-subagents:hooks'). (from Claude Code/OpenCode)
- **Permission inheritance**: Directional parent→child tool restriction. RO parent forces RO child. (from Claude Code)
- **Deferred context engine**: Build context at session.create boundary, saving 15-48% tokens on queued agents. (from Droid Factory)
- **Dual-phase compaction**: Prune old tool outputs + per-agent memory limits (default keep 5 turns). (from OpenCode)
- **Partitioned agent state**: Isolated tool/skill subsets per partition. No cross-contamination. (from OpenCode)
- **Context-mode-fork integration**: Optional ctx_* sandbox tool injection. New "Analysis" default agent type. (@groeponline/context-mode peerDependency)
- **Code health**: Removed agent-registry.ts duplication. Fixed 35 pre-existing schedule test failures.

### 📊 Metrics
- 391 → 518 → 595 tests (+204, 0 failures)
- 22 → 30 → 33 test files
- 11 commits
- 4 plan review cycles (all APPROVED)

### 🧪 Test Suite Expansion (post v0.8.0)
- **E2E chain tests** (`test/e2e-chain.test.ts`): 28 tests covering budget enforcement, depth limit, validator isolation, permission inheritance, handoff parsing/graceful degrade, hooks dispatch, partition filtering, ctx_* tools, and full chain (spawn → run → validators → handoff → result)
- **Performance baseline** (`test/performance-baseline.test.ts`): 18 tests measuring spawn latency, context building, compaction reduction, deferred context timing, token estimation, batch throughput, and hook dispatch overhead
- **Backward compatibility** (`test/backward-compat.test.ts`): 31 tests verifying old AgentConfig loads, new field defaults, old-style invocation, and existing agent type integrity

## 0.7.6
- Fix: author -> OnlineChef, clean README

## 0.7.5
- Remove tintinweb URLs from package.json

## 0.7.4
- Publish @groeponline/pi-agent-orchestrator to GitHub Packages

## 0.7.3 (original)
- Forked from tintinweb/pi-subagents
