import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNextPatchTransition, loadReleasePolicy } from "./release-policy.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", options.ignoreError ? "ignore" : "pipe"],
  }).trim();
}

function hasTag(tag) {
  try {
    git(["rev-parse", "--verify", `refs/tags/${tag}`]);
    return true;
  } catch {
    return false;
  }
}

function releaseSubjects(sourceVersion) {
  const range = hasTag(`v${sourceVersion}`) ? [`v${sourceVersion}..HEAD`] : ["-1", "HEAD"];
  const lines = git(["log", "--first-parent", "--pretty=%s", ...range]).split("\n");
  const unique = [];
  const seen = new Set();
  for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
    if (/^chore\(release\): v\d+\.\d+\.\d+$/.test(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    unique.push(line);
  }
  return unique;
}

async function main() {
  const [version, sourceVersion] = process.argv.slice(2);
  if (!version || !sourceVersion) {
    throw new Error("Usage: node scripts/generate-release-notes.mjs <version> <source-version>");
  }

  const policy = await loadReleasePolicy(ROOT);
  assertNextPatchTransition(sourceVersion, version, policy);
  const notesPath = resolve(ROOT, `docs/releases/v${version}.md`);

  const existing = await readFile(notesPath, "utf8").catch(() => "");
  if (existing.trim()) {
    console.log(`Keeping existing release notes: docs/releases/v${version}.md`);
    return;
  }
  const subjects = releaseSubjects(sourceVersion);
  const bullets = subjects.length > 0
    ? subjects.map((subject) => `- ${subject}`).join("\n")
    : "- Automated patch release of the current main state.";
  const content = `### Changes since v${sourceVersion}\n\n${bullets}\n`;

  await mkdir(dirname(notesPath), { recursive: true });
  await writeFile(notesPath, content);
  console.log(`Generated release notes: docs/releases/v${version}.md`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
