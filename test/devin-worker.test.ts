/**
 * devin-worker policy and command construction. The devin binary is mocked.
 */

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireLane,
  assertPilotOpen,
  buildDevinArgv,
  buildPrBody,
  calendarDate,
  combineExitCodes,
  DEFAULT_PILOT_UNTIL_FLASH,
  DEFAULT_PILOT_UNTIL_SWE2,
  DEFAULT_TIMEOUT_MS,
  EXIT,
  isAllowlistedModelId,
  main,
  parseModelCatalog,
  redactSecrets,
  resolveLaneWaitMs,
  resolveListedModel,
  resolveMaxLanes,
  resolvePilotUntil,
  resolveTimeoutMs,
  runWithLanes,
  runWorker,
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
  return { repo, work };
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
      "-p",
      task,
      "--sandbox",
      "--export",
      "/var/lib/devin-worker/exports/CHEF-9-say-hi.json",
    ]);
  });

  it("asks the mocked devin binary for the catalog, then runs that exact argv", async () => {
    const { repo, work } = await tempDirs();
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
    expect(execCalls[0]).toEqual({ command: "devin", args: ["models", "list", "--format", "json"] });
    const exportPath = join(work, "exports", "CHEF-123-say-hi-touch-tmp-pwn.json");
    expect(spawnCalls).toEqual([{
      command: "devin",
      args: buildDevinArgv({ model: "swe-2-medium", task, exportPath }),
      cwd: join(work, "worktrees", "CHEF-123-say-hi-touch-tmp-pwn"),
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
          if (args[0] === "status") return { stdout: item.status, stderr: "" };
          return { stdout: "", stderr: "" };
        },
        spawnCommand: async () => item.spawn,
      });
      expect(outcome.exitCode, item.name).toBe(item.exitCode);
      for (const forbidden of item.forbid) expect(commands, item.name).not.toContain(forbidden);
    }

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
          error.stderr = "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz";
          throw error;
        }
        return { stdout: "", stderr: "" };
      },
      spawnCommand: async () => ({ code: 0, signal: null, timedOut: false }),
    });
    expect(outcome.exitCode).toBe(EXIT.FAILED);
    expect(outcome.results[0]?.message).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(outcome.results[0]?.message).toContain("[redacted]");
    expect(redactSecrets("token=sk-live-secret-value")).toBe("token=[redacted]");
    expect(combineExitCodes([EXIT.OK, EXIT.TIMEOUT, EXIT.USAGE])).toBe(EXIT.TIMEOUT);
  });
});
