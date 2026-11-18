/**
 * devin-worker policy and command construction. The devin binary is mocked.
 */

import { execFileSync, spawn as spawnChild } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { link, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireLane,
  acquireTaskLock,
  assertLocalCliArgv,
  assertNoCloudRoute,
  assertPilotOpen,
  buildDevinArgv,
  buildPrBody,
  calendarDate,
  combineExitCodes,
  DEFAULT_PILOT_UNTIL_FLASH,
  DEFAULT_PILOT_UNTIL_SWE2,
  DEFAULT_TIMEOUT_MS,
  defaultExecFile,
  defaultSpawn,
  EXIT,
  HERDR_CORE_LANE_ROUTE,
  installSignalForwarding,
  isAllowlistedModelId,
  isSensitivePath,
  LOCAL_CLI_ROUTE,
  main,
  parseModelCatalog,
  porcelainPaths,
  redactSecrets,
  resolveExecutionRoute,
  resolveLaneWaitMs,
  resolveListedModel,
  resolveMaxLanes,
  resolvePilotUntil,
  resolveTimeoutMs,
  routeLogLine,
  runWithLanes,
  runWorker,
  taskPaths,
} from "../scripts/devin-worker.mjs";

const CATALOG = JSON.stringify({
  families: [
    {
      family_uid: "swe-2",
      family_label: "SWE-2",
      aliases: ["swe"],
      variants: [
        { model_uid: "swe-2-medium", label: "SWE-2 Medium" },
        { model_uid: "swe-2-high", label: "SWE-2 High" },
        { model_uid: "swe-2-max", label: "SWE-2 Max" },
        { model_uid: "swe-2-flash-medium", label: "SWE-2 Flash Medium" },
        { model_uid: "swe-2-flash-high", label: "SWE-2 Flash High" },
        { model_uid: "swe-2-flash-max", label: "SWE-2 Flash Max" },
        { model_uid: "swe-2-high-lightning", label: "SWE-2 High Lightning" },
      ],
    },
    {
      family_uid: "swe-1-7",
      aliases: ["fast"],
      variants: [{ model_uid: "swe-1-7-lightning", label: "SWE-1.7 Lightning" }],
    },
    {
      family_uid: "claude",
      variants: [{ model_uid: "claude-opus-5", label: "Claude Opus 5" }],
    },
  ],
});

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDirs() {
  const root = await mkdtemp(join(tmpdir(), "devin-worker-"));
  roots.push(root);
  const repo = await realpath(await mkdir(join(root, "repo")).then(() => join(root, "repo")));
  const work = await realpath(await mkdir(join(root, "work")).then(() => join(root, "work")));
  return { root, repo, work };
}

function enabledEnv(work: string, extra: Record<string, string> = {}) {
  return {
    DEVIN_WORKER_ENABLED: "true",
    DEVIN_WORKER_WORK_DIR: work,
    DEVIN_WORKER_LANE_WAIT_MS: "0",
    DEVIN_PILOT_UNTIL_SWE2: DEFAULT_PILOT_UNTIL_SWE2,
    DEVIN_PILOT_UNTIL_FLASH: DEFAULT_PILOT_UNTIL_FLASH,
    ...extra,
  };
}

function taskArgs(repo: string, model = "swe-2-medium", task = "Fix the race") {
  return ["--issue", "CHEF-123", "--repo", repo, "--model", model, "--task", task];
}

describe("model allowlist", () => {
  const ids = parseModelCatalog(CATALOG);

  it("reads variant model_uid values and ignores family aliases", () => {
    expect(ids).toContain("swe-2-medium");
    expect(ids).toContain("swe-2-flash-max");
    expect(ids).not.toContain("swe");
    expect(ids).not.toContain("swe-2");
    expect(ids).not.toContain("fast");
  });

  it("allows swe-2 and swe-2-flash variants from the live list", () => {
    for (const id of ["swe-2-medium", "swe-2-high", "swe-2-max", "swe-2-flash-medium", "swe-2-flash-high", "swe-2-flash-max"]) {
      expect(isAllowlistedModelId(id)).toBe(true);
      expect(resolveListedModel(id, ids)).toBe(id);
    }
  });

  it("refuses lightning ids even when the CLI lists them", () => {
    expect(isAllowlistedModelId("swe-2-high-lightning")).toBe(false);
    expect(isAllowlistedModelId("swe-1-7-lightning")).toBe(false);
    expect(() => resolveListedModel("swe-2-high-lightning", ids)).toThrow(/lightning models are not allowed/);
    expect(() => resolveListedModel("SWE-1.7 Lightning", ids)).toThrow(/lightning models are not allowed/);
  });

  it("refuses ids outside the swe-2 prefix and ids the CLI did not list", () => {
    expect(() => resolveListedModel("claude-opus-5", ids)).toThrow(/only swe-2 variants are allowed/);
    expect(() => resolveListedModel("swe", ids)).toThrow(/only swe-2 variants are allowed/);
    expect(() => resolveListedModel("swe-20-max", ids)).toThrow(/only swe-2 variants are allowed/);
    expect(() => resolveListedModel("swe-2", ids)).toThrow(/not present in devin models list/);
  });
});

describe("kill switch", () => {
  it("runs only when DEVIN_WORKER_ENABLED is exactly true", async () => {
    const calls: string[] = [];
    const boom = async () => {
      calls.push("called");
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    };
    for (const value of [undefined, "", "false", "1", "TRUE", "yes"]) {
      const env: Record<string, string> = {};
      if (value !== undefined) env.DEVIN_WORKER_ENABLED = value;
      const code = await main(["--model", "swe-2-high-lightning"], {
        env,
        execFile: boom,
        spawnCommand: boom,
        log: () => {},
        warn: () => {},
      });
      expect(code).toBe(EXIT.OK);
    }
    expect(calls).toEqual([]);
  });
});

describe("pilot end dates", () => {
  it("formats calendar days in Europe/Amsterdam", () => {
    expect(calendarDate(new Date("2026-11-29T22:30:00.000Z"))).toBe("2026-11-29");
    expect(calendarDate(new Date("2026-11-29T23:30:00.000Z"))).toBe("2026-11-30");
  });

  it("allows a model through the inclusive end date and refuses the next Amsterdam day", () => {
    const swe2Open = assertPilotOpen({
      modelId: "swe-2-high",
      now: new Date("2026-11-29T22:30:00.000Z"),
      swe2Until: DEFAULT_PILOT_UNTIL_SWE2,
      flashUntil: DEFAULT_PILOT_UNTIL_FLASH,
    });
    expect(swe2Open.today).toBe("2026-11-29");
    expect(() => assertPilotOpen({
      modelId: "swe-2-high",
      now: new Date("2026-11-29T23:30:00.000Z"),
      swe2Until: DEFAULT_PILOT_UNTIL_SWE2,
      flashUntil: DEFAULT_PILOT_UNTIL_FLASH,
    })).toThrow(/through 2026-11-29/);

    expect(assertPilotOpen({
      modelId: "swe-2-flash-max",
      now: new Date("2026-11-29T23:30:00.000Z"),
      swe2Until: DEFAULT_PILOT_UNTIL_SWE2,
      flashUntil: DEFAULT_PILOT_UNTIL_FLASH,
    }).family).toBe("SWE-2 Flash");
    expect(() => assertPilotOpen({
      modelId: "swe-2-flash-medium",
      now: new Date("2026-12-03T23:30:00.000Z"),
      swe2Until: DEFAULT_PILOT_UNTIL_SWE2,
      flashUntil: DEFAULT_PILOT_UNTIL_FLASH,
    })).toThrow(/through 2026-12-03/);
  });

  it("keeps the default date, accepts an override, and treats an empty value as no deadline", () => {
    expect(resolvePilotUntil(undefined, DEFAULT_PILOT_UNTIL_SWE2)).toBe("2026-11-29");
    expect(resolvePilotUntil("2026-12-31", DEFAULT_PILOT_UNTIL_SWE2)).toBe("2026-12-31");
    expect(resolvePilotUntil("  ", DEFAULT_PILOT_UNTIL_SWE2)).toBeNull();
    expect(() => resolvePilotUntil("2026-13-01", DEFAULT_PILOT_UNTIL_SWE2)).toThrow(/YYYY-MM-DD/);
    expect(assertPilotOpen({
      modelId: "swe-2-medium",
      now: new Date("2027-06-01T12:00:00.000Z"),
      swe2Until: null,
      flashUntil: null,
    }).until).toBeNull();
    expect(assertPilotOpen({
      modelId: "swe-2-medium",
      now: new Date("2026-12-01T12:00:00.000Z"),
      swe2Until: "2026-12-31",
      flashUntil: DEFAULT_PILOT_UNTIL_FLASH,
    }).until).toBe("2026-12-31");
  });
});

describe("lanes and timeout", () => {
  it("defaults to one lane and 30 minutes, and rejects values above the cap", () => {
    expect(resolveMaxLanes(undefined)).toBe(1);
    expect(resolveMaxLanes("4")).toBe(4);
    expect(() => resolveMaxLanes("5")).toThrow(/1 to 4/);
    expect(() => resolveMaxLanes("0")).toThrow(/1 to 4/);
    expect(resolveTimeoutMs(undefined)).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMs("1800000")).toBe(DEFAULT_TIMEOUT_MS);
    expect(() => resolveTimeoutMs("0")).toThrow(/positive integer/);
    expect(resolveLaneWaitMs(undefined)).toBe(15_000);
    expect(resolveLaneWaitMs("0")).toBe(0);
  });

  it("never runs more than the lane cap at once", async () => {
    let active = 0;
    let peak = 0;
    await runWithLanes([1, 2, 3, 4, 5, 6], 4, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((done) => setTimeout(done, 15));
      active -= 1;
      return "ok";
    });
    expect(peak).toBe(4);
  });

  it("reuses a lane after release and refuses a live one", async () => {
    const { work } = await tempDirs();
    const first = await acquireLane(work, 1, { waitMs: 0 });
    await expect(acquireLane(work, 1, { waitMs: 0 })).rejects.toThrow(/lanes are busy/);
    await first.release();
    const second = await acquireLane(work, 1, { waitMs: 0 });
    await second.release();

    await mkdir(join(work, "lanes"), { recursive: true });
    await writeFile(join(work, "lanes", "0"), "424242\n");
    await expect(acquireLane(work, 1, { waitMs: 0, isPidAlive: () => true })).rejects.toThrow(/busy/);
    const stolen = await acquireLane(work, 1, { waitMs: 0, isPidAlive: () => false });
    await stolen.release();
  });

  it("publishes the lane file in one step and leaves another owner's lane alone", async () => {
    const { work } = await tempDirs();
    const laneFile = join(work, "lanes", "0");
    const mine = await acquireLane(work, 1, { waitMs: 0, pid: 111 });
    // The claim is visible with its full content: no zero-byte window that reads
    // as pid 0, and the temp file used for the atomic link is gone.
    expect((await readFile(laneFile, "utf8")).split("\n")[0]).toBe("111");
    expect(await readdir(join(work, "lanes"))).toEqual(["0"]);

    // Another worker reclaimed the lane after this pid "died".
    await writeFile(laneFile, "222\n");
    await mine.release();
    expect(await readFile(laneFile, "utf8")).toBe("222\n");
    await expect(acquireLane(work, 1, { waitMs: 0, isPidAlive: () => true })).rejects.toThrow(/busy/);
    expect(await readFile(laneFile, "utf8")).toBe("222\n");
  });

  it("retries a lane whose previous owner released it before the claim read", async () => {
    const { work } = await tempDirs();
    const laneFile = join(work, "lanes", "0");
    let firstClaim = true;
    let released = false;
    const linkImpl = async (source: string, destination: string) => {
      if (firstClaim) {
        firstClaim = false;
        await writeFile(destination, "424242\n");
        throw Object.assign(new Error("lane was claimed"), { code: "EEXIST" });
      }
      return link(source, destination);
    };
    const readFileImpl = async (path: string, encoding: BufferEncoding) => {
      if (path === laneFile && !released) {
        released = true;
        await rm(path, { force: true });
        throw Object.assign(new Error("lane was released"), { code: "ENOENT" });
      }
      return readFile(path, encoding);
    };

    const lane = await acquireLane(work, 1, {
      waitMs: 0,
      link: linkImpl,
      readFile: readFileImpl,
    });
    await lane.release();
    expect(released).toBe(true);
    expect(await readdir(join(work, "lanes"))).toEqual([]);
  });

  it("serializes competing stale-lane reclamation", async () => {
    const { work } = await tempDirs();
    const laneFile = join(work, "lanes", "0");
    await mkdir(join(work, "lanes"), { recursive: true });
    await writeFile(laneFile, "424242\nstale-token\n");
    const isPidAlive = (pid: number) => [process.pid, 111, 222].includes(pid);
    const results = await Promise.allSettled([
      acquireLane(work, 1, { waitMs: 0, pid: 111, isPidAlive }),
      acquireLane(work, 1, { waitMs: 0, pid: 222, isPidAlive }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) {
      if (result.status === "fulfilled") await result.value.release();
    }
  });

  it("does not publish an ownerless mutation lock after metadata write failure", async () => {
    const { work } = await tempDirs();
    await mkdir(join(work, "lanes"), { recursive: true });
    await writeFile(join(work, "lanes", "0"), "424242\nstale-token\n");
    let failOwnerWrite = true;
    const writeFileImpl = async (
      filePath: string,
      contents: string,
      options?: { mode?: number },
    ) => {
      if (filePath.endsWith("/owner.json") && failOwnerWrite) {
        failOwnerWrite = false;
        throw Object.assign(new Error("simulated metadata write failure"), { code: "EIO" });
      }
      return writeFile(filePath, contents, options);
    };

    await expect(acquireLane(work, 1, {
      waitMs: 0,
      isPidAlive: () => false,
      writeFile: writeFileImpl,
    })).rejects.toThrow(/simulated metadata write failure/);
    expect(await readdir(join(work, "locks"))).not.toContain("mutation");

    const recovered = await acquireLane(work, 1, { waitMs: 0, isPidAlive: () => false });
    await recovered.release();
  });
});

describe("task identity locks", () => {
  it("prevents duplicate tasks while allowing the same task in another repository", async () => {
    const { work } = await tempDirs();
    const branch = "devin/CHEF-123-fix-the-race";
    const isPidAlive = (pid: number) => [111, 222].includes(pid);
    const release = await acquireTaskLock(work, "/repos/one", branch, { pid: 111, isPidAlive });
    await expect(acquireTaskLock(work, "/repos/one", branch, { pid: 222, isPidAlive })).rejects.toThrow(/already owns this task/);
    const releaseOtherRepo = await acquireTaskLock(work, "/repos/two", branch, { pid: 222, isPidAlive });
    await releaseOtherRepo();
    await release();
    const releaseAgain = await acquireTaskLock(work, "/repos/one", branch, { pid: 222, isPidAlive });
    await releaseAgain();
  });

  it("keeps a task release retryable after a transient owner read failure", async () => {
    const { work } = await tempDirs();
    const branch = "devin/CHEF-123-fix-the-race";
    const lockId = createHash("sha256").update(`/repos/one\0${branch}`).digest("hex");
    const taskLock = join(work, "task-locks", `${lockId}.json`);
    let taskLockReads = 0;
    const readFileImpl = async (path: string, encoding: BufferEncoding) => {
      if (path === taskLock && ++taskLockReads === 2) {
        throw Object.assign(new Error("temporary read failure"), { code: "EIO" });
      }
      return readFile(path, encoding);
    };
    const release = await acquireTaskLock(work, "/repos/one", branch, {
      pid: 111,
      isPidAlive: () => false,
      readFile: readFileImpl,
    });

    await expect(release()).rejects.toThrow(/temporary read failure/);
    await release();
    await expect(readFile(taskLock, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("namespaces worktree and artifact paths by repository", async () => {
    const { work } = await tempDirs();
    const task = { issue: "CHEF-123", task: "Fix the race" };
    const first = taskPaths(work, task, "/repos/one");
    const second = taskPaths(work, task, "/repos/two");
    expect(first.branch).toBe(second.branch);
    expect(first.worktreePath).not.toBe(second.worktreePath);
    expect(first.exportPath).not.toBe(second.exportPath);
    expect(first.stdoutPath).not.toBe(second.stdoutPath);
  });
});

describe("worker signal forwarding", () => {
  it("forwards termination to active children and removes its handlers", () => {
    const target = new EventEmitter();
    const forwarded: string[] = [];
    const children = new Map([["child", (signal: string) => forwarded.push(signal)]]);
    const controller = installSignalForwarding(target, children);
    target.emit("SIGTERM");
    expect(controller.signal).toBe("SIGTERM");
    expect(forwarded).toEqual(["SIGTERM"]);
    controller.dispose();
    target.emit("SIGINT");
    expect(forwarded).toEqual(["SIGTERM"]);
  });
});

describe("child output", () => {
  it("terminates Devin and rejects if an output stream cannot be written", async () => {
    const { root } = await tempDirs();
    const badLog = join(root, "not-a-file");
    await mkdir(badLog);
    await expect(defaultSpawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        cwd: root,
        env: process.env,
        stdoutPath: badLog,
        stderrPath: join(root, "stderr.log"),
        timeoutMs: 10_000,
      },
    )).rejects.toThrow(/Could not write Devin stdout log/);
  });

  it("terminates Devin if a child output stream errors", async () => {
    const { root } = await tempDirs();
    const child = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const signals: string[] = [];
    Object.assign(child, {
      pid: 2_147_483_647,
      stdout,
      stderr,
      kill: (signal: string) => {
        signals.push(signal);
        queueMicrotask(() => child.emit("close", null, signal));
        return true;
      },
    });
    const outcome = defaultSpawn("devin", [], {
      cwd: root,
      env: process.env,
      stdoutPath: join(root, "stdout.log"),
      stderrPath: join(root, "stderr.log"),
      timeoutMs: 10_000,
      spawnImpl: () => child,
    });
    stdout.emit("error", Object.assign(new Error("source stream failed"), { code: "EIO" }));
    await expect(outcome).rejects.toThrow(/Could not read Devin stdout stream/);
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("rejects a log write error that arrives after the child closes", async () => {
    const { root } = await tempDirs();
    const stdout = new Writable({
      write(_chunk, _encoding, callback) {
        setTimeout(() => {
          callback(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
        }, 20);
      },
    });
    await expect(defaultSpawn(
      process.execPath,
      ["-e", "process.stdout.write('done')"],
      {
        cwd: root,
        env: process.env,
        stdoutPath: join(root, "stdout.log"),
        stderrPath: join(root, "stderr.log"),
        timeoutMs: 10_000,
        createWriteStreamImpl: (path: string) => path.endsWith("stdout.log")
          ? stdout
          : new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
      },
    )).rejects.toThrow(/Could not write Devin stdout log/);
  });

  it("stops detached grandchildren before releasing Devin's process group", async () => {
    if (process.platform === "win32") return;
    const { root } = await tempDirs();
    let processGroupId: number | undefined;
    await expect(defaultSpawn(
      process.execPath,
      [
        "-e",
        "const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); process.exit(0);",
      ],
      {
        cwd: root,
        env: process.env,
        stdoutPath: join(root, "stdout.log"),
        stderrPath: join(root, "stderr.log"),
        timeoutMs: 10_000,
        spawnImpl: (command: string, args: string[], options: Parameters<typeof spawnChild>[2]) => {
          const child = spawnChild(command, args, options);
          processGroupId = child.pid;
          return child;
        },
      },
    )).resolves.toMatchObject({ code: 0 });

    if (!processGroupId) throw new Error("Expected Devin process group id.");
    expect(() => process.kill(-processGroupId, 0)).toThrow();
  });

  it("does not time out after Devin exits while a descendant holds its log pipes", async () => {
    if (process.platform === "win32") return;
    const { root } = await tempDirs();
    let processGroupId: number | undefined;
    const result = await defaultSpawn(
      process.execPath,
      [
        "-e",
        "const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }); process.exit(0);",
      ],
      {
        cwd: root,
        env: process.env,
        stdoutPath: join(root, "stdout.log"),
        stderrPath: join(root, "stderr.log"),
        timeoutMs: 1_000,
        spawnImpl: (command: string, args: string[], options: Parameters<typeof spawnChild>[2]) => {
          const child = spawnChild(command, args, options);
          processGroupId = child.pid;
          return child;
        },
      },
    );

    expect(result).toMatchObject({ code: 0, signal: null, timedOut: false });
    if (!processGroupId) throw new Error("Expected Devin process group id.");
    expect(() => process.kill(-processGroupId, 0)).toThrow();
  });

  it("bounds the wait for a Devin log stream to close", async () => {
    const { root } = await tempDirs();
    const blockedLog = new Writable({
      write() {},
    });

    await expect(defaultSpawn(
      process.execPath,
      ["-e", "process.stdout.write('blocked'); process.exit(0);"],
      {
        cwd: root,
        env: process.env,
        stdoutPath: join(root, "stdout.log"),
        stderrPath: join(root, "stderr.log"),
        timeoutMs: 10_000,
        createWriteStreamImpl: (path: string) => path.endsWith("stdout.log")
          ? blockedLog
          : new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
      },
    )).rejects.toThrow(/ETIMEDOUT/);
  }, 10_000);
});

describe("argument parsing", () => {
  const boom = async () => ({ stdout: CATALOG, stderr: "" });

  it("accepts inline task text that starts with -- and mentions a cloud host", async () => {
    const { repo, work } = await tempDirs();
    const spawnArgs: string[][] = [];
    const task = "--fix the race and mention api.devin.ai in the docs";
    const outcome = await runWorker(
      ["--issue", "CHEF-123", "--repo", repo, "--model", "swe-2-medium", `--task=${task}`],
      {
        env: enabledEnv(work),
        now: () => new Date("2026-11-12T12:00:00.000Z"),
        execFile: async (command: string, args: string[]) => {
          if (command === "devin") return { stdout: CATALOG, stderr: "" };
          if (args.includes("--show-toplevel")) return { stdout: `${repo}\n`, stderr: "" };
          if (args.includes("--abbrev-ref")) return { stdout: "origin/main\n", stderr: "" };
          if (args[0] === "status") return { stdout: " M src/app.ts\n", stderr: "" };
          if (command === "gh") return { stdout: "https://github.com/example/repo/pull/12\n", stderr: "" };
          return { stdout: "", stderr: "" };
        },
        spawnCommand: async (_command: string, args: string[]) => {
          spawnArgs.push([...args]);
          return { code: 0, signal: null, timedOut: false };
        },
      },
    );
    expect(outcome.exitCode).toBe(EXIT.OK);
    expect(spawnArgs[0]).toContain(`--print=${task}`);
  });

  it("refuses a bare flag with no operand and an unknown key", async () => {
    const { repo, work } = await tempDirs();
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    const bare = await main(["--issue", "CHEF-123", "--repo", repo, "--model", "swe-2-medium", "--task"], {
      env: enabledEnv(work),
      execFile: boom,
      spawnCommand: boom,
      log: () => {},
      warn,
    });
    expect(bare).toBe(EXIT.USAGE);
    expect(warnings.join("\n")).toMatch(/Missing value for --task/);

    warnings.length = 0;
    const unknown = await main([...taskArgs(repo), "--nope=1"], {
      env: enabledEnv(work),
      execFile: boom,
      spawnCommand: boom,
      log: () => {},
      warn,
    });
    expect(unknown).toBe(EXIT.USAGE);
    expect(warnings.join("\n")).toMatch(/Unknown argument "--nope"/);
  });

  it("names a refused flag without echoing its value", async () => {
    const value = "cloud-session-value-abc";
    expect(() => assertNoCloudRoute({}, [`--cloud=${value}`])).toThrow(/\(--cloud\)/);
    expect(() => assertNoCloudRoute({}, [`--cloud=${value}`])).not.toThrow(new RegExp(value));
    expect(() => assertNoCloudRoute({}, ["https://api.devin.ai/sessions?token=abc123"])).toThrow(/a Devin cloud argument/);
    expect(() => assertNoCloudRoute({}, ["https://api.devin.ai/sessions?token=abc123"])).not.toThrow(/token=abc123/);

    const { repo, work } = await tempDirs();
    const warnings: string[] = [];
    const code = await main([...taskArgs(repo), `--cloud=${value}`], {
      env: enabledEnv(work),
      execFile: boom,
      spawnCommand: boom,
      log: () => {},
      warn: (message: string) => warnings.push(message),
    });
    expect(code).toBe(EXIT.USAGE);
    expect(warnings.join("\n")).toMatch(/--cloud/);
    expect(warnings.join("\n")).not.toContain(value);
  });
});

describe("devin command construction", () => {
  it("builds the headless sandbox argv without a shell", () => {
    const task = "say \"hi\"; touch /tmp/pwn";
    expect(buildDevinArgv({
      model: "swe-2-high",
      task,
      exportPath: "/var/lib/devin-worker/exports/CHEF-9-say-hi.json",
    })).toEqual([
      "--model",
      "swe-2-high",
      `--print=${task}`,
      "--sandbox",
      "--export",
      "/var/lib/devin-worker/exports/CHEF-9-say-hi.json",
    ]);
    expect(buildDevinArgv({
      model: "swe-2-high",
      task: "--fix the race",
      exportPath: "/var/lib/devin-worker/exports/CHEF-9-fix-the-race.json",
    })).toContain("--print=--fix the race");
  });

  it("asks the mocked devin binary for the catalog, then runs that exact argv", async () => {
    const { repo, work } = await tempDirs();
    const repoIdentity = createHash("sha256").update(repo).digest("hex");
    const artifactName = `${repoIdentity}-CHEF-123-say-hi-touch-tmp-pwn`;
    const execCalls: { command: string; args: string[] }[] = [];
    const spawnCalls: { command: string; args: string[]; cwd: string; timeoutMs: number; shell: boolean }[] = [];
    const task = "say \"hi\"; touch /tmp/pwn";
    const outcome = await runWorker(taskArgs(repo, "swe-2-medium", task), {
      env: enabledEnv(work),
      now: () => new Date("2026-11-12T12:00:00.000Z"),
      execFile: async (command: string, args: string[]) => {
        execCalls.push({ command, args: [...args] });
        if (command === "devin" && args[0] === "models") return { stdout: CATALOG, stderr: "" };
        if (command === "git" && args.includes("--show-toplevel")) return { stdout: `${repo}\n`, stderr: "" };
        if (command === "git" && args.includes("--abbrev-ref")) return { stdout: "origin/main\n", stderr: "" };
        if (command === "git" && args[0] === "status") return { stdout: " M src/app.ts\n", stderr: "" };
        if (command === "gh" && args[0] === "pr") return { stdout: "https://github.com/example/repo/pull/7\n", stderr: "" };
        return { stdout: "", stderr: "" };
      },
      spawnCommand: async (command: string, args: string[], options: { cwd: string; timeoutMs: number; shell: boolean }) => {
        spawnCalls.push({
          command,
          args: [...args],
          cwd: options.cwd,
          timeoutMs: options.timeoutMs,
          shell: options.shell,
        });
        return { code: 0, signal: null, timedOut: false };
      },
    });

    expect(outcome.exitCode).toBe(EXIT.OK);
    expect(outcome.route).toBe(LOCAL_CLI_ROUTE);
    expect(execCalls[0]).toEqual({ command: "devin", args: ["models", "list", "--format", "json"] });
    const exportPath = join(work, "exports", `${artifactName}.json`);
    expect(spawnCalls).toEqual([{
      command: "devin",
      args: buildDevinArgv({ model: "swe-2-medium", task, exportPath }),
      cwd: join(work, "worktrees", artifactName),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      shell: false,
    }]);
    const pr = execCalls.find((call) => call.command === "gh" && call.args[0] === "pr");
    expect(pr?.args).toContain("devin/CHEF-123-say-hi-touch-tmp-pwn");
    const bodyPath = pr?.args[pr.args.indexOf("--body-file") + 1] ?? "";
    const body = await readFile(bodyPath, "utf8");
    expect(body).toBe(buildPrBody({
      issue: "CHEF-123",
      task,
      modelId: "swe-2-medium",
      transcriptPath: exportPath,
    }));
    expect(body).toContain(task);
    expect(body).toContain("swe-2-medium");
    expect(body).toContain(exportPath);
    expect(outcome.results[0]?.url).toBe("https://github.com/example/repo/pull/7");
    expect(spawnCalls[0]?.args.some((arg) => arg.startsWith("--print="))).toBe(true);
    expect(spawnCalls[0]?.args).not.toContain("--cloud");
  });

  it("does not call devin when the model is lightning or the pilot date has passed", async () => {
    const { repo, work } = await tempDirs();
    const calls: string[] = [];
    const boom = async () => {
      calls.push("called");
      return { stdout: CATALOG, stderr: "", code: 0, timedOut: false };
    };
    const warnings: string[] = [];
    const lightning = await main(taskArgs(repo, "swe-2-high-lightning"), {
      env: enabledEnv(work),
      execFile: boom,
      spawnCommand: boom,
      log: () => {},
      warn: (message: string) => warnings.push(message),
    });
    expect(lightning).toBe(EXIT.USAGE);
    expect(warnings.join("\n")).toMatch(/lightning/);

    const expired = await main(taskArgs(repo, "swe-2-medium"), {
      env: enabledEnv(work),
      now: () => new Date("2026-11-29T23:30:00.000Z"),
      execFile: boom,
      spawnCommand: boom,
      log: () => {},
      warn: (message: string) => warnings.push(message),
    });
    expect(expired).toBe(EXIT.USAGE);
    expect(warnings.join("\n")).toMatch(/2026-11-29/);
    expect(calls).toEqual([]);
  });

  it("rechecks the pilot cutoff immediately before starting Devin", async () => {
    const { repo, work } = await tempDirs();
    let currentTime = new Date("2026-11-29T10:00:00.000Z");
    let spawned = false;
    const outcome = await runWorker(taskArgs(repo), {
      env: enabledEnv(work),
      now: () => currentTime,
      execFile: async (command: string, args: string[]) => {
        if (command === "devin") return { stdout: CATALOG, stderr: "" };
        if (args.includes("--show-toplevel")) return { stdout: `${repo}\n`, stderr: "" };
        if (args.includes("--abbrev-ref")) return { stdout: "origin/main\n", stderr: "" };
        if (args[0] === "worktree" && args[1] === "add") currentTime = new Date("2026-11-30T10:00:00.000Z");
        if (args[0] === "status") return { stdout: " M src/app.ts\n", stderr: "" };
        if (command === "gh") return { stdout: "https://github.com/example/repo/pull/13\n", stderr: "" };
        return { stdout: "", stderr: "" };
      },
      spawnCommand: async () => {
        spawned = true;
        return { code: 0, signal: null, timedOut: false };
      },
    });
    expect(spawned).toBe(false);
    expect(outcome.results[0]?.message).toMatch(/through 2026-11-29/);
  });

  it("does not spawn devin when the listed catalog lacks the requested id", async () => {
    const { repo, work } = await tempDirs();
    let spawned = false;
    const outcome = await runWorker(taskArgs(repo, "swe-2-medium"), {
      env: enabledEnv(work),
      now: () => new Date("2026-11-12T12:00:00.000Z"),
      execFile: async (command: string, args: string[]) => {
        if (command === "devin") {
          return {
            stdout: JSON.stringify({ families: [{ variants: [{ model_uid: "swe-2-high" }] }] }),
            stderr: "",
          };
        }
        if (args.includes("--show-toplevel")) return { stdout: `${repo}\n`, stderr: "" };
        return { stdout: "", stderr: "" };
      },
      spawnCommand: async () => {
        spawned = true;
        return { code: 0, signal: null, timedOut: false };
      },
    });
    expect(spawned).toBe(false);
    expect(outcome.exitCode).toBe(EXIT.USAGE);
    expect(outcome.results[0]?.message).toMatch(/not present in devin models list/);
  });

  it("stops on timeout, an empty diff, or a secret path, and redacts tokens from errors", async () => {
    const cases = [
      {
        name: "timeout",
        status: " M src/app.ts\n",
        spawn: { code: null, signal: "SIGTERM", timedOut: true },
        exitCode: EXIT.TIMEOUT,
        forbid: ["add", "pr"],
      },
      {
        name: "no changes",
        status: "",
        spawn: { code: 0, signal: null, timedOut: false },
        exitCode: EXIT.NO_CHANGES,
        forbid: ["add", "pr"],
      },
      {
        name: "secret",
        status: "?? .env\n",
        spawn: { code: 0, signal: null, timedOut: false },
        exitCode: EXIT.FAILED,
        forbid: ["add", "pr"],
      },
      {
        name: "renamed secret",
        status: "R  public.txt -> .env\n",
        spawn: { code: 0, signal: null, timedOut: false },
        exitCode: EXIT.FAILED,
        forbid: ["add", "pr"],
      },
      {
        name: "private key",
        status: "?? server.key\n",
        spawn: { code: 0, signal: null, timedOut: false },
        exitCode: EXIT.FAILED,
        forbid: ["add", "pr"],
      },
    ];
    for (const item of cases) {
      const { repo, work } = await tempDirs();
      const commands: string[] = [];
      const outcome = await runWorker(taskArgs(repo), {
        env: enabledEnv(work),
        now: () => new Date("2026-11-12T12:00:00.000Z"),
        execFile: async (command: string, args: string[]) => {
          commands.push(args[0] ?? command);
          if (command === "devin") return { stdout: CATALOG, stderr: "" };
          if (args.includes("--show-toplevel")) return { stdout: `${repo}\n`, stderr: "" };
          if (args.includes("--abbrev-ref")) return { stdout: "origin/main\n", stderr: "" };
          if (args[0] === "status") return { stdout: item.status, stderr: "" };
          return { stdout: "", stderr: "" };
        },
        spawnCommand: async () => item.spawn,
      });
      expect(outcome.exitCode, item.name).toBe(item.exitCode);
      for (const forbidden of item.forbid) expect(commands, item.name).not.toContain(forbidden);
    }

    const fakeToken = ["ghp", "abcdefghijklmnopqrstuvwxyz"].join("_");
    const { repo, work } = await tempDirs();
    const outcome = await runWorker(taskArgs(repo), {
      env: enabledEnv(work),
      now: () => new Date("2026-11-12T12:00:00.000Z"),
      execFile: async (command: string, args: string[]) => {
        if (command === "devin") return { stdout: CATALOG, stderr: "" };
        if (args.includes("--show-toplevel")) return { stdout: `${repo}\n`, stderr: "" };
        if (args.includes("--abbrev-ref")) return { stdout: "origin/main\n", stderr: "" };
        if (args[0] === "status") return { stdout: " M src/app.ts\n", stderr: "" };
        if (args[0] === "push") {
          const error = new Error("push failed") as Error & { stderr?: string };
          error.stderr = `Authorization: Bearer ${fakeToken}`;
          throw error;
        }
        return { stdout: "", stderr: "" };
      },
      spawnCommand: async () => ({ code: 0, signal: null, timedOut: false }),
    });
    expect(outcome.exitCode).toBe(EXIT.FAILED);
    expect(outcome.results[0]?.message).not.toContain(fakeToken);
    expect(outcome.results[0]?.message).toContain("[redacted]");
    expect(redactSecrets("token=sk-live-secret-value")).toBe("token=[redacted]");
    expect(combineExitCodes([EXIT.OK, EXIT.TIMEOUT, EXIT.USAGE])).toBe(EXIT.TIMEOUT);
  });

  it("checks both rename paths and recognizes private-key filenames", () => {
    const humanReadableRename = porcelainPaths("R  public.txt -> .env\n");
    const nulSeparatedRename = porcelainPaths("R  public.txt\0.env\0");
    expect(humanReadableRename.some(isSensitivePath)).toBe(true);
    expect(nulSeparatedRename.some(isSensitivePath)).toBe(true);
    expect(isSensitivePath("server.key")).toBe(true);
    expect(isSensitivePath(".envrc")).toBe(true);
    expect(isSensitivePath(".envrc.local")).toBe(true);
  });

  it("refuses a sensitive path added and removed in real Git history", async () => {
    const { root, repo, work } = await tempDirs();
    const origin = join(root, "origin.git");
    execFileSync("git", ["init", "--bare", "--initial-branch=main", origin], { encoding: "utf8" });
    execFileSync("git", ["init", "--initial-branch=main", repo], { encoding: "utf8" });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    git("config", "user.name", "Worker Test");
    git("config", "user.email", "worker-test@example.invalid");
    git("config", "commit.gpgsign", "false");
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src", "app.ts"), "export const value = 1;\n");
    git("add", "src/app.ts");
    git("commit", "-m", "test: create safe base");
    git("remote", "add", "origin", origin);
    git("push", "-u", "origin", "main");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

    await writeFile(join(repo, ".env"), "not-a-real-secret\n");
    git("add", ".env");
    git("commit", "-m", "test: add sensitive path");
    await rm(join(repo, ".env"));
    git("add", "-u", "--", ".env");
    git("commit", "-m", "test: remove sensitive path");
    git("branch", "devin/CHEF-123-remove-env-history");

    const commands: string[][] = [];
    const outcome = await runWorker(taskArgs(repo, "swe-2-medium", "Remove env history"), {
      env: enabledEnv(work),
      now: () => new Date("2026-11-12T12:00:00.000Z"),
      execFile: async (command: string, args: string[], options: { cwd: string }) => {
        commands.push([command, ...args]);
        if (command === "devin") return { stdout: CATALOG, stderr: "" };
        if (command === "git" && args[0] === "push") throw new Error("test blocks remote writes");
        if (command === "gh") throw new Error("test blocks GitHub writes");
        return defaultExecFile(command, args, options);
      },
      spawnCommand: async () => ({ code: 0, signal: null, timedOut: false }),
    });
    expect(outcome.exitCode).toBe(EXIT.FAILED);
    expect(outcome.results[0]?.message).toMatch(/likely secret file "\.env"/);
    expect(commands.some(([command, ...args]) => command === "git" && args[0] === "push")).toBe(false);
    expect(commands.some(([command]) => command === "gh")).toBe(false);

    await writeFile(join(repo, ".env"), "not-a-real-secret\n");
    git("add", ".env");
    git("commit", "-m", "test: add sensitive file to base");
    git("push", "origin", "main");
    git("branch", "devin/CHEF-124-rename-env");

    const renameCommands: string[][] = [];
    const renameOutcome = await runWorker(
      ["--issue", "CHEF-124", "--repo", repo, "--model", "swe-2-medium", "--task", "Rename env"],
      {
        env: enabledEnv(work),
        now: () => new Date("2026-11-12T12:00:00.000Z"),
        execFile: async (command: string, args: string[], options: { cwd: string }) => {
          renameCommands.push([command, ...args]);
          if (command === "devin") return { stdout: CATALOG, stderr: "" };
          if (command === "git" && args[0] === "push") throw new Error("test blocks remote writes");
          if (command === "gh") throw new Error("test blocks GitHub writes");
          return defaultExecFile(command, args, options);
        },
        spawnCommand: async (_command: string, _args: string[], options: { cwd: string }) => {
          execFileSync("git", ["mv", ".env", "public.txt"], { cwd: options.cwd, encoding: "utf8" });
          return { code: 0, signal: null, timedOut: false };
        },
      },
    );
    expect(renameOutcome.exitCode).toBe(EXIT.FAILED);
    expect(renameOutcome.results[0]?.message).toMatch(/likely secret file "\.env"/);
    expect(renameCommands.some(([command, ...args]) => command === "git" && args[0] === "push")).toBe(false);
    expect(renameCommands.some(([command]) => command === "gh")).toBe(false);
  });

  it("refuses a sensitive path introduced only by merge history", async () => {
    const { repo, work } = await tempDirs();
    const commands: string[] = [];
    let logArgs: string[] = [];
    const outcome = await runWorker(taskArgs(repo), {
      env: enabledEnv(work),
      now: () => new Date("2026-11-12T12:00:00.000Z"),
      execFile: async (command: string, args: string[]) => {
        commands.push(args[0] ?? command);
        if (command === "devin") return { stdout: CATALOG, stderr: "" };
        if (args.includes("--show-toplevel")) return { stdout: `${repo}\n`, stderr: "" };
        if (args.includes("--abbrev-ref")) return { stdout: "origin/main\n", stderr: "" };
        if (args[0] === "log") {
          logArgs = [...args];
          const mergeOnlyPaths = args.includes("--diff-merges=separate") ? ".env\n" : "";
          return { stdout: `${mergeOnlyPaths}src/app.ts\n`, stderr: "" };
        }
        if (args[0] === "status") return { stdout: " M src/app.ts\n", stderr: "" };
        return { stdout: "", stderr: "" };
      },
      spawnCommand: async () => ({ code: 0, signal: null, timedOut: false }),
    });
    expect(outcome.exitCode).toBe(EXIT.FAILED);
    expect(outcome.results[0]?.message).toMatch(/likely secret file "\.env"/);
    expect(logArgs).toEqual([
      "log",
      "--diff-merges=separate",
      "--format=",
      "--name-only",
      "--no-renames",
      "origin/main..refs/heads/devin/CHEF-123-fix-the-race",
    ]);
    for (const forbidden of ["add", "commit", "push", "pr"]) {
      expect(commands, forbidden).not.toContain(forbidden);
    }
  });

  it("opens a pull request for work Devin already committed", async () => {
    const { repo, work } = await tempDirs();
    const calls: string[][] = [];
    const outcome = await runWorker(taskArgs(repo), {
      env: enabledEnv(work),
      now: () => new Date("2026-11-12T12:00:00.000Z"),
      execFile: async (command: string, args: string[]) => {
        calls.push([command, ...args]);
        if (command === "devin") return { stdout: CATALOG, stderr: "" };
        if (args.includes("--show-toplevel")) return { stdout: `${repo}\n`, stderr: "" };
        if (args.includes("--abbrev-ref")) return { stdout: "origin/main\n", stderr: "" };
        if (args[0] === "diff" && args[1] === "--cached") return { stdout: "", stderr: "" };
        if (args[0] === "diff") return { stdout: "src/app.ts\n", stderr: "" };
        if (args[0] === "status") return { stdout: "", stderr: "" };
        if (command === "gh") return { stdout: "https://github.com/example/repo/pull/13\n", stderr: "" };
        return { stdout: "", stderr: "" };
      },
      spawnCommand: async () => ({ code: 0, signal: null, timedOut: false }),
    });
    expect(outcome.exitCode).toBe(EXIT.OK);
    expect(calls.some(([command, ...args]) => command === "git" && args[0] === "commit")).toBe(false);
    expect(calls.some(([command, ...args]) => command === "git" && args[0] === "push")).toBe(true);
    expect(calls.some(([command, ...args]) => command === "gh" && args[0] === "pr" && args[1] === "create")).toBe(true);
  });

  it("refuses to publish a branch containing only an empty commit", async () => {
    const { repo, work } = await tempDirs();
    const calls: string[][] = [];
    const outcome = await runWorker(taskArgs(repo), {
      env: enabledEnv(work),
      now: () => new Date("2026-11-12T12:00:00.000Z"),
      execFile: async (command: string, args: string[]) => {
        calls.push([command, ...args]);
        if (command === "devin") return { stdout: CATALOG, stderr: "" };
        if (args.includes("--show-toplevel")) return { stdout: `${repo}\n`, stderr: "" };
        if (args.includes("--abbrev-ref")) return { stdout: "origin/main\n", stderr: "" };
        if (args[0] === "diff") return { stdout: "", stderr: "" };
        if (args[0] === "status") return { stdout: "", stderr: "" };
        return { stdout: "", stderr: "" };
      },
      spawnCommand: async () => ({ code: 0, signal: null, timedOut: false }),
    });
    expect(outcome.exitCode).toBe(EXIT.NO_CHANGES);
    expect(calls.some(([command, ...args]) => command === "git" && args[0] === "push")).toBe(false);
    expect(calls.some(([command, ...args]) => command === "gh" && args[0] === "pr" && args[1] === "create")).toBe(false);
  });

  it("cancels publishing when termination arrives during push", async () => {
    const { repo, work } = await tempDirs();
    const signalTarget = new EventEmitter();
    const calls: string[][] = [];
    const outcome = await runWorker(taskArgs(repo), {
      env: enabledEnv(work),
      now: () => new Date("2026-11-12T12:00:00.000Z"),
      signalTarget,
      execFile: async (
        command: string,
        args: string[],
        options: { signal?: AbortSignal },
      ) => {
        calls.push([command, ...args]);
        if (command === "devin") return { stdout: CATALOG, stderr: "" };
        if (args.includes("--show-toplevel")) return { stdout: `${repo}\n`, stderr: "" };
        if (args.includes("--abbrev-ref")) return { stdout: "origin/main\n", stderr: "" };
        if (args[0] === "status") return { stdout: " M src/app.ts\n", stderr: "" };
        if (args[0] === "diff" && args[1] === "--cached") return { stdout: "src/app.ts\n", stderr: "" };
        if (args[0] === "diff") return { stdout: "src/app.ts\n", stderr: "" };
        if (args[0] === "push") {
          return new Promise((_resolve, reject) => {
            const abort = () => {
              const error = new Error("push aborted");
              error.name = "AbortError";
              reject(error);
            };
            if (options.signal?.aborted) abort();
            else options.signal?.addEventListener("abort", abort, { once: true });
            signalTarget.emit("SIGTERM");
          });
        }
        return { stdout: "", stderr: "" };
      },
      spawnCommand: async () => ({ code: 0, signal: null, timedOut: false }),
    });

    expect(outcome.exitCode).toBe(EXIT.FAILED);
    expect(outcome.results[0]?.message).toMatch(/stopping after SIGTERM/);
    expect(calls.some(([command, ...args]) => command === "gh" && args[0] === "pr" && args[1] === "create")).toBe(false);
  });

  it("returns the opened PR if lane cleanup fails", async () => {
    const { repo, work } = await tempDirs();
    const outcome = await runWorker(taskArgs(repo), {
      env: enabledEnv(work),
      now: () => new Date("2026-11-12T12:00:00.000Z"),
      acquireLane: async () => ({
        slot: 0,
        release: async () => {
          throw new Error("simulated lane cleanup failure");
        },
      }),
      execFile: async (command: string, args: string[]) => {
        if (command === "devin") return { stdout: CATALOG, stderr: "" };
        if (args.includes("--show-toplevel")) return { stdout: `${repo}\n`, stderr: "" };
        if (args.includes("--abbrev-ref")) return { stdout: "origin/main\n", stderr: "" };
        if (args[0] === "status") return { stdout: " M src/app.ts\n", stderr: "" };
        if (args[0] === "diff" && args[1] === "--cached") return { stdout: "src/app.ts\n", stderr: "" };
        if (args[0] === "diff") return { stdout: "src/app.ts\n", stderr: "" };
        if (command === "gh") return { stdout: "https://github.com/example/repo/pull/14\n", stderr: "" };
        return { stdout: "", stderr: "" };
      },
      spawnCommand: async () => ({ code: 0, signal: null, timedOut: false }),
    });

    expect(outcome.exitCode).toBe(EXIT.FAILED);
    expect(outcome.results[0]?.url).toBe("https://github.com/example/repo/pull/14");
    expect(outcome.results[0]?.message).toMatch(/Pull request .* was opened.*Lane release failed/);
  });

  it("reuses its own leftover worktree on a retry and refuses a foreign one", async () => {
    const { root, repo, work } = await tempDirs();
    const repoIdentity = createHash("sha256").update(repo).digest("hex");
    const worktreePath = join(work, "worktrees", `${repoIdentity}-CHEF-123-fix-the-race`);
    const otherRepo = await realpath(await mkdir(join(root, "other-repo")).then(() => join(root, "other-repo")));
    await Promise.all([mkdir(join(repo, ".git")), mkdir(join(otherRepo, ".git"))]);
    await mkdir(worktreePath, { recursive: true });

    async function attempt(headBranch: string, worktreeRepo = repo) {
      const commands: string[][] = [];
      const outcome = await runWorker(taskArgs(repo), {
        env: enabledEnv(work),
        now: () => new Date("2026-11-12T12:00:00.000Z"),
        execFile: async (command: string, args: string[], options: { cwd: string }) => {
          commands.push([command, ...args]);
          if (command === "devin") return { stdout: CATALOG, stderr: "" };
          if (args.includes("--show-toplevel")) {
            return { stdout: `${options.cwd === worktreePath ? worktreeRepo : repo}\n`, stderr: "" };
          }
          if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
            const gitRoot = options.cwd === worktreePath ? worktreeRepo : repo;
            return { stdout: `${gitRoot}/.git\n`, stderr: "" };
          }
          if (args.includes("--abbrev-ref") && args.includes("origin/HEAD")) return { stdout: "origin/main\n", stderr: "" };
          if (args[0] === "rev-parse" && args.includes("HEAD")) return { stdout: `${headBranch}\n`, stderr: "" };
          if (args[0] === "status") return { stdout: " M src/app.ts\n", stderr: "" };
          if (command === "gh") return { stdout: "https://github.com/example/repo/pull/13\n", stderr: "" };
          return { stdout: "", stderr: "" };
        },
        spawnCommand: async () => ({ code: 0, signal: null, timedOut: false }),
      });
      return { outcome, commands };
    }

    const reused = await attempt("devin/CHEF-123-fix-the-race");
    expect(reused.outcome.exitCode).toBe(EXIT.OK);
    expect(reused.commands.filter((call) => call[1] === "worktree" && call[2] === "add")).toEqual([]);

    const foreign = await attempt("devin/other-issue-other-slug");
    expect(foreign.outcome.exitCode).toBe(EXIT.FAILED);
    expect(foreign.outcome.results[0]?.message).toMatch(/not checked out on devin\/CHEF-123-fix-the-race/);

    const wrongRepository = await attempt("devin/CHEF-123-fix-the-race", otherRepo);
    expect(wrongRepository.outcome.exitCode).toBe(EXIT.FAILED);
    expect(wrongRepository.outcome.results[0]?.message).toMatch(/belongs to a different repository/);
  });

});

describe("local CLI only", () => {
  it("refuses cloud flags, an API key, and remote routes without starting devin", async () => {
    const secret = "super-secret-key-value";
    expect(() => assertNoCloudRoute({ DEVIN_API_KEY: secret })).toThrow(/DEVIN_API_KEY/);
    expect(() => assertNoCloudRoute({ DEVIN_API_KEY: secret })).not.toThrow(new RegExp(secret));
    expect(() => assertNoCloudRoute({ DEVIN_WORKER_ROUTE: "cloud" })).toThrow(/cloud\/remote/);
    expect(() => assertNoCloudRoute({ COMPOSIO_DEVIN_MCP: "1" })).toThrow(/COMPOSIO_DEVIN_MCP/);
    expect(() => assertLocalCliArgv(["--cloud", "--print=fix tests"])).toThrow(/--cloud/);
    expect(() => assertLocalCliArgv(["cloud", "drs", "whoami"])).toThrow(/headless -p/);
    expect(() => assertLocalCliArgv(["--model", "swe-2-medium", "--print=mention api.devin.ai in the notes", "--sandbox", "--export", "/tmp/out.json"])).not.toThrow();

    const { repo, work } = await tempDirs();
    const calls: string[] = [];
    const boom = async () => {
      calls.push("called");
      return { stdout: CATALOG, stderr: "", code: 0, timedOut: false };
    };
    const warnings: string[] = [];
    const code = await main([...taskArgs(repo), "--cloud"], {
      env: enabledEnv(work),
      execFile: boom,
      spawnCommand: boom,
      log: () => {},
      warn: (message: string) => warnings.push(message),
    });
    expect(code).toBe(EXIT.USAGE);
    expect(warnings.join("\n")).toMatch(/--cloud/);
    expect(warnings.join("\n")).not.toContain(secret);

    const keyed = await main(taskArgs(repo), {
      env: { ...enabledEnv(work), DEVIN_API_KEY: secret, DEVIN_API_URL: "https://api.devin.ai" },
      now: () => new Date("2026-11-12T12:00:00.000Z"),
      execFile: boom,
      spawnCommand: boom,
      log: () => {},
      warn: (message: string) => warnings.push(message),
    });
    expect(keyed).toBe(EXIT.USAGE);
    expect(warnings.join("\n")).toMatch(/DEVIN_API_KEY/);
    expect(warnings.join("\n")).toMatch(/DEVIN_API_URL/);
    expect(warnings.join("\n")).not.toContain(secret);
    expect(warnings.join("\n")).not.toContain("https://api.devin.ai");
    expect(calls).toEqual([]);
  });

  it("runs the local CLI route and a herdr-core lane on the same headless argv", async () => {
    const logs: string[] = [];
    const seenEnv: Record<string, string | undefined>[] = [];
    async function run(routeEnv: Record<string, string>) {
      const { repo, work } = await tempDirs();
      const spawnArgs: string[][] = [];
      const outcome = await runWorker(taskArgs(repo), {
        env: { ...enabledEnv(work), ...routeEnv },
        now: () => new Date("2026-11-12T12:00:00.000Z"),
        log: (line: string) => logs.push(line),
        execFile: async (command: string, args: string[]) => {
          if (command === "devin") return { stdout: CATALOG, stderr: "" };
          if (args.includes("--show-toplevel")) return { stdout: `${repo}\n`, stderr: "" };
          if (args.includes("--abbrev-ref")) return { stdout: "origin/main\n", stderr: "" };
          if (args[0] === "status") return { stdout: " M src/app.ts\n", stderr: "" };
          if (command === "gh") return { stdout: "https://github.com/example/repo/pull/9\n", stderr: "" };
          return { stdout: "", stderr: "" };
        },
        spawnCommand: async (_command: string, args: string[], options: { env?: Record<string, string | undefined> }) => {
          spawnArgs.push([...args]);
          seenEnv.push(options.env ?? {});
          return { code: 0, signal: null, timedOut: false };
        },
      });
      return { outcome, spawnArgs };
    }

    const cli = await run({});
    expect(cli.outcome.route).toBe(LOCAL_CLI_ROUTE);
    expect(cli.outcome.exitCode).toBe(EXIT.OK);
    expect(cli.spawnArgs[0]?.some((arg) => arg.startsWith("--print="))).toBe(true);
    expect(cli.spawnArgs[0]).not.toContain("--cloud");
    expect(logs).toContain(routeLogLine(LOCAL_CLI_ROUTE));

    const herdr = await run({ DEVIN_WORKER_ROUTE: HERDR_CORE_LANE_ROUTE, HERDR_LANE: "lane-1" });
    expect(herdr.outcome.route).toBe(HERDR_CORE_LANE_ROUTE);
    expect(resolveExecutionRoute({ HERDR_CORE: "1" })).toBe(HERDR_CORE_LANE_ROUTE);
    expect(herdr.spawnArgs[0]?.slice(0, -1)).toEqual(cli.spawnArgs[0]?.slice(0, -1));
    expect(herdr.spawnArgs[0]?.slice(0, 2)).toEqual(["--model", "swe-2-medium"]);
    expect(herdr.spawnArgs[0]?.some((arg) => arg.startsWith("--print="))).toBe(true);
    expect(herdr.spawnArgs[0]).not.toContain("--cloud");
    expect(logs).toContain(routeLogLine(HERDR_CORE_LANE_ROUTE));
    for (const env of seenEnv) {
      expect(env.DEVIN_API_KEY).toBeUndefined();
      expect(env.DEVIN_API_URL).toBeUndefined();
    }
  });
});
