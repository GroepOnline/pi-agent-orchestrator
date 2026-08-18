# Site hosting

Canonical product URL is a **subdomain of `chefgroep.online`**. Cloudflare Pages is only the deploy backend; GitHub Pages is an optional mirror for org `.github.io` links.

## URLs

| Host | Role |
|------|------|
| `https://orchestrator.chefgroep.online` | **Canonical** product site (`chefgroep.online` zone) |
| `https://groeponline.github.io/pi-agent-orchestrator/` | GitHub Pages mirror and **pi.dev `pi.video` host** |

Internal only (not a public brand URL): the Cloudflare project default host `pi-agent-orchestrator.pages.dev` exists as the Pages origin behind the CNAME. Do not advertise it; point humans and agents at `orchestrator.chefgroep.online`. The Pages origin and branch-preview hosts receive `X-Robots-Tag: noindex` through `site/web/public/_headers`.

GitHub Pages is workflow-backed (`build_type=workflow`, enabled 2026-08-18). The Deploy Pages workflow only publishes from `main`. `actions/deploy-pages` runs on `ubuntu-latest`; a hung fleet job in the `pages` concurrency group would block catalog-video publishes.

## Deployment

Production deploys run from the `main` branch:

1. `scripts/build-site.sh` builds the Vite SPA in `site/web/` and assembles `_site/`
2. Cloudflare: `wrangler pages deploy` via [`.github/workflows/cloudflare-pages.yml`](../.github/workflows/cloudflare-pages.yml)
3. GitHub mirror: [`.github/workflows/pages.yml`](../.github/workflows/pages.yml) (base path `/pi-agent-orchestrator/`). Path filters include `package.json` and `CHANGELOG.md` so a release commit republishes `pi.video`. The build fails if `_site/assets/dashboard_preview.mp4` is missing or tiny.

Showcase media is staged from `docs/images/` before the Vite build. Documentation markdown is bundled into the SPA as HTML. The build also publishes a deliberately small machine-readable surface verbatim: `llms.txt`, `llms-full.txt`, `sitemap.md`, `AGENTS.md`, `agent-permissions.json`, and `/.well-known/agent-permissions.json`. The remaining `docs/*.md` files stay package-owned and are not exposed as raw public files.

**SPA routing:** Cloudflare Pages enables native SPA fallback when `404.html` is absent (canonical deploy, `SITE_BASE=/`). The GitHub mirror build (`SITE_BASE=/pi-agent-orchestrator/`) copies `index.html` → `404.html` because GitHub Pages has no equivalent. `_redirects` keeps **301-only** legacy `.md` redirects — never `/* /index.html 200` (Cloudflare turns those into 308 loops).

## Agent and crawler contract

- `site/web/scripts/stage-public.mjs` copies the repository SSOTs into the Vite public directory before every build.
- `site/web/public/_headers` forces the correct text/Markdown/JSON content types, short revalidation caching, canonical `Link` headers, and deindexing for Pages origin hosts.
- `agent-permissions.json` follows the LAS-WG 1.0.0 schema with `strict: true`; unspecified interactive actions are therefore denied by default.
- `site/web/index.html` advertises the permissions file, the LLM index, and Schema.org JSON-LD.
- CI must verify that every discovery file survives the production build and that both permissions copies are byte-identical.

Cloudflare edge security must not return a different response solely because a request uses a citation-crawler user agent. Crawl preferences belong in `robots.txt`; bot/WAF rules should remain consistent with that policy.

## Custom domain

`orchestrator.chefgroep.online` is attached to the Pages project in the same Cloudflare account as the `chefgroep.online` zone. DNS is a proxied CNAME from that subdomain to the Pages project origin.

To add or change custom domains: **Workers & Pages** → **pi-agent-orchestrator** → **Custom domains**.
