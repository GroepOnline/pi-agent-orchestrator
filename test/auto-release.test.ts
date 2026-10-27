import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadReleasePolicy, nextPatchVersion } from "../scripts/release-policy.mjs";

const root = resolve(import.meta.dirname ?? ".", "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("automatic patch release", () => {
  it("advances exactly one patch inside the locked train", async () => {
    const policy = await loadReleasePolicy(root);
    expect(nextPatchVersion("0.19.0", policy)).toBe("0.19.1");
    expect(nextPatchVersion("0.19.1", policy)).toBe("0.19.2");
    expect(() => nextPatchVersion("0.20.0", policy)).toThrow();
  });

  it("dispatches guarded preparation after main advances", () => {
    const workflow = read(".github/workflows/auto-release.yml");
    expect(workflow).toContain("branches: [main]");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("workflow_run:");
    expect(workflow).toContain("node scripts/plan-auto-release.mjs");
    expect(workflow).toContain("node scripts/release-recovery.mjs check-exact");
    expect(workflow).toContain("gh workflow run prepare-release.yml");
    expect(workflow).not.toContain("npm publish");

    const releaseWorkflow = read(".github/workflows/release.yml");
    expect(releaseWorkflow).toContain("gh workflow run auto-release.yml --ref main");
  });

  it("refreshes an existing release PR instead of duplicating it", () => {
    const workflow = read(".github/workflows/prepare-release.yml");
    expect(workflow).toContain("Refreshing existing release PR");
    expect(workflow).toContain("--force-with-lease");
    expect(workflow).toContain("gh pr edit");
    expect(workflow).toContain("--auto --squash");
  });
});
