# CHEF-100: expose `workspaceContext` on `ExtensionAPI` and delete `src/env.ts`

Tracks: [GitHub #213](../../issues/213) · [Linear CHEF-832](https://linear.app/chefclawsheesh/issue/CHEF-832/)

## Goal

Stop shelling out to `git` per subagent spawn. Move cwd/git/platform detection into the Pi host surface so `pi-agent-orchestrator` consumes it synchronously instead of via `detectEnv`. Worst-case overhead reduction: **0-10s of sequential `pi.exec("git", ...)` per spawn**, dominated by two 5000ms timeouts.

## Status

This tracking branch carries the **architectural plan + RFC document** for review before any migration code lands. No code changes in `src/` yet — Phase 1 dual-read implementation lands in a follow-up PR after the upstream RFC is reviewed by the `@earendil-works/pi-coding-agent` maintainers.

## Proposed host API

```ts
// Upstream: @earendil-works/pi-coding-agent
interface WorkspaceContext {
  /** Host current working directory at extension load / cwd-change events. */
  readonly cwd: string;
  /**
   * Discriminated git state. `isRepo: false` is the only correct shape when
   * the cwd is not inside a git worktree or `.git` cannot be read.
   */
  readonly git:
    | { readonly isRepo: true; readonly branch: string }
    | { readonly isRepo: false };
  /** Matches `process.platform` on the host. */
  readonly platform: NodeJS.Platform;
}

interface ExtensionAPI {
  // ... existing surface
  readonly workspaceContext: WorkspaceContext;
}
```

## Behavior parity note (the `"unknown"` sentinel)

Current `detectEnv` returns `branch = "unknown"` when `git branch --show-current`
throws or exits non-zero; it returns `branch = ""` for a clean detached HEAD.
These two cases collapse into `""` in the discriminated union above (the
`branch: string` form already allows empty strings).

Mitigation options:

- (a) Extend to `branch: string | null` — keeps the sentinel via `null`, but
  forces every consumer to handle nullability. Cost: more type branching in
  `prompts.ts`.
- (b) Keep the proposed shape and document the reduction as intentional —
  detached HEAD and "branch cmd failed" both render as empty branch. Simpler
  consumer code; **loses the ability to debug a broken `git` install via the
  spawned agent's system prompt**, which is the only place this sentinel is
  currently visible.

**Recommended for RFC review: option (b)** with explicit documentation. The
sentinel lives in `detectEnv` only; once we trust the host, the diagnostic value
of a string sentinel in the rendered prompt diminishes. If reviewers prefer
strict parity, switch to (a) at design time — both are one-line changes.

## Call chain today (the problem)

```
src/agent-runner.ts:396  ->  effectiveCwd = options.cwd ?? ctx.cwd
src/agent-runner.ts:410  ->  const env = await detectEnv(options.pi, effectiveCwd)
                                |
src/env.ts:25             ->  shells out to git x2 with 5000ms timeout each
                                |
src/prompts.ts:34-66      ->  formats # Environment block into every subagent system prompt
```

`EnvInfo` is fed into `buildAgentPrompt` for **every** subagent spawn: every batch operation, every swarm join, every schedule trigger. Multiplied across N agents, this is the dominant non-model latency in `agent-runner.ts`.

## Migration phases

### Phase 1 — RFC + dual-read (target for follow-up code PR after this one)

- File RFC upstream against `@earendil-works/pi-coding-agent`.
- In `src/agent-runner.ts:410`, replace:
  ```ts
  const env = await detectEnv(options.pi, effectiveCwd);
  ```
  with:
  ```ts
  const env = options.pi.workspaceContext ?? await detectEnv(options.pi, effectiveCwd);
  ```
  so the fallback kicks in only on hosts that do not yet expose `workspaceContext`.
- Same `# Environment` block format, no new tests (existing `test/env.test.ts` continues to cover the fallback path).

### Phase 2 — Primary host API

- Bump `@earendil-works/pi-coding-agent` peer dep to the version exposing `workspaceContext`.
- Drop the `detectEnv` fallback path.

### Phase 3 — Cleanup

- Delete `src/env.ts`.
- Delete `EnvInfo` from `src/types.ts`.
- Remove the dual-read fallback branch.
- Replace `test/env.test.ts` with `test/prompts.workspace-context.test.ts` against the new shape.

## Acceptance criteria

See [issue body acceptance criteria](../../issues/213) for the canonical list. Summary:

### Upstream (Pi host RFC)

- `WorkspaceContext` exposed on `ExtensionAPI` (or analogously on `ExtensionContext`).
- `cwd` reflects host CWD live + on cwd-change events.
- `git.isRepo` / `git.branch` correctly populated (incl. submodules, detached HEAD).
- `platform` matches `process.platform` on the host.
- Recomputed on cwd change / session-init, not per call.

### Downstream (pi-agent-orchestrator)

- `src/env.ts` deleted; no remaining imports.
- `EnvInfo` removed from `src/types.ts`.
- `agent-runner.ts` reads `workspaceContext` synchronously (no `await` on env path).
- `prompts.ts` accepts the new shape directly.
- `test/env.test.ts` deleted or replaced.
- `npm run typecheck && npm run lint && npm test` green.

## Out of scope

- Reformatting the `# Environment` block in `prompts.ts` (separate ticket if needed).
- `src/worktree.ts` — separate worktree concerns, separate agent lifecycle.
- Exposing other env fields beyond cwd/git/platform (userInfo, process.env, node version, …).

## Open questions (for upstream RFC review)

1. Should `WorkspaceContext` live on `ExtensionAPI` (synchronous, eager) or `ExtensionContext` (per-session)? Current consumer wants synchronous access from `ExtensionAPI`.
2. Should `git` expose additional fields we do not currently use (`remoteUrl`, `HEAD` SHA, `isDirty`)? Default: no; add only when a consumer needs them. Today's needs are `isRepo + branch`.
3. How aggressively should the host cache — event-driven vs lazy? Default: event-driven, recomputed on `cwd` change.
4. Should mutations be observable via a `subscribe(() => WorkspaceContext)` API? Default: no; document host update cadence instead.
5. When `cwd` is changed through worktree isolation (`src/worktree.ts`), does `workspaceContext.cwd` reflect the worktree path or the original cwd? Default: worktree path, since subagents spawned from isolated worktrees should see the worktree git state.

## Alternatives considered

- **Keep `detectEnv` as a permanent fallback.** Rejected: eternal maintenance burden, never gets to Phase 3 cleanup. The 0-10s spawn overhead becomes a long-term tax on every subagent.
- **Use Node `child_process.spawn` directly instead of `pi.exec`.** Rejected: bypasses the host's safety sandbox, and AGENTS.md Common Mistake #4 warns extensions should not shell out directly.
- **Use the worktree API (`simple-git`, `isomorphic-git`).** Rejected: brings a new direct dependency; same shell-out problem if `isomorphic-git` falls back to git; pi host API is the SSOT.

## Risks

- **Host API stability.** If `@earendil-works/pi-coding-agent` ships breaking-shape changes to `WorkspaceContext` in a minor release, downstream `pi-agent-orchestrator` may need a quick bump. Mitigation: keep dual-read in `npm`-published version until the host release is broadly available.
- **Phase 1 dual-read regression risk.** `options.pi.workspaceContext ?? await detectEnv(...)` adds a property access on a hot path. Risk: if some host exposes `workspaceContext` with an unusual type, the fallback might not fire. Mitigation: TypeScript types should catch most issues; verify on the actual host version before rip-greping.
- **Behavior change on detached HEAD vs `branch=` (option (b) above).** Documentation must be clear in `prompts.ts` change.

## Rollback

- Phase 1 rollback: revert the dual-read change, restore `const env = await detectEnv(...)`. Single-commit revert.
- Phase 2 rollback: re-add the `detectEnv` fallback, no API change required.
- Phase 3 rollback: this is deletion-only; revert is `git revert` of the cleanup commit + restore `src/env.ts` from git history.

## Net effect (post Phase 3)

- **Zero shell-out per spawn** — instantaneous host-provided values.
- **Synchronous** access — no additional `await` on the agent spawn hot path.
- **Single source of truth** — Pi host owns environment state; extension consumes it.
- **Cleaner type** — discriminated union instead of `isGitRepo: boolean + branch: string`.

## Why this is more than perf

`process.platform` is read directly in `src/env.ts:39` — extensions should not be reading global Node state. The host is the only SSOT.

## References

- GitHub: [GroepOnline/pi-agent-orchestrator#213](../../issues/213)
- Linear: [CHEF-832](https://linear.app/chefclawsheesh/issue/CHEF-832/)
- Background commits:
  - `accd80f8` — env.ts tactical P4 fix via helper extraction (defeats overdrive detector false positive)
  - `dd086382` — overdrive linter ruleset + pattern catalogue
  - `e9bf13d3` — vi.fn()-based unit tests for `detectEnv`
- AGENTS.md:
  - Project nature section: pi extension, not standalone
  - Common Mistake #4: host platform packages are NEVER direct deps; this RFC consumes `WorkspaceContext` via existing `ExtensionAPI` types, no new dep added.
