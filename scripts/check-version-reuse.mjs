/**
 * Fail when package.json version already has a git tag or GitHub Release.
 * Prevents silently reusing a published version on a later bump PR.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function versionReuseFailures({ version, tags, releases }) {
  const tag = `v${version}`;
  const failures = [];
  if (tags.includes(tag)) failures.push(`tag ${tag} already exists`);
  if (releases.includes(tag)) failures.push(`GitHub Release ${tag} already exists`);
  return failures;
}

export function assertVersionAvailable({ version, tags, releases }) {
  const failures = versionReuseFailures({ version, tags, releases });
  if (failures.length > 0) {
    throw new Error(
      `package version ${version} already has a Release/tag (${failures.join("; ")}); bump the version instead of reusing it`,
    );
  }
}

function gitRemote() {
  const configured = process.env.VERSION_REUSE_GIT_REMOTE;
  return configured && configured.trim() !== "" ? configured.trim() : "origin";
}

function listRemoteTags(version, { gitBin = "git" } = {}) {
  const tag = `v${version}`;
  const result = spawnSync(gitBin, ["ls-remote", "--tags", gitRemote(), `refs/tags/${tag}`], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new Error(`failed to spawn ${gitBin}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `git ls-remote failed (${result.status})`).trim());
  }
  return String(result.stdout || "").trim() ? [tag] : [];
}

function listGitHubReleases(version, { ghBin = "gh" } = {}) {
  const tag = `v${version}`;
  const repo = process.env.GITHUB_REPOSITORY;
  const args = ["release", "view", tag, "--json", "tagName"];
  if (repo) args.push("--repo", repo);
  const result = spawnSync(ghBin, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new Error(`failed to spawn ${ghBin}: ${result.error.message}`);
  if (result.status === 0) return [tag];
  const text = `${result.stderr}\n${result.stdout}`;
  if (/release not found|HTTP 404|Not Found/i.test(text)) return [];
  throw new Error(String(result.stderr || result.stdout || `gh release view failed (${result.status})`).trim());
}

function main() {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  const version = pkg.version;
  const tags = listRemoteTags(version);
  const releases = listGitHubReleases(version);
  assertVersionAvailable({ version, tags, releases });
  console.log(`package version ${version} is not yet tagged or released`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
