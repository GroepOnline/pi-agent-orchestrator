/**
 * Ensures operational workflows consume the same explicit Node runtime as
 * local development and package metadata. The compatibility matrix remains
 * intentionally separate because it tests supported Node majors by design.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname ?? ".", "..");
const runtimeManagedWorkflows = [
  "ci.yml",
  "cloudflare-pages.yml",
  "droid-wiki-refresh.yml",
  "prepare-release.yml",
  "publish-baseline.yml",
  "qa.yml",
  "release.yml",
  "remotion-showcase.yml",
] as const;

function readRoot(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

function readWorkflow(name: (typeof runtimeManagedWorkflows)[number]): string {
  return readRoot(`.github/workflows/${name}`);
}

describe("Node runtime workflow contract", () => {
  it("pins the repository runtime to an explicit stable version", () => {
    expect(readRoot(".nvmrc").trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("uses .nvmrc in every production, release, and functional QA workflow", () => {
    for (const workflow of runtimeManagedWorkflows) {
      expect(readWorkflow(workflow), workflow).toContain('node-version-file: ".nvmrc"');
    }
  });

  it("does not reintroduce an unmanaged hard-coded runtime outside the compatibility matrix", () => {
    for (const workflow of runtimeManagedWorkflows) {
      const unmanagedVersions = readWorkflow(workflow).match(/node-version:\s*["']?\d/gu) ?? [];
      expect(unmanagedVersions, workflow).toEqual([]);
    }

    expect(readWorkflow("ci.yml")).toContain("node-version: $" + "{{ matrix.node }}");
  });
});

describe("CI critical-path workflow contract", () => {
  it("starts independent benchmarks without weakening the required gate", () => {
    const ci = readWorkflow("ci.yml");
    const benchmarks = ci.match(/\n {2}benchmarks:[\s\S]*?\n {2}required-gate:/)?.[0] ?? "";
    const requiredGate = ci.match(/\n {2}required-gate:[\s\S]*?\n {2}notify-on-failure:/)?.[0] ?? "";

    expect(benchmarks).not.toMatch(/^\s+needs:/m);
    expect(requiredGate).toContain("- benchmarks");
    expect(requiredGate).toContain(`test "$BENCHMARKS_RESULT" = "success"`);
  });
});
