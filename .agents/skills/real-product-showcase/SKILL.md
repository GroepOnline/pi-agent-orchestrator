---
name: real-product-showcase
trigger: /real-showcase
description: "Record realistic product demos from real terminal, browser, or app sessions. No fake UI. Use for real demos, hero MP4s, asciinema/Remotion, browser walkthroughs, app recordings, or when the user says no namaak / fully realistic showcase."
---

# Real product showcase

Cursor entry for the packaged skill.

## What you must do

1. Open [`skills/real-product-showcase/SKILL.md`](../../../skills/real-product-showcase/SKILL.md) and follow it.
2. Load only the reference you need from `skills/real-product-showcase/references/`:
   - `terminal-asciinema.md` for Pi/CLI/TUI
   - `browser-capture.md` for web apps
   - `desktop-mobile-apps.md` for native/Electron/mobile
   - `remotion-post.md` for cutting and encoding
   - `quality-gates.md` before you call it done
3. When the user wants a real or complete demo, prefer a live capture over `npm run showcase:ci` GIFs.
4. Do not ship a hero video with the product chrome cut off.
