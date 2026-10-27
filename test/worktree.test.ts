import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupWorktree, createWorktree, pruneWorktrees } from "../src/worktree.js";

function initGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-test-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# Test repo");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "pipe" });
  return dir;
}

function removeWorktree(repoDir: string, path: string): void {
  try {
    execFileSync("git", ["worktree", "remove", "--force", path], {
      cwd: repoDir,
      stdio: "pipe",
    });
  } catch {
    // Best-effort test cleanup.
  }
}

function removeBranch(repoDir: string, branch: string | undefined): void {
  if (!branch) return;
  try {
    execFileSync("git", ["branch", "-D", branch], { cwd: repoDir, stdio: "pipe" });
  } catch {
    // Best-effort test cleanup.
  }
}

describe("worktree", () => {
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

  describe("createWorktree", () => {
    it("normalizes traversal input to a confined path and valid branch", async () => {
      const worktree = await createWorktree(repoDir, "../../etc/passwd");
      expect(worktree).toBeDefined();
      expect(resolve(worktree!.path).startsWith(resolve(tmpdir()))).toBe(true);
      expect(worktree!.branch).toBe("pi-agent-etc-passwd");
      expect(worktree!.branch).not.toMatch(/\.\./);
      execFileSync("git", ["check-ref-format", "--branch", worktree!.branch], {
        cwd: repoDir,
        stdio: "pipe",
      });
      removeWorktree(repoDir, worktree!.path);
    });

    it("creates a detached worktree in tmpdir", async () => {
      const worktree = await createWorktree(repoDir, "test-id-1");
      expect(worktree).toBeDefined();
      expect(existsSync(worktree!.path)).toBe(true);
      expect(worktree!.branch).toBe("pi-agent-test-id-1");
      expect(existsSync(join(worktree!.path, "README.md"))).toBe(true);
      removeWorktree(repoDir, worktree!.path);
    });

    it("returns undefined outside a git repository", async () => {
      const nonGit = mkdtempSync(join(tmpdir(), "pi-wt-nongit-"));
      try {
        expect(await createWorktree(nonGit, "test-id-2")).toBeUndefined();
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
      }
    });

    it("returns undefined for a repository without commits", async () => {
      const emptyRepo = mkdtempSync(join(tmpdir(), "pi-wt-empty-"));
      try {
        execFileSync("git", ["init"], { cwd: emptyRepo, stdio: "pipe" });
        expect(await createWorktree(emptyRepo, "no-commits")).toBeUndefined();
      } finally {
        rmSync(emptyRepo, { recursive: true, force: true });
      }
    });

    it("uses unique paths for concurrent worktrees", async () => {
      const first = await createWorktree(repoDir, "multi-1");
      const second = await createWorktree(repoDir, "multi-2");
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(first!.path).not.toBe(second!.path);
      removeWorktree(repoDir, first!.path);
      removeWorktree(repoDir, second!.path);
    });

    it.each([
      ["empty string", "", "unknown"],
      ["null runtime bypass", null, "unknown"],
      ["undefined runtime bypass", undefined, "unknown"],
      ["number runtime bypass", 42, "unknown"],
      ["path separators only", "///", "unknown"],
      ["special characters only", "~~~", "unknown"],
      ["whitespace and controls", " \t\n ", "unknown"],
      ["spaces and punctuation", "My Agent!123", "My-Agent-123"],
      ["edge punctuation", "$$$abc$$$", "abc"],
      ["backslash traversal", "..\\..\\windows", "windows"],
      ["unicode prefix", "😀-agent", "agent"],
      ["accent normalization", "déploiement", "deploiement"],
    ])("normalizes %s", async (_name, input, expectedSuffix) => {
      const worktree = await createWorktree(repoDir, input as string);
      expect(worktree).toBeDefined();
      expect(worktree!.branch).toBe(`pi-agent-${expectedSuffix}`);
      expect(resolve(worktree!.path).startsWith(resolve(tmpdir()))).toBe(true);
      execFileSync("git", ["check-ref-format", "--branch", worktree!.branch], {
        cwd: repoDir,
        stdio: "pipe",
      });
      removeWorktree(repoDir, worktree!.path);
    });

    it("truncates identifiers to 64 normalized characters", async () => {
      const worktree = await createWorktree(repoDir, "a".repeat(100));
      expect(worktree).toBeDefined();
      expect(worktree!.branch).toBe(`pi-agent-${"a".repeat(64)}`);
      expect(worktree!.path).toContain(`pi-agent-${"a".repeat(64)}-`);
      removeWorktree(repoDir, worktree!.path);
    });

    it("rejects traversal and shell syntax from the exposed branch", async () => {
      const worktree = await createWorktree(repoDir, "../../../tmp/pwned; rm -rf ~");
      expect(worktree).toBeDefined();
      expect(worktree!.branch).toBe("pi-agent-tmp-pwned-rm-rf");
      expect(worktree!.branch).not.toMatch(/[\\/;~]/);
      expect(worktree!.branch).not.toMatch(/\.\./);
      execFileSync("git", ["check-ref-format", "--branch", worktree!.branch], {
        cwd: repoDir,
        stdio: "pipe",
      });
      removeWorktree(repoDir, worktree!.path);
    });
  });

  describe("cleanupWorktree", () => {
    it("removes a clean worktree", async () => {
      const worktree = (await createWorktree(repoDir, "clean-1"))!;
      const result = await cleanupWorktree(repoDir, worktree, "test cleanup");
      expect(result).toEqual({ hasChanges: false });
      expect(existsSync(worktree.path)).toBe(false);
    });

    it("commits changes, creates the branch, and removes the worktree", async () => {
      const worktree = (await createWorktree(repoDir, "dirty-1"))!;
      writeFileSync(join(worktree.path, "new-file.txt"), "agent wrote this");

      const result = await cleanupWorktree(repoDir, worktree, "added new file");
      expect(result).toEqual({ hasChanges: true, branch: "pi-agent-dirty-1" });
      expect(existsSync(worktree.path)).toBe(false);

      const branches = execFileSync("git", ["branch", "--list", result.branch!], {
        cwd: repoDir,
        stdio: "pipe",
      }).toString();
      expect(branches).toContain(result.branch!);

      const log = execFileSync("git", ["log", "--oneline", "-1", result.branch!], {
        cwd: repoDir,
        stdio: "pipe",
      }).toString();
      expect(log).toContain("pi-agent: added new file");
      removeBranch(repoDir, result.branch);
    });

    it("preserves dirty work when staging fails", async () => {
      const worktree = (await createWorktree(repoDir, "stage-failure"))!;
      const changedFile = join(worktree.path, "important-agent-work.txt");
      writeFileSync(changedFile, "must not be deleted");
      const indexLock = execFileSync("git", ["rev-parse", "--git-path", "index.lock"], {
        cwd: worktree.path,
        stdio: "pipe",
      }).toString().trim();
      writeFileSync(indexLock, "held by test");

      const result = await cleanupWorktree(repoDir, worktree, "should be recoverable");
      expect(result).toMatchObject({ hasChanges: true, path: worktree.path });
      expect(result.branch).toBeUndefined();
      expect(result.error).toContain("preserved for recovery");
      expect(existsSync(changedFile)).toBe(true);

      rmSync(indexLock, { force: true });
      removeWorktree(repoDir, worktree.path);
    });

    it("does not overwrite an existing branch", async () => {
      const first = (await createWorktree(repoDir, "conflict-1"))!;
      writeFileSync(join(first.path, "first.txt"), "first");
      const firstResult = await cleanupWorktree(repoDir, first, "first");
      expect(firstResult.branch).toBe("pi-agent-conflict-1");

      const second = (await createWorktree(repoDir, "conflict-1"))!;
      writeFileSync(join(second.path, "second.txt"), "second");
      const secondResult = await cleanupWorktree(repoDir, second, "second");
      expect(secondResult.branch).toMatch(/^pi-agent-conflict-1-\d+$/);

      removeBranch(repoDir, firstResult.branch);
      removeBranch(repoDir, secondResult.branch);
    });

    it("handles an already deleted worktree", async () => {
      const worktree = (await createWorktree(repoDir, "gone-1"))!;
      rmSync(worktree.path, { recursive: true, force: true });
      expect(await cleanupWorktree(repoDir, worktree, "already gone")).toEqual({ hasChanges: false });
    });

    it("sanitizes control and shell characters in commit descriptions", async () => {
      const worktree = (await createWorktree(repoDir, "sanitize-1"))!;
      writeFileSync(join(worktree.path, "change.txt"), "something");
      const result = await cleanupWorktree(repoDir, worktree, 'test\n`malicious`\r\n$(echo foo)\x00"quote"');
      const log = execFileSync("git", ["log", "--format=%s", "-1", result.branch!], {
        cwd: repoDir,
        stdio: "pipe",
      }).toString().trim();
      expect(log).toBe("pi-agent: test malicious (echo foo) quote");
      removeBranch(repoDir, result.branch);
    });

    it("truncates descriptions without splitting surrogate pairs", async () => {
      const worktree = (await createWorktree(repoDir, "surrogate-msg"))!;
      writeFileSync(join(worktree.path, "change.txt"), "something");
      const result = await cleanupWorktree(repoDir, worktree, `${"a".repeat(199)}😀`);
      const log = execFileSync("git", ["log", "--format=%s", "-1", result.branch!], {
        cwd: repoDir,
        stdio: "pipe",
      }).toString().trim();
      expect(log.length).toBe(209);
      expect(log).not.toContain("\uFFFD");
      removeBranch(repoDir, result.branch);
    });

    it("converts non-string descriptions defensively", async () => {
      const worktree = (await createWorktree(repoDir, "non-string-msg"))!;
      writeFileSync(join(worktree.path, "change.txt"), "something");
      const result = await cleanupWorktree(repoDir, worktree, ["hello", "world"] as unknown as string);
      const log = execFileSync("git", ["log", "--format=%s", "-1", result.branch!], {
        cwd: repoDir,
        stdio: "pipe",
      }).toString().trim();
      expect(log).toContain("hello,world");
      removeBranch(repoDir, result.branch);
    });

    it("caps long descriptions at 200 characters plus prefix", async () => {
      const worktree = (await createWorktree(repoDir, "long-msg"))!;
      writeFileSync(join(worktree.path, "change.txt"), "something");
      const result = await cleanupWorktree(repoDir, worktree, "x".repeat(300));
      const log = execFileSync("git", ["log", "--format=%s", "-1", result.branch!], {
        cwd: repoDir,
        stdio: "pipe",
      }).toString().trim();
      expect(log.length).toBeLessThanOrEqual(210);
      removeBranch(repoDir, result.branch);
    });

    it("normalizes caller-supplied branch values defensively", async () => {
      const worktree = (await createWorktree(repoDir, "manual-branch"))!;
      worktree.branch = "pi-agent-feature..escape/$bad";
      writeFileSync(join(worktree.path, "change.txt"), "something");
      const result = await cleanupWorktree(repoDir, worktree, "defensive branch normalization");
      expect(result.branch).toBe("pi-agent-feature-escape-bad");
      execFileSync("git", ["check-ref-format", "--branch", result.branch!], {
        cwd: repoDir,
        stdio: "pipe",
      });
      removeBranch(repoDir, result.branch);
    });
  });

  describe("pruneWorktrees", () => {
    it("does not reject for a clean repository", async () => {
      await expect(pruneWorktrees(repoDir)).resolves.toBeUndefined();
    });

    it("does not reject outside a repository", async () => {
      const nonGit = mkdtempSync(join(tmpdir(), "pi-wt-prune-nongit-"));
      try {
        await expect(pruneWorktrees(nonGit)).resolves.toBeUndefined();
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
      }
    });
  });
});
