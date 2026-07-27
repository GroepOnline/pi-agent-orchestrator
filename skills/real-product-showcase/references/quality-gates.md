# Quality gates

Run these before you call a showcase done.

## Probe

```bash
ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name,width,height,r_frame_rate,pix_fmt \
  -show_entries format=duration \
  -of default=nw=1 "$FILE"
```

For this package's Remotion heroes expect:

- `codec_name=h264`
- `width=1920`, `height=1080`
- `pix_fmt=yuv420p`
- `r_frame_rate=60/1` (or a documented 30/1)
- duration inside the scene budget (±0.1s)

There is no dedicated `verify-media` script; the `ffprobe` output above is the gate. Compare it against the expected values (by eye or a small shell check).

## Framing check

Pull a few stills:

```bash
ffmpeg -y -ss 8 -i "$FILE" -frames:v 1 /tmp/frame.png
```

Reuse the same `$FILE` you probed above so the framing still comes from the actual master or clip you are gating, not a stale render.

Pass only if:

1. Product chrome is readable (Pi prompt bar, browser URL or app title, or the equivalent).
2. That chrome is not clipped top or bottom.
3. Text is legible at 1080p.
4. After you ignore surrounding marketing labels, the frame still looks like this product.

## Story check

| Clip | Must show |
|------|-----------|
| skill-creation | Real skill file create or copy success |
| subagent-run | Real Agent or subagent start with id/status |
| dashboard-top | Live `/agents` or top view updating |
| handoff | Structured handoff or completed proof |

Reject clips that only show typing into an empty prompt.

## Publish checklist

- [ ] Master on disk (`showcase_tmux.mp4` / `showcase_live.mp4`, or your browser/app recording)
- [ ] All four per-scene clips on disk: `showcase_skill-creation.mp4`, `showcase_subagent-run.mp4`, `showcase_dashboard-top.mp4`, `showcase_handoff.mp4` (see [remotion-post.md](remotion-post.md))
- [ ] `ffprobe` checks above pass (codec, resolution, fps, duration) on the master and every clip
- [ ] Framing stills reviewed
- [ ] Artifacts ready for PR review
- [ ] Tracked docs/changelog updated when required
- [ ] No secrets in the recording (API keys, private URLs, token-bearing home paths)
