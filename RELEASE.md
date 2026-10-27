# Release — pi-agent-orchestrator

Releases use one canonical workflow pair. Do not tag locally and do not add a second npm publisher.

- Button: `.github/workflows/prepare-release.yml` creates the reviewed `chore(release): vX.Y.Z` PR.
- Publisher: `.github/workflows/release.yml` publishes the exact squash-merged commit on `main`.
- Operator detail: [`.github/NPM_SETUP.md`](.github/NPM_SETUP.md)
- Agent skill: [`.pi/skills/release/SKILL.md`](.pi/skills/release/SKILL.md)

## After npm publish — pi.dev and GitHub Pages

`pi.dev` reads live npm metadata. The catalog video is `package.json` → `pi.video`:

`https://groeponline.github.io/pi-agent-orchestrator/assets/dashboard_preview.mp4`

That URL is served by GitHub Pages (`.github/workflows/pages.yml`), not by npm. A release commit already touches `package.json` / `CHANGELOG.md`, which retriggers Pages. Site-only fixes can use **Actions → Deploy Pages → Run workflow** on `main`.

Post-publish checks:

```bash
npm view @groeponline/pi-agent-orchestrator version
npm view @groeponline/pi-agent-orchestrator pi --json
curl -sI "https://groeponline.github.io/pi-agent-orchestrator/assets/dashboard_preview.mp4"
```

Confirm `Content-Type: video/mp4` and a non-tiny `Content-Length`. Then open the GroepOnline package on pi.dev (not the retired `@onlinechefgroep` listing).

No version bump is required solely to refresh the hosted MP4. Republish only when npm README, `pi.video`, or other packed metadata must change.
