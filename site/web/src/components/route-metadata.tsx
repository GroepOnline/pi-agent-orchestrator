import { useEffect } from "react";
import { useLocation } from "react-router";

import { canonicalUrl, PRODUCT_NAME } from "@/lib/site";

type Metadata = { title: string; description: string };

const ROUTE_METADATA: Record<string, Metadata> = {
  "/": {
    title: "Pi Agent Orchestrator | Multi-Agent Coding Agent Orchestration",
    description:
      "Multi-agent orchestration for Pi coding agents with autonomous subagents, parallel worktrees, swarms, schedules, handoffs, budgets, and a live terminal dashboard.",
  },
  "/install": {
    title: "Install Pi Agent Orchestrator | Pi Coding Agent Extension",
    description:
      "Install the Pi Agent Orchestrator extension and start running bounded coding subagents, worktrees, swarms, schedules, and handoffs from your terminal.",
  },
  "/capabilities": {
    title: "Pi Agent Orchestrator Capabilities | Subagents, Swarms, Worktrees",
    description:
      "Explore Pi Agent Orchestrator capabilities for autonomous coding subagents, git worktree isolation, swarms, schedules, token budgets, handoffs, and live observability.",
  },
  "/showcase": {
    title: "Pi Agent Orchestrator Showcase | Live Multi-Agent Terminal",
    description:
      "Watch the real Pi Agent Orchestrator terminal UI coordinate coding agents, worktrees, swarms, schedules, dashboards, and structured handoffs.",
  },
  "/docs": {
    title: "Pi Agent Orchestrator Documentation | Multi-Agent Orchestration",
    description:
      "Documentation for Pi Agent Orchestrator, including architecture, API, custom agents, performance, troubleshooting, permissions, scheduling, and agent workflows.",
  },
};

function metadataFor(pathname: string): Metadata {
  const exact = ROUTE_METADATA[pathname];
  if (exact) return exact;
  if (pathname.startsWith("/docs/")) {
    const raw = pathname.slice("/docs/".length).replaceAll("-", " ");
    const section = raw.replace(/\b\w/g, (letter) => letter.toUpperCase());
    return {
      title: `${section} | ${PRODUCT_NAME} Docs`,
      description: `${section} documentation for Pi Agent Orchestrator and multi-agent coding workflows inside Pi.`,
    };
  }
  return ROUTE_METADATA["/"]!;
}

function setMeta(selector: string, attribute: string, value: string) {
  const element = document.head.querySelector<HTMLMetaElement>(selector);
  if (element) element.setAttribute(attribute, value);
}

export function RouteMetadata() {
  const { pathname } = useLocation();

  useEffect(() => {
    const metadata = metadataFor(pathname);
    const url = canonicalUrl(pathname);
    document.title = metadata.title;

    let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.rel = "canonical";
      document.head.append(canonical);
    }
    canonical.href = url;

    setMeta('meta[name="description"]', "content", metadata.description);
    setMeta('meta[property="og:title"]', "content", metadata.title);
    setMeta('meta[property="og:description"]', "content", metadata.description);
    setMeta('meta[property="og:url"]', "content", url);
    setMeta('meta[name="twitter:title"]', "content", metadata.title);
    setMeta('meta[name="twitter:description"]', "content", metadata.description);
  }, [pathname]);

  return null;
}
