import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadReleasePolicy, nextPatchVersion } from "./release-policy.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function writeOutput(name, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `${name}=${value}\n`);
  else console.log(`${name}=${value}`);
}

function headSubject() {
  return execFileSync("git", ["log", "-1", "--pretty=%s"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
}

async function main() {
  const pkg = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));
  const policy = await loadReleasePolicy(ROOT);
  const current = pkg.version;
  const subject = headSubject();
  if (subject === `chore(release): v${current}`) {
    writeOutput("should_prepare", "false");
    writeOutput("reason", "canonical-release-commit");
    writeOutput("source_version", current);
    return;
  }

  const version = nextPatchVersion(current, policy);
  writeOutput("should_prepare", "true");
  writeOutput("reason", "main-advanced");
  writeOutput("source_version", current);
  writeOutput("version", version);
  writeOutput("branch", `release/v${version}`);
  writeOutput("title", `chore(release): v${version}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
