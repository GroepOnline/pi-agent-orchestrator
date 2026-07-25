# Showcase media layout

Binary showcase media (`*.mp4`, large `*.gif`) should not keep growing inside
this repository. Git history already carries multiple generations of the same
files; every clone and every PR CI run pays for that.

## Target layout

| Path | Owns |
| --- | --- |
| `OnlineChefGroep/pi-agent-orchestrator` | Source, site app code, small posters/SVGs |
| `OnlineChefGroep/pi-agent-orchestrator-assets` (sibling) | Binary media under `images/` |
| `OnlineChefGroep/showcase-videos` | Remotion compositions / generated films |

Checkout side by side:

```text
OrgChefgroep/
  pi-agent-orchestrator/
  pi-agent-orchestrator-assets/   # images/dashboard_preview.mp4, …
  showcase-videos/
```

## Local wiring

```bash
# clone once
git clone git@github.com:OnlineChefGroep/pi-agent-orchestrator-assets.git ../pi-agent-orchestrator-assets

# optional: point docs/images at the external images/ tree
npm run assets:link
npm run assets:status
```

Override the location with `ORCHESTRATOR_MEDIA_DIR=/absolute/path`.

`site/web/scripts/stage-public.mjs` already honors `ORCHESTRATOR_MEDIA_DIR`
(and otherwise reads `docs/images`, whether that is a real directory or a
symlink).

## CI / Pages

Until the migration finishes, required media still ships in `docs/images/` so
Cloudflare Pages and GitHub Pages builds keep working without an extra clone.
The follow-up cutover is:

1. Copy current `docs/images/*.{mp4,gif}` into `pi-agent-orchestrator-assets/images/`
2. Stop tracking those binaries in this repo (keep `.svg` / small `.png` posters)
3. Teach `cloudflare-pages.yml` / `pages.yml` to checkout the assets repo into
   `docs/images` (or set `ORCHESTRATOR_MEDIA_DIR`) before `stage-public`
4. Optional later: `git filter-repo` to purge historical blobs from this repo

## Why not git-lfs here

LFS still stores large objects in the same project quota and complicates
`npm pack` / shallow CI clones. A sibling assets repo keeps `git clone` of the
extension fast and matches how `showcase-videos` already works for Remotion.
