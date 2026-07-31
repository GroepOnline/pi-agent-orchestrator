import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ROOT_LOCK_FIELDS = [
  "name",
  "version",
  "license",
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "engines",
];

function fail(message) {
  throw new Error(`Release policy violation: ${message}`);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

export function sameJson(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

export function parseStableVersion(value) {
  const match = STABLE_SEMVER.exec(String(value ?? ""));
  if (!match) fail(`expected a stable x.y.z version, received ${JSON.stringify(value)}`);
  return {
    raw: match[0],
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareVersions(left, right) {
  const a = typeof left === "string" ? parseStableVersion(left) : left;
  const b = typeof right === "string" ? parseStableVersion(right) : right;
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export async function loadReleasePolicy(root = ROOT) {
  const policy = JSON.parse(await readFile(resolve(root, ".release-policy.json"), "utf8"));
  if (policy.schemaVersion !== 1) fail("unsupported .release-policy.json schemaVersion");
  if (!/^\d+\.\d+$/.test(policy.releaseTrain ?? "")) fail("releaseTrain must be major.minor");
  parseStableVersion(policy.initialRelease);
  parseStableVersion(policy.blockedNextMinor);
  if (!Array.isArray(policy.sourceBaselines) || policy.sourceBaselines.length === 0) {
    fail("sourceBaselines must contain at least one pre-release source version");
  }
  for (const version of policy.sourceBaselines) parseStableVersion(version);
  return policy;
}

export function assertReleaseCandidate(version, policy) {
  const parsed = parseStableVersion(version);
  const [trainMajor, trainMinor] = policy.releaseTrain.split(".").map(Number);
  const initial = parseStableVersion(policy.initialRelease);
  const blocked = parseStableVersion(policy.blockedNextMinor);

  if (policy.allowPrerelease !== false) fail("allowPrerelease must remain false for the 0.18 stabilization release");
  if (parsed.major !== trainMajor || parsed.minor !== trainMinor) {
    fail(`${version} is outside the locked ${policy.releaseTrain}.x release train; ${policy.blockedNextMinor} remains blocked`);
  }
  if (compareVersions(parsed, initial) < 0) fail(`${version} is older than initial release ${policy.initialRelease}`);
  if (compareVersions(parsed, blocked) >= 0) fail(`${version} reaches or exceeds blocked version ${policy.blockedNextMinor}`);
  return parsed;
}

/** Pre-train maintenance baselines (e.g. 0.17.5) listed in sourceBaselines. */
export function assertMaintenanceBaseline(version, policy) {
  const parsed = parseStableVersion(version);
  const initial = parseStableVersion(policy.initialRelease);
  if (!policy.sourceBaselines.includes(parsed.raw)) {
    fail(`${version} is not an approved maintenance baseline in sourceBaselines`);
  }
  if (compareVersions(parsed, initial) >= 0) {
    fail(`${version} is not a maintenance baseline; use the ${policy.releaseTrain}.x release train instead`);
  }
  return parsed;
}

export async function verifyRepositoryReleaseState(root = ROOT, options = {}) {
  const { requireCandidate = false } = options;
  const policy = await loadReleasePolicy(root);
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
  const rootLock = lock.packages?.[""];

  if (pkg.name !== policy.packageName) fail(`package name must remain ${policy.packageName}`);
  if (!rootLock) fail("package-lock is missing packages[''] root metadata");
  if (lock.name !== pkg.name || rootLock.name !== pkg.name) {
    fail("package-lock package names do not match package.json");
  }
  if (lock.version !== pkg.version || rootLock.version !== pkg.version) {
    fail("package.json and both package-lock root versions must match");
  }

  parseStableVersion(pkg.version);
  const isBaseline = policy.sourceBaselines.includes(pkg.version);
  if (requireCandidate || !isBaseline) {
    assertReleaseCandidate(pkg.version, policy);
    for (const field of ROOT_LOCK_FIELDS) {
      if (!sameJson(rootLock[field], pkg[field])) {
        fail(`package-lock root field ${field} does not match package.json for a release candidate`);
      }
    }
  }

  const changelog = await readFile(resolve(root, "CHANGELOG.md"), "utf8");
  const releaseHeader = new RegExp(`^## v${policy.initialRelease.replaceAll(".", "\\.")} \\((?:UNRELEASED|\\d{4}-\\d{2}-\\d{2})\\)$`, "m");
  const templateExists = await readFile(resolve(root, `docs/releases/v${policy.initialRelease}.md`), "utf8")
    .then((content) => content.trim().length > 0)
    .catch(() => false);
  if (!releaseHeader.test(changelog) && !templateExists) {
    fail(`missing CHANGELOG entry or release template for v${policy.initialRelease}`);
  }
  if (requireCandidate && !releaseHeader.test(changelog)) {
    fail(`publish state requires a finalized dated CHANGELOG entry for v${policy.initialRelease}`);
  }

  return { policy, packageVersion: pkg.version, isBaseline };
}

async function main() {
  const mode = process.argv[2] ?? "repository";
  if (mode === "candidate") {
    const version = process.argv[3];
    const policy = await loadReleasePolicy();
    assertReleaseCandidate(version, policy);
    console.log(`Release candidate accepted: ${version} within ${policy.releaseTrain}.x`);
    return;
  }
  if (mode === "publish") {
    const result = await verifyRepositoryReleaseState(ROOT, { requireCandidate: true });
    console.log(
      `Publish policy ready: package=${result.packageVersion}, train=${result.policy.releaseTrain}.x, blocked=${result.policy.blockedNextMinor}`,
    );
    return;
  }
  if (mode === "baseline") {
    const version = process.argv[3];
    const policy = await loadReleasePolicy();
    assertMaintenanceBaseline(version, policy);
    const pkg = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));
    if (pkg.version !== version) {
      fail(`package.json version ${pkg.version} does not match requested baseline ${version}`);
    }
    const changelog = await readFile(resolve(ROOT, "CHANGELOG.md"), "utf8");
    const datedHeader = new RegExp(`^## v${String(version).replaceAll(".", "\\.")} \\(\\d{4}-\\d{2}-\\d{2}\\)$`, "m");
    if (!datedHeader.test(changelog)) {
      fail(`CHANGELOG lacks a dated v${version} heading required for maintenance publish`);
    }
    await verifyRepositoryReleaseState(ROOT);
    console.log(`Maintenance baseline accepted for publish: ${version}`);
    return;
  }
  if (mode !== "repository") fail(`unknown mode ${JSON.stringify(mode)}`);
  const result = await verifyRepositoryReleaseState();
  console.log(
    `Release policy ready: package=${result.packageVersion}, train=${result.policy.releaseTrain}.x, blocked=${result.policy.blockedNextMinor}`,
  );
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
