# RFC: Expose `workspaceContext` on `@earendil-works/pi-coding-agent` `ExtensionAPI`

## Filing context

- **Filed by:** GroepOnline / OrgBeheer (downstream consumer org)
- **Filed against:** `earendil-works/pi-coding-agent` (this repo)
- **Motivating consumer:** `GroepOnline/pi-agent-orchestrator` (project README at github.com/GroepOnline/pi-agent-orchestrator)
- **Downstream tracking ticket:** [`GroepOnline/pi-agent-orchestrator#213`](https://github.com/GroepOnline/pi-agent-orchestrator/issues/213) — `CHEF-100: expose workspaceContext on ExtensionAPI and delete src/env.ts`
- **Downstream tracking PR:** [`GroepOnline/pi-agent-orchestrator#214`](https://github.com/GroepOnline/pi-agent-orchestrator/pull/214) on branch `chore/CHEF-100-workspace-context-rfc`
- **Linear mirror:** `CHEF-832` in the `ChefSheesh` team
- **Filing date:** May 2026

## Summary

Today, extensions that need cwd / git-repo state / current branch must shell out to `git` via `pi.exec`, and many read `process.platform` directly to gate per-OS behaviour. This duplicates state the host already knows and adds per-spawn latency to every installed extension that performs the same detection.

This RFC proposes exposing a **single synchronous `workspaceContext` field on `ExtensionAPI`** so that all installed extensions can drop their own `git` shell-outs from the spawn hot path. The most acute consumer motivating this RFC is `pi-agent-orchestrator`, which spends up to **0-10s of sequential `pi.exec("git", ...)` per subagent spawn**, dominated by two 5000ms timeouts for `git rev-parse --is-inside-work-tree` and `git branch --show-current`. The fix is not specific to that extension: any extension that detects workspace context at spawn time benefits once the host surface is added.

## Proposed TypeScript shape

```ts
// Public type export — accessible to extensions via:
//   import type { WorkspaceContext } from "@earendil-works/pi-coding-agent";
export interface WorkspaceContext {
  /** Host current working directory at extension load / cwd-change events. */
  readonly cwd: string;

  /**
   * Discriminated git state.
   * - `isRepo: false` is the only correct shape when the cwd is not inside
   *   a git worktree or `.git` cannot be read.
   * - `isRepo: true` means a worktree is present. `branch` is the current
   *   branch name, OR an empty string (`""`) in BOTH of these cases:
   *     (a) detached HEAD (e.g. CI checkouts, post-rebase mid-flight)
   *     (b) unborn branch (initialised repo with no commits yet)
   *   Consumers SHOULD NOT treat `branch: ""` as "no branch info at all"
   *   without first checking `isRepo`.
   */
  readonly git:
    | { readonly isRepo: true; readonly branch: string }
    | { readonly isRepo: false };

  /** Matches `process.platform` on the host. */
  readonly platform: NodeJS.Platform;
}

export interface ExtensionAPI {
  // ... existing surface
  readonly workspaceContext: WorkspaceContext;
}
```

### Design rationale

- **Discriminated union for `git`** makes the three meaningful states (no repo / repo without HEAD / repo with branch) distinct at the type level. The pre-RFC sentinel pattern (`isGitRepo: boolean` + `branch: string` + `branch === ""` overload) is fragile and a known source of consumer bugs; the union eliminates the sentinel check.
- **`NodeJS.Platform`** (not bare `string`) gives consumers a closed enum to match on; this matches Node's runtime surface and is already in scope for any extension that branches on platform.
- **`readonly` throughout** because this is host state, not consumer-mutable.

## Behavior

- **`cwd`**: reflects the host's working directory. Updates live when the host's cwd changes (e.g. session switching, worktree isolation).
- **`git`**: computed at host startup; recomputed on cwd change. Cheap to read repeatedly. (See Open Question 4 — caching/invalidation strategy.)
- **`git.branch`**: current branch name, or `""` on detached HEAD / unborn branch. Submodules: returns the worktree's branch, not the parent's.
- **`platform`**: stable for the host process lifetime; matches `process.platform` for extensions that want to cross-check.

## Type export path

`WorkspaceContext` is exposed as a top-level public type from the root `@earendil-works/pi-coding-agent` entry point:

```ts
import type { WorkspaceContext } from "@earendil-works/pi-coding-agent";
```

Consumers should be able to consume the type without depending on `@earendil-works/pi-coding-agent`'s internal module paths. The runtime contract lives entirely on `pi.workspaceContext`; the type import is compile-time only and erases at build (extensions can safely ship without a runtime dep bump if host types already flow in via the existing platform shim — see Open Question 2).

## Versioning statement

- This is an **additive surface change**; no existing `ExtensionAPI` consumer is broken.
- Ship behind a **minor** version bump of `@earendil-works/pi-coding-agent`. Consumers feature-detect via TypeScript (`'workspaceContext' in pi`) and dual-read for at least one minor version before deleting fallback paths.
- **No deprecation this release.** Existing extensions that shell out via `pi.exec` continue to function. Document a recommendation to migrate once the dual-read window passes, but do not remove `pi.exec` shell-out paths from upstream itself.
- For extension authors on a host older than the minor that introduces `workspaceContext`: pre-RFC behaviour (`pi.exec("git", ...)` shell-outs) is the only path. The discriminated union and async reading pattern remain valid in those extensions indefinitely.

## Security review

Exposing host cwd / git state / platform to extensions does not materially change the trust model: every extension already has `pi.exec` and can run `git rev-parse --is-inside-work-tree` (or any other shell command). This RFC only moves the answer from a side channel into a typed, documented surface. Sandbox restrictions, if any, are unchanged; this RFC adds no new permission grant.

The information disclosed (cwd, git-repo boolean, current-or-empty branch, OS) is the same information an extension can already derive via `pi.exec`. There is no new leakage beyond what `pi.exec` already exposes. No telemetry, no callbacks, no I/O happens on read.

## Acceptance criteria (host-side, for maintainers)

- `WorkspaceContext` interface exported from `@earendil-works/pi-coding-agent` root.
- `workspaceContext` field installed on `ExtensionAPI`.
- `cwd` reflects host CWD live and updates on cwd-change events.
- `git.isRepo` returns `true` inside any git worktree, including submodules; returns `false` outside any worktree.
- `git.branch` returns the current branch name, OR `""` for both detached HEAD and unborn branch.
- `platform` matches `process.platform` on the host (stable for process lifetime).
- Values recompute on cwd change / session-init events — NOT per extension call.
- TypeScript type import works from the package root, no internal path leaks required.

## Out of scope (re: this RFC)

- Reformatting any existing prompt block in extensions.
- Touching extensions' worktree-isolation paths beyond what `cwd` already covers.
- Exposing `process.env`, `os.userInfo()`, `node` version, or other env fields not in this RFC.
- Removing or deprecating `pi.exec` as a public API.
- Any change to extension sandboxing, permissions, or trust model.

## Open questions (for host maintainers)

1. **API surface placement.** Should `workspaceContext` live on `ExtensionAPI` (synchronous, eager) or `ExtensionContext` (per-session, possibly different per subagent session)? Downstream preference: `ExtensionAPI` for synchronous access from the spawn hot path.
2. **Type export surface.** Where in the package.json `exports` map should `WorkspaceContext` live? Root access is the consumer-friendly default; an internal-only path would force a runtime dep bump.
3. **Additional git fields.** Should `git` expose `remoteUrl`, `HEAD` SHA, `isDirty`? Default: **no** — add only when a consumer needs them. Today's downstream needs are `isRepo + branch`, with `""` covering detached HEAD and unborn branch.
4. **Caching / invalidation.** Event-driven (recompute on cwd change) or lazy (recompute per extension call)? Default: **event-driven**, with cwd-change events invalidating the cache. Matches existing host patterns (e.g. `ctx.cwd` is recomputed on session init).
5. **Observability / change signals.** Should mutations be observable via `subscribe(() => WorkspaceContext)` or a similar signal? Default: **no** — document the host's update cadence instead. Subagents don't currently observe env changes; if they ever need to, a separate `change` signal would be a cleaner API surface.
6. **Worktree integration.** When an extension spawns a subagent in an isolated git worktree, should `workspaceContext.cwd` reflect the worktree path or the host cwd? Default: **worktree path**, since subagents see the worktree's git state, not the parent's.
7. **Shipping cadence / deprecation story.** Is the change gated by a minor bump as proposed? Are existing extensions on older host versions expected to keep working indefinitely via their pre-RFC fallback paths? Is there a host-side version floor below which consumers should NOT migrate?

## Host-side implementation considerations

These are notes for the maintainer evaluating the implementation approach, not a binding design:

- **Eager property vs async getter**: an eager, synchronous property is cheap (one read at startup + one per cwd-change event) and matches the documented "spawn-hot-path" use case. An async getter adds latency on every consumer access; the property should win unless the host can prove the synchronous cost is high on cwd-change.
- **Single value vs `WorkspaceProvider` interface**: a single value on `ExtensionAPI` keeps the surface flat and discoverable. A `WorkspaceProvider` interface is more idiomatic for long-lived streams but increases consumer boilerplate at every call site.
- **In-process caching**: the host already maintains cwd and (likely) git state internally for its own UI. `workspaceContext` should be a typed view onto that same cache, not a parallel computation. Sourcing the value from existing host internals eliminates the cost concern entirely.

## Downstream impact (informational only)

If this RFC ships, downstream consumers can:

- Drop their own git shell-outs from the agent spawn hot path. In the motivating consumer, this reclaims 0-10s per spawn (worst case = two 5000ms timeouts back-to-back).
- Defer env detection to host lifetime (cached on cwd change vs per-call).
- Type-check env access: the discriminated union prevents the common bug where `branch: ""` is misinterpreted as "not a repo".

Consumers would gate on a peer-dep bump once `workspaceContext` is available. Recommendation: ship behind a minor version bump so consumers feature-detect via TypeScript and dual-read for at least one minor version. This protects extensions in the wild from breakage during host upgrades.

## Cross-org tracking

| Surface | Identifier |
|---------|-----------|
| GitHub (downstream ticket) | [GroepOnline/pi-agent-orchestrator#213](https://github.com/GroepOnline/pi-agent-orchestrator/issues/213) |
| GitHub (downstream PR) | [GroepOnline/pi-agent-orchestrator#214](https://github.com/GroepOnline/pi-agent-orchestrator/pull/214) |
| Linear | `CHEF-832` (`ChefSheesh` team) |
| Downstream RFC doc (full) | `docs/chef-rfcs/CHEF-100-workspace-context.md` in `GroepOnline/pi-agent-orchestrator` |

— Filed by GroepOnline / OrgBeheer, May 2026.
