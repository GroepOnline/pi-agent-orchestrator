/**
 * Ensures operational workflows consume the same explicit Node runtime as
 * local development and package metadata. The compatibility matrix remains
 * intentionally separate because it tests supported Node majors by design.
 */

import { readdirSync, readFileSync } from "node:fs";
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
  "release-tag-artifacts.yml",
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

describe("runner and concurrency workflow contract", () => {
  const hostedCiWorkflows = new Set([
    "ci.yml",
    "design-system-contract.yml",
    "linter.yml",
    "qa.yml",
  ]);
  const standardConcurrency = [
    "group: $" + "{{ github.workflow }}-$" + "{{ github.ref }}",
    "cancel-in-progress: true",
  ];
  // This public repository has no reachable self-hosted lane: group 25 is a
  // selected list that excludes it, and the retired `heavy` label has no
  // online runner, so any fleet label leaves the job queued forever
  // (#127, #129). GitHub-hosted Linux minutes are free for a public repo, so
  // every job runs on ubuntu-latest. macOS/Windows legs stay out.
  const fleetLabels = ["self-hosted", "chefgroep-ci-oci", "heavy"];

  it("routes every job to GitHub-hosted Linux and never to a fleet label", () => {
    const dir = resolve(root, ".github/workflows");
    const files = readdirSync(dir).filter(name => name.endsWith(".yml") || name.endsWith(".yaml"));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const content = readRoot(`.github/workflows/${name}`);
      const routes = content.match(/^\s*runs-on:.*$/gm) ?? [];
      expect(routes, `${name} must declare a runs-on route`).not.toHaveLength(0);
      for (const route of routes) {
        for (const label of fleetLabels) {
          expect(route, `${name} must not route to the ${label} label`).not.toContain(label);
        }
        expect(route, `${name} must use GitHub-hosted Linux`).toMatch(
          /ubuntu-latest|\$\{\{ matrix\.runs-on \}\}/,
        );
      }
    }
  });

  it("cancels superseded runs on the required public CI workflows", () => {
    for (const name of hostedCiWorkflows) {
      const content = readRoot(`.github/workflows/${name}`);
      for (const line of standardConcurrency) {
        expect(content, name).toContain(line);
      }
    }
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
