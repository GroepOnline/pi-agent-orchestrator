/**
 * Tag-driven GitHub Release contract: tag vX.Y.Z == package.json version
 * and the tag commit must be an ancestor of origin/main.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseStableTag(tagName) {
  const match = /^v([0-9]+\.[0-9]+\.[0-9]+)$/.exec(String(tagName ?? ""));
  if (!match) {
    throw new Error(`tag ${JSON.stringify(tagName)} is not vX.Y.Z`);
  }
  return match[1];
}

export function assertTagMatchesPackage(tagName, packageVersion) {
  const tagVersion = parseStableTag(tagName);
  if (tagVersion !== packageVersion) {
    throw new Error(`tag ${tagName} does not match package version ${packageVersion}`);
  }
  return tagVersion;
}

export function assertCommitOnOriginMain({ commitSha, ancestorOfMain }) {
  if (!commitSha) throw new Error("commit SHA is missing");
  if (!ancestorOfMain) {
    throw new Error(`tag commit ${commitSha} is not on origin/main`);
  }
}

function git(args, { cwd = ROOT } = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function main() {
  const tagName = process.env.GITHUB_REF_NAME;
  const commitSha = process.env.GITHUB_SHA || git(["rev-parse", "HEAD"]);
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  assertTagMatchesPackage(tagName, pkg.version);
  git(["fetch", "--no-tags", "origin", "main"]);
  let ancestorOfMain = false;
  try {
    git(["merge-base", "--is-ancestor", commitSha, "origin/main"]);
    ancestorOfMain = true;
  } catch {
    ancestorOfMain = false;
  }
  assertCommitOnOriginMain({ commitSha, ancestorOfMain });
  console.log(`release tag contract OK (${tagName} == ${pkg.version}; ${commitSha} on origin/main)`);
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
