# Remotion showcase

This package renders a real terminal recording and the reusable promo-media set for
`@onlinechefgroep/pi-agent-orchestrator`.

The terminal compositions all come from one asciicast. The other compositions do not
contain hand-written product claims. Before rendering,
`scripts/extract-promo-data.mjs` reads the repository package metadata, the
README capability and agent tables, the prompt-compression level table, and the
ASCII architecture diagram. It writes the normalized snapshot to
`public/promo-data.json`.

## Compositions

| ID | Type | Output |
| --- | --- | --- |
| `PiAgentTerminal` | 60fps video, dynamic duration | `docs/images/dashboard_preview.mp4` |
| `PiAgentSkillCreation` | 60fps scene clip | `docs/images/showcase_skill_creation.mp4` |
| `PiAgentSubagentRun` | 60fps scene clip | `docs/images/showcase_subagent_run.mp4` |
| `PiAgentDashboardTop` | 60fps scene clip | `docs/images/showcase_dashboard_top.mp4` |
| `PiAgentHandoff` | 60fps scene clip | `docs/images/showcase_handoff.mp4` |
| `PiAgentTerminalPoster` | still | `docs/images/dashboard_preview.png` |
| `PromoBanner` | still, 1280×640 | `docs/images/promo_banner.png` |
| `PromoSocialCard` | still, 1200×630 | `docs/images/social_preview.png` |
| `ArchitectureDiagram` | still, 1920×1080 | `docs/images/architecture_overview.png` |
| `FeatureTour` | video, dynamic duration | `docs/images/feature_tour.mp4` |

## Commands

From the repository root:

```bash
npm run showcase:label-scenes -- /path/to/real-session.cast
npm run showcase:remotion -- /path/to/real-session.cast
```

Record the session with asciinema's marker shortcut configured through
`rec.add_marker_key`. Press it at the start of skill creation, subagent execution,
dashboard/top, and handoff, in that order. Native asciicast `m` events do not appear
in terminal output. `showcase:label-scenes` attaches stable IDs, titles, and cue text
to those four markers after recording.

The render command requires the cast path. It never launches
`scripts/showcase-live-demo.mjs` and does not fall back to generated terminal state.
It renders the 1920x1080 H.264 master and all four clips at exactly 60fps, then runs
`scripts/verify-showcase-media.mjs`.

For focused work inside this directory:

```bash
npm install
npm run promo:data
npm run promo:data:check
npm run typecheck
npm run lint
npm test
npm run verify
npm run studio
npm run promo:all
```

`promo:data:check` ignores only the volatile `generatedAt` value. Every product
claim, table row, and architecture line must otherwise match the canonical
repository documents. `npm run verify` executes the package typecheck, static
checks, and snapshot test before media is rendered.

See `references/remotion-conventions.md` for visual and rendering invariants.
