import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNextPatchTransition, compareVersions, loadReleasePolicy, parseStableVersion } from "./release-policy.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error(`Version transition violation: ${message}`);
}

function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function packageVersion(ref) {
  const pkg = JSON.parse(git(["show", `${ref}:package.json`]));
  return pkg.version;
}

function isMaintenanceBaselineBump(baseVersion, headVersion, policy) {
  const base = parseStableVersion(baseVersion);
  const head = parseStableVersion(headVersion);
  const initial = parseStableVersion(policy.initialRelease);
  const [trainMajor, trainMinor] = String(policy.releaseTrain).split(".").map(Number);
  if (base.major !== head.major || base.minor !== head.minor) return false;
  if (head.major !== trainMajor || head.minor !== trainMinor - 1) return false;
  if (compareVersions(head, base) <= 0) return false;
  if (compareVersions(head, initial) >= 0) return false;
  if (!policy.sourceBaselines.includes(baseVersion)) return false;
  if (!policy.sourceBaselines.includes(headVersion)) {
    fail(`maintenance bump ${baseVersion} -> ${headVersion} requires ${headVersion} in sourceBaselines`);
  }
  return true;
}

async function verify(baseRef, headRef, branchName) {
  const policy = await loadReleasePolicy(ROOT);
  const baseVersion = packageVersion(baseRef);
  const headVersion = packageVersion(headRef);
  if (baseVersion === headVersion) {
    console.log(`No package version transition: ${headVersion}`);
    return;
  }
  if (isMaintenanceBaselineBump(baseVersion, headVersion, policy)) {
    console.log(`Maintenance baseline transition verified: ${baseVersion} -> ${headVersion} on ${branchName}`);
    return;
  }

  const expectedBranch = `release/v${headVersion}`;
  if (branchName !== expectedBranch) {
    fail(`version changes are allowed only on ${expectedBranch}, received ${branchName}`);
  }
  try {
    assertNextPatchTransition(baseVersion, headVersion, policy);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const commitCount = Number(git(["rev-list", "--count", `${baseRef}..${headRef}`]));
  if (commitCount !== 1) fail(`release transition must contain exactly one commit, received ${commitCount}`);
  const subject = git(["log", "-1", "--pretty=%s", headRef]);
  const expectedTitle = `chore(release): v${headVersion}`;
  if (subject !== expectedTitle) fail(`release commit title must be ${expectedTitle}, received ${subject}`);

  const transaction = spawnSync(
    process.execPath,
    ["scripts/verify-release-transaction.mjs", baseRef, headRef, headVersion],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (transaction.status !== 0) {
    fail(transaction.stderr.trim() || transaction.stdout.trim() || "semantic transaction verifier failed");
  }
  console.log(`Version transition verified: ${baseVersion} -> ${headVersion} on ${branchName}`);
}

const [baseRef, headRef, branchName] = process.argv.slice(2);
if (!baseRef || !headRef || !branchName) {
  console.error("Usage: node scripts/verify-version-transition.mjs <base-ref> <head-ref> <branch-name>");
  process.exitCode = 2;
} else {
  verify(baseRef, headRef, branchName).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
