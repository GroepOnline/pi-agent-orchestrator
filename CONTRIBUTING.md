# Contributing

Thanks for contributing. This project is a small **pi extension** that
runs inside a [Pi coding agent](https://github.com/GroepOnline) host.
Most of what you will need lives in [AGENTS.md](AGENTS.md) — read that
first, it documents the architecture, conventions, and the long list of
common mistakes that have cost us review cycles.

Please also read our [Code of Conduct](CODE_OF_CONDUCT.md).

## TL;DR

1. Fork and create a branch.
2. Make your change. Follow [AGENTS.md](AGENTS.md).
3. Run `npm run typecheck && npm run lint && npm test`.
4. Open a PR. Use [Conventional Commits](https://www.conventionalcommits.org/)
   in the title (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
   Scope is encouraged (e.g. `feat(dashboard):`).
5. Wait for review. Merging requires an `@GroepOnline/admins` member to
   approve — this is enforced by branch protection.

## Development setup

- Node.js **22 or 24** (CI matrix). Run `node --version`.
- Linux, macOS, or Windows.
- Git.

```bash
git clone https://github.com/GroepOnline/pi-agent-orchestrator
cd pi-agent-orchestrator
npm install
npm run setup:hooks   # optional: pre-commit biome+tsc, pre-push full test
```

## Running the dev version

The host loads this extension from `dist/index.js` (declared in
`package.json` → `pi.extensions`), so a source edit is only visible to pi
after a rebuild. Two ways to run your working copy:

```bash
npm run dev            # tsc --watch, rebuilds dist/ on every save
npm run dev:run        # build if needed, then launch pi with this checkout only
npm run dev:run -- -c  # extra arguments are forwarded to pi
```

`dev:run` uses the host's `--extension` flag, so it affects that one
session and never touches your settings. To load the checkout in *every*
pi session instead:

```bash
npm run dev:link       # register this checkout as a pi package
npm run dev:status     # show link state, resolved agent dir, dist freshness
npm run dev:unlink     # go back to the published version
```

`dev:link` writes to the user-level agent directory
(`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`). Add `-- --local` to
register it in the project's `.pi/settings.json` instead. Both commands
are idempotent and `dev:unlink` removes exactly the entry `dev:link`
added.

Run `npm run dev:status` first when pi seems to ignore your changes — it
reports whether `dist/` is stale.

## Verifying a change

```bash
npm run typecheck                  # tsc --noEmit
npm run lint                       # biome check src/ test/ scripts/
npm test                           # full vitest suite
npm test -- test/some-file.test.ts # a single test file
npm run lint:fix                   # auto-fix biome issues
```

Before opening a PR also run `npm run build` (builds dist/).

The CI matrix runs the same plus cross-platform tests. A PR is green when
all required checks pass and an `@GroepOnline/admins` team member
approves.

## Project conventions (the short list)

- **ESM with `.js` import extensions.** Source is `.ts`, imports are `.js`.
- **Biome double quotes.** `"foo"` not `'foo'`. Use template literals for interpolation.
- **No comments in code unless asked.**
- **No `as any` in test mocks.** Include all required fields.
- **Frontmatter booleans are strings in YAML.** Use
  `parseBooleanWithDefault` from `src/custom-agents.ts` — never
  `if (frontmatter.handoff)`.
- **Conventional Commits only.** No `feat!`; use a `BREAKING CHANGE:`
  footer.
- **Test files in `test/`, named `*.test.ts`.** Never co-locate.
- **Map/Set insertion order is intentional.** Don't sort agent lists.
- **No emoji in commits, code, or PR text** unless asked.
- **Host platform packages (`@earendil-works/pi-*`) are never direct deps.**
  Use `import type` at call sites that need them.

See [AGENTS.md](AGENTS.md) for the full architecture map and the
spawn-roles table.

## Pull Request Workflow

1. Fork the repo or create a branch directly.
2. Make commits using Conventional Commits.
3. Ensure `npm run typecheck`, `npm run lint`, and `npm test` pass.
4. Open a PR against `main`.
5. An `@GroepOnline/admins` team member must approve.
6. The merge must be a fast-forward or squash merge — linear history is enforced.
7. The branch is deleted after merge.

## Git Hooks (Optional)

Run once after clone: `npm run setup:hooks`.

| Hook | When | What |
| --- | --- | --- |
| `pre-commit` | Before commit | Biome lint + tsc typecheck |
| `pre-push` | Before push | Full test suite |

Skip with `git commit --no-verify` or `git push --no-verify`.

## Windows tests

`schedule.test.ts` and `schedule-store.test.ts` have pre-existing flaky
tests on Windows related to temp directory races. These are
`continue-on-error` in CI and should not block your PR.

## Adding a built-in agent or setting

- New agent type → update `src/default-agents.ts` +
  `test/default-agents.test.ts` + a row in the README agents table.
- New setting → update `src/settings.ts` (interface + defaults) +
  `buildSettingsSnapshot` in `src/output-handler.ts` + settings menu.
  See `docs/api-reference.md` for the schema.

## Release flow

- Conventional Commits drive changelog groups.
- The maintainer (currently the only member of `@GroepOnline/admins`)
  updates `CHANGELOG.md` (CI sets `package.json` version from the tag).
- Tag `vX.Y.Z` and push it; `release.yml` builds, gates, publishes to npm,
  and creates the GitHub Release. Don't publish manually.

## Need help?

Open an issue.
