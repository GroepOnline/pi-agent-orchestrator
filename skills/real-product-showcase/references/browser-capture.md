# Browser / web app capture

Use this when the truth is a web UI: docs site, dashboard SPA, admin console, marketing flows.

## Tools

| Tool | Role |
|------|------|
| Playwright / Puppeteer / CDP | Repeatable navigation and video |
| Cursor `RecordScreen` / OS recorder | Manual passes with human pacing |
| `ffmpeg` | Normalize fps, crop, encode |

Automate when the path repeats. Screen-record when you need human pacing or auth that automation cannot hold.

## Recording

1. Boot the real app (local preview, staging, or read-only production). No Storybook fakes for hero claims.
2. Fix the viewport (1440×900 or 1920×1080). Keep device scale at 1 unless you want retina on purpose.
3. Keep browser chrome in frame when the story is "using this in a browser": URL bar, tab title, or a clear in-app top bar. Viewport-only is fine only if the first second shows an unmistakable product header.
4. Mark beats with one of:
   - Playwright `page.evaluate` flashing a slate (`SCENE: checkout`) for ~0.4s
   - Chapter timestamps in a sidecar JSON
   - Hotkey overlays from an interactive recorder
5. Click and type the real controls. Wait for network idle or a selector that proves success.

## Beats for web

1. Land on the product
2. Do the core action
3. Show the live result
4. Show the durable outcome (saved record, share link, export)

Each beat needs a selector or text check you can cite in the PR.

## Post

- Cut on markers. Drop login and typing dead air.
- Encode H.264 `yuv420p` at 30 or 60 fps. Drop audio unless you need narration.
- Export a poster that still shows product chrome.

## Bad take

- Storybook screenshots chained into a "demo"
- URL or product shell cropped so it could be any site
- Cursor wiggling with no state change
- Purple gradient filler instead of the real UI
