import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertVersionAvailable, versionReuseFailures } from "../scripts/check-version-reuse.mjs";
import { assertCommitOnOriginMain, assertTagMatchesPackage, parseStableTag } from "../scripts/verify-release-tag.mjs";
import {
  formatRuntimeIdentity,
  readPackageVersion,
  readSourceSha,
} from "../src/runtime-identity.js";

const sandboxes: string[] = [];

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "pi-identity-"));
  sandboxes.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("runtime identity", () => {
  it("reads the package version and treats a missing build stamp as null", () => {
    const dir = sandbox();
    const pkg = join(dir, "package.json");
    const stamp = join(dir, "build-stamp.json");
    writeFileSync(pkg, `${JSON.stringify({ name: "x", version: "1.2.3" })}\n`);
    expect(readPackageVersion(pkg)).toBe("1.2.3");
    expect(readSourceSha({}, stamp)).toBeNull();
    expect(formatRuntimeIdentity({}, pkg, stamp)).toBe("1.2.3");
  });

  it("prefers an explicit build-stamp SHA and ignores an empty env override", () => {
    const dir = sandbox();
    const pkg = join(dir, "package.json");
    const stamp = join(dir, "build-stamp.json");
    writeFileSync(pkg, `${JSON.stringify({ version: "0.19.2" })}\n`);
    writeFileSync(stamp, `${JSON.stringify({ sha: "abc123def" })}\n`);
    expect(readSourceSha({}, stamp)).toBe("abc123def");
    expect(readSourceSha({ PI_ORCHESTRATOR_BUILD_SHA: "" }, stamp)).toBeNull();
    expect(formatRuntimeIdentity({ PI_ORCHESTRATOR_BUILD_SHA: "deadbeef" }, pkg, stamp)).toBe(
      "0.19.2 (deadbeef)",
    );
  });
});

describe("release tag contract helpers", () => {
  it("accepts only vX.Y.Z tags that match the package version", () => {
    expect(parseStableTag("v0.19.2")).toBe("0.19.2");
    expect(assertTagMatchesPackage("v0.19.2", "0.19.2")).toBe("0.19.2");
    expect(() => parseStableTag("0.19.2")).toThrow(/not vX\.Y\.Z/);
    expect(() => assertTagMatchesPackage("v0.19.2", "0.19.1")).toThrow(/does not match/);
  });

  it("rejects a tag commit that is not on origin/main", () => {
    expect(() => assertCommitOnOriginMain({ commitSha: "", ancestorOfMain: true })).toThrow(/missing/);
    expect(() =>
      assertCommitOnOriginMain({ commitSha: "abc", ancestorOfMain: false }),
    ).toThrow(/not on origin\/main/);
  });

  it("fails when the package version already has a tag or Release", () => {
    expect(versionReuseFailures({ version: "0.19.2", tags: [], releases: [] })).toEqual([]);
    expect(versionReuseFailures({ version: "0.19.1", tags: ["v0.19.1"], releases: [] })).toEqual([
      "tag v0.19.1 already exists",
    ]);
    expect(() =>
      assertVersionAvailable({ version: "0.19.1", tags: [], releases: ["v0.19.1"] }),
    ).toThrow(/already has a Release\/tag/);
  });
});
