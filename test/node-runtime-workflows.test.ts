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
      expect(readWorkflow(workflow), workflow).toContain(
        'node-version-file: ".nvmrc"'
      );
    }
  });

  it("does not reintroduce an unmanaged hard-coded runtime outside the compatibility matrix", () => {
    for (const workflow of runtimeManagedWorkflows) {
      const unmanagedVersions =
        readWorkflow(workflow).match(/node-version:\s*["']?\d/gu) ?? [];
      expect(unmanagedVersions, workflow).toEqual([]);
    }

    expect(readWorkflow("ci.yml")).toContain(
      "node-version: $" + "{{ matrix.node }}"
    );
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
  // Parse the runs-on value instead of the raw line so a YAML comment cannot
  // smuggle a fleet or non-Linux label past the contract.
  const hostedLinuxLabels = new Set([
    "ubuntu-latest",
    "$" + "{{ matrix.runs-on }}",
  ]);

  interface RunsOnRoute {
    source: string;
    labels: string[];
  }

  function stripYamlComment(value: string): string {
    let quote: '"' | "'" | null = null;
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];
      if (quote) {
        if (char === quote) {
          if (value[index + 1] === quote) index += 1;
          else quote = null;
        }
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === "#" && (index === 0 || /\s/u.test(value[index - 1]))) {
        return value.slice(0, index).trimEnd();
      }
    }
    return value.trim();
  }

  function unquoteYamlScalar(value: string): string {
    const trimmed = value.trim();
    const quote = trimmed[0];
    if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
      return trimmed.slice(1, -1).replaceAll(quote + quote, quote);
    }
    return trimmed;
  }

  function splitFlowLabels(value: string): string[] {
    const labels: string[] = [];
    let quote: '"' | "'" | null = null;
    let start = 0;
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];
      if (quote) {
        if (char === quote) {
          if (value[index + 1] === quote) index += 1;
          else quote = null;
        }
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ",") {
        labels.push(value.slice(start, index));
        start = index + 1;
      }
    }
    labels.push(value.slice(start));
    return labels;
  }

  function parseRunsOnValue(rawValue: string): string[] {
    const value = stripYamlComment(rawValue).trim();
    if (!value) return [];
    const list =
      value.startsWith("[") && value.endsWith("]")
        ? splitFlowLabels(value.slice(1, -1))
        : [value];
    return list
      .map((label) => unquoteYamlScalar(label))
      .filter((label) => label.length > 0);
  }

  function collectRunsOnRoutes(content: string): RunsOnRoute[] {
    const lines = content.split(/\r?\n/u);
    const routes: RunsOnRoute[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const match = /^(\s*)runs-on:\s*(.*)$/u.exec(lines[index]);
      if (!match) continue;
      const indent = match[1].length;
      const labels = parseRunsOnValue(match[2]);
      if (labels.length === 0) {
        for (let itemIndex = index + 1; itemIndex < lines.length; itemIndex += 1) {
          const raw = lines[itemIndex];
          if (!raw.trim()) continue;
          const itemIndent = raw.match(/^\s*/u)?.[0].length ?? 0;
          const item = raw.trim();
          if (itemIndent <= indent || !item.startsWith("-")) break;
          labels.push(...parseRunsOnValue(item.slice(1).trim()));
        }
      }
      routes.push({ source: lines[index].trim(), labels });
    }
    return routes;
  }

  function runsOnLabels(snippet: string): string[] {
    return collectRunsOnRoutes(snippet)[0]?.labels ?? [];
  }

  function isHostedLinuxRoute(line: string): boolean {
    const labels = runsOnLabels(line);
    return (
      labels.length > 0 && labels.every((label) => hostedLinuxLabels.has(label))
    );
  }

  function usesFleetLabel(line: string): boolean {
    return runsOnLabels(line).some((label) =>
      fleetLabels.some((fleet) => label.includes(fleet))
    );
  }

  it("routes every job to GitHub-hosted Linux and never to a fleet label", () => {
    const dir = resolve(root, ".github/workflows");
    const files = readdirSync(dir).filter(
      (name) => name.endsWith(".yml") || name.endsWith(".yaml")
    );
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const content = readRoot(`.github/workflows/${name}`);
      const routes = collectRunsOnRoutes(content);
      expect(routes, `${name} must declare a runs-on route`).not.toHaveLength(
        0
      );
      for (const route of routes) {
        expect(
          route.labels.length,
          `${name} must declare runs-on labels`
        ).toBeGreaterThan(0);
        expect(
          route.labels.some((label) =>
            fleetLabels.some((fleet) => label.includes(fleet))
          ),
          `${name} must not route to a fleet label`
        ).toBe(false);
        expect(
          route.labels.every((label) => hostedLinuxLabels.has(label)),
          `${name} must use GitHub-hosted Linux`
        ).toBe(true);
      }
    }
  });

  it("checks the parsed runs-on value, not comments or raw text", () => {
    const matrixLabel = "$" + "{{ matrix.runs-on }}";
    for (const route of [
      "    runs-on: ubuntu-latest",
      '    runs-on: ["ubuntu-latest"]',
      `    runs-on: ${matrixLabel}`,
      `    runs-on: ["ubuntu-latest", "${matrixLabel}"]`,
      "    runs-on: ubuntu-latest # hosted Linux minutes are free here",
      "    runs-on:\n      - ubuntu-latest",
      `    runs-on:\n      - ubuntu-latest\n      - "${matrixLabel}"`,
    ]) {
      expect(isHostedLinuxRoute(route), route).toBe(true);
      expect(usesFleetLabel(route), route).toBe(false);
    }
    for (const route of [
      "    runs-on: windows-latest # ubuntu-latest",
      `    runs-on: windows-latest # ${matrixLabel}`,
      "    runs-on: [self-hosted, Linux, X64, heavy]",
      '    runs-on: ["chefgroep-ci-oci"]',
      '    runs-on: "ubuntu-latest # geen commentaar"',
      "    runs-on:\n      - ubuntu-latest\n      - chefgroep-ci-oci",
    ]) {
      expect(isHostedLinuxRoute(route), route).toBe(false);
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
    const benchmarks =
      ci.match(/\n {2}benchmarks:[\s\S]*?\n {2}required-gate:/)?.[0] ?? "";
    const requiredGate =
      ci.match(/\n {2}required-gate:[\s\S]*?\n {2}notify-on-failure:/)?.[0] ??
      "";

    expect(benchmarks).not.toMatch(/^\s+needs:/m);
    expect(requiredGate).toContain("- benchmarks");
    expect(requiredGate).toContain(`test "$BENCHMARKS_RESULT" = "success"`);
  });
});

describe("public repository self-hosted runner guard", () => {
  // This public repo keeps runner group 25 (chefgroep-ci-oci) admitted for
  // trusted release events only; pull request code must never reach it.
  const pullRequestTrigger =
    /^\s*(?:on:\s*\[?[^\n]*\bpull_request(?:_target)?\b|pull_request(?:_target)?\s*:?\s*$)/mu;

  it("keeps pull_request and pull_request_target workflows off chefgroep-ci-oci", () => {
    const dir = resolve(root, ".github", "workflows");
    const files = readdirSync(dir).filter(
      (name) => name.endsWith(".yml") || name.endsWith(".yaml")
    );
    const offenders = files.filter((name) => {
      const content = readFileSync(resolve(dir, name), "utf8");
      return (
        pullRequestTrigger.test(content) && content.includes("chefgroep-ci-oci")
      );
    });
    expect(offenders).toEqual([]);
  });

  it("detects pull request triggers in every supported form", () => {
    for (const sample of [
      "on: pull_request",
      "on: [push, pull_request_target]",
      "on:\n  pull_request:\n",
      "on:\n  - pull_request\n",
    ]) {
      expect(pullRequestTrigger.test(sample), sample).toBe(true);
    }
    expect(pullRequestTrigger.test("on:\n  push:\n    tags: [v*]\n")).toBe(
      false
    );
  });
});
