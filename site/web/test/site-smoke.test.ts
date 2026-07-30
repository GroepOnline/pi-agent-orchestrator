import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { docLinks, showcaseMedia, showcasePipelines } from "@/lib/content";
import { docSourceIds, docSources } from "@/lib/doc-sources";
import { CANONICAL_BASE_URL, canonicalUrl } from "@/lib/site";

const pageShell = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const headersContract = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
const agentPermissions = JSON.parse(
  readFileSync(new URL("../../../agent-permissions.json", import.meta.url), "utf8"),
) as {
  metadata?: { schema_version?: string };
  strict?: boolean;
  resource_rules?: unknown[];
};

describe("site constants", () => {
  it("uses the orchestrator canonical base URL", () => {
    expect(CANONICAL_BASE_URL).toBe("https://orchestrator.chefgroep.online");
    expect(canonicalUrl("/install")).toBe("https://orchestrator.chefgroep.online/install");
    expect(canonicalUrl("/showcase")).toBe("https://orchestrator.chefgroep.online/showcase");
  });

  it("lists documentation links for the docs index", () => {
    expect(docLinks.length).toBeGreaterThan(5);
    expect(docLinks.every((doc) => doc.href.startsWith("/docs/") && !doc.href.endsWith(".md"))).toBe(true);
    expect(docLinks.every((doc) => docSources[doc.docId])).toBe(true);
  });

  it("bundles every doc link into build-time sources", () => {
    for (const id of docSourceIds) {
      expect(docSources[id]?.markdown.length).toBeGreaterThan(20);
    }
  });

  it("declares showcase pipelines and media entries", () => {
    expect(showcasePipelines.length).toBe(5);
    expect(showcaseMedia.some((item) => item.featured)).toBe(true);
    expect(showcaseMedia.every((item) => item.href.startsWith("/assets/"))).toBe(true);
  });

  it("features the real-capture terminal master from the Remotion pipeline", () => {
    expect(showcaseMedia.find((item) => item.id === "real-terminal-master")).toMatchObject({
      href: "/assets/dashboard_preview.mp4",
      kind: "video",
      pipeline: "remotion",
      featured: true,
    });
  });

  it("advertises valid base-aware machine-readable discovery metadata", () => {
    expect(pageShell).toContain('rel="alternate" type="text/plain" href="%BASE_URL%llms.txt"');
    expect(pageShell).toContain(
      'rel="agent-permissions" href="%BASE_URL%.well-known/agent-permissions.json"',
    );
    expect(pageShell).toContain('type="application/ld+json"');
    expect(agentPermissions.metadata?.schema_version).toBe("1.0.0");
    expect(agentPermissions.strict).toBe(true);
    expect(agentPermissions.resource_rules?.length).toBeGreaterThan(0);
  });

  it("canonicalizes both agent-permissions aliases in Cloudflare headers", () => {
    const canonical =
      "Link: <https://orchestrator.chefgroep.online/.well-known/agent-permissions.json>; rel=\"canonical\"";
    for (const path of ["/agent-permissions.json", "/.well-known/agent-permissions.json"]) {
      // Match path at the start of a headers block line (not as a suffix of another path).
      const marker = `\n${path}\n`;
      const padded = `\n${headersContract}`;
      const blockStart = padded.indexOf(marker);
      expect(blockStart).toBeGreaterThanOrEqual(0);
      const contentStart = blockStart + 1; // skip the leading newline we padded
      const nextBlock = padded.indexOf("\n/", contentStart + path.length);
      const block = nextBlock === -1 ? padded.slice(contentStart) : padded.slice(contentStart, nextBlock);
      expect(block.startsWith(`${path}\n`)).toBe(true);
      expect(block).toContain(canonical);
    }
  });
});
