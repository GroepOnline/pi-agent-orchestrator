import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReleaseCandidate, loadReleasePolicy } from "./release-policy.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED_FILES = ["CHANGELOG.md", "package-lock.json", "package.json"];
const PROMO_DATA_PATH = "showcase/remotion/public/promo-data.json";
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
  throw new Error(`Release transaction violation: ${message}`);
}

function normalizeLineEndings(value) {
  return value.replace(/\r\n?/g, "\n");
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function readAt(ref, path) {
  return git(["show", `${ref}:${path}`]);
}

function existsAt(ref, path) {
  try {
    execFileSync("git", ["cat-file", "-e", `${ref}:${path}`], {
      cwd: ROOT,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
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

function sameJson(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

async function verify(parentRef, releaseRef, expectedVersion) {
  const policy = await loadReleasePolicy(ROOT);
  assertReleaseCandidate(expectedVersion, policy);

  const parentHasPromoData = existsAt(parentRef, PROMO_DATA_PATH);
  const expectedFiles = parentHasPromoData
    ? [...ALLOWED_FILES, PROMO_DATA_PATH]
    : ALLOWED_FILES;
  const changed = git(["diff", "--name-only", parentRef, releaseRef])
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
  if (!sameJson(changed, [...expectedFiles].sort())) {
    const additionalRequirement = parentHasPromoData
      ? `; required additional file ${PROMO_DATA_PATH}`
      : "";
    fail(
      `changed files must be exactly ${ALLOWED_FILES.join(", ")}; received ${changed.join(", ")}${additionalRequirement}`,
    );
  }

  const parentPackage = JSON.parse(readAt(parentRef, "package.json"));
  const releasePackage = JSON.parse(readAt(releaseRef, "package.json"));
  if (!policy.sourceBaselines.includes(parentPackage.version)) {
    fail(`parent package version ${parentPackage.version} is not an approved source baseline`);
  }
  if (releasePackage.version !== expectedVersion) {
    fail(`release package version ${releasePackage.version} does not equal ${expectedVersion}`);
  }
  const normalizedParentPackage = { ...parentPackage, version: expectedVersion };
  if (!sameJson(normalizedParentPackage, releasePackage)) {
    fail("package.json changed fields other than version");
  }

  const parentLock = JSON.parse(readAt(parentRef, "package-lock.json"));
  const releaseLock = JSON.parse(readAt(releaseRef, "package-lock.json"));
  const releaseRoot = releaseLock.packages?.[""];
  if (!releaseRoot) fail("release package-lock is missing packages[''] metadata");
  if (releaseLock.version !== expectedVersion || releaseRoot.version !== expectedVersion) {
    fail("release package-lock versions do not equal the release version");
  }
  for (const field of ROOT_LOCK_FIELDS) {
    if (!sameJson(releaseRoot[field], releasePackage[field])) {
      fail(`release package-lock root field ${field} does not match package.json`);
    }
  }

  const normalizedParentLock = cloneJson(parentLock);
  const normalizedReleaseLock = cloneJson(releaseLock);
  normalizedParentLock.version = expectedVersion;
  normalizedReleaseLock.version = expectedVersion;
  delete normalizedParentLock.packages[""];
  delete normalizedReleaseLock.packages[""];
  if (!sameJson(normalizedParentLock, normalizedReleaseLock)) {
    fail("package-lock changed outside top-level version and packages[''] root metadata");
  }

  const parentChangelog = readAt(parentRef, "CHANGELOG.md");
  const releaseChangelog = readAt(releaseRef, "CHANGELOG.md");
  if (parentChangelog.includes(`## v${expectedVersion} (`)) {
    fail(`parent CHANGELOG already contains v${expectedVersion}`);
  }
  const historyMarker = "## v0.17.1 ";
  const parentHistory = parentChangelog.indexOf(historyMarker);
  const releaseHistory = releaseChangelog.indexOf(historyMarker);
  if (parentHistory < 0 || releaseHistory < 0) fail("CHANGELOG history marker v0.17.1 is missing");
  if (parentChangelog.slice(parentHistory) !== releaseChangelog.slice(releaseHistory)) {
    fail("CHANGELOG history from v0.17.1 backwards was modified");
  }
  const datedHeader = new RegExp(
    `^## v${expectedVersion.replaceAll(".", "\\.")} \\((\\d{4}-\\d{2}-\\d{2})\\)$`,
    "m",
  );
  const datedHeaderMatch = releaseChangelog.match(datedHeader);
  if (!datedHeaderMatch) fail(`release CHANGELOG lacks a dated v${expectedVersion} heading`);
  const notes = normalizeLineEndings(
    await readFile(resolve(ROOT, `docs/releases/v${expectedVersion}.md`), "utf8"),
  ).trim();
  if (!notes || !releaseChangelog.includes(notes)) fail("release CHANGELOG does not contain the canonical release notes template");

  if (parentHasPromoData) {
    const parentPromoData = JSON.parse(readAt(parentRef, PROMO_DATA_PATH));
    const releasePromoData = JSON.parse(readAt(releaseRef, PROMO_DATA_PATH));
    if (parentPromoData.version !== parentPackage.version) {
      fail(`parent ${PROMO_DATA_PATH} version does not match parent package.json`);
    }
    if (releasePromoData.version !== expectedVersion) {
      fail(`release ${PROMO_DATA_PATH} version does not equal ${expectedVersion}`);
    }
    const expectedGeneratedAt = `${datedHeaderMatch[1]}T00:00:00.000Z`;
    if (releasePromoData.generatedAt !== expectedGeneratedAt) {
      fail(`release ${PROMO_DATA_PATH} generatedAt must equal ${expectedGeneratedAt}`);
    }
    const normalizedParentPromoData = cloneJson(parentPromoData);
    normalizedParentPromoData.version = expectedVersion;
    normalizedParentPromoData.generatedAt = expectedGeneratedAt;
    if (!sameJson(normalizedParentPromoData, releasePromoData)) {
      fail(`${PROMO_DATA_PATH} changed fields other than version and generatedAt`);
    }
  }

  console.log(`Release transaction verified: ${parentRef} -> ${releaseRef} as v${expectedVersion}`);
}

const [parentRef, releaseRef, expectedVersion] = process.argv.slice(2);
if (!parentRef || !releaseRef || !expectedVersion) {
  console.error("Usage: node scripts/verify-release-transaction.mjs <parent-ref> <release-ref> <version>");
  process.exitCode = 2;
} else {
  verify(parentRef, releaseRef, expectedVersion).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
