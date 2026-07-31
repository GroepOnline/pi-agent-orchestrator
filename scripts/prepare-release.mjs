import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReleaseCandidate, loadReleasePolicy, sameJson } from "./release-policy.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
  throw new Error(`Release preparation failed: ${message}`);
}

function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizeLineEndings(value) {
  return value.replace(/\r\n?/g, "\n");
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function validateDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`invalid release date ${JSON.stringify(value)}`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    fail(`invalid calendar date ${JSON.stringify(value)}`);
  }
  return value;
}

async function prepareRelease(version, releaseDate) {
  const policy = await loadReleasePolicy(ROOT);
  assertReleaseCandidate(version, policy);
  if (version !== policy.initialRelease) {
    fail(`the release button is intentionally pinned to ${policy.initialRelease}; patch releases require a separate reviewed workflow change`);
  }

  const packagePath = resolve(ROOT, "package.json");
  const lockPath = resolve(ROOT, "package-lock.json");
  const changelogPath = resolve(ROOT, "CHANGELOG.md");
  const notesPath = resolve(ROOT, `docs/releases/v${version}.md`);

  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  if (!policy.sourceBaselines.includes(pkg.version)) {
    fail(`expected a source baseline (${policy.sourceBaselines.join(", ")}), found ${pkg.version}`);
  }
  if (lock.version !== pkg.version || lock.packages?.[""]?.version !== pkg.version) {
    fail("package-lock versions are not synchronized before release preparation");
  }
  if (!lock.packages?.[""]) fail("package-lock is missing packages[''] root metadata");

  const changelog = normalizeLineEndings(await readFile(changelogPath, "utf8"));
  if (new RegExp(`^## v${version.replaceAll(".", "\\.")} \\(`, "m").test(changelog)) {
    fail(`CHANGELOG already contains v${version}`);
  }
  const unreleasedHeading = "## [Unreleased]";
  const unreleasedStart = changelog.indexOf(unreleasedHeading);
  if (unreleasedStart < 0) fail("CHANGELOG is missing the [Unreleased] heading");
  const separator = "\n---\n";
  const separatorStart = changelog.indexOf(separator, unreleasedStart);
  if (separatorStart < 0) fail("CHANGELOG [Unreleased] section has no terminating separator");

  const prefix = changelog.slice(0, unreleasedStart);
  const unreleasedBody = changelog
    .slice(unreleasedStart + unreleasedHeading.length, separatorStart)
    .trim();
  const history = changelog.slice(separatorStart + separator.length).replace(/^\s+/, "");
  const releaseNotes = normalizeLineEndings(await readFile(notesPath, "utf8")).trim();
  if (!releaseNotes) fail(`release notes template ${notesPath} is empty`);

  const additionalChanges = unreleasedBody
    ? `\n\n### Additional changes since v0.17.1\n\n${unreleasedBody}`
    : "";
  const nextChangelog = `${prefix}${unreleasedHeading}\n\nNo unreleased changes. The repository remains locked to the 0.18.x stabilization train.\n\n---\n\n## v${version} (${releaseDate})\n\n${releaseNotes}${additionalChanges}\n\n---\n\n${history}`;

  pkg.version = version;
  lock.version = version;
  for (const field of ROOT_LOCK_FIELDS) {
    const value = field === "version" ? version : pkg[field];
    if (value === undefined) {
      delete lock.packages[""][field];
    } else if (field === "version" || !sameJson(lock.packages[""][field], value)) {
      lock.packages[""][field] = cloneJson(value);
    }
  }

  await writeFile(packagePath, formatJson(pkg));
  await writeFile(lockPath, formatJson(lock));
  await writeFile(changelogPath, nextChangelog);
  console.log(`Prepared v${version} for ${releaseDate} with synchronized package-lock root metadata`);
}

const version = process.argv[2];
const releaseDate = validateDate(process.argv[3] ?? new Date().toISOString().slice(0, 10));
prepareRelease(version, releaseDate).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
