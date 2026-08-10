/**
 * release-verification.test.ts — Offline verification of the public npm release contract.
 *
 * Tests cover package contents, license consistency, registry configuration,
 * the frozen 0.18 release train, and the prepare/publish workflow split.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname ?? ".", "..");
const policySandboxes: string[] = [];

function readRoot(file: string): string {
  return readFileSync(resolve(root, file), "utf-8");
}

function fileExists(file: string): boolean {
  return existsSync(resolve(root, file));
}

function runReleasePolicy(...args: string[]) {
  return runReleasePolicyAt(root, ...args);
}

function runReleasePolicyAt(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, ["scripts/release-policy.mjs", ...args], {
    cwd,
    encoding: "utf8",
  });
}

function createBaselinePolicySandbox(version = "0.17.5"): string {
  const sandbox = mkdtempSync(join(tmpdir(), "pi-release-policy-"));
  policySandboxes.push(sandbox);
  for (const path of [
    ".release-policy.json",
    "CHANGELOG.md",
    "package.json",
    "package-lock.json",
    "docs/releases/v0.18.0.md",
    "docs/releases/v0.18.1.md",
    "scripts/release-policy.mjs",
  ]) {
    const destination = join(sandbox, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readRoot(path));
  }

  const packagePath = join(sandbox, "package.json");
  const lockPath = join(sandbox, "package-lock.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (!lock.packages?.[""]) throw new Error("release policy fixture is missing lockfile root metadata");
  pkg.version = version;
  lock.version = version;
  lock.packages[""].version = version;
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return sandbox;
}

afterEach(() => {
  for (const sandbox of policySandboxes.splice(0)) {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// ── npm pack verification ────────────────────────────────────────────────────

describe("npm pack verification", () => {
  it("package.json files field includes every public package resource", () => {
    const pkg = JSON.parse(readRoot("package.json"));
    const files: string[] = pkg.files ?? [];
    for (const required of [
      "dist/",
      "src/",
      "skills/",
      "prompts/",
      "README.md",
      "CHANGELOG.md",
      "LICENSE",
    ]) {
      expect(files).toContain(required);
    }
  });

  it(".npmignore excludes package-lock.json", () => {
    expect(fileExists(".npmignore")).toBe(true);
    const npmignore = readRoot(".npmignore");
    expect(npmignore).toContain("package-lock.json");
  });

  it("package.json files field does not include dev-only paths", () => {
    const pkg = JSON.parse(readRoot("package.json"));
    const files: string[] = pkg.files ?? [];
    expect(files).not.toContain("test/");
    expect(files).not.toContain(".github/");
    expect(files).not.toContain("scripts/");
  });
});

// ── License verification ─────────────────────────────────────────────────────

describe("license verification", () => {
  it("LICENSE file exists and is MIT", () => {
    expect(fileExists("LICENSE")).toBe(true);
    const license = readRoot("LICENSE");
    expect(license).toContain("MIT License");
    expect(license).toContain("Copyright (c) 2026 GroepOnline");
  });

  it("package.json declares MIT license", () => {
    const pkg = JSON.parse(readRoot("package.json"));
    expect(pkg.license).toBe("MIT");
  });

  it("no proprietary markings in key source files", () => {
    const proprietaryTerms = ["All Rights Reserved", "Proprietary", "Confidential"];
    const sourceFiles = [
      "src/index.ts",
      "src/types.ts",
      "src/settings.ts",
      "src/agent-runner.ts",
    ];
    for (const file of sourceFiles) {
      if (!fileExists(file)) continue;
      const content = readRoot(file);
      for (const term of proprietaryTerms) expect(content).not.toContain(term);
    }
  });

  it("public governance and security files exist", () => {
    expect(fileExists("SECURITY.md")).toBe(true);
    expect(fileExists("CODE_OF_CONDUCT.md")).toBe(true);
    expect(fileExists("ROADMAP.md")).toBe(true);
    expect(fileExists("ENTERPRISE_READINESS.md")).toBe(false);
  });
});

// ── Node.js version consistency ──────────────────────────────────────────────

describe("Node.js version consistency", () => {
  it(".nvmrc pins the exact Node version used by release-critical CI", () => {
    expect(fileExists(".nvmrc")).toBe(true);
    expect(readRoot(".nvmrc").trim()).toBe("22.19.0");
  });

  it("package.json engines.node requires at least the .nvmrc version", () => {
    const pkg = JSON.parse(readRoot("package.json"));
    expect(pkg.engines?.node).toBe(">=22.19.0");
  });

  it("package-lock root metadata matches package.json", () => {
    const pkg = JSON.parse(readRoot("package.json"));
    const lock = JSON.parse(readRoot("package-lock.json"));
    const rootPackage = lock.packages?.[""];
    expect(rootPackage?.engines?.node).toBe(pkg.engines.node);
    expect(lock.name).toBe(pkg.name);
    expect(rootPackage?.name).toBe(pkg.name);
    expect(lock.version).toBe(pkg.version);
    expect(rootPackage?.version).toBe(pkg.version);
  });

  it("ci.yml pins release-critical Linux jobs to Node 22.19", () => {
    const ci = readRoot(".github/workflows/ci.yml");
    const pinned = [...ci.matchAll(/node-version:\s*22\.19/g)];
    expect(pinned.length).toBeGreaterThanOrEqual(3);
    const qualityJob = ci.match(/quality:[\s\S]*?compatibility:/)?.[0] ?? "";
    expect(qualityJob).toMatch(/node-version:\s*22\.19/);
    expect(qualityJob).not.toMatch(/node-version:\s*22\s*$/m);
  });

  it("version-transition avoids unauthenticated git fetch origin main", () => {
    const ci = readRoot(".github/workflows/ci.yml");
    const qualityJob = ci.match(/quality:[\s\S]*?compatibility:/)?.[0] ?? "";
    expect(qualityJob).toContain("verify-version-transition.mjs");
    expect(qualityJob).toContain("BASE_SHA");
    expect(qualityJob).toContain("x-access-token");
    // Bare fetch after credential strip exits 128 on transferred org remotes
    // and was misread as a verify:release-policy failure in Quality gate logs.
    expect(qualityJob).not.toMatch(/^\s*git fetch origin main\s*$/m);
  });

  it("Required CI gate skips (not fails) when a run is cancelled via concurrency", () => {
    const ci = readRoot(".github/workflows/ci.yml");
    const gate = ci.match(/\n {2}required-gate:[\s\S]*$/)?.[0] ?? "";
    expect(gate).toContain("name: Required CI gate");
    // always() makes the gate FAIL on concurrency-cancelled runs, leaving a
    // spurious required-check failure that stalls auto-merge. !cancelled()
    // skips the gate on cancellation while still catching genuine failures.
    expect(gate).toMatch(/if:\s*\$\{\{\s*!cancelled\(\)\s*\}\}/);
    expect(gate).not.toMatch(/if:\s*always\(\)/);
  });
});

// ── Frozen release train ─────────────────────────────────────────────────────

describe("0.18 release policy", () => {
  it("declares 0.18.x as the only allowed train and blocks 0.19.0", () => {
    const policy = JSON.parse(readRoot(".release-policy.json"));
    expect(policy.releaseTrain).toBe("0.18");
    expect(policy.initialRelease).toBe("0.18.1");
    expect(policy.sourceBaselines).toEqual(["0.17.1", "0.17.5", "0.17.6", "0.18.0"]);
    expect(policy.allowPrerelease).toBe(false);
    expect(policy.blockedNextMinor).toBe("0.19.0");
    expect(policy.releaseCommitTitle).toBe("chore(release): v0.18.1");
  });

  it("accepts stable 0.18 candidates", () => {
    expect(runReleasePolicy("candidate", "0.18.1").status).toBe(0);
    expect(runReleasePolicy("candidate", "0.18.7").status).toBe(0);
  });

  it("rejects 0.19, old trains, and prereleases", () => {
    for (const blocked of ["0.19.0", "0.17.2", "1.0.0", "0.18.0-beta.1"]) {
      const result = runReleasePolicy("candidate", blocked);
      expect(result.status, `${blocked}: ${result.stderr}`).not.toBe(0);
    }
  });

  it("accepts the baseline for repository CI but rejects it for publishing", () => {
    const sandbox = createBaselinePolicySandbox();
    const repository = runReleasePolicyAt(sandbox, "repository");
    expect(repository.status, repository.stderr).toBe(0);
    const publish = runReleasePolicyAt(sandbox, "publish");
    expect(publish.status).not.toBe(0);
    expect(publish.stderr).toContain("outside the locked 0.18.x release train");
  });

  it("accepts maintenance baseline publish policy for 0.17.5", () => {
    const sandbox = createBaselinePolicySandbox();
    const baseline = runReleasePolicyAt(sandbox, "baseline", "0.17.5");
    expect(baseline.status, baseline.stderr).toBe(0);
    expect(baseline.stdout).toContain("Maintenance baseline accepted");
    const blocked = runReleasePolicyAt(sandbox, "baseline", "0.18.0");
    expect(blocked.status).not.toBe(0);
  });

  it("ships a workflow_dispatch path for maintenance baseline npm publish", () => {
    expect(fileExists(".github/workflows/publish-baseline.yml")).toBe(true);
    const content = readRoot(".github/workflows/publish-baseline.yml");
    expect(content).toContain("workflow_dispatch:");
    // The dispatch must validate the requested version against the package.json
    // version currently on main, not a hardcoded literal, so any approved
    // sourceBaseline (0.17.5, 0.17.6, ...) can be published.
    expect(content).not.toContain("inputs.confirm == '0.17.5'");
    // The confirm input is validated as a single scalar, not per line: reject
    // any CR/LF, then anchor strict semver against the whole value so a
    // multi-line "0.17.6\nextra" cannot smuggle a valid version through.
    expect(content).toContain(String.raw`*[$'\r\n']*)`);
    expect(content).toContain(String.raw`[[ ! "$CONFIRM_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]`);
    // The version-match step compares the full value against package.json on main.
    expect(content).toContain("printenv CONFIRM_VERSION | grep -Fxq");
    expect(content).not.toContain('REQUESTED="$CONFIRM_VERSION"');
    expect(content).toContain("node scripts/release-policy.mjs baseline");
    expect(content).toContain("npm publish");
  });

  // The confirm-version guard is bash embedded in YAML; execute it directly so a
  // multi-line value cannot regress into passing the per-line grep validation.
  it.skipIf(process.platform === "win32")(
    "rejects multi-line confirm versions in the publish-baseline guard",
    () => {
      const content = readRoot(".github/workflows/publish-baseline.yml");
      const match = content.match(
        /- name: Validate confirm version format[\s\S]*?\n {8}run: \|\n([\s\S]*?)\n {6}- /,
      );
      expect(match, "could not locate the confirm-version validation step").not.toBeNull();
      const script = match![1]
        .split("\n")
        .map(line => line.replace(/^ {10}/, ""))
        .join("\n");

      const runGuard = (confirm: string) =>
        spawnSync("bash", ["-c", script], {
          encoding: "utf8",
          env: { ...process.env, CONFIRM_VERSION: confirm },
        });

      // A clean single-line baseline passes.
      expect(runGuard("0.17.6").status).toBe(0);
      // A valid version followed by newline-separated extra text is rejected.
      expect(runGuard("0.17.6\nextra text").status).not.toBe(0);
      // Two versions on separate lines are rejected (no per-line escape hatch).
      expect(runGuard("0.17.5\n0.18.0").status).not.toBe(0);
      // A trailing CR/LF alone is still rejected as multi-line.
      expect(runGuard("0.17.6\n").status).not.toBe(0);
      // Non-semver garbage is rejected.
      expect(runGuard("not-a-version").status).not.toBe(0);
    },
  );

  it("ships a non-empty v0.18.0 release record template", () => {
    const notes = readRoot("docs/releases/v0.18.0.md");
    expect(notes).toContain("### Pi package distribution");
    expect(notes).toContain("### Release integrity");
    expect(notes).toContain("### Runtime and security hardening");
  });
});

// ── Transactional release workflows ─────────────────────────────────────────

describe("transactional release workflow", () => {
  it("provides an explicit guarded Prepare Release 0.18.1 button", () => {
    expect(fileExists(".github/workflows/prepare-release.yml")).toBe(true);
    const content = readRoot(".github/workflows/prepare-release.yml");
    expect(content).toMatch(/name:\s*Prepare Release 0\.18\.1/);
    expect(content).toMatch(/workflow_dispatch:/);
    expect(content).toContain("RELEASE 0.18.1");
    expect(content).toContain("node scripts/prepare-release.mjs");
    expect(content).toContain("node scripts/verify-release-transaction.mjs HEAD^ HEAD");
    expect(content).toContain("gh pr create");
    expect(content).toContain("gh workflow run ci.yml");
    expect(content).toContain("gh workflow run linter.yml");
    expect(content).toContain("--auto --squash");
    expect(content).not.toMatch(/npm publish/);
    expect(content).toContain("node scripts/release-recovery.mjs assert-absent");
    expect(content).not.toMatch(
      /PUBLISHED="\$\(npm view @groeponline\/pi-agent-orchestrator version\)"/,
    );
  });

  it("release.yml publishes only a semantically verified reviewed commit", () => {
    expect(fileExists(".github/workflows/release.yml")).toBe(true);
    expect(fileExists("scripts/verify-release-transaction.mjs")).toBe(true);
    const content = readRoot(".github/workflows/release.yml");
    const verifier = readRoot("scripts/verify-release-transaction.mjs");
    expect(content).toMatch(/branches:\s*\[main\]/);
    expect(content).not.toMatch(/tags:\s*\n/);
    expect(content).toContain("chore(release): v$VERSION");
    expect(content).toContain("npm run verify:release-policy:publish");
    expect(content).toContain("node scripts/verify-release-transaction.mjs");
    expect(content).toContain("node scripts/release-policy.mjs candidate");
    expect(verifier).toContain('ALLOWED_FILES = ["CHANGELOG.md", "package-lock.json", "package.json"]');
    expect(verifier).toContain("package.json changed fields other than version");
    expect(verifier).toContain("package-lock changed outside top-level version");
    expect(verifier).toContain("CHANGELOG history from v0.17.1 backwards was modified");
  });

  it("checks exact npm versions and validates GitHub Release recovery metadata", () => {
    const prepare = readRoot(".github/workflows/prepare-release.yml");
    const release = readRoot(".github/workflows/release.yml");
    expect(fileExists("scripts/release-recovery.mjs")).toBe(true);
    expect(prepare).toContain("node scripts/release-recovery.mjs assert-absent");
    expect(release).toContain("node scripts/release-recovery.mjs decide-publish");
    expect(release).toContain("node scripts/release-recovery.mjs ensure-github-release");
    expect(release).toContain("node scripts/ensure-release-tag.mjs");
    // Critical: finalize must not embed an indented bash here-doc (breaks `if` parsing).
    expect(release).not.toMatch(/Create or verify GitHub Release[\s\S]*?<<'NODE'/);
    expect(release).not.toContain("<<'NODE'");
    expect(release).toContain("sparse-checkout:");
    expect(release).toContain("scripts/release-recovery.mjs");
    expect(release).toContain("scripts/verify-published-package.mjs");
  });

  it("isolates read-only verification, npm OIDC, and Git write permissions", () => {
    const content = readRoot(".github/workflows/release.yml");
    expect(content).toMatch(/^permissions:\s*\{\}/m);
    const detect = content.match(/\n {2}detect:[\s\S]*?\n {2}verify:/)?.[0] ?? "";
    const verify = content.match(/\n {2}verify:[\s\S]*?\n {2}publish:/)?.[0] ?? "";
    const publish = content.match(/\n {2}publish:[\s\S]*?\n {2}finalize:/)?.[0] ?? "";
    const finalize = content.match(/\n {2}finalize:[\s\S]*$/)?.[0] ?? "";
    expect(detect).toContain("contents: read");
    expect(verify).toContain("contents: read");
    expect(verify).not.toContain("id-token: write");
    expect(verify).not.toContain("contents: write");
    expect(publish).toContain("id-token: write");
    expect(publish).not.toContain("contents: write");
    expect(finalize).toContain("contents: write");
    expect(finalize).not.toContain("id-token: write");
  });

  it("publishes one immutable tarball with provenance and verifies registry integrity", () => {
    const content = readRoot(".github/workflows/release.yml");
    expect(content).toMatch(/registry-url:\s*"https:\/\/registry\.npmjs\.org"/);
    expect(content).toContain("actions/upload-artifact@");
    expect(content).toContain("actions/download-artifact@");
    expect(content).toContain(`npm publish "./release-artifact/\${TARBALL}"`);
    expect(content).toContain("--access public --provenance --ignore-scripts");
    expect(content).toMatch(/NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/);
    expect(content).toContain("node scripts/write-release-manifest.mjs");
    expect(content).toContain("node scripts/verify-published-package.mjs");
    expect(content).toContain("node scripts/ensure-release-tag.mjs");
    expect(content).toContain("node scripts/release-recovery.mjs ensure-github-release");
    expect(content).not.toContain("<<'NODE'");
    expect(content).not.toMatch(/LATEST="\$\(npm view/);
    expect(readRoot("scripts/release-recovery.mjs")).toContain("gh release create");
    expect(fileExists("scripts/verify-published-package.mjs")).toBe(true);
    expect(fileExists("scripts/write-release-manifest.mjs")).toBe(true);
    expect(fileExists("scripts/ensure-release-tag.mjs")).toBe(true);
    expect(readRoot("scripts/verify-published-package.mjs")).toContain(
      "Registry dist.integrity does not match the reviewed tarball",
    );
    expect(readRoot("scripts/verify-published-package.mjs")).toContain(
      "Downloaded tarball integrity does not match the reviewed tarball",
    );
  });

  it("Super-Linter supports explicit dispatch and retained diagnostics", () => {
    const linter = readRoot(".github/workflows/linter.yml");
    expect(linter).toMatch(/workflow_dispatch:/);
    expect(linter).toContain("github.event_name == 'workflow_dispatch'");
    expect(linter).toContain("SAVE_SUPER_LINTER_OUTPUT: true");
    expect(linter).toContain("Upload Super-Linter diagnostics");
    // Dependency CVEs stay in the Required CI gate (dependency-review), not
    // Super-Linter Trivy — otherwise unrelated PRs go UNSTABLE for site lockfile
    // findings and auto-merge stalls.
    expect(linter).not.toContain("VALIDATE_TRIVY");
    expect(readRoot(".github/workflows/ci.yml")).toContain("dependency-review");
  });

  it("legacy publish workflows remain removed", () => {
    expect(fileExists(".github/workflows/publish.yml")).toBe(false);
    expect(fileExists(".github/workflows/publish-npm.yml")).toBe(false);
  });

  it("package.json uses separate repository and strict publish policy scripts", () => {
    const pkg = JSON.parse(readRoot("package.json"));
    expect(pkg.publishConfig?.registry).toBe("https://registry.npmjs.org");
    expect(pkg.publishConfig?.access).toBe("public");
    expect(pkg.scripts?.["verify:release-policy"]).toBe(
      "node scripts/release-policy.mjs repository",
    );
    expect(pkg.scripts?.["verify:release-policy:publish"]).toBe(
      "node scripts/release-policy.mjs publish",
    );
    expect(pkg.scripts?.prepublishOnly).toContain("npm run verify:release-policy:publish");
  });
});
