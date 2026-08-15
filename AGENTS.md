# AGENTS.md — pi-agent-orchestrator

> Developer guide for the Pi agent orchestrator extension: conventions, common mistakes, spawn rules, and architecture.

## Pre-context (read first)

Pi extension — runs inside the pi coding agent host, not standalone. Orchestrates autonomous sub-agents: spawn lifecycle, permission inheritance, parent context injection, handoff JSON, cron schedules, swarm join, and TUI dashboard.

| Rule | Detail |
|------|--------|
| **Spawn SSOT** | `src/default-agents.ts` (built-ins), `.pi/agents/*.md` (custom overrides), `src/settings.ts` + `.pi/subagents.json` (runtime) |
| **Never** | Import `@earendil-works/pi-*` as direct deps; treat YAML booleans as truthy strings; sort agent lists (Map insertion order is intentional) |
| **Peer extensions** | `@groeponline/context-mode` → `ctx_*` tools (optional, feature-gated) |

## Dashboard / motion notes

The v2 dashboard rewrite has shipped. Files under `docs/handoff/v2-refactor/` are a **historical archive** of that roadmap, not an active implementation lane. Prefer the live code under `src/ui/` and `docs/PERFORMANCE.md` as SSOT.

When touching dashboard / animation code:

- Keep dashboard animation glyphs single-cell unless a renderer explicitly reserves a fixed multi-cell width.
- Use ANSI-aware helpers (`visibleWidth`, `padAndTruncate`, `fastTruncate`) instead of native string padding on colored content.
- Assign motion deterministically so agent rows do not change style between renders.
- Prefer semantic motion roles (`header`, `queue`, `handoff`, `swarm`, `tool`) over one global spinner everywhere.
- Preserve responsive rendering at 60, 80, 100, and 140 terminal columns.
- Add focused tests for frame wrapping, deterministic assignment, width safety, and responsive column selection.

## Spawn rules

**Config SSOT (edit order):** `src/default-agents.ts` → `.pi/agents/<name>.md` override → `src/custom-agents.ts` frontmatter → `/agents → Settings` (`.pi/subagents.json`).

| Built-in type | Mode | Use when |
|---------------|------|----------|
| `Explore` | read-only | Parallel codebase audit, grep sweeps, SSOT boundary checks |
| `Plan` | read-only | Architecture pass before multi-file edits |
| `Analysis` | read-only + `ctx_*` | Data/compute via sandbox (requires context-mode peer) |
| `general-purpose` | full tools | Bounded implementation after Plan/Explore land |

## Quick commands

```bash
npm run typecheck && npm run lint && npm test   # full verification
npm run lint:fix                                # auto-fix Biome warnings
npm test -- test/some-file.test.ts              # run a single test file
npm test -- --watch                             # watch mode
```

## Project nature

This is a **pi extension** — it runs inside a pi coding agent host, not standalone. The `@earendil-works/pi-*` host-platform packages are never direct dependencies. (`@earendil-works/pi-tui` is no longer a direct dependency — its API surface is mirrored locally in `src/ui/tui-shim.ts`. See Common Mistake #4 below for the full rule.) The entry point is declared in `package.json` → `pi.extensions` as `./dist/index.js`.

Published to **npmjs.org** (`@groeponline/pi-agent-orchestrator`).

ES modules only (`"type": "module"`). No CommonJS.

## Lint

**Biome only.** ESLint and Prettier were deliberately removed. The Biome formatter is disabled (`biome.json` formatter.enabled = false). Run `npm run lint` (check) or `npm run lint:fix` (auto-fix).

## Test flakiness

`test/schedule.test.ts` and `test/schedule-store.test.ts` are known-flaky on **Windows** due to temp directory races. CI marks these `continue-on-error`. These failures should not block PRs or dev workflow on Windows.

## Adding built-in agents or settings

- New agent type → update `src/default-agents.ts` + `test/default-agents.test.ts` + `README.md`
- New setting → update `src/settings.ts` (interface + defaults) + `src/output-handler.ts` (`buildSettingsSnapshot` + settings menu) + `docs/api-reference.md`

## Commit style

Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.

## Common Mistakes

These are patterns that have caused bugs or wasted review cycles. Read before touching the codebase.

### 1. YAML boolean strings are strings, not booleans

When reading frontmatter via `js-yaml`, `handoff: true` is parsed as a JS string `"true"`, not a boolean. Use `parseBooleanOptional`/`parseBooleanWithDefault` helpers in `src/custom-agents.ts` — never write `if (frontmatter.handoff)` because that makes `handoff: "false"` truthy.

```ts
// Don't do this — string "false" is truthy
if (frontmatter.handoff) { /* runs for "false" string */ }

// Do this — explicit parse with strict semantics
handoff: parseBooleanWithDefault(fm.handoff, false),
```

### 2. ESM imports need explicit `.js` extensions

Even though source is TypeScript, imports must use `.js` (not `.ts`). `import { x } from './foo.js'` ✅, `import { x } from './foo'` ❌, `import { x } from './foo.ts'` ❌.

### 3. Type-only imports: prefer `import type`, allow inline `type` modifier

For modules where ALL imports are types, use the strict form `import type { Foo } from './foo.js'`. When a single import mixes types and runtime values from the same module, the inline form `import { type Foo, bar } from './foo.js'` is equivalent and preferred: the `type` modifier erases the typed binding at build time and prevents accidental runtime bundling. Use the strict form when ALL imports from a module are types; use the inline form when mixing type and value imports from the same module.

### 4. Host platform packages are NEVER direct deps

> **Scope:** This rule covers `@earendil-works/pi-*` host-platform packages. The optional peer `@groeponline/context-mode` is unrelated to that scope and falls under the third category below.

The host platform packages are libraries **used by** the host runtime, not the host itself. Never `import` from them in a way that assumes the package is present at runtime.

Three distinct categories:

- **Category A — Avoidable platform types → local compat shim.** `@earendil-works/pi-tui` must never be imported: every shape this extension consumes (`Component`, `TUI`, `Text`, `visibleWidth`, `truncateToWidth`, `wrapTextWithAnsi`, `matchesKey`) is declared locally in `src/ui/tui-shim.ts`. The shim mirrors the host's `Component` exactly so structural typing aligns at boundary sites (e.g. `defineTool({ renderCall })`, `registerMessageRenderer`, `ctx.ui.custom(factory)`). Do not re-introduce any direct import of `@earendil-works/pi-tui`.
- **Category B — Unavoidable platform types → `import type` at named sites.** `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `@earendil-works/pi-agent-core` (`pi-agent-core` is in `devDependencies` for the `ThinkingLevel` type currently consumed at `src/types.ts:5`, plus the agent-loop + session type family for future use) are required deps of this extension, so their type surfaces (`ExtensionCommandContext`, `AgentSession`, `Model`, `TextContent`, `ThinkingLevel`, the `defineTool` / `registerMessageRenderer` / `registerTool` signatures) are unavoidable. Import those types directly with `import type` at the call sites that need them. They are required, not optional.
- **Category C — Optional peer → feature detection.** `@groeponline/context-mode` is an OPTIONAL peer (separate scope, `@groeponline/*`) that gates the `ctx_*` tools. That case DOES use the dynamic-import / feature-detection pattern, kept in `src/context-mode-bridge.ts`. This category is the only one where feature detection is appropriate — do not apply it to Category B packages.

### 5. Windows schedule tests are known-flaky

`test/schedule.test.ts` and `test/schedule-store.test.ts` race on temp dirs in Windows CI. CI marks them `continue-on-error`. Local Windows runs may flake. This is a known issue, not a regression in your code.

### 6. Biome formatter is disabled

Don't run `prettier` or assume `biome format` works. `biome.json` has `formatter.enabled: false`. Use `biome check` for lint, `npm run lint:fix` to auto-fix.

### 7. Biome requires double quotes

`"foo"` ✅, `'foo'` ❌. Use template literals for interpolation. The project's Biome config enforces double quotes.

### 8. Avoid `as any` in test mocks

When mocking `AgentRecord` or similar types, include ALL required fields. `as any` defeats type checking and breaks the `Parse Don't Validate` philosophy. Reference the type in `src/types.ts` and copy the shape.

```ts
// Don't do this
const mock = { id: "x" } as any;

// Do this
const mock: AgentRecord = { id: "x", /* all required fields */ };
```

### 9. Benchmark tests use `toBeLessThan` thresholds, not `console.log`

`test/*.benchmark.test.ts` files should assert performance with `expect(elapsed).toBeLessThan(threshold)`. `console.log` + `toContain` is a CodeRabbit-flagged anti-pattern in this repo.

### 10. Settings persist to `.pi/subagents.json`

Not to `package.json`, not to env vars (except at first-run), and not to the obsolete `.pi/subagent-settings.json` name. Project settings live at `<cwd>/.pi/subagents.json`; user-global settings at `$PI_CODING_AGENT_DIR/subagents.json` (default `~/.pi/agent/subagents.json`). The schema lives in `src/settings.ts` (`SubagentsSettings` interface). When adding a setting: update the interface, defaults, validation, snapshot (`buildSettingsSnapshot` in `output-handler.ts`), AND the settings menu.

### 11. Pre-commit hook runs biome + tsc only, NOT tests

Tests are in the pre-push hook. If you must push and tests are slow/flaky, `git push --no-verify` is acceptable but document why in the commit body. Hooks are opt-in: run `npm run setup:hooks` after `npm install` to enable.

### 12. Extension entry is `pi.extensions` in package.json

The `pi.extensions` field points to your entry file (e.g., `./dist/index.js` after build). The host loads this. Don't rename or restructure without updating package.json.

### 13. Map/Set preserve insertion order

Rely on this for deterministic UI output (running agents first, then queued, then done). Don't sort unless you need a different order.

### 14. Conventional commit types are limited

`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`. No `feat!` (use a body footer `BREAKING CHANGE:` instead). Scopes are recommended for clarity (e.g., `feat(agents):`).

### 15. Test files live in `test/`, not `tests/`

Use `.test.ts` extension. Use `describe`/`it`/`expect` from vitest. Do not co-locate tests with source files.

## Optional peer deps

`@groeponline/context-mode` enables `ctx_*` sandbox tools. Its code path is gated behind feature detection (`src/context-mode-bridge.ts`).

## Settings reference

All runtime-configurable settings are defined in `src/settings.ts` (`SubagentsSettings` interface) and surfaced through `/agents → Settings`. See `docs/api-reference.md` for the full settings schema.

## Architecture at a glance

- `src/agent-types.ts` — permission model (base tools → parent restrictions → partition filter → disallow floor)
- `src/agent-runner.ts` — agent lifecycle: spawn → build context → create session → run loop
- `src/index.ts` — extension entry point, command registration, batch/group coordination
- `src/ui/agent-dashboard.ts` — vim-hotkey interactive TUI with 6 views: list, top (resource usage), schedules (`z`), perf (`/perf`), help (`?`), settings
- `src/ui/agent-top-renderer.ts` — top view table calculations, sorting (by tokens, turns, duration, tool uses, name, recency), and pagination
- `src/ui/agent-widget-renderer.ts` + `src/ui/agent-widget.ts` — virtual scrolling, thinking level display, compact batch rendering, adaptive refresh
- `src/ui/dashboard/schedules-section.ts` — daemon schedule view in dashboard body
- `src/swarm-join.ts` — live swarm join/leave coordination
- `src/schedule.ts` + `src/schedule-store.ts` — cron-style scheduling, persisted to `.pi/subagent-schedules/`

See `docs/architecture.md` for the full module map and data-flow diagram.

## Verification Suite

Ensure you run `npm run typecheck && npm run lint && npm test` before committing.
Currently passing: **1875 tests** across **110 test files**, including performance benchmarks for render, snapshot, virtual scrolling, and spawn latency.

## Cursor Cloud specific instructions

This package is a **Pi host extension**, not a standalone app or server — there is no `dev`/`start`/`serve` process. The Cloud environment is repository-owned and deterministic.

**Canonical files and commands** (do not rediscover these):

| Purpose | File / command |
| --- | --- |
| Environment definition | `.cursor/environment.json` (`build.dockerfile` + `install`) |
| Deterministic base image | `.cursor/Dockerfile` (`node:22.22.3-bookworm`, `ubuntu` user, git/sudo, Google Chrome stable) |
| Node source of truth | `.nvmrc` (kept in sync with the Dockerfile base and `package.json` `engines.node`) |
| Install / update | `bash scripts/cursor-cloud-install.sh` (runs from `environment.json`) |
| Full verification gate | `npm run verify:cloud` (Node-safe; runs `scripts/cursor-cloud-verify.sh` → `verify:cloud:internal`) |
| Pi-host extension smoke | `bash scripts/cursor-cloud-smoke.sh` |
| Reviewable artifacts | `bash scripts/cursor-cloud-artifacts.sh` |

**Invariants:**

- **Node is compliant by default.** In Cloud the `.cursor/Dockerfile` bakes Node `22.22.3` at `/usr/local/bin/node` (pinned by digest so the image is reproducible), so even bare shells resolve a compliant `node`. As defense-in-depth (and for local/non-Docker runs), `scripts/cursor-cloud-lib.sh` treats `.nvmrc` as a **minimum**: it accepts any ambient Node `>= .nvmrc`, and only installs the exact `.nvmrc` version via `nvm` when the ambient Node is missing or older. When bumping Node, change `.nvmrc` **and** the `.cursor/Dockerfile` `FROM` (tag + digest) together. Do not hardcode absolute NVM/exec-daemon paths.
- **System packages + browser stay fresh.** The Dockerfile runs `apt-get update && apt-get upgrade` and installs `google-chrome-stable` from Google's apt repo. `scripts/cursor-cloud-install.sh` also refreshes apt packages (and Chrome when available) on each install/build so computer-use gets a current browser without a separate image edit.
- **The Pi host loads the built extension.** The smoke test runs `pi --mode rpc --no-session -e ./dist/index.js` (credential-free) and asserts the host registered the extension's commands from `dist/index.js`. No model API key is required to prove loading.
- **Artifacts must never modify tracked docs.** Generate the dashboard via `scripts/cursor-cloud-artifacts.sh` (writes to the Cursor artifact dir or `.cloud-artifacts/`). Do **not** use `npm run screenshots` for artifacts — that overwrites the tracked `docs/images/dashboard_preview.svg`. Artifact generation asserts a clean working tree.

## Learned User Preferences

- For merge readiness on this repo, treat only `Required CI gate` and `Quality gate` as branch-protection required checks; Super-Linter `Lint Code Base` is not required and must not drive auto-merge decisions.
- When rolling out `@groeponline/pi-agent-orchestrator`, update **sofie** (path install of the local checkout) and **jan** (npm package); do not treat `chefgroep-vps` / `chefgroep` or offline jump hosts as active deploy targets.

## Learned Workspace Facts

- `chefgroep-vps` / `chefgroep` is heavily deprecated: SSH may still exist via ProxyJump `weg54`, but do not probe or update it as live infrastructure.
- `weg54` is expected offline (former workstation / original control node); fleet inventory and Tailscale both treat it as stale.
- `chef-control-01` and `chef-runner-01` are real Tailscale Linux peers (SSH Host entries exist); they are not local Docker containers on sofie and may be offline independently.
- `joep` / ProBook uses MagicDNS `joep.tail86a8f2.ts.net` (`Host joep`); Tailscale can show it active even when plain SSH previously timed out.
- `sofie-dev` is in the utrecht-data-os SSH fleet block (`100.120.188.59`) and may be offline independently of `sofie`.
- Reachable `bc-scan-*` / `bc-monitor` hosts usually have no orchestrator checkout; they are not primary orch update targets.
- On `jan`, `~/.npmrc` may scope `@groeponline` to GitHub Packages (older caps); this package publishes to npmjs.org (`publishConfig.registry`), so `pi update` may need `--@groeponline:registry=https://registry.npmjs.org`.
- Dependency CVE SSOT for merges is `dependency-review` inside `Required CI gate` plus Dependabot — not Super-Linter Trivy (`VALIDATE_TRIVY` must not be treated as a required merge signal).
- Binary showcase media lives in sibling repo `GroepOnline/pi-agent-orchestrator-assets`; consume via `npm run assets:link` or `ORCHESTRATOR_MEDIA_DIR` (see `docs/assets-layout.md` when present).
