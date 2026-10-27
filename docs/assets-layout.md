# Showcase media layout

Documentation visuals and generated showcase media have different jobs and should be stored accordingly.

## Ownership

| Asset class | Canonical location | Rule |
| --- | --- | --- |
| Small source-controlled diagrams and SVGs | `GroepOnline/pi-agent-orchestrator` | Reviewable in normal PR diffs |
| Small generated posters/social cards needed by the package/site | `docs/images/` while required by current build wiring | Keep only when a build or metadata path depends on them |
| Large MP4/GIF showcase media | `GroepOnline/pi-agent-orchestrator-assets` | Do not keep growing the main repo history |
| Remotion composition source / generated films | `GroepOnline/showcase-videos` plus the repo's `showcase/remotion/` integration | Composition source stays reviewable; large outputs remain external where possible |

The README and architecture overview use `docs/images/orchestration_flow.svg`. This is intentionally a compact, source-controlled vector rather than a generated screenshot or social card. The generated `social_preview.png` remains a social/package metadata asset and is no longer the primary README hero.

## Local checkout layout

```text
OrgChefgroep/
  pi-agent-orchestrator/
  pi-agent-orchestrator-assets/
  showcase-videos/
```

Clone the binary asset repository once when you need the complete media set:

```bash
git clone git@github.com:GroepOnline/pi-agent-orchestrator-assets.git ../pi-agent-orchestrator-assets
npm run assets:link
npm run assets:status
```

Override the media location with `ORCHESTRATOR_MEDIA_DIR=/absolute/path`.

`site/web/scripts/stage-public.mjs` honors `ORCHESTRATOR_MEDIA_DIR`; otherwise it reads `docs/images`, whether that path is a normal directory or a symlink.

## Documentation image policy

Primary documentation should prefer, in order:

1. Small SVG diagrams that explain architecture or flow.
2. Real product posters generated from product renderers.
3. Short real-product video only when motion is essential to understanding the feature.

Avoid using a marketing/social image as the only explanation of a technical workflow. Social cards optimize for sharing, while README and architecture visuals should optimize for comprehension and diffability.

## Current migration state

Required media still exists under `docs/images/` because Cloudflare Pages, GitHub Pages and existing showcase scripts expect those paths. The staged cutover remains:

1. Keep source SVGs and small required posters in the main repository.
2. Copy large `*.mp4` and large `*.gif` outputs to `pi-agent-orchestrator-assets/images/`.
3. Stop tracking migrated large binaries in the main repository.
4. Teach `cloudflare-pages.yml` and `pages.yml` to check out or stage the asset repository before site packaging.
5. Keep `ORCHESTRATOR_MEDIA_DIR` as the explicit local/CI override.
6. Consider historical blob cleanup separately; do not mix history rewriting into a normal release PR.

## Why not Git LFS here

Git LFS still couples large objects to the same project quota and complicates shallow CI, package verification and developer setup. A sibling binary asset repository keeps the extension checkout smaller and preserves a clean separation between reviewable source and generated media.
