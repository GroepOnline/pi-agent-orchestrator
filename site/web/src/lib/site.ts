export const CANONICAL_BASE_URL = "https://orchestrator.chefgroep.online";

export const PRODUCT_NAME = "Pi Agent Orchestrator";

export const NPM_PACKAGE = "@groeponline/pi-agent-orchestrator";

export function canonicalUrl(path = "/"): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${CANONICAL_BASE_URL}${normalized === "/" ? "" : normalized}`;
}

/** Prefix static asset paths with the Vite base (GitHub Pages mirror uses a subpath). */
export function siteAssetUrl(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalized}`;
}
