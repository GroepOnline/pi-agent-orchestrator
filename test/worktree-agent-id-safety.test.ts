import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupWorktree, createWorktree, pruneWorktrees } from "../src/worktree.js";

function initGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-agent-id-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# Test repo");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "pipe" });
  return dir;
}

describe("worktree agent ID safety", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = initGitRepo();
  });

  afterEach(async () => {
    try {
      await pruneWorktrees(repoDir);
    } catch {
      // Best-effort test cleanup.
    }
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("persists dirty traversal input to a valid branch without escaping tmpdir", async () => {
    const worktree = await createWorktree(repoDir, "../../etc/passwd");
    expect(worktree).toBeDefined();
    expect(resolve(worktree!.path).startsWith(resolve(tmpdir()))).toBe(true);
    expect(worktree!.branch).toBe("pi-agent-etc-passwd");

    writeFileSync(join(worktree!.path, "agent-output.txt"), "safe");
    const result = await cleanupWorktree(repoDir, worktree!, "validate sanitized agent ID");

    expect(result).toMatchObject({
      hasChanges: true,
      branch: "pi-agent-etc-passwd",
    });
    expect(result.path).toBeUndefined();

    execFileSync("git", ["check-ref-format", "--branch", result.branch!], {
      cwd: repoDir,
      stdio: "pipe",
    });
    execFileSync("git", ["branch", "-D", result.branch!], { cwd: repoDir, stdio: "pipe" });
  });
});
