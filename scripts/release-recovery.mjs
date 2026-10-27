/**
 * Shared release recovery helpers: exact npm version gates and GitHub Release
 * metadata validation/repair. Invoked by unit tests and by release workflows.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function decideNpmPublish({ releaseVersion, exactVersion, latestVersion }) {
  const release = String(releaseVersion ?? "");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release)) {
    throw new Error(`expected stable release version, received ${JSON.stringify(releaseVersion)}`);
  }
  if (exactVersion != null && exactVersion !== "") {
    if (String(exactVersion) === release) {
      return { publish: false, reason: "exact-version-exists", message: `npm already contains ${release}; continuing recovery without republishing` };
    }
    throw new Error(`npm view returned unexpected exact version ${JSON.stringify(exactVersion)} for ${release}`);
  }
  if (latestVersion != null && latestVersion !== "") {
    const highest = [String(latestVersion), release].sort(compareSemver)[1];
    if (highest !== release) throw new Error(`Refusing to publish ${release} behind npm latest ${latestVersion}`);
  }
  return { publish: true, reason: "exact-version-absent", message: `npm does not contain ${release}; publish required` };
}

export function assertExactVersionAbsent({ releaseVersion, exactVersion }) {
  const decision = decideNpmPublish({ releaseVersion, exactVersion, latestVersion: null });
  if (!decision.publish) {
    throw new Error(`npm already contains ${releaseVersion}; use release recovery instead of preparing again`);
  }
}

function compareSemver(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function validateGitHubReleaseMetadata(release, expected) {
  const tagName = String(expected?.tagName ?? "");
  const title = String(expected?.name ?? tagName);
  if (!tagName) throw new Error("expected.tagName is required");
  if (!release || typeof release !== "object") throw new Error(`GitHub Release ${tagName} metadata is missing`);
  if (release.tagName !== tagName) {
    throw new Error(`GitHub Release tagName is ${JSON.stringify(release.tagName)}, expected ${JSON.stringify(tagName)}`);
  }
  const repairs = [];
  if (release.isDraft === true) repairs.push("draft");
  if (release.isPrerelease === true) repairs.push("prerelease");
  if (String(release.name ?? "") !== title) repairs.push("title");
  return { ok: repairs.length === 0, repairs, expected: { tagName, name: title, isDraft: false, isPrerelease: false } };
}

function isNpmNotFound(stderr, stdout) {
  const text = `${stderr}\n${stdout}`;
  return /E404|ETARGET|404 Not Found|is not in this registry|No match found for version/i.test(text);
}

function spawnErrorMessage(result, fallback) {
  if (result.error) return result.error.message || String(result.error);
  return String(result.stderr ?? "").trim() || String(result.stdout ?? "").trim() || fallback;
}

export function npmViewVersion(spec, { npmBin = "npm" } = {}) {
  const result = spawnSync(npmBin, ["view", spec, "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw new Error(`failed to spawn ${npmBin}: ${result.error.message}`);
  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? "");
  if (result.status !== 0) {
    if (isNpmNotFound(stderr, stdout)) return null;
    throw new Error(`npm view ${spec} version failed: ${spawnErrorMessage(result, `exit ${result.status}`)}`);
  }
  if (!stdout) throw new Error(`npm view ${spec} version returned empty output`);
  return stdout;
}

function writeGithubOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) {
    console.log(`${name}=${value}`);
    return;
  }
  appendFileSync(outputFile, `${name}=${value}\n`);
}

export function ensureGitHubRelease({ tagName, title = tagName, createIfMissing = true, ghBin = "gh" }) {
  const view = spawnSync(ghBin, ["release", "view", tagName, "--json", "tagName,isDraft,isPrerelease,name"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (view.error) throw new Error(`failed to spawn ${ghBin}: ${view.error.message}`);
  if (view.status !== 0) {
    if (!createIfMissing) throw new Error(`GitHub Release ${tagName} does not exist`);
    const created = spawnSync(ghBin, ["release", "create", tagName, "--verify-tag", "--generate-notes", "--title", title], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (created.error || created.status !== 0) throw new Error(spawnErrorMessage(created, "gh release create failed"));
    console.log(`Created GitHub Release ${tagName}`);
    return { created: true, repaired: false };
  }
  const release = JSON.parse(view.stdout);
  const result = validateGitHubReleaseMetadata(release, { tagName, name: title });
  if (result.repairs.length > 0) {
    const edited = spawnSync(ghBin, ["release", "edit", tagName, "--draft=false", "--prerelease=false", "--title", title], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (edited.error || edited.status !== 0) throw new Error(spawnErrorMessage(edited, "gh release edit failed"));
    console.log(`Repaired GitHub Release ${tagName} metadata: ${result.repairs.join(", ")}`);
    return { created: false, repaired: true, repairs: result.repairs };
  }
  console.log(`GitHub Release ${tagName} already exists with correct metadata.`);
  return { created: false, repaired: false };
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "check-exact") {
    const [packageName, releaseVersion] = args;
    if (!packageName || !releaseVersion) throw new Error("Usage: node scripts/release-recovery.mjs check-exact <package> <version>");
    const exactVersion = npmViewVersion(`${packageName}@${releaseVersion}`);
    const exists = exactVersion === releaseVersion;
    console.log(exists ? `Exact version exists on npm: ${packageName}@${releaseVersion}` : `Exact version absent on npm: ${packageName}@${releaseVersion}`);
    writeGithubOutput("exists", exists ? "true" : "false");
    return;
  }
  if (command === "assert-absent") {
    const [packageName, releaseVersion] = args;
    if (!packageName || !releaseVersion) throw new Error("Usage: node scripts/release-recovery.mjs assert-absent <package> <version>");
    const exactVersion = npmViewVersion(`${packageName}@${releaseVersion}`);
    assertExactVersionAbsent({ releaseVersion, exactVersion });
    console.log(`Exact version absent on npm: ${packageName}@${releaseVersion}`);
    return;
  }
  if (command === "decide-publish") {
    const [packageName, releaseVersion] = args;
    if (!packageName || !releaseVersion) throw new Error("Usage: node scripts/release-recovery.mjs decide-publish <package> <version>");
    const exactVersion = npmViewVersion(`${packageName}@${releaseVersion}`);
    const latestVersion = npmViewVersion(packageName);
    const decision = decideNpmPublish({ releaseVersion, exactVersion, latestVersion });
    console.log(decision.message);
    writeGithubOutput("publish", decision.publish ? "true" : "false");
    return;
  }
  if (command === "ensure-github-release") {
    const [tagName, title = tagName] = args;
    if (!tagName) throw new Error("Usage: node scripts/release-recovery.mjs ensure-github-release <tag> [title]");
    ensureGitHubRelease({ tagName, title });
    return;
  }
  throw new Error(`Unknown command ${JSON.stringify(command)}. Expected check-exact | assert-absent | decide-publish | ensure-github-release`);
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
