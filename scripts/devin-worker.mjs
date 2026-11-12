/**
 * devin-worker — one Linear task in, one pull request out.
 *
 * Host scripts in this repo are started with `node scripts/<name>.mjs`
 * (`scripts/dev.mjs`, `scripts/linear-github-sync.mjs`): exported functions,
 * an `import.meta.url` direct-invoke guard, and side effects behind an
 * injected executor so tests never call a real binary. Git worktrees follow
 * the same isolation rules as `src/worktree.ts` (execFile, sanitized ref,
 * timeout). `.opencode/` only stores agent definitions; it does not spawn a
 * CLI, so this pilot stays a standalone script and is not registered on the
 * Pi extension entry.
 *
 * Delete this file, `test/devin-worker.test.ts`, and the README section to
 * remove the pilot. It does not read tokens from the repo or from a config
 * file. Devin, git, and gh use the login already present on the host.
 */

import { execFile as execFileCb, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { finished } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);

export const EXIT = {
  OK: 0,
  USAGE: 2,
  TIMEOUT: 3,
  FAILED: 4,
  NO_CHANGES: 5,
};

export const PILOT_TIME_ZONE = "Europe/Amsterdam";
export const DEFAULT_PILOT_UNTIL_SWE2 = "2026-11-29";
export const DEFAULT_PILOT_UNTIL_FLASH = "2026-12-03";
export const DEFAULT_MAX_LANES = 1;
export const MAX_LANES = 4;
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_LANE_WAIT_MS = 15_000;
export const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_TASKS = 50;
const MAX_TASK_CHARS = 8000;

const HELP_TEXT = [
  "Usage:",
  "  node scripts/devin-worker.mjs --issue CHEF-123 --repo /path/to/checkout --model swe-2-medium --task \"short assignment\"",
  "  node scripts/devin-worker.mjs --tasks tasks.json",
  "",
  "Requires DEVIN_WORKER_ENABLED=true. Any other value exits 0 and does not call devin.",
  "Models come from `devin models list --format json`. Only swe-2 variant ids are accepted.",
  "Any id containing \"lightning\" is refused. SWE-2 runs through DEVIN_PILOT_UNTIL_SWE2",
  "(default 2026-11-29). SWE-2 Flash runs through DEVIN_PILOT_UNTIL_FLASH (default 2026-12-03).",
  "Dates are inclusive calendar days in Europe/Amsterdam. An empty value disables that deadline.",
  "",
  "DEVIN_WORKER_MAX_LANES   parallel devin processes, 1-4, default 1",
  "DEVIN_WORKER_TIMEOUT_MS  per-task timeout in milliseconds, default 1800000 (30 minutes)",
  "DEVIN_WORKER_WORK_DIR    fixed directory for worktrees, exports, and lane locks",
  "DEVIN_WORKER_LANE_WAIT_MS  how long to wait for a free lane, default 15000",
  "DEVIN_BIN                devin executable, default devin",
  "",
  "Exit codes: 0 ok or disabled, 2 refused input, 3 task timeout, 4 execution failure, 5 no changes to commit.",
].join("\n");

export class WorkerError extends Error {
  constructor(message, exitCode = EXIT.FAILED) {
    super(message);
    this.name = "WorkerError";
    this.exitCode = exitCode;
  }
}

export function isWorkerEnabled(env) {
  return env?.DEVIN_WORKER_ENABLED === "true";
}

export function redactSecrets(text) {
  return String(text)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{8,}\b/g, "[redacted]")
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, "$1=[redacted]");
}

export function resolveMaxLanes(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_MAX_LANES;
  const trimmed = String(raw).trim();
  if (!/^[1-4]$/.test(trimmed)) {
    throw new WorkerError("DEVIN_WORKER_MAX_LANES must be an integer from 1 to 4.", EXIT.USAGE);
  }
  return Number(trimmed);
}

export function resolveTimeoutMs(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_TIMEOUT_MS;
  const trimmed = String(raw).trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new WorkerError("DEVIN_WORKER_TIMEOUT_MS must be a positive integer number of milliseconds.", EXIT.USAGE);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 1000 || value > MAX_TIMEOUT_MS) {
    throw new WorkerError("DEVIN_WORKER_TIMEOUT_MS must be between 1000 and 86400000.", EXIT.USAGE);
  }
  return value;
}

export function resolveLaneWaitMs(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_LANE_WAIT_MS;
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new WorkerError("DEVIN_WORKER_LANE_WAIT_MS must be an integer number of milliseconds.", EXIT.USAGE);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value > DEFAULT_TIMEOUT_MS) {
    throw new WorkerError("DEVIN_WORKER_LANE_WAIT_MS must be between 0 and 1800000.", EXIT.USAGE);
  }
  return value;
}

export function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

/**
 * Unset keeps the pilot default. An empty string disables the deadline.
 * Any other value must be a real YYYY-MM-DD and replaces the default.
 */
export function resolvePilotUntil(raw, fallback) {
  if (raw === undefined || raw === null) return fallback;
  const trimmed = String(raw).trim();
  if (trimmed === "") return null;
  if (!isIsoDate(trimmed)) {
    throw new WorkerError(`Pilot end date ${JSON.stringify(trimmed)} is not a real YYYY-MM-DD.`, EXIT.USAGE);
  }
  return trimmed;
}

export function calendarDate(now, timeZone = PILOT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new WorkerError(`Could not format the date in ${timeZone}.`, EXIT.USAGE);
  }
  return `${year}-${month}-${day}`;
}

export function isFlashModel(modelId) {
  return String(modelId).toLowerCase().includes("flash");
}

export function isLightningModel(modelId) {
  return String(modelId).toLowerCase().includes("lightning");
}

/** Prefix allowlist: `swe-2` or `swe-2-*`, never a lightning id. */
export function isAllowlistedModelId(modelId) {
  const id = String(modelId ?? "").trim();
  if (isLightningModel(id)) return false;
  if (!/^swe-2(?:-[A-Za-z0-9][A-Za-z0-9._-]{0,64})?$/.test(id)) return false;
  return id.toLowerCase() === "swe-2" || id.toLowerCase().startsWith("swe-2-");
}

export function assertModelShape(modelId) {
  const id = typeof modelId === "string" ? modelId.trim() : "";
  if (isLightningModel(id)) {
    throw new WorkerError(
      `Refusing model ${JSON.stringify(id)}: lightning models are not allowed.`,
      EXIT.USAGE,
    );
  }
  if (!isAllowlistedModelId(id)) {
    throw new WorkerError(
      `Refusing model ${JSON.stringify(id)}: only swe-2 variants are allowed.`,
      EXIT.USAGE,
    );
  }
  return id;
}

export function assertPilotOpen({ modelId, now, swe2Until, flashUntil, timeZone = PILOT_TIME_ZONE }) {
  const flash = isFlashModel(modelId);
  const until = flash ? flashUntil : swe2Until;
  const family = flash ? "SWE-2 Flash" : "SWE-2";
  if (until === null) return { family, until: null, today: calendarDate(now, timeZone) };
  const today = calendarDate(now, timeZone);
  if (today > until) {
    throw new WorkerError(
      `Refusing model ${JSON.stringify(modelId)}: the ${family} pilot allows this model through ${until} (${timeZone}). The current date there is ${today}.`,
      EXIT.USAGE,
    );
  }
  return { family, until, today };
}

/**
 * Real ids are `variants[].model_uid` from `devin models list --format json`
 * (`{"families":[{"family_uid","variants":[{"model_uid"}]}]}`). Family aliases
 * are not runnable ids.
 */
export function parseModelCatalog(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw new WorkerError("devin models list returned invalid JSON.", EXIT.FAILED);
  }
  const families = parsed && typeof parsed === "object" ? parsed.families : null;
  if (!Array.isArray(families)) {
    throw new WorkerError("devin models list JSON has no families array.", EXIT.FAILED);
  }
  const ids = [];
  for (const family of families) {
    const variants = family && typeof family === "object" ? family.variants : null;
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) {
      const id = variant && typeof variant.model_uid === "string" ? variant.model_uid.trim() : "";
      if (id) ids.push(id);
    }
  }
  if (ids.length === 0) {
    throw new WorkerError("devin models list returned no model_uid values.", EXIT.FAILED);
  }
  return ids;
}

export function resolveListedModel(requested, catalogIds) {
  const id = assertModelShape(requested);
  const match = catalogIds.find((candidate) => candidate.toLowerCase() === id.toLowerCase());
  if (!match) {
    throw new WorkerError(
      `Refusing model ${JSON.stringify(id)}: not present in devin models list.`,
      EXIT.USAGE,
    );
  }
  if (!isAllowlistedModelId(match)) {
    throw new WorkerError(
      `Refusing model ${JSON.stringify(match)}: listed id is outside the swe-2 allowlist.`,
      EXIT.USAGE,
    );
  }
  return match;
}

export function buildDevinArgv({ model, task, exportPath }) {
  return ["--model", model, "-p", task, "--sandbox", "--export", exportPath];
}

export function assertIssueId(issue) {
  const value = typeof issue === "string" ? issue.trim() : "";
  if (!/^[A-Za-z][A-Za-z0-9]*-[1-9][0-9]{0,8}$/.test(value)) {
    throw new WorkerError(
      `Issue id ${JSON.stringify(issue)} is not a Linear identifier like CHEF-123.`,
      EXIT.USAGE,
    );
  }
  return value;
}

export function slugFromTask(task) {
  const slug = String(task)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "task";
}

export function buildBranchName(issue, task) {
  const branch = `devin/${assertIssueId(issue)}-${slugFromTask(task)}`;
  if (!/^devin\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(branch)) {
    throw new WorkerError(`Branch name ${JSON.stringify(branch)} is not safe.`, EXIT.USAGE);
  }
  return branch;
}

export function buildPrTitle(issue, slug) {
  const title = `devin: ${issue} ${slug}`.replace(/\s+/g, " ").trim();
  return title.length <= 72 ? title : `${title.slice(0, 69).replace(/[- ]+$/g, "")}...`;
}

export function buildPrBody({ issue, task, modelId, transcriptPath }) {
  return [
    "## Task",
    "",
    String(task).trim(),
    "",
    "## Model",
    "",
    modelId,
    "",
    "## Transcript",
    "",
    transcriptPath,
    "",
    `Linear: ${issue}`,
    "",
    "Opened by devin-worker. A human or Dev merges this pull request.",
    "",
  ].join("\n");
}

export function porcelainPaths(status) {
  const paths = [];
  for (const line of String(status).split("\n")) {
    if (line.length < 4) continue;
    const body = line.slice(3).trim();
    if (!body) continue;
    const arrow = body.lastIndexOf(" -> ");
    paths.push(arrow === -1 ? body : body.slice(arrow + 4).trim());
  }
  return paths;
}

export function isSensitivePath(filePath) {
  const normalized = String(filePath).replace(/\\/g, "/");
  return /(^|\/)\.env($|\.)|(^|\/)credentials(\.[^/]+)?$|(^|\/)[^/]+\.pem$|(^|\/)id_(rsa|ed25519|ecdsa|dsa)($|\.)|(^|\/)\.npmrc$|(^|\/)\.netrc$/i.test(normalized);
}

export function isPathInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function combineExitCodes(codes) {
  if (codes.some((code) => code === EXIT.FAILED)) return EXIT.FAILED;
  if (codes.some((code) => code === EXIT.TIMEOUT)) return EXIT.TIMEOUT;
  if (codes.some((code) => code === EXIT.NO_CHANGES)) return EXIT.NO_CHANGES;
  if (codes.some((code) => code === EXIT.USAGE)) return EXIT.USAGE;
  if (codes.every((code) => code === EXIT.OK)) return EXIT.OK;
  return EXIT.FAILED;
}

export async function runWithLanes(items, lanes, worker) {
  const results = new Array(items.length);
  let next = 0;
  const count = Math.max(1, Math.min(lanes, items.length));
  async function lane() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: count }, () => lane()));
  return results;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function acquireLane(workDir, maxLanes, options = {}) {
  const mkdirImpl = options.mkdir ?? mkdir;
  const rmImpl = options.rm ?? rm;
  const writeFileImpl = options.writeFile ?? writeFile;
  const readFileImpl = options.readFile ?? readFile;
  const alive = options.isPidAlive ?? isPidAlive;
  const sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const now = options.now ?? Date.now;
  const waitMs = options.waitMs ?? 0;
  const pid = options.pid ?? process.pid;
  const lanesDir = join(workDir, "lanes");
  await mkdirImpl(lanesDir, { recursive: true });
  const deadline = now() + waitMs;

  async function claim(file) {
    await writeFileImpl(file, `${pid}\n`, { flag: "wx", mode: 0o600 });
    return {
      release: async () => {
        await rmImpl(file, { force: true });
      },
    };
  }

  async function trySlot(slot) {
    const file = join(lanesDir, String(slot));
    try {
      return await claim(file);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = Number(String(await readFileImpl(file, "utf8").catch(() => "")).trim());
      if (owner === pid || alive(owner)) return null;
      await rmImpl(file, { force: true });
      try {
        return await claim(file);
      } catch (retryError) {
        if (retryError?.code === "EEXIST") return null;
        throw retryError;
      }
    }
  }

  for (;;) {
    for (let slot = 0; slot < maxLanes; slot += 1) {
      const acquired = await trySlot(slot);
      if (acquired) return { slot, release: acquired.release };
    }
    if (now() >= deadline) {
      throw new WorkerError(`All ${maxLanes} devin-worker lanes are busy.`, EXIT.FAILED);
    }
    await sleep(50);
  }
}

export function parseArgs(argv) {
  const parsed = { help: false, tasksPath: null, task: null };
  const flags = { issue: null, repo: null, task: null, model: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    const key = arg === "--tasks" ? "tasks" : arg.startsWith("--") ? arg.slice(2) : "";
    if (!["tasks", "issue", "repo", "task", "model"].includes(key)) {
      throw new WorkerError(`Unknown argument ${JSON.stringify(arg)}.`, EXIT.USAGE);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new WorkerError(`Missing value for --${key}.`, EXIT.USAGE);
    }
    index += 1;
    if (key === "tasks") parsed.tasksPath = value;
    else flags[key] = value;
  }
  const hasSingle = Object.values(flags).some((value) => value !== null);
  if (parsed.tasksPath && hasSingle) {
    throw new WorkerError("Pass either --tasks or --issue/--repo/--task/--model.", EXIT.USAGE);
  }
  if (parsed.tasksPath || parsed.help) return parsed;
  for (const key of ["issue", "repo", "task", "model"]) {
    if (!flags[key]) throw new WorkerError(`Missing --${key}.`, EXIT.USAGE);
  }
  parsed.task = flags;
  return parsed;
}

function assertDirectoryPath(label, value) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new WorkerError(`${label} is required.`, EXIT.USAGE);
  }
  const resolved = resolve(value.trim());
  if (parse(resolved).base.startsWith("-")) {
    throw new WorkerError(`${label} must not start with '-'.`, EXIT.USAGE);
  }
  return resolved;
}

function loadWorkerConfig(env, now) {
  const workDir = assertDirectoryPath("DEVIN_WORKER_WORK_DIR", env.DEVIN_WORKER_WORK_DIR);
  if (workDir === parse(workDir).root) {
    throw new WorkerError("DEVIN_WORKER_WORK_DIR must not be the filesystem root.", EXIT.USAGE);
  }
  const devinBin = (env.DEVIN_BIN ?? "").trim() || "devin";
  if (!/^[\w./@:-]+$/.test(devinBin)) {
    throw new WorkerError("DEVIN_BIN must be a command name or path.", EXIT.USAGE);
  }
  return {
    lanes: resolveMaxLanes(env.DEVIN_WORKER_MAX_LANES),
    timeoutMs: resolveTimeoutMs(env.DEVIN_WORKER_TIMEOUT_MS),
    laneWaitMs: resolveLaneWaitMs(env.DEVIN_WORKER_LANE_WAIT_MS),
    workDir,
    devinBin,
    swe2Until: resolvePilotUntil(env.DEVIN_PILOT_UNTIL_SWE2, DEFAULT_PILOT_UNTIL_SWE2),
    flashUntil: resolvePilotUntil(env.DEVIN_PILOT_UNTIL_FLASH, DEFAULT_PILOT_UNTIL_FLASH),
    now,
  };
}

function normalizeTask(input) {
  if (!input || typeof input !== "object") {
    throw new WorkerError("Each task must be an object.", EXIT.USAGE);
  }
  const issue = assertIssueId(input.issue);
  const task = typeof input.task === "string" ? input.task.trim() : "";
  if (task.length === 0) throw new WorkerError("Task text is empty.", EXIT.USAGE);
  if (task.length > MAX_TASK_CHARS) {
    throw new WorkerError(`Task text is longer than ${MAX_TASK_CHARS} characters.`, EXIT.USAGE);
  }
  if (task.includes("\0")) throw new WorkerError("Task text is invalid.", EXIT.USAGE);
  const repo = assertDirectoryPath("Repo", input.repo);
  const model = assertModelShape(input.model);
  return { issue, task, repo, model };
}

async function loadTasks(parsed, readFileImpl) {
  if (!parsed.tasksPath) return [normalizeTask(parsed.task)];
  const raw = await readFileImpl(parsed.tasksPath, "utf8");
  let items;
  try {
    items = JSON.parse(raw);
  } catch {
    throw new WorkerError("Tasks file is not valid JSON.", EXIT.USAGE);
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_TASKS) {
    throw new WorkerError(`Tasks file must be a JSON array of 1 to ${MAX_TASKS} tasks.`, EXIT.USAGE);
  }
  return items.map((item) => normalizeTask(item));
}

function commandEnv(base) {
  return {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
  };
}

function execMessage(error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr : "";
  const message = error instanceof Error ? error.message : String(error);
  return `${message} ${stderr}`.replace(/\s+/g, " ").trim().slice(0, 400);
}

async function run(execFile, command, args, options) {
  try {
    const result = await execFile(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
      env: options.env,
      windowsHide: true,
      killSignal: "SIGKILL",
    });
    return {
      stdout: String(result?.stdout ?? ""),
      stderr: String(result?.stderr ?? ""),
    };
  } catch (error) {
    if (error instanceof WorkerError) throw error;
    if (error?.killed === true || error?.code === "ETIMEDOUT") {
      throw new WorkerError(`${command} timed out.`, EXIT.FAILED);
    }
    if (error?.code === "ENOENT") {
      throw new WorkerError(`Executable not found: ${command}.`, EXIT.FAILED);
    }
    throw new WorkerError(
      `${command} ${args[0] ?? ""} failed: ${redactSecrets(execMessage(error))}`,
      EXIT.FAILED,
    );
  }
}

function signalTree(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process is already gone.
    }
  }
}

async function closeStream(stream) {
  if (!stream.closed) stream.end();
  try {
    await finished(stream);
  } catch {
    // The log file is best-effort once the child has exited.
  }
}

export function defaultExecFile(command, args, options = {}) {
  return execFileAsync(command, args, options);
}

export function defaultSpawn(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const stdoutStream = createWriteStream(options.stdoutPath, { flags: "w", mode: 0o600 });
    const stderrStream = createWriteStream(options.stderrPath, { flags: "w", mode: 0o600 });
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout?.pipe(stdoutStream);
    child.stderr?.pipe(stderrStream);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      signalTree(child, "SIGTERM");
      const killer = setTimeout(() => signalTree(child, "SIGKILL"), 5000);
      killer.unref?.();
    }, options.timeoutMs);
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      Promise.all([closeStream(stdoutStream), closeStream(stderrStream)]).finally(() => {
        rejectPromise(error);
      });
    };
    child.once("error", (error) => {
      if (error?.code === "ENOENT") {
        rejectOnce(new WorkerError(`Devin executable not found: ${command}.`, EXIT.FAILED));
        return;
      }
      rejectOnce(error instanceof Error ? error : new WorkerError(String(error), EXIT.FAILED));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      Promise.all([closeStream(stdoutStream), closeStream(stderrStream)]).then(
        () => resolvePromise({ code: code ?? 1, signal, timedOut }),
        rejectPromise,
      );
    });
  });
}

function failureResult(error) {
  const message = redactSecrets(error instanceof Error ? error.message : String(error));
  const exitCode = error instanceof WorkerError ? error.exitCode : EXIT.FAILED;
  return { exitCode, message };
}

async function executeTask(task, ctx) {
  const repoInfo = await stat(task.repo);
  if (!repoInfo.isDirectory()) {
    throw new WorkerError(`Repo is not a directory: ${task.repo}`, EXIT.USAGE);
  }
  const repo = await realpath(task.repo);
  const env = commandEnv(process.env);
  const execFile = ctx.execFile;
  await run(execFile, "git", ["rev-parse", "--is-inside-work-tree"], { cwd: repo, timeoutMs: 15_000, env });
  const top = await run(execFile, "git", ["rev-parse", "--show-toplevel"], { cwd: repo, timeoutMs: 15_000, env });
  const repoRoot = await realpath(top.stdout.trim());
  const workRoot = await realpath(ctx.workDir);
  if (isPathInside(repoRoot, workRoot)) {
    throw new WorkerError("DEVIN_WORKER_WORK_DIR must be outside the target repository.", EXIT.USAGE);
  }

  const branch = buildBranchName(task.issue, task.task);
  const dirName = branch.slice("devin/".length);
  const worktreePath = join(workRoot, "worktrees", dirName);
  const exportPath = join(workRoot, "exports", `${dirName}.json`);
  const stdoutPath = join(workRoot, "logs", `${dirName}.stdout`);
  const stderrPath = join(workRoot, "logs", `${dirName}.stderr`);
  const messagePath = join(workRoot, "messages", `${dirName}.txt`);
  const bodyPath = join(workRoot, "pr-bodies", `${dirName}.md`);
  if (!isPathInside(workRoot, worktreePath) || !isPathInside(workRoot, exportPath)) {
    throw new WorkerError("Refusing to create a worktree outside the work directory.", EXIT.FAILED);
  }
  await mkdir(join(workRoot, "worktrees"), { recursive: true, mode: 0o700 });
  await mkdir(join(workRoot, "exports"), { recursive: true, mode: 0o700 });
  await mkdir(join(workRoot, "logs"), { recursive: true, mode: 0o700 });
  await mkdir(join(workRoot, "messages"), { recursive: true, mode: 0o700 });
  await mkdir(join(workRoot, "pr-bodies"), { recursive: true, mode: 0o700 });

  await run(execFile, "git", ["check-ref-format", "--branch", branch], { cwd: repo, timeoutMs: 15_000, env });
  await run(
    execFile,
    "git",
    ["worktree", "add", "-b", branch, "--", worktreePath, "HEAD"],
    { cwd: repo, timeoutMs: 60_000, env },
  );

  const argv = buildDevinArgv({ model: task.model, task: task.task, exportPath });
  let spawned;
  try {
    spawned = await ctx.spawnCommand(ctx.devinBin, argv, {
      cwd: worktreePath,
      timeoutMs: ctx.timeoutMs,
      stdoutPath,
      stderrPath,
      env,
      shell: false,
    });
  } catch (error) {
    if (error instanceof WorkerError) throw error;
    throw new WorkerError(
      `Devin failed to start: ${redactSecrets(error instanceof Error ? error.message : String(error))}. Worktree kept at ${worktreePath}.`,
      EXIT.FAILED,
    );
  }
  if (spawned?.timedOut) {
    throw new WorkerError(
      `Devin timed out after ${ctx.timeoutMs}ms. Worktree kept at ${worktreePath}. Export path: ${exportPath}.`,
      EXIT.TIMEOUT,
    );
  }
  if (spawned?.code !== 0) {
    throw new WorkerError(
      `Devin exited ${spawned?.code ?? "unknown"}. Worktree kept at ${worktreePath}. Export path: ${exportPath}.`,
      EXIT.FAILED,
    );
  }

  const status = await run(execFile, "git", ["status", "--porcelain=v1", "-uall"], {
    cwd: worktreePath,
    timeoutMs: 30_000,
    env,
  });
  const paths = porcelainPaths(status.stdout);
  if (paths.length === 0) {
    throw new WorkerError(
      `Devin made no changes for ${task.issue}. No pull request opened. Worktree kept at ${worktreePath}. Export path: ${exportPath}.`,
      EXIT.NO_CHANGES,
    );
  }
  for (const filePath of paths) {
    if (filePath.startsWith("\"") || filePath.includes("\n")) {
      throw new WorkerError("Refusing to commit a quoted or multiline git path. Worktree kept.", EXIT.FAILED);
    }
    if (isSensitivePath(filePath)) {
      throw new WorkerError(
        `Refusing to commit likely secret file ${JSON.stringify(filePath)}. Worktree kept at ${worktreePath}.`,
        EXIT.FAILED,
      );
    }
  }

  const slug = slugFromTask(task.task);
  await writeFile(messagePath, `devin(${task.issue}): ${slug}\n\nModel: ${task.model}\n`, { mode: 0o600 });
  await run(execFile, "git", ["add", "-A"], { cwd: worktreePath, timeoutMs: 30_000, env });
  await run(execFile, "git", ["commit", "-F", messagePath], { cwd: worktreePath, timeoutMs: 30_000, env });
  await run(execFile, "git", ["push", "--set-upstream", "origin", branch], {
    cwd: worktreePath,
    timeoutMs: 60_000,
    env,
  });

  const base = await resolveBaseBranch(repo, execFile, env);
  const body = buildPrBody({
    issue: task.issue,
    task: task.task,
    modelId: task.model,
    transcriptPath: exportPath,
  });
  await writeFile(bodyPath, body, { mode: 0o600 });
  const created = await run(
    execFile,
    "gh",
    ["pr", "create", "--base", base, "--head", branch, "--title", buildPrTitle(task.issue, slug), "--body-file", bodyPath],
    { cwd: worktreePath, timeoutMs: 60_000, env },
  );
  const url = created.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
  if (!/^https:\/\/\S+$/.test(url)) {
    throw new WorkerError(
      `Pull request command did not return a URL. Branch ${branch} is pushed. Body: ${bodyPath}.`,
      EXIT.FAILED,
    );
  }
  await run(execFile, "git", ["worktree", "remove", "--force", "--", worktreePath], {
    cwd: repo,
    timeoutMs: 30_000,
    env,
  }).catch(() => {
    // The branch and pull request already exist. A leftover worktree is recoverable.
  });
  return { exitCode: EXIT.OK, url, branch, transcriptPath: exportPath };
}

async function resolveBaseBranch(repo, execFile, env) {
  try {
    const head = await run(execFile, "git", ["rev-parse", "--abbrev-ref", "origin/HEAD"], {
      cwd: repo,
      timeoutMs: 15_000,
      env,
    });
    const value = head.stdout.trim();
    if (value.startsWith("origin/")) return value.slice("origin/".length);
  } catch {
    // Fall through to gh when the clone has no origin/HEAD.
  }
  const viewed = await run(
    execFile,
    "gh",
    ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
    { cwd: repo, timeoutMs: 20_000, env },
  );
  const name = viewed.stdout.trim();
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) {
    throw new WorkerError("Could not resolve the target repository default branch.", EXIT.FAILED);
  }
  return name;
}

async function runOne(task, ctx) {
  let release = async () => {};
  try {
    const model = resolveListedModel(task.model, ctx.catalog);
    assertPilotOpen({
      modelId: model,
      now: ctx.now,
      swe2Until: ctx.swe2Until,
      flashUntil: ctx.flashUntil,
    });
    const lane = await acquireLane(ctx.workDir, ctx.lanes, {
      waitMs: ctx.laneWaitMs,
      sleep: ctx.sleep,
      isPidAlive: ctx.isPidAlive,
    });
    release = lane.release;
    return await executeTask({ ...task, model }, ctx);
  } catch (error) {
    return failureResult(error);
  } finally {
    await release();
  }
}

export async function runWorker(argv, deps = {}) {
  const env = deps.env ?? process.env;
  if (!isWorkerEnabled(env)) return { exitCode: EXIT.OK, results: [], disabled: true };
  const now = deps.now ? deps.now() : new Date();
  const parsed = parseArgs(argv);
  const tasks = await loadTasks(parsed, deps.readFile ?? readFile);
  for (const task of tasks) {
    assertModelShape(task.model);
    assertPilotOpen({
      modelId: task.model,
      now,
      swe2Until: resolvePilotUntil(env.DEVIN_PILOT_UNTIL_SWE2, DEFAULT_PILOT_UNTIL_SWE2),
      flashUntil: resolvePilotUntil(env.DEVIN_PILOT_UNTIL_FLASH, DEFAULT_PILOT_UNTIL_FLASH),
    });
  }
  const config = loadWorkerConfig(env, now);
  await mkdir(config.workDir, { recursive: true, mode: 0o700 });
  const execFile = deps.execFile ?? defaultExecFile;
  const listed = await run(
    execFile,
    config.devinBin,
    ["models", "list", "--format", "json"],
    { cwd: process.cwd(), timeoutMs: 30_000, env: commandEnv(process.env) },
  );
  const catalog = parseModelCatalog(listed.stdout);
  const results = await runWithLanes(tasks, config.lanes, (task) => runOne(task, {
    ...config,
    catalog,
    execFile,
    spawnCommand: deps.spawnCommand ?? defaultSpawn,
    sleep: deps.sleep,
    isPidAlive: deps.isPidAlive,
  }));
  return { exitCode: combineExitCodes(results.map((result) => result.exitCode)), results, disabled: false };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.error;
  if (argv.includes("--help") || argv.includes("-h")) {
    log(HELP_TEXT);
    return EXIT.OK;
  }
  const env = deps.env ?? process.env;
  if (!isWorkerEnabled(env)) {
    warn("devin-worker: disabled. Set DEVIN_WORKER_ENABLED=true to run a task.");
    return EXIT.OK;
  }
  try {
    const outcome = await runWorker(argv, deps);
    for (const result of outcome.results) {
      if (result.url) log(result.url);
      if (result.message) warn(`devin-worker: ${result.message}`);
    }
    return outcome.exitCode;
  } catch (error) {
    warn(`devin-worker: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    return error instanceof WorkerError ? error.exitCode : EXIT.FAILED;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
    process.exitCode = EXIT.FAILED;
  });
}
