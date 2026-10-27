/**
 * schedule-store.ts — File-backed store for scheduled subagents.
 *
 * Session-scoped: each pi session owns its own schedules at
 * `<cwd>/.pi/subagent-schedules/<sessionId>.json`. `/new` starts a fresh
 * empty store; `/resume` reloads.
 *
 * Concurrency model: every mutation acquires an atomic lock directory,
 * re-reads the latest state from disk, applies the change, atomic-writes via
 * temp+rename, releases.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, promises as fs, constants as fsConstants } from "node:fs";
import { basename, dirname, join } from "node:path";
import { logger } from "./logger.js";
import type { ScheduledSubagent, ScheduleStoreData } from "./types.js";

const MAX_STORE_BYTES = 5 * 1024 * 1024;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const OPEN_READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 50;
const LOCK_OWNER_FILE = "owner";

function safeSessionFileStem(sessionId: string): string {
  if (SAFE_SESSION_ID.test(sessionId)) return sessionId;
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  return `session-${digest}`;
}

/** Resolve the storage path for a session-scoped store. */
export function resolveStorePath(cwd: string, sessionId: string): string {
  return join(cwd, ".pi", "subagent-schedules", `${safeSessionFileStem(sessionId)}.json`);
}

async function removeLegacyFileLock(lockPath: string): Promise<void> {
  try {
    const stat = await fs.stat(lockPath);
    if (!stat.isDirectory()) await fs.unlink(lockPath);
  } catch {
    /* no legacy lock to migrate */
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

export class ScheduleStore {
  private filePath: string;
  private lockPath: string;
  private jobs = new Map<string, ScheduledSubagent>();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
  }

  static async create(filePath: string): Promise<ScheduleStore> {
    const store = new ScheduleStore(filePath);
    await store.load();
    return store;
  }

  /** Create the backing directory lazily — only when we're about to persist. */
  private async ensureDir(): Promise<void> {
    const dir = dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Schedule store directory must be a regular directory");
    }
    if (process.platform !== "win32") {
      await fs.chmod(dir, 0o700);
    }
  }

  /** Ensure a private regular backing file exists without overwriting a concurrent writer. */
  private async ensureBackingFile(): Promise<void> {
    try {
      await fs.writeFile(
        this.filePath,
        JSON.stringify({ version: 1, jobs: [] }),
        { encoding: "utf-8", flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    const stat = await fs.lstat(this.filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("Schedule store must be a regular file");
    }
    if (process.platform !== "win32") {
      await fs.chmod(this.filePath, 0o600);
    }
  }

  /** Reload from disk into the in-memory cache (async). */
  private async load(): Promise<void> {
    // Keep the last valid snapshot visible to synchronous readers while I/O is
    // in flight. Swap only after the complete file validates; the catch path
    // still clears stale state before any later mutation can persist it.
    try {
      // Open once with O_NOFOLLOW so a symlink swap between lstat and read cannot win.
      const handle = await fs.open(this.filePath, OPEN_READ_FLAGS);
      let content: string;
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error("Schedule store must be a regular file");
        if (stat.size > MAX_STORE_BYTES) throw new Error("Schedule store payload too large");
        content = await handle.readFile("utf-8");
      } finally {
        await handle.close();
      }

      const data = JSON.parse(content) as Partial<ScheduleStoreData>;
      if (!Array.isArray(data.jobs)) throw new Error("Schedule store jobs must be an array");

      // Validate into a temporary map so a mid-array failure never leaves a
      // half-populated cache that the next mutation would persist.
      const next = new Map<string, ScheduledSubagent>();
      for (const value of data.jobs) {
        if (!value || typeof value !== "object") throw new Error("Schedule store contains an invalid job");
        const job = value as ScheduledSubagent;
        if (typeof job.id !== "string" || job.id.length === 0) {
          throw new Error("Schedule store contains a job without a valid id");
        }
        if (next.has(job.id)) {
          throw new Error("Schedule store contains duplicate job ids");
        }
        next.set(job.id, job);
      }
      this.jobs = next;
    } catch (error) {
      this.jobs.clear();
      if (!isErrno(error, "ENOENT")) {
        logger.warn("Ignoring corrupt schedule store; next mutation will rewrite it", {
          path: this.filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Atomic write via temp file + rename (POSIX-atomic, Windows-safe). */
  private async save(): Promise<void> {
    const data: ScheduleStoreData = {
      version: 1,
      jobs: [...this.jobs.values()],
    };

    const targetDir = dirname(this.filePath);
    const tmpPath = join(targetDir, `${basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`);

    try {
      await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), {
        encoding: "utf-8",
        flag: "wx",
        mode: 0o600,
      });
      await fs.rename(tmpPath, this.filePath);
      if (process.platform !== "win32") await fs.chmod(this.filePath, 0o600);
    } catch (error) {
      try {
        await fs.unlink(tmpPath);
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  private async acquireDirLock(): Promise<string> {
    await this.ensureDir();
    await removeLegacyFileLock(this.lockPath);
    const ownerToken = randomUUID();
    const ownerPath = join(this.lockPath, LOCK_OWNER_FILE);
    const started = Date.now();
    for (;;) {
      try {
        await fs.mkdir(this.lockPath);
        try {
          await fs.writeFile(ownerPath, ownerToken, { encoding: "utf-8", flag: "wx", mode: 0o600 });
          return ownerToken;
        } catch (error) {
          await fs.rm(this.lockPath, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
        if (Date.now() - started > LOCK_STALE_MS) throw error;
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
  }

  private async releaseDirLock(ownerToken: string): Promise<void> {
    const ownerPath = join(this.lockPath, LOCK_OWNER_FILE);
    try {
      const currentOwner = await fs.readFile(ownerPath, "utf-8");
      if (currentOwner !== ownerToken) return;
      await fs.unlink(ownerPath);
      await fs.rmdir(this.lockPath);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        logger.warn("Failed to release schedule-store lock cleanly", {
          path: this.lockPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Acquire lock → reload → mutate → save → release. */
  private async withLock<T>(fn: () => T): Promise<T> {
    const ownerToken = await this.acquireDirLock();
    try {
      await this.ensureBackingFile();
      await this.load();
      const result = fn();
      await this.save();
      return result;
    } finally {
      await this.releaseDirLock(ownerToken);
    }
  }

  /** Read-only — returns a snapshot of the in-memory cache. */
  list(): ScheduledSubagent[] {
    return [...this.jobs.values()];
  }

  /** Read-only check — uses the cache. */
  hasName(name: string, exceptId?: string): boolean {
    for (const job of this.jobs.values()) {
      if (job.id !== exceptId && job.name === name) return true;
    }
    return false;
  }

  get(id: string): ScheduledSubagent | undefined {
    return this.jobs.get(id);
  }

  async add(job: ScheduledSubagent, maxSchedules?: number): Promise<void> {
    await this.withLock(() => {
      if (maxSchedules !== undefined && this.jobs.size >= maxSchedules) {
        throw new Error(`Maximum number of schedules reached (${maxSchedules}). Remove existing schedules before adding new ones.`);
      }
      if (this.jobs.has(job.id)) {
        throw new Error(`A scheduled job with id "${job.id}" already exists.`);
      }
      for (const existing of this.jobs.values()) {
        if (existing.name === job.name) {
          throw new Error(`A scheduled job named "${job.name}" already exists.`);
        }
      }
      this.jobs.set(job.id, job);
    });
  }

  async update(
    id: string,
    patch: Partial<ScheduledSubagent>,
  ): Promise<ScheduledSubagent | undefined> {
    // Preserve the lazy no-op contract when neither cache nor disk can contain
    // the job. If the file exists, re-check under lock to avoid stale-cache TOCTOU.
    if (!this.jobs.has(id) && !existsSync(this.filePath)) return undefined;

    return this.withLock(() => {
      const existing = this.jobs.get(id);
      if (!existing) return undefined;
      const { id: _ignoredId, ...mutablePatch } = patch;
      const updated: ScheduledSubagent = { ...existing, ...mutablePatch, id };
      for (const other of this.jobs.values()) {
        if (other.id !== id && other.name === updated.name) {
          throw new Error(`A scheduled job named "${updated.name}" already exists.`);
        }
      }
      this.jobs.set(id, updated);
      return updated;
    });
  }

  async remove(id: string): Promise<boolean> {
    if (!this.jobs.has(id) && !existsSync(this.filePath)) return false;
    return this.withLock(() => this.jobs.delete(id));
  }

  /** Delete the backing file only after a lock-protected disk reload confirms it is empty. */
  async deleteFileIfEmpty(): Promise<void> {
    if (!existsSync(this.filePath)) return;
    const ownerToken = await this.acquireDirLock();
    try {
      await this.load();
      if (this.jobs.size === 0) await fs.unlink(this.filePath);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    } finally {
      await this.releaseDirLock(ownerToken);
    }
  }
}
