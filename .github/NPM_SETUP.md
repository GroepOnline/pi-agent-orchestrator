# npm release setup

`@groeponline/pi-agent-orchestrator` has one canonical transactional release path.
Do not create tags manually and do not add a second npm or GitHub Packages publisher.

## Release architecture

1. `.github/workflows/prepare-release.yml` prepares an exact reviewed patch release on `main`.
2. `.github/workflows/release.yml` publishes only the exact reviewed release commit after merge.

The preparation path verifies policy, source freshness, npm version absence, build, typecheck, lint, tests, package metadata, Pi package contract, Remotion promo data and the packed npm artifact. It then creates `release/v<VERSION>` and a reviewable PR. Publication starts only from the matching squash commit on `main`, then creates the npm package, immutable Git tag and GitHub Release for the same SHA.

## Current policy

`.release-policy.json` is the source of truth.

- current source baseline: `0.19.0`;
- next pinned patch: `0.19.1`;
- allowed release train: stable `0.19.x` only;
- prereleases: blocked;
- `0.20.0` and other release lines: blocked;
- historical source/maintenance baselines remain listed for verification and recovery.

Policy checks:

```bash
npm run verify:release-policy
node scripts/release-policy.mjs candidate 0.19.1
```

Advancing to another patch such as `0.19.2` requires a dedicated reviewed policy PR that updates the pinned initial release, source baseline, release branch/title, canonical release notes and verification tests. Minor `0.20.0` remains explicitly blocked.

## Authentication

The publisher currently reads the repository Actions secret `NPM_TOKEN` and requests `id-token: write` so npm provenance can be attached. Keep the token scoped to `@groeponline/pi-agent-orchestrator` with the shortest practical expiration.

Preferred target is npm trusted publishing for GitHub Actions (`GroepOnline/pi-agent-orchestrator`, workflow `release.yml`). Do not remove token authentication until trusted publishing is verified.

## Preparing v0.19.1

1. Confirm the intended source commit is on `main` and required CI is green.
2. Verify `v0.19.1` and npm `@groeponline/pi-agent-orchestrator@0.19.1` do not already exist.
3. Run the guarded preparation flow for `0.19.1` from `main` with confirmation `RELEASE 0.19.1`.
4. Review the generated release PR and required checks. Do not bypass a genuine failed gate.
5. After approval and green checks, squash-merge with subject `chore(release): v0.19.1`.
6. `release.yml` verifies the exact transaction, publishes npm with provenance, creates `v0.19.1`, and creates the matching GitHub Release.

## Post-release verification

```bash
npm view @groeponline/pi-agent-orchestrator version
npm view @groeponline/pi-agent-orchestrator pi --json
npm pack @groeponline/pi-agent-orchestrator@0.19.1 --dry-run
pi -e npm:@groeponline/pi-agent-orchestrator
```

Verify npm reports `0.19.1`, package metadata still exposes `./dist/index.js`, skills/prompts and the public video asset, tag `v0.19.1` points to the release source commit, the matching GitHub Release exists, Pages redeployed where required, and pi.dev shows `@groeponline/pi-agent-orchestrator` rather than the retired `@onlinechefgroep` listing.

## Failure recovery

The publisher is idempotent. Repair failed validation or authentication and re-run the failed release job. If npm already contains the exact version, recovery must verify/complete metadata rather than republish. Never force-move an existing tag, reuse a published version, or increment a version only to repair release metadata.
