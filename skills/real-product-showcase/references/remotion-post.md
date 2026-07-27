# Post-production

Take one marked real capture. Cut a master and short clips. Do not invent frames.

## Goals

- Keep every scene from the capture
- Compress idle so the hero stays short
- Keep product chrome (scale to fit, do not crop identity away)
- Emit H.264 files people can review

## This package

```bash
# Render the source-derived Remotion hero + promo suite (dashboard_preview.mp4).
# Remotion is programmatic polish; it does not ingest your .cast.
npm run showcase:remotion
```

To cut a real capture into a master plus per-scene clips, mark scenes live while recording and follow the concrete edit-list flow in "Cut a real capture into master + clips" below. There is no `label-scenes` or `verify-media` npm script; gate the output with the `ffprobe` checks in [quality-gates.md](quality-gates.md).

| File | Job |
|------|-----|
| `scripts/render-showcase-remotion.sh` | Build, capture, and render the Remotion hero + promo suite |
| `showcase/remotion/scripts/capture-terminal.mjs` | Build the terminal frames the composition renders |
| `showcase/remotion/src/PiTerminalShowcase.tsx` | 1080p terminal composition; fits font size to captured rows |

## Timeline

- Cap scene length by compressing idle (about 10s skill, 12s subagent, 10s dashboard, 8s handoff). Do not delete markers.
- You may trim prelude before the first marker.
- Keep timestamps stable (`roundTime` style) so tests do not flake.

## Framing

- The video canvas size is not the cast row count. The content must still show every row.
- `fontSize = contentHeight / (rows * lineHeight)`.
- After chrome padding or height changes, re-render and check the prompt, URL, or app bar by eye.

## Encoding

If the renderer emits `yuvj420p`:

```bash
ffmpeg -y -i in.mp4 -vf "scale=in_range=pc:out_range=tv" \
  -c:v libx264 -pix_fmt yuv420p -color_range tv -an -movflags +faststart out.mp4
```

Hero target: 1920×1080, 60 fps (or 30 if the source is 30), H.264, `yuv420p`.

## Cut a real capture into master + clips

The publish gate expects a full-length master plus one clip per scene. Scene ids are fixed and ordered (same list as [terminal-asciinema.md](terminal-asciinema.md)): `skill-creation`, `subagent-run`, `dashboard-top`, `handoff`. Output filenames are stable so the quality gate can find them:

| Artifact | File |
|----------|------|
| Master (terminal) | `docs/images/showcase_tmux.mp4` or `docs/images/showcase_live.mp4` |
| Master (browser / app) | your recorded `.mp4` |
| `skill-creation` clip | `docs/images/showcase_skill-creation.mp4` |
| `subagent-run` clip | `docs/images/showcase_subagent-run.mp4` |
| `dashboard-top` clip | `docs/images/showcase_dashboard-top.mp4` |
| `handoff` clip | `docs/images/showcase_handoff.mp4` |

Terminal masters come from the existing scripts (`npm run showcase:tmux` / `showcase:live`). There is no `label-scenes` or `verify-media` npm script, so cut the clips by hand with an ffmpeg edit list built from the markers you dropped live:

```bash
# 1. Read the marker timestamps from the cast (asciicast "m" events: [t, "m", "label"]).
grep -n '"m"' /tmp/real-session.cast

# 2. Pick the master you produced.
MASTER=docs/images/showcase_tmux.mp4   # or showcase_live.mp4, or your browser/app recording

# 3. Cut one clip per scene: START = that scene's marker, END = the next marker (or EOF).
cut_scene() {  # cut_scene <start> <end> <scene-id>
  ffmpeg -y -ss "$1" -to "$2" -i "$MASTER" \
    -c:v libx264 -pix_fmt yuv420p -movflags +faststart \
    "docs/images/showcase_$3.mp4"
}

cut_scene 0     12.5 skill-creation
cut_scene 12.5  27.0 subagent-run
cut_scene 27.0  39.0 dashboard-top
cut_scene 39.0  50.0 handoff
```

Only after the master and all four clips exist do you run the publish gate. Timestamps above are placeholders: use the real marker times from step 1.

## Browser and app takes

Same contract, no Remotion: set `MASTER` to your screen recording and run the same `cut_scene` edit list above, driven by your marker sidecar instead of the cast. Remotion is polish. It is not permission to replace the capture with fake UI.
