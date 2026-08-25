import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const sourceRoot = resolve(import.meta.dirname ?? ".", "..");
const sandboxes: string[] = [];
const BASELINE_VERSION = "0.18.0"; // pre-train maintenance line for the 0.19 train
const BASELINE_CHANGELOG = `# Changelog

## [Unreleased]

Release transaction fixture changes.

---

## v0.17.5 (2026-07-16)

Maintenance baseline fixture.

---

## v0.17.1 (2026-07-14)

Initial public baseline fixture.
`;

function copyFixture(root: string, path: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(join(sourceRoot, path), destination);
}

function normalizeSourceBaseline(root: string): void {
  const packagePath = join(root, "package.json");
  const lockPath = join(root, "package-lock.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (!lock.packages?.[""]) throw new Error("release fixture is missing package-lock root metadata");

  pkg.version = BASELINE_VERSION;
  lock.version = BASELINE_VERSION;
  lock.packages[""].version = BASELINE_VERSION;
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  writeFileSync(join(root, "CHANGELOG.md"), BASELINE_CHANGELOG);
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function node(root: string, ...args: string[]) {
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
  });
}

function createReleaseSandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-release-transaction-"));
  sandboxes.push(root);
  for (const path of [
    ".release-policy.json",
    "CHANGELOG.md",
    "package.json",
    "package-lock.json",
    "docs/releases/v0.19.0.md",
    "scripts/prepare-release.mjs",
    "scripts/release-policy.mjs",
    "scripts/release-recovery.mjs",
    "scripts/verify-release-transaction.mjs",
    "scripts/verify-version-transition.mjs",
  ]) {
    copyFixture(root, path);
  }
  normalizeSourceBaseline(root);
  git(root, "init");
  git(root, "config", "user.email", "release-test@example.invalid");
  git(root, "config", "user.name", "Release Test");
  git(root, "add", ".");
  git(root, "commit", "-m", "baseline");
  return root;
}

afterEach(() => {
  for (const root of sandboxes.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("v0.19 release transaction", () => {
  it("prepares, validates, and rejects manipulated release paths", { timeout: 30000 }, () => {
    const root = createReleaseSandbox();
    const prepare = node(root, "scripts/prepare-release.mjs", "0.19.0", "2026-08-25");
    expect(prepare.status, prepare.stderr).toBe(0);

    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    expect(pkg.version).toBe("0.19.0");
    expect(lock.version).toBe("0.19.0");
    expect(lock.packages[""].version).toBe("0.19.0");
    expect(lock.packages[""].peerDependencies).toEqual(pkg.peerDependencies);
    expect(lock.packages[""].engines).toEqual(pkg.engines);
    expect(changelog).toContain("## v0.19.0 (2026-08-25)");
    expect(changelog).toContain("No unreleased changes");
    expect(changelog).toContain("The repository is now on the 0.19.x release train.");
    expect(changelog).toContain("### Additional changes since v0.18.0");
    expect(changelog).not.toContain("0.18.x stabilization train");
    expect(changelog).not.toContain("Additional changes since v0.17.1");

    const publishPolicy = node(root, "scripts/release-policy.mjs", "publish");
    expect(publishPolicy.status, publishPolicy.stderr).toBe(0);

    git(root, "add", "CHANGELOG.md", "package.json", "package-lock.json");
    git(root, "commit", "-m", "chore(release): v0.19.0");
    const verify = node(
      root,
      "scripts/verify-release-transaction.mjs",
      "HEAD^",
      "HEAD",
      "0.19.0",
    );
    expect(verify.status, verify.stderr).toBe(0);

    const transition = node(
      root,
      "scripts/verify-version-transition.mjs",
      "HEAD^",
      "HEAD",
      "release/v0.19.0",
    );
    expect(transition.status, transition.stderr).toBe(0);
    const wrongBranch = node(
      root,
      "scripts/verify-version-transition.mjs",
      "HEAD^",
      "HEAD",
      "feature/version-bump",
    );
    expect(wrongBranch.status).not.toBe(0);
    expect(wrongBranch.stderr).toContain("version changes are allowed only on release/v0.19.0");

    pkg.description = "tampered after release preparation";
    writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    git(root, "add", "package.json");
    git(root, "commit", "-m", "chore(release): v0.19.0");
    const rejected = node(
      root,
      "scripts/verify-release-transaction.mjs",
      "HEAD^",
      "HEAD",
      "0.19.0",
    );
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain(
      "changed files must be exactly CHANGELOG.md, package-lock.json, package.json; received package.json",
    );
  });

  it("allows pre-train maintenance bumps between sourceBaselines on any branch", () => {
    const root = createReleaseSandbox();
    const policy = JSON.parse(readFileSync(join(root, ".release-policy.json"), "utf8"));
    const baselines = policy.sourceBaselines as string[];
    expect(baselines.length).toBeGreaterThanOrEqual(2);

    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    // Pre-train maintenance line for the 0.19 train is 0.18.x.
    // The sandbox baseline already carries 0.18.0 (BASELINE_VERSION).
    const toV = "0.18.1";
    expect(baselines).toContain("0.18.0");
    expect(baselines).toContain(toV);

    pkg.version = toV;
    lock.version = toV;
    lock.packages[""].version = toV;
    writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    writeFileSync(join(root, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
    git(root, "add", "package.json", "package-lock.json");
    git(root, "commit", "-m", `chore: maintenance bump to ${toV}`);

    const maintenance = node(
      root,
      "scripts/verify-version-transition.mjs",
      "HEAD^",
      "HEAD",
      "release/0.18.0-sweep",
    );
    expect(maintenance.status, maintenance.stderr).toBe(0);
    expect(maintenance.stdout).toContain("Maintenance baseline transition verified");
  });

  it("accepts the 0.18.0 -> 0.18.1 maintenance patch train on any branch", () => {
    const root = createReleaseSandbox();
    const policy = JSON.parse(readFileSync(join(root, ".release-policy.json"), "utf8"));
    expect(policy.sourceBaselines).toContain("0.18.1");

    // Maintenance-bump package.json + lock from the current baseline (0.18.0)
    // to the approved patch baseline (0.18.1), dating the changelog the
    // way a real maintenance PR would.
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    expect(pkg.version).toBe("0.18.0");
    expect(lock.version).toBe("0.18.0");
    expect(lock.packages[""].version).toBe("0.18.0");
    pkg.version = "0.18.1";
    lock.version = "0.18.1";
    lock.packages[""].version = "0.18.1";
    writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    writeFileSync(join(root, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);

    const originalChangelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    const separatorMatch = originalChangelog.match(/\r?\n---\r?\n/);
    expect(separatorMatch, "CHANGELOG must keep the [Unreleased] --- separator").not.toBeNull();
    const separator = separatorMatch![0];
    const separatorIndex = separatorMatch!.index!;
    const datedChangelog =
      originalChangelog.slice(0, separatorIndex + separator.length) +
      "\n## v0.18.1 (2026-08-22)\n\nSubagent budget fix and patch baseline.\n\n" +
      originalChangelog.slice(separatorIndex + separator.length);
    writeFileSync(join(root, "CHANGELOG.md"), datedChangelog);

    git(root, "add", "package.json", "package-lock.json", "CHANGELOG.md");
    git(root, "commit", "-m", "chore: maintenance bump to 0.18.1");

    // CI's version-transition gate must accept the patch bump on any branch.
    const transition = node(
      root,
      "scripts/verify-version-transition.mjs",
      "HEAD^",
      "HEAD",
      "release/0.18.1-patch",
    );
    expect(transition.status, transition.stderr).toBe(0);
    expect(transition.stdout).toContain("Maintenance baseline transition verified");

    // publish-baseline.yml's policy gate must accept 0.17.6 as a publishable baseline.
    const baselinePolicy = node(root, "scripts/release-policy.mjs", "baseline", "0.18.1");
    expect(baselinePolicy.status, baselinePolicy.stderr).toBe(0);
    expect(baselinePolicy.stdout).toContain("Maintenance baseline accepted for publish: 0.18.1");
  });
});
