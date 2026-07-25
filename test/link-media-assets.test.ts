/**
 * link-media-assets.test.ts — Unit coverage for external media root resolution.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { candidateMediaRoots, describeLinkState, resolveMediaRoot } from "../scripts/link-media-assets.mjs";

describe("link-media-assets.mjs source", () => {
  it("has no shebang so vitest can import it on Windows", () => {
    // A leading `#!/usr/bin/env node` is not stripped when vitest transforms a
    // project .mjs on Windows, so it throws "SyntaxError: Invalid or unexpected
    // token" and fails the whole suite. The script is always run via `node`, so
    // the shebang is unnecessary.
    const source = readFileSync(new URL("../scripts/link-media-assets.mjs", import.meta.url), "utf8");
    expect(source.startsWith("#!")).toBe(false);
  });
});

describe("candidateMediaRoots", () => {
  it("prefers ORCHESTRATOR_MEDIA_DIR when set", () => {
    const roots = candidateMediaRoots({ ORCHESTRATOR_MEDIA_DIR: "/media/orch" }, "/home/dev");
    expect(roots[0]).toBe("/media/orch");
  });

  it("includes the home OrgChefgroep assets checkout as a fallback", () => {
    const roots = candidateMediaRoots({}, "/home/dev");
    expect(roots).toContain(join("/home/dev", "OrgChefgroep", "pi-agent-orchestrator-assets"));
  });
});

describe("resolveMediaRoot", () => {
  it("returns null when no candidate exists", () => {
    expect(resolveMediaRoot({ ORCHESTRATOR_MEDIA_DIR: "/no/such/media-root-xyz" }, "/no/such/home-xyz")).toBeNull();
  });
});

describe("describeLinkState", () => {
  it("reports missing when the path does not exist", () => {
    expect(describeLinkState("/tmp/definitely-missing-orch-images-xyz")).toEqual({
      state: "missing",
      target: null,
    });
  });
});
