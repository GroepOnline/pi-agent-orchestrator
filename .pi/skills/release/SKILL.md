---
name: release
description: Cut a release of @groeponline/pi-agent-orchestrator to npmjs.org and GitHub. Use when publishing a new version, creating a release tag, or validating the canonical release workflow.
---

# Release — pi-agent-orchestrator

Releases use one canonical workflow: `.github/workflows/release.yml`.

Do not add parallel npm or GitHub Packages publish workflows. Duplicate tag triggers can publish only part of a release and leave npm, GitHub Releases, and source metadata out of sync.

## Automated release flow

A `v*` tag reachable from `main`, or a manual workflow dispatch on `main`, runs:

```text
npm ci
→ build
→ typecheck
→ lint
→ test
→ package metadata and prepublish validation
→ npm publish --access public
→ GitHub Release
```

The workflow resolves the target version from the tag or manual input and sets it inside CI with `npm version --no-git-tag-version`. Do not create a standalone package-version commit solely for the release.

## Before releasing

1. Confirm the release commit is on `main` and required CI is green.
2. Check the currently published version:

   ```bash
   npm view @groeponline/pi-agent-orchestrator version
   ```

3. Update `CHANGELOG.md` with user-visible changes.
4. Choose a new semantic version that is strictly greater than npm `latest`.
5. Ensure the package catalog contract passes:

   ```bash
   npm run verify:package
   npm pack --dry-run
   ```

## Tag release

```bash
git switch main
git pull --ff-only
git tag vX.Y.Z
git push origin vX.Y.Z
```

The release tag must be reachable from `main`.

## Manual release

Run the `Release` workflow on `main` and supply `X.Y.Z`. Use the same validation and changelog discipline as a tag release.

## Authentication

Current workflow authentication uses the repository Actions secret `NPM_TOKEN` with package-scoped publish permission.

Preferred target state is npm trusted publishing through GitHub OIDC:

1. Configure `GroepOnline/pi-agent-orchestrator` and workflow `release.yml` as the trusted publisher in npm.
2. Add `id-token: write` to release workflow permissions.
3. Remove `NODE_AUTH_TOKEN` and the `NPM_TOKEN` dependency.
4. Publish with `npm publish --access public --provenance`.

Do not remove token authentication until npm trusted publishing is configured.

## Post-release verification

```bash
npm view @groeponline/pi-agent-orchestrator version
npm view @groeponline/pi-agent-orchestrator pi --json
pi -e npm:@groeponline/pi-agent-orchestrator
```

Confirm that:

- npm reports the intended version;
- `pi.extensions` includes `./dist/index.js`;
- `pi.video` contains the public showcase MP4;
- the matching GitHub Release exists;
- the package card refreshes in the Pi package catalog.

## Recovery rules

- Never overwrite or reuse a published version.
- If npm succeeded and GitHub Release creation failed, create the missing release; do not republish.
- If npm failed, repair authentication or validation and release a new valid version.
- `dist/` is generated during publishing and must remain uncommitted.
