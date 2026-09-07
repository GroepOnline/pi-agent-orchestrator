/**
 * schedule-store.test.ts — Persistence + concurrency for ScheduleStore.
 *
 * Mirrors the patterns from pi-chonky-tasks's task-store testing: round-trip
 * load/save, parse-error self-heal, owner-fenced locking.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveStorePath, ScheduleStore } from "../src/schedule-store.js";
import type { ScheduledSubagent } from "../src/types.js";

function makeJob(overrides: Partial<ScheduledSubagent> = {}): ScheduledSubagent {
  return {
    id: `job-${Math.random().toString(36).slice(2, 10)}`,
    name: "test-job",
    description: "test",
    schedule: "5m",
    scheduleType: "interval",
    intervalMs: 5 * 60_000,
    subagent_type: "general-purpose",
    prompt: "hello",
    enabled: true,
    createdAt: new Date().toISOString(),
    runCount: 0,
    ...overrides,
  };
}

describe("ScheduleStore", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "schedule-store-test-"));
  });

  afterEach(() => {
    // maxRetries + retryDelay handles Windows file-locking races where the
    // fs.mkdir lock directory is briefly held open after release.
    // EBUSY/EPERM triggers Node's built-in retry-with-linear-backoff.
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("resolveStorePath produces session-scoped path under .pi/subagent-schedules/", () => {
    const p = resolveStorePath("/repo", "abc123");
    // Normaliseer backslashes (Windows) naar forward slashes voor cross-platform vergelijking
    expect(p.replace(/\\/g, "/")).toBe("/repo/.pi/subagent-schedules/abc123.json");
  });

  it("resolveStorePath hashes unsafe session ids instead of allowing path traversal", () => {
    const p = resolveStorePath("/repo", "../../outside").replace(/\\/g, "/");
    expect(p).toMatch(/^\/repo\/\.pi\/subagent-schedules\/session-[a-f0-9]{32}\.json$/);
    expect(p).not.toContain("../");
  });

  it("starts empty and round-trips a job through add/list", async () => {
    const store = await ScheduleStore.create(join(tmp, "s.json"));
    expect(store.list()).toEqual([]);
    const job = makeJob();
    await store.add(job);
    expect(store.list()).toEqual([job]);

    // New instance on same file — verifies persistence
    const fresh = await ScheduleStore.create(join(tmp, "s.json"));
    expect(fresh.list()).toEqual([job]);
  });

  it("update returns merged record and persists the patch", async () => {
    const store = await ScheduleStore.create(join(tmp, "s.json"));
    const job = makeJob({ name: "before" });
    await store.add(job);

    const updated = await store.update(job.id, { name: "after", runCount: 3 });
    expect(updated).toMatchObject({ id: job.id, name: "after", runCount: 3 });

    const fresh = await ScheduleStore.create(join(tmp, "s.json"));
    expect(fresh.list()[0]).toMatchObject({ name: "after", runCount: 3 });
  });

  it("does not allow update patches to change the stable job id", async () => {
    const store = await ScheduleStore.create(join(tmp, "s.json"));
    const job = makeJob({ id: "stable" });
    await store.add(job);

    const updated = await store.update(job.id, { id: "replacement", name: "renamed" });
    expect(updated).toMatchObject({ id: "stable", name: "renamed" });
    expect(store.get("replacement")).toBeUndefined();
  });

  it("rejects duplicate job ids instead of silently overwriting", async () => {
    const store = await ScheduleStore.create(join(tmp, "s.json"));
    await store.add(makeJob({ id: "same", name: "first" }));
    await expect(store.add(makeJob({ id: "same", name: "second" }))).rejects.toThrow("already exists");
    expect(store.list()).toHaveLength(1);
  });

  it("update returns undefined for unknown id and does not create a record", async () => {
    const store = await ScheduleStore.create(join(tmp, "s.json"));
    const r = await store.update("nonexistent", { name: "x" });
    expect(r).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it("refreshes stale cache before update", async () => {
    const file = join(tmp, "s.json");
    const stale = await ScheduleStore.create(file);
    const writer = await ScheduleStore.create(file);
    const job = makeJob({ id: "shared", name: "before" });
    await writer.add(job);

    const updated = await stale.update(job.id, { name: "after" });
    expect(updated).toMatchObject({ id: "shared", name: "after" });
    expect((await ScheduleStore.create(file)).get(job.id)?.name).toBe("after");
  });

  it("remove returns true on existing job and false on missing", async () => {
    const store = await ScheduleStore.create(join(tmp, "s.json"));
    const job = makeJob();
    await store.add(job);
    expect(await store.remove(job.id)).toBe(true);
    expect(store.list()).toEqual([]);
    expect(await store.remove(job.id)).toBe(false);
  });

  it("refreshes stale cache before remove", async () => {
    const file = join(tmp, "s.json");
    const stale = await ScheduleStore.create(file);
    const writer = await ScheduleStore.create(file);
    const job = makeJob({ id: "shared" });
    await writer.add(job);

    expect(await stale.remove(job.id)).toBe(true);
    expect((await ScheduleStore.create(file)).list()).toEqual([]);
  });

  it("hasName excludes a given id (for rename safety)", async () => {
    const store = await ScheduleStore.create(join(tmp, "s.json"));
    const job = makeJob({ name: "alpha" });
    await store.add(job);
    expect(store.hasName("alpha")).toBe(true);
    expect(store.hasName("alpha", job.id)).toBe(false);  // excluded — own record
    expect(store.hasName("beta")).toBe(false);
  });

  it("uses atomic temp+rename — write produces final file, no .tmp leftover", async () => {
    const file = join(tmp, "s.json");
    const store = await ScheduleStore.create(file);
    await store.add(makeJob());
    expect(existsSync(file)).toBe(true);
    expect(readdirSync(tmp).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("creates private schedule directories and files on POSIX", async () => {
    if (process.platform === "win32") return;
    const dir = join(tmp, "private");
    const file = join(dir, "s.json");
    const store = await ScheduleStore.create(file);
    await store.add(makeJob());

    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("self-heals from a corrupt JSON file — load silently empties, next save rewrites", async () => {
    const file = join(tmp, "s.json");
    writeFileSync(file, "{ this is not valid JSON");
    const store = await ScheduleStore.create(file);
    expect(store.list()).toEqual([]);

    // Next mutation overwrites the broken file with healthy JSON
    await store.add(makeJob({ id: "fresh" }));
    const data = JSON.parse(readFileSync(file, "utf-8"));
    expect(data.version).toBe(1);
    expect(data.jobs).toHaveLength(1);
    expect(data.jobs[0].id).toBe("fresh");
  });

  it("clears stale in-memory jobs when the backing file becomes corrupt", async () => {
    const file = join(tmp, "s.json");
    const store = await ScheduleStore.create(file);
    const job = makeJob({ id: "stale" });
    await store.add(job);
    writeFileSync(file, "not-json");

    expect(await store.update(job.id, { name: "must-not-return" })).toBeUndefined();
    expect(store.list()).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf-8")).jobs).toEqual([]);
  });

  it("clears the cache on partial jobs-array corruption instead of persisting a truncated set", async () => {
    const file = join(tmp, "s.json");
    const store = await ScheduleStore.create(file);
    const valid = makeJob({ id: "valid", name: "kept-if-bug" });
    await store.add(valid);

    writeFileSync(
      file,
      JSON.stringify({ version: 1, jobs: [valid, { notid: "x" }] }),
    );

    expect(await store.update(valid.id, { name: "must-not-return" })).toBeUndefined();
    expect(store.list()).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf-8")).jobs).toEqual([]);
  });

  it("treats duplicate job ids in the backing file as corruption and clears state", async () => {
    const file = join(tmp, "s.json");
    const store = await ScheduleStore.create(file);
    const first = makeJob({ id: "dup", name: "first" });
    const second = makeJob({ id: "dup", name: "second" });
    writeFileSync(file, JSON.stringify({ version: 1, jobs: [first, second] }));

    expect(await store.update("dup", { name: "must-not-return" })).toBeUndefined();
    expect(store.list()).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf-8")).jobs).toEqual([]);
  });

  it("rejects a symlinked backing file instead of following it", async () => {
    if (process.platform === "win32") return;
    const target = join(tmp, "outside.json");
    const file = join(tmp, "s.json");
    writeFileSync(target, JSON.stringify({ version: 1, jobs: [makeJob({ id: "secret" })] }));
    symlinkSync(target, file);

    const store = await ScheduleStore.create(file);
    expect(store.list()).toEqual([]);
    await expect(store.add(makeJob({ id: "new" }))).rejects.toThrow("regular file");
    expect(JSON.parse(readFileSync(target, "utf-8")).jobs).toHaveLength(1);
    expect(JSON.parse(readFileSync(target, "utf-8")).jobs[0].id).toBe("secret");
  });

  it("recovers from a legacy plain-file .lock before acquiring an fs.mkdir lock dir", async () => {
    const file = join(tmp, "s.json");
    const lockPath = `${file}.lock`;
    writeFileSync(lockPath, "999999999");

    const store = await ScheduleStore.create(file);
    await expect(store.add(makeJob())).resolves.toBeUndefined();
    expect(store.list()).toHaveLength(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("releases only the lock instance owned by the caller", async () => {
    const file = join(tmp, "s.json");
    const lockPath = `${file}.lock`;
    const ownerPath = join(lockPath, "owner");
    mkdirSync(lockPath);
    writeFileSync(ownerPath, "other-owner");
    const store = await ScheduleStore.create(file);
    const release = (token: string) => (store as unknown as { releaseDirLock(token: string): Promise<void> }).releaseDirLock(token);

    await release("not-the-owner");
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(ownerPath, "utf-8")).toBe("other-owner");

    await release("other-owner");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("releases the lock after a successful mutation so subsequent ones don't deadlock", async () => {
    const store = await ScheduleStore.create(join(tmp, "s.json"));
    const a = makeJob({ id: "a", name: "job-a" });
    const b = makeJob({ id: "b", name: "job-b" });
    await store.add(a);
    await store.add(b);  // would hang if the lock from the first add wasn't released
    expect(store.list().map(j => j.id).sort()).toEqual(["a", "b"]);
  });

  it("does not create the backing directory until a mutation persists", async () => {
    const dir = join(tmp, ".pi", "subagent-schedules");
    const file = join(dir, "sess.json");

    // Constructing + read-only use must not touch the filesystem.
    const store = await ScheduleStore.create(file);
    expect(store.list()).toEqual([]);

    // First mutation lazily creates the directory.
    await store.add(makeJob());
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  it("no-op update/remove of an unknown id never creates the backing directory", async () => {
    const dir = join(tmp, ".pi", "subagent-schedules");
    const file = join(dir, "sess.json");
    const store = await ScheduleStore.create(file);

    expect(await store.update("nonexistent", { name: "x" })).toBeUndefined();
    expect(await store.remove("nonexistent")).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  it("deleteFileIfEmpty unlinks file only when no jobs remain", async () => {
    const file = join(tmp, "s.json");
    const store = await ScheduleStore.create(file);
    const job = makeJob();
    await store.add(job);
    await store.deleteFileIfEmpty();  // not empty — should be a no-op
    expect(existsSync(file)).toBe(true);

    await store.remove(job.id);
    await store.deleteFileIfEmpty();
    expect(existsSync(file)).toBe(false);
  });

  it("deleteFileIfEmpty reloads under lock instead of trusting a stale empty cache", async () => {
    const file = join(tmp, "s.json");
    const stale = await ScheduleStore.create(file);
    const writer = await ScheduleStore.create(file);
    const job = makeJob({ id: "persisted" });
    await writer.add(job);

    await stale.deleteFileIfEmpty();
    expect(existsSync(file)).toBe(true);
    expect((await ScheduleStore.create(file)).get(job.id)).toMatchObject({ id: "persisted" });
  });
});
