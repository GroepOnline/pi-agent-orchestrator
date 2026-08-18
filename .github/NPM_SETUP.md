# npm release setup

`@groeponline/pi-agent-orchestrator` has one canonical, transactional release path.

Do not create tags manually and do not add another npm or GitHub Packages publish workflow. A release must move source, npm, Git tag, and GitHub Release together.

## Release architecture

Two workflows divide preparation from publication:

1. `.github/workflows/prepare-release.yml` — the human-facing **Prepare Release 0.18.0** button.
2. `.github/workflows/release.yml` — the automatic npm publisher for the exact reviewed release commit on `main`.

The button does not publish directly. It:

1. Refuses non-`main`, stale, duplicate, already-tagged, or already-published attempts.
2. Verifies `.release-policy.json` and the locked `0.18.x` train.
3. Updates `package.json`, both package-lock root versions, and `CHANGELOG.md` to `0.18.0`.
4. Runs build, typecheck, lint, tests, package metadata validation, and real npm tarball inspection.
5. Proves only `CHANGELOG.md`, `package.json`, and `package-lock.json` changed.
6. Creates `release/v0.18.0` and a reviewable release PR.
7. Explicitly dispatches CI and Super-Linter because GitHub suppresses `pull_request` events created with `GITHUB_TOKEN`.
8. Requests an external reviewer and enables auto-merge after checks and approval.

After the release PR squash-merges, `release.yml`:

1. Requires the exact commit subject `chore(release): v0.18.0`.
2. Requires the commit to contain exactly the three transactional release files.
3. Re-runs the immutable release gate from the merged source commit.
4. Publishes npm with provenance.
5. Creates `v0.18.0` on that exact commit.
6. Creates the matching GitHub Release.

## Version freeze

`.release-policy.json` is the source of truth.

Current policy:

- source baseline before release: `0.17.1`;
- allowed release train: stable `0.18.x` only;
- initial release: `0.18.0`;
- prereleases: blocked;
- `0.19.0` and all other release lines: blocked.

The policy is enforced by:

```bash
npm run verify:release-policy
node scripts/release-policy.mjs candidate 0.18.0
```

Do not unlock `0.19.x` as part of a feature, dependency, or routine release PR. It requires a dedicated reviewed policy change after the `0.18.x` stabilization period.

## Current authentication

The publisher currently reads the repository Actions secret `NPM_TOKEN` and also requests `id-token: write` so npm provenance can be attached.

Create a granular npm access token with the smallest possible scope:

- Package: `@groeponline/pi-agent-orchestrator`
- Permission: read and write
- Expiration: the shortest operationally practical period

Store it at:

```text
https://github.com/GroepOnline/pi-agent-orchestrator/settings/secrets/actions
```

## Preferred authentication: npm trusted publishing

Configure a trusted publisher in npm with:

- Provider: GitHub Actions
- Organization or user: `GroepOnline`
- Repository: `pi-agent-orchestrator`
- Workflow filename: `release.yml`
- Environment: leave empty unless a protected release environment is introduced

After npm trusted publishing is verified:

1. Remove `NODE_AUTH_TOKEN` and the `NPM_TOKEN` dependency from `release.yml`.
2. Keep `id-token: write`.
3. Keep `npm publish --access public --provenance`.

Do not remove token authentication before the trusted publisher is active.

## How to release 0.18.0

1. Open GitHub Actions.
2. Select **Prepare Release 0.18.0**.
3. Choose `main`.
4. Select `RELEASE 0.18.0` in the confirmation field.
5. Run the workflow.
6. Review the generated PR and its checks.

No version text, tag, or npm command needs to be entered manually. Branch protection still requires approval from someone other than the last pusher. After that approval and green checks, auto-merge and publication continue automatically.

## Post-release verification

```bash
npm view @groeponline/pi-agent-orchestrator version
npm view @groeponline/pi-agent-orchestrator pi --json
npm pack @groeponline/pi-agent-orchestrator@0.18.0 --dry-run
pi -e npm:@groeponline/pi-agent-orchestrator
```

Verify:

- npm shows `0.18.0`;
- `pi.extensions` contains `./dist/index.js`;
- `pi.skills` contains `./skills`;
- `pi.prompts` contains `./prompts`;
- `pi.video` contains the public MP4 showcase URL;
- the packed artifact contains the Orchestra skill and all three prompts;
- tag `v0.18.0` points to the same commit as the source version bump;
- the GitHub Release exists for `v0.18.0`;
- GitHub Pages served `https://groeponline.github.io/pi-agent-orchestrator/assets/dashboard_preview.mp4` as `video/mp4`;
- pi.dev refreshes `@groeponline/pi-agent-orchestrator` (the `@onlinechefgroep` listing is retired).

Release commits already retrigger [`.github/workflows/pages.yml`](workflows/pages.yml) because `package.json` and `CHANGELOG.md` are in its path filters. If only site media changed, run **Deploy Pages** on `main`. A hosted-MP4 fix does not require a version bump.

## Failure recovery

The publisher is intentionally idempotent.

| Failure | Response |
| --- | --- |
| Release preparation fails | Fix the hardening PR or remove an abandoned `release/v0.18.0` branch, then press the button again. |
| Release PR checks fail | Fix the release branch; do not bypass branch protection. |
| `401` or `ENEEDAUTH` | Verify `NPM_TOKEN`, or the npm trusted publisher after migration. |
| `403 Forbidden` | Verify package-level publish permission for the `@groeponline` scope. |
| npm already contains `0.18.0` | Re-run the failed Release job. It skips npm publish and completes tag/release verification. |
| npm publish succeeds but tag or GitHub Release fails | Re-run the failed Release job. Never increment the version solely to repair release metadata. |
| Existing tag points elsewhere | Stop. Do not force-move the tag; investigate the source-integrity violation. |
| A request attempts `0.19.0` | Keep it blocked until a dedicated policy-unlock PR is intentionally approved. |
