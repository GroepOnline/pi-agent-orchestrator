import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PACKAGE_JSON = join(HERE, "..", "package.json");
const DEFAULT_STAMP = join(HERE, "build-stamp.json");

export function readPackageVersion(packageJsonPath = DEFAULT_PACKAGE_JSON): string {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  const version = typeof pkg.version === "string" ? pkg.version.trim() : "";
  if (!version) {
    throw new Error("package.json version is missing");
  }
  return version;
}

export function readSourceSha(
  env: NodeJS.ProcessEnv = process.env,
  stampPath = DEFAULT_STAMP,
): string | null {
  const fromEnv = env.PI_ORCHESTRATOR_BUILD_SHA;
  if (fromEnv != null) {
    const sha = String(fromEnv).trim();
    return sha === "" ? null : sha;
  }
  try {
    const stamp = JSON.parse(readFileSync(stampPath, "utf8")) as { sha?: unknown };
    const sha = typeof stamp.sha === "string" ? stamp.sha.trim() : "";
    return sha === "" ? null : sha;
  } catch {
    return null;
  }
}

export function formatRuntimeIdentity(
  env: NodeJS.ProcessEnv = process.env,
  packageJsonPath = DEFAULT_PACKAGE_JSON,
  stampPath = DEFAULT_STAMP,
): string {
  const version = readPackageVersion(packageJsonPath);
  const sha = readSourceSha(env, stampPath);
  return sha ? `${version} (${sha})` : version;
}
