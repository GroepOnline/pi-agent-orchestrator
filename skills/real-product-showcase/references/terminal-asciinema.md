# Terminal / CLI / TUI capture

Use this when the truth is in a terminal: Pi CLI, dashboards, TUIs, shell flows.

## Tools

| Tool | Role |
|------|------|
| `asciinema` v3+ | Records the session and supports a live marker hotkey |
| `tmux` (optional) | Bracketed paste, fixed pane size, light automation |
| `agg` (+ `ffmpeg`) | Renders the recorded `.cast` into a 60 fps GIF/MP4 |
| `ffprobe` | Checks the output |

Remotion is not a cast renderer: `npm run showcase:remotion` builds a source-derived programmatic hero and does not ingest your `.cast`. To turn a real recording into video, use `agg`.

asciinema v2 and v3 both support the `add_marker_key` marker hotkey, and both insert unlabeled markers you label afterwards, so markers alone are not a reason to upgrade. The difference is the config file: v3 reads `~/.config/asciinema/config.toml`, while v2 reads `~/.config/asciinema/config` with the key under a `[record]` section.

v3, `~/.config/asciinema/config.toml`:

```toml
[session]
add_marker_key = "^x"
```

v2, `~/.config/asciinema/config`:

```ini
[record]
add_marker_key = C-x
```

## Recording

1. Lock cols/rows first (for example `120×36`). Do not resize mid-take unless post can handle resize events.
2. Launch the real product:

   ```bash
   asciinema rec /tmp/real-session.cast \
     --idle-time-limit 2 \
     --command 'pi --no-session -e ./dist/index.js ...'
   ```

3. Hit the marker hotkey at each beat (or inject an `m` event).
4. For multi-line prompts, use bracketed paste (`tmux paste-buffer -p`) so the CLI gets one prompt, not one line per paste.
5. Stop after the last success (handoff verified, dashboard stable).

## Marker contract (this package)

Scene ids, in order:

1. `skill-creation`
2. `subagent-run`
3. `dashboard-top`
4. `handoff`

Drop these markers live while recording (Recording step 3, asciinema marker hotkey); there is no `label-scenes` script. To turn the real cast into a GIF/MP4, use `agg` (or `ffmpeg`). `npm run showcase:remotion` renders the programmatic hero and does not ingest your cast.

## Framing

The cast header owns the row count. Remotion must scale font size to `rows`. A fixed large font in a short box clips the Pi prompt bar (cwd, model, input line) and the clip looks like a random dark box.

Fit math lives in `showcase/remotion/src/PiTerminalShowcase.tsx`. After layout edits, re-render. Re-record only if the cast itself is wrong.

## Good take

- Bottom of frame shows Pi footer: workspace, token %, model, prompt/status line
- Title chrome says Pi / coding agent
- Skill create, Agent spawn, `/agents` top, and handoff each get their own marked scene
- Idle is compressed. No multi-minute thinking stares

## Bad take

- Programmatic dashboard GIF sold as the README hero after a request for a real session
- Only the prompt input, no tool or agent result
- Bottom rows cropped to enlarge glyphs
- asciinema v2 plus homemade marker hacks
