/**
 * release-finalize-exec.test.ts — Execute the real release decision scripts and
 * shell orchestration (not YAML string inspection). Covers publish decisions,
 * empty/erroneous npm view, tag/release recovery, and a local finalize transaction.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, delimiter as pathDelimiter, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const sourceRoot = resolve(import.meta.dirname ?? ".", "..");
const sandboxes: string[] = [];
const ghHookName = "gh-hook.cjs";

function track(dir: string): string {
  sandboxes.push(dir);
  return dir;
}

function writeStub(binDir: string, name: string, body: string): string {
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

function ghHandler(argsExpression: string, statePath: string): string {
  return `const fs = require("node:fs");
const statePath = ${JSON.stringify(statePath)};
const args = ${argsExpression};
const read = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
const write = (state) => fs.writeFileSync(statePath, JSON.stringify(state));

if (args[0] === "release" && args[1] === "view") {
  const state = read();
  if (!state.exists) {
    console.error("release not found");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(state.release));
  process.exit(0);
}

if (args[0] === "release" && args[1] === "create") {
  const tag = args[2];
  write({
    exists: true,
    release: { tagName: tag, isDraft: false, isPrerelease: false, name: tag },
  });
  console.log("created " + tag);
  process.exit(0);
}

if (args[0] === "release" && args[1] === "edit") {
  const tag = args[2];
  const state = read();
  state.release = { tagName: tag, isDraft: false, isPrerelease: false, name: tag };
  write(state);
  console.log("edited " + tag);
  process.exit(0);
}

console.error("unexpected gh args: " + args.join(" "));
process.exit(2);
`;
}

function writeGhStub(binDir: string, statePath: string): string {
  // On Windows, spawn() cannot execute .cmd files without a shell. A hardlink to
  // node.exe is a real executable; NODE_OPTIONS preloads the isolated handler.
  if (process.platform === "win32") {
    const hookPath = writeStub(
      binDir,
      ghHookName,
      `const path = require("node:path");
if (path.basename(process.execPath).toLowerCase() === "gh.exe") {
${ghHandler('["release", ...process.argv.slice(2)]', statePath)}}
`,
    );
    const executablePath = join(binDir, "gh.exe");
    try {
      linkSync(process.execPath, executablePath);
    } catch {
      copyFileSync(process.execPath, executablePath);
    }
    return hookPath;
  }

  return writeStub(
    binDir,
    "gh",
    `#!/usr/bin/env node
${ghHandler("process.argv.slice(2)", statePath)}`,
  );
}

function nodeEnv(extraPath: string, env: Record<string, string> = {}) {
  const hookPath = join(extraPath, ghHookName);
  const inheritedNodeOptions = env.NODE_OPTIONS ?? process.env.NODE_OPTIONS;
  const nodeOptions =
    process.platform === "win32" && existsSync(hookPath)
      ? [inheritedNodeOptions, `--require=${hookPath}`].filter(Boolean).join(" ")
      : inheritedNodeOptions;

  return {
    ...process.env,
    ...env,
    ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
    PATH: `${extraPath}${process.env.PATH ? `${pathDelimiter}${process.env.PATH}` : ""}`,
  };
}

function shellcheckAvailable(): boolean {
  const probe = spawnSync("shellcheck", ["--version"], { encoding: "utf8" });
  return probe.error == null;
}

function script(...parts: string[]): string {
  return join(sourceRoot, ...parts);
}

function runNode(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(process.execPath, args, {
    cwd: options.cwd ?? sourceRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
  });
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function extractWorkflowRunBlocks(workflowPath: string): string[] {
  const text = readFileSync(workflowPath, "utf8");
  const lines = text.split(/(?<=\n)/);
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*run:\s*\|/.test(lines[i] ?? "")) continue;
    let indent: number | null = null;
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const line = lines[j] ?? "";
      if (line.trim() === "") {
        body.push(line);
        j += 1;
        continue;
      }
      const lead = line.match(/^ */)?.[0].length ?? 0;
      if (indent === null) indent = lead;
      if (lead < indent && line.trim()) break;
      body.push(indent !== null && lead >= indent ? line.slice(indent) : line);
      j += 1;
    }
    blocks.push(body.join(""));
    i = j - 1;
  }
  return blocks;
}

afterEach(() => {
  for (const root of sandboxes.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("historical finalize heredoc regression", () => {
  it("reproduces the indented NODE terminator parse failure with bash -n", () => {
    const fixture = join(sourceRoot, "test/fixtures/broken-finalize-heredoc.sh");
    const result = spawnSync("bash", ["-n", fixture], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toMatch(/here-document|unexpected end of file/i);
  });

  it("current release.yml run blocks parse with bash -n and contain no NODE heredocs", { timeout: 30000 }, () => {
    const workflow = join(sourceRoot, ".github/workflows/release.yml");
    const content = readFileSync(workflow, "utf8");
    expect(content).not.toContain("<<'NODE'");
    expect(content).not.toContain("<<\"NODE\"");
    const blocks = extractWorkflowRunBlocks(workflow);
    expect(blocks.length).toBeGreaterThanOrEqual(6);
    for (const [index, body] of blocks.entries()) {
      const scriptPath = join(track(mkdtempSync(join(tmpdir(), "release-run-"))), `block-${index}.sh`);
      // Workflow fragments have no shebang; declare bash for ShellCheck.
      writeFileSync(scriptPath, `#!/usr/bin/env bash\n${body}`);
      const syntax = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
      expect(syntax.status, `block ${index}: ${syntax.stderr}`).toBe(0);
      if (!shellcheckAvailable()) continue;
      const shell = spawnSync(
        "shellcheck",
        ["-x", "-e", "SC2154,SC2164", scriptPath],
        { encoding: "utf8" },
      );
      expect(shell.status, `shellcheck block ${index}: ${shell.stdout}${shell.stderr}`).toBe(0);
    }
  });
});

describe.skipIf(process.platform === "win32")("decide-publish CLI with real npm stubs", () => {
  it("publishes when the package was never published (exact and latest both 404)", () => {
    const bin = track(mkdtempSync(join(tmpdir(), "npm-never-")));
    writeStub(
      bin,
      "npm",
      `#!/usr/bin/env bash
set -euo pipefail
echo "npm error code E404" >&2
echo "npm error 404 '@groeponline/pi-agent-orchestrator' is not in this registry." >&2
exit 1
`,
    );
    const out = join(bin, "github.output");
    writeFileSync(out, "");
    const result = runNode(
      ["scripts/release-recovery.mjs", "decide-publish", "@groeponline/pi-agent-orchestrator", "0.18.0"],
      { env: nodeEnv(bin, { GITHUB_OUTPUT: out }) },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("publish=true");
    expect(result.stdout).toMatch(/publish required/i);
  });

  it("publishes when the package exists but the exact version is absent", () => {
    const bin = track(mkdtempSync(join(tmpdir(), "npm-absent-ver-")));
    writeStub(
      bin,
      "npm",
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"@0.18.0"* ]]; then
  echo "npm error code E404" >&2
  echo "npm error 404 No match found for version 0.18.0" >&2
  exit 1
fi
if [[ "$*" == *"view @groeponline/pi-agent-orchestrator version"* ]] || [[ "$3" == "version" && "$2" == "@groeponline/pi-agent-orchestrator" ]]; then
  echo "0.17.1"
  exit 0
fi
echo "unexpected npm args: $*" >&2
exit 2
`,
    );
    const out = join(bin, "github.output");
    writeFileSync(out, "");
    const result = runNode(
      ["scripts/release-recovery.mjs", "decide-publish", "@groeponline/pi-agent-orchestrator", "0.18.0"],
      { env: nodeEnv(bin, { GITHUB_OUTPUT: out }) },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("publish=true");
  });

  it("skips publish when the exact version already exists", () => {
    const bin = track(mkdtempSync(join(tmpdir(), "npm-exists-")));
    writeStub(
      bin,
      "npm",
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"@0.18.0"* ]]; then
  echo "0.18.0"
  exit 0
fi
echo "0.18.0"
exit 0
`,
    );
    const out = join(bin, "github.output");
    writeFileSync(out, "");
    const result = runNode(
      ["scripts/release-recovery.mjs", "decide-publish", "@groeponline/pi-agent-orchestrator", "0.18.0"],
      { env: nodeEnv(bin, { GITHUB_OUTPUT: out }) },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("publish=false");
    expect(result.stdout).toMatch(/continuing recovery without republishing/i);
  });

  it("fails closed on empty npm view stdout", () => {
    const bin = track(mkdtempSync(join(tmpdir(), "npm-empty-")));
    writeStub(
      bin,
      "npm",
      `#!/usr/bin/env bash
set -euo pipefail
exit 0
`,
    );
    const result = runNode(
      ["scripts/release-recovery.mjs", "decide-publish", "@groeponline/pi-agent-orchestrator", "0.18.0"],
      { env: nodeEnv(bin) },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/returned empty output/);
  });

  it("fails closed on erroneous non-404 npm view responses", () => {
    const bin = track(mkdtempSync(join(tmpdir(), "npm-err-")));
    writeStub(
      bin,
      "npm",
      `#!/usr/bin/env bash
set -euo pipefail
echo "npm error code ECONNRESET" >&2
echo "network socket disconnected" >&2
exit 1
`,
    );
    const result = runNode(
      ["scripts/release-recovery.mjs", "decide-publish", "@groeponline/pi-agent-orchestrator", "0.18.0"],
      { env: nodeEnv(bin) },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/npm view .* failed|ECONNRESET/);
  });
});

describe("finalize tag and GitHub Release recovery", () => {
  it("creates a missing tag after publication and verifies idempotent reruns", { timeout: 30000 }, () => {
    const root = track(mkdtempSync(join(tmpdir(), "release-tag-")));
    const remote = track(mkdtempSync(join(tmpdir(), "release-tag-remote-")));
    git(remote, "init", "--bare");
    git(root, "init");
    git(root, "config", "user.email", "release-test@example.invalid");
    git(root, "config", "user.name", "Release Test");
    writeFileSync(join(root, "README.md"), "release\n");
    git(root, "add", "README.md");
    git(root, "commit", "-m", "chore(release): v0.18.0");
    const sha = git(root, "rev-parse", "HEAD");
    git(root, "remote", "add", "origin", remote);

    const created = runNode([script("scripts/ensure-release-tag.mjs"), "v0.18.0", sha], {
      cwd: root,
    });
    expect(created.status, created.stderr).toBe(0);
    expect(created.stdout).toMatch(/Created annotated tag/);
    expect(git(root, "rev-list", "-n1", "v0.18.0")).toBe(sha);
    expect(git(remote, "rev-list", "-n1", "v0.18.0")).toBe(sha);

    const rerun = runNode([script("scripts/ensure-release-tag.mjs"), "v0.18.0", sha], {
      cwd: root,
    });
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(rerun.stdout).toMatch(/already points to the correct commit/);
  });

  it("creates a missing GitHub Release and repairs draft metadata on recovery rerun", { timeout: 30000 }, () => {
    const bin = track(mkdtempSync(join(tmpdir(), "gh-release-")));
    const statePath = join(bin, "release-state.json");
    writeFileSync(statePath, JSON.stringify({ exists: false }));
    writeGhStub(bin, statePath);

    const missing = runNode(
      ["scripts/release-recovery.mjs", "ensure-github-release", "v0.18.0", "v0.18.0"],
      { env: nodeEnv(bin) },
    );
    expect(missing.status, missing.stderr).toBe(0);
    expect(missing.stdout).toMatch(/Created GitHub Release/);
    expect(JSON.parse(readFileSync(statePath, "utf8")).exists).toBe(true);

    // Simulate a partial failure that left a draft release behind.
    writeFileSync(
      statePath,
      JSON.stringify({
        exists: true,
        release: { tagName: "v0.18.0", isDraft: true, isPrerelease: false, name: "broken" },
      }),
    );
    const repair = runNode(
      ["scripts/release-recovery.mjs", "ensure-github-release", "v0.18.0", "v0.18.0"],
      { env: nodeEnv(bin) },
    );
    expect(repair.status, repair.stderr).toBe(0);
    expect(repair.stdout).toMatch(/Repaired GitHub Release/);
    const repaired = JSON.parse(readFileSync(statePath, "utf8")).release;
    expect(repaired.isDraft).toBe(false);
    expect(repaired.name).toBe("v0.18.0");
  });
});

describe.skipIf(process.platform === "win32")("local finalize transaction matching GitHub Actions commands", () => {
  it("runs decide-publish → ensure-release-tag → ensure-github-release in a temp repository", { timeout: 30000 }, () => {
    const root = track(mkdtempSync(join(tmpdir(), "finalize-txn-")));
    const remote = track(mkdtempSync(join(tmpdir(), "finalize-txn-remote-")));
    const bin = track(mkdtempSync(join(tmpdir(), "finalize-txn-bin-")));

    for (const path of [
      "scripts/release-recovery.mjs",
      "scripts/ensure-release-tag.mjs",
      "scripts/verify-published-package.mjs",
      "scripts/write-release-manifest.mjs",
      "scripts/package-resource-contract.mjs",
      ".release-policy.json",
      "package.json",
    ]) {
      const destination = join(root, path);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(sourceRoot, path), destination);
    }

    git(remote, "init", "--bare");
    git(root, "init");
    git(root, "config", "user.email", "release-test@example.invalid");
    git(root, "config", "user.name", "Release Test");
    writeFileSync(join(root, "CHANGELOG.md"), "## v0.18.0 (2026-07-14)\n\n- release\n");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    pkg.version = "0.18.0";
    writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    git(root, "add", ".");
    git(root, "commit", "-m", "chore(release): v0.18.0");
    const sha = git(root, "rev-parse", "HEAD");
    git(root, "remote", "add", "origin", remote);

    // npm: version already published (recovery / partial rerun path).
    writeStub(
      bin,
      "npm",
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"@0.18.0"* ]]; then
  echo "0.18.0"
  exit 0
fi
echo "0.18.0"
exit 0
`,
    );

    const releaseState = join(bin, "release-state.json");
    writeFileSync(releaseState, JSON.stringify({ exists: false }));
    writeGhStub(bin, releaseState);

    const githubOutput = join(bin, "github.output");
    writeFileSync(githubOutput, "");

    // Exact commands used by release.yml publish + finalize jobs.
    const decide = runNode(
      [
        script("scripts/release-recovery.mjs"),
        "decide-publish",
        "@groeponline/pi-agent-orchestrator",
        "0.18.0",
      ],
      { cwd: root, env: nodeEnv(bin, { GITHUB_OUTPUT: githubOutput }) },
    );
    expect(decide.status, decide.stderr).toBe(0);
    expect(readFileSync(githubOutput, "utf8")).toContain("publish=false");

    const tag = runNode([script("scripts/ensure-release-tag.mjs"), "v0.18.0", sha], {
      cwd: root,
      env: nodeEnv(bin),
    });
    expect(tag.status, tag.stderr).toBe(0);
    expect(git(root, "rev-list", "-n1", "v0.18.0")).toBe(sha);

    const release = runNode(
      [script("scripts/release-recovery.mjs"), "ensure-github-release", "v0.18.0", "v0.18.0"],
      { cwd: root, env: nodeEnv(bin) },
    );
    expect(release.status, release.stderr).toBe(0);
    expect(release.stdout).toMatch(/Created GitHub Release/);

    // Rerun after partial failure must stay idempotent.
    const decideAgain = runNode(
      [
        script("scripts/release-recovery.mjs"),
        "decide-publish",
        "@groeponline/pi-agent-orchestrator",
        "0.18.0",
      ],
      { cwd: root, env: nodeEnv(bin, { GITHUB_OUTPUT: githubOutput }) },
    );
    expect(decideAgain.status, decideAgain.stderr).toBe(0);
    const tagAgain = runNode([script("scripts/ensure-release-tag.mjs"), "v0.18.0", sha], {
      cwd: root,
      env: nodeEnv(bin),
    });
    expect(tagAgain.status, tagAgain.stderr).toBe(0);
    const releaseAgain = runNode(
      [script("scripts/release-recovery.mjs"), "ensure-github-release", "v0.18.0", "v0.18.0"],
      { cwd: root, env: nodeEnv(bin) },
    );
    expect(releaseAgain.status, releaseAgain.stderr).toBe(0);
    expect(releaseAgain.stdout).toMatch(/already exists with correct metadata/);
  });
});

describe("write-release-manifest and published verification helpers", () => {
  it("writes a release manifest from an npm pack report", async () => {
    const dir = track(mkdtempSync(join(tmpdir(), "manifest-")));
    cpSync(join(sourceRoot, "package.json"), join(dir, "package.json"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    cpSync(
      join(sourceRoot, "scripts/package-resource-contract.mjs"),
      join(dir, "scripts/package-resource-contract.mjs"),
    );
    cpSync(
      join(sourceRoot, "scripts/write-release-manifest.mjs"),
      join(dir, "scripts/write-release-manifest.mjs"),
    );
    writeFileSync(
      join(dir, "release-pack.json"),
      `${JSON.stringify([
        {
          filename: "groeponline-pi-agent-orchestrator-0.17.1.tgz",
          integrity: "sha512-testintegrity",
          files: [{ path: "dist/index.js" }],
        },
      ])}\n`,
    );
    const result = runNode(
      ["scripts/write-release-manifest.mjs", "release-pack.json", "release-manifest.json"],
      { cwd: dir },
    );
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(join(dir, "release-manifest.json"), "utf8"));
    expect(manifest.tarballFile).toBe("groeponline-pi-agent-orchestrator-0.17.1.tgz");
    expect(manifest.tarballIntegrity).toBe("sha512-testintegrity");
    expect(manifest.package.name).toBe("@groeponline/pi-agent-orchestrator");
  });

  it("verifies published metadata against the reviewed manifest", async () => {
    const { assertPublishedMatchesManifest } = await import("../scripts/verify-published-package.mjs");
    const expected = {
      package: {
        name: "@groeponline/pi-agent-orchestrator",
        version: "0.18.0",
        license: "MIT",
        engines: { node: ">=22.19.0" },
        peerDependencies: { "@earendil-works/pi-ai": ">=0.80.6" },
        pi: { extensions: ["./dist/index.js"] },
      },
      requiredFiles: ["dist/index.js", "README.md"],
      tarballIntegrity: "sha512-abc",
    };
    expect(
      assertPublishedMatchesManifest({
        expected,
        published: {
          ...expected.package,
          dist: { integrity: "sha512-abc" },
        },
        packed: {
          integrity: "sha512-abc",
          files: [{ path: "dist/index.js" }, { path: "README.md" }],
        },
      }).ok,
    ).toBe(true);

    expect(() =>
      assertPublishedMatchesManifest({
        expected,
        published: {
          ...expected.package,
          dist: { integrity: "sha512-wrong" },
        },
        packed: {
          integrity: "sha512-abc",
          files: [{ path: "dist/index.js" }, { path: "README.md" }],
        },
      }),
    ).toThrow(/dist\.integrity/);
  });
});
