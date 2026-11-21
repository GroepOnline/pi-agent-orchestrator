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
 *
 * Local CLI only. Headless `devin -p`, or the same binary inside a
 * herdr-core lane. Never Devin Cloud, api.devin.ai session endpoints, or
 * Composio devin_mcp. Joep, 12 Nov 2026 10:40: "belangrijk geen devin cloud
 * maar draaien via cli".
 */

import { execFile as execFileCb, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { link, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
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
  "Both --flag value and --flag=value are accepted. Use --task=--value when the",
  "value itself starts with \"--\".",
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
  "DEVIN_WORKER_ROUTE       local-cli (default) or herdr-core-lane",
  "",
  "Only the local Devin CLI. --cloud, DEVIN_API_KEY, api.devin.ai, and Composio devin_mcp are refused.",
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

export const LOCAL_CLI_ROUTE = "local-cli";
export const HERDR_CORE_LANE_ROUTE = "herdr-core-lane";

const BLOCKED_ENV_KEYS = new Set([
  "DEVIN_API_KEY",
  "DEVIN_API_TOKEN",
  "DEVIN_API_URL",
  "DEVIN_API_BASE",
  "DEVIN_BASE_URL",
  "DEVIN_SESSION_TOKEN",
  "DEVIN_SESSION_ID",
  "DEVIN_CLOUD",
  "DEVIN_CLOUD_SESSION",
  "DEVIN_REMOTE",
  "DEVIN_MCP",
  "DEVIN_MCP_URL",
  "COMPOSIO_DEVIN_MCP",
]);

const CLOUD_ROUTES = new Set([
  "cloud",
  "devin-cloud",
  "api",
  "remote",
  "composio",
  "devin_mcp",
  "devin-mcp",
]);

const WORKER_CLOUD_FLAGS = new Set([
  "--cloud",
  "--remote",
  "--api",
  "--session",
  "--devin-mcp",
  "--composio",
]);

function isBlockedEnvKey(key) {
  if (BLOCKED_ENV_KEYS.has(key)) return true;
  return /DEVIN_API_KEY|DEVIN_API_URL|DEVIN_API_BASE|DEVIN_CLOUD|DEVIN_REMOTE|DEVIN_MCP|DEVIN_SESSION_TOKEN|DEVIN_SESSION_ID|COMPOSIO_DEVIN|devin_mcp/i.test(key);
}

function isCloudCliArg(arg) {
  const lower = String(arg).toLowerCase();
  if (lower === "--cloud" || lower === "--remote" || lower === "cloud" || lower === "connect") return true;
  if (lower.startsWith("--cloud=") || lower.startsWith("--remote=") || lower.startsWith("--resume=")) return true;
  if (lower === "--resume" || lower === "-r") return true;
  return /api\.devin\.ai|mcp\.devin\.ai|app\.devin\.ai\/sessions|devin_mcp/i.test(arg);
}

/**
 * Name the flag, never its value: `--cloud=<value>` and cloud URLs must not
 * reach an error message. Only an explicit flag token is echoed; anything else
 * becomes a generic label.
 */
function cloudFlagLabel(arg) {
  const head = String(arg).split("=", 1)[0].trim();
  return /^--?[A-Za-z0-9][\w-]*$/.test(head) ? head : "a Devin cloud argument";
}

function blockedEnvHits(env) {
  const hits = [];
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!isBlockedEnvKey(key)) continue;
    if (typeof value === "string" && value.trim() !== "") hits.push(key);
  }
  const route = String(env?.DEVIN_WORKER_ROUTE ?? "").trim().toLowerCase();
  if (CLOUD_ROUTES.has(route)) hits.push("DEVIN_WORKER_ROUTE");
  return hits;
}

/**
 * Refuse cloud, API-key, and remote-session configuration before any process starts.
 * The error names the variables and flags. It does not include their values.
 */
export function assertNoCloudRoute(env, argv = []) {
  const hits = blockedEnvHits(env);
  for (const arg of argv) {
    if (typeof arg === "string" && (WORKER_CLOUD_FLAGS.has(arg) || isCloudCliArg(arg))) hits.push(cloudFlagLabel(arg));
  }
  if (hits.length === 0) return;
  throw new WorkerError(
    `Refusing Devin cloud/remote route (${hits.join(", ")}). This worker only runs the local Devin CLI: headless devin -p, or a herdr-core lane. Unset DEVIN_API_KEY and do not pass --cloud. Devin cloud, api.devin.ai sessions, and Composio devin_mcp are not used.`,
    EXIT.USAGE,
  );
}

export function resolveExecutionRoute(env) {
  assertNoCloudRoute(env);
  const explicit = String(env?.DEVIN_WORKER_ROUTE ?? "").trim().toLowerCase();
  if (explicit === LOCAL_CLI_ROUTE || explicit === "cli") return LOCAL_CLI_ROUTE;
  if (explicit === HERDR_CORE_LANE_ROUTE || explicit === "herdr") return HERDR_CORE_LANE_ROUTE;
  if (explicit !== "") {
    throw new WorkerError(
      `Refusing DEVIN_WORKER_ROUTE ${JSON.stringify(explicit)}. Allowed routes are local-cli and herdr-core-lane.`,
      EXIT.USAGE,
    );
  }
  const onHerdrLane = ["HERDR_LANE", "HERDR_CORE", "HERDR_SESSION"].some((key) => String(env?.[key] ?? "").trim() !== "");
  return onHerdrLane ? HERDR_CORE_LANE_ROUTE : LOCAL_CLI_ROUTE;
}

export function routeLogLine(route) {
  return `devin-worker: route ${route} (local Devin CLI, headless devin --print; not Devin cloud)`;
}

const PRINT_FLAGS = new Set(["-p", "--print"]);
const SKIP_VALUE_FLAGS = new Set(["-p", "--print", "--model", "--export", "--prompt-file"]);

/** Headless local CLI only. The value after -p/--print is the task, not a flag. */
export function assertLocalCliArgv(argv) {
  if (!Array.isArray(argv)) {
    throw new WorkerError("Refusing Devin invocation without an argument list.", EXIT.USAGE);
  }
  let sawPrint = false;
  const checked = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    if (arg.startsWith("--print=")) {
      sawPrint = true;
      continue;
    }
    if (PRINT_FLAGS.has(arg)) {
      sawPrint = true;
      const next = argv[index + 1];
      if (typeof next === "string" && !next.startsWith("--")) index += 1;
      continue;
    }
    if (SKIP_VALUE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    checked.push(arg);
  }
  if (!sawPrint) {
    throw new WorkerError(
      "Refusing Devin invocation without headless -p/--print. Devin cloud and remote sessions are not allowed.",
      EXIT.USAGE,
    );
  }
  for (const arg of checked) {
    if (isCloudCliArg(arg)) {
      throw new WorkerError(
        `Refusing Devin argument ${cloudFlagLabel(arg)}. This worker only runs the local CLI (devin -p or a herdr-core lane), never Devin cloud, api.devin.ai, or Composio devin_mcp.`,
        EXIT.USAGE,
      );
    }
  }
  return argv;
}

export function assertCatalogArgv(argv) {
  const expected = ["models", "list", "--format", "json"];
  const same = Array.isArray(argv) && argv.length === expected.length && argv.every((arg, index) => arg === expected[index]);
  if (!same) {
    throw new WorkerError(
      "Refusing devin models invocation that is not the local `devin models list --format json`.",
      EXIT.USAGE,
    );
  }
  return argv;
}

export function buildDevinArgv({ model, task, exportPath }) {
  return assertLocalCliArgv(["--model", model, `--print=${task}`, "--sandbox", "--export", exportPath]);
}

export function cliChildEnv(base) {
  assertNoCloudRoute(base);
  const env = {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
  };
  for (const key of Object.keys(env)) {
    if (isBlockedEnvKey(key)) delete env[key];
  }
  return env;
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
  const text = String(status);
  if (text.includes("\0")) {
    const fields = text.split("\0");
    const paths = [];
    for (let index = 0; index < fields.length; index += 1) {
      const record = fields[index];
      if (record.length < 4) continue;
      const statusCode = record.slice(0, 2);
      paths.push(record.slice(3));
      if (statusCode.includes("R") || statusCode.includes("C")) {
        const otherPath = fields[index + 1];
        if (otherPath) paths.push(otherPath);
        index += 1;
      }
    }
    return paths;
  }

  const paths = [];
  for (const line of text.split("\n")) {
    if (line.length < 4) continue;
    const body = line.slice(3).trim();
    if (!body) continue;
    const arrow = body.indexOf(" -> ");
    if (arrow === -1) paths.push(body);
    else paths.push(body.slice(0, arrow).trim(), body.slice(arrow + 4).trim());
  }
  return paths;
}

export function isSensitivePath(filePath) {
  const normalized = String(filePath).replace(/\\/g, "/");
  return /(^|\/)\.env(rc)?($|\.)|(^|\/)credentials(\.[^/]+)?$|(^|\/)[^/]+\.(pem|key)$|(^|\/)id_(rsa|ed25519|ecdsa|dsa)($|\.)|(^|\/)\.npmrc$|(^|\/)\.netrc$/i.test(normalized);
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

function processGroupMarkerPaths(lockPath, token) {
  return {
    starting: `${lockPath}.starting-${token}`,
    processGroup: `${lockPath}.process-group-${token}`,
  };
}

async function readOptionalFile(path, readFileImpl) {
  try {
    return await readFileImpl(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function processGroupIsActive(lockPath, token, readFileImpl, isProcessGroupAliveImpl) {
  const markers = processGroupMarkerPaths(lockPath, token);
  const [starting, rawProcessGroupId] = await Promise.all([
    readOptionalFile(markers.starting, readFileImpl),
    readOptionalFile(markers.processGroup, readFileImpl),
  ]);
  if (rawProcessGroupId === null) return starting !== null;
  const processGroupId = Number(rawProcessGroupId.trim());
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) return true;
  return isProcessGroupAliveImpl(processGroupId);
}

async function clearProcessGroupMarkers(lockPath, token, rmImpl) {
  const markers = processGroupMarkerPaths(lockPath, token);
  await Promise.all([
    rmImpl(markers.starting, { force: true }),
    rmImpl(markers.processGroup, { force: true }),
  ]);
}

function parseLockOwner(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function waitForMutationLock(lockDir, ownerPath, deadline, options) {
  const raw = await readOptionalFile(ownerPath, options.readFileImpl);
  const owner = parseLockOwner(raw);
  if (Number.isInteger(owner?.pid) && owner.pid > 0 && !options.alive(owner.pid)) {
    throw new WorkerError(
      `Found an abandoned worker mutation lock at ${lockDir}; verify no worker is active before removing it.`,
      EXIT.FAILED,
    );
  }
  if (options.now() >= deadline) {
    throw new WorkerError(`Timed out waiting for worker mutation lock at ${lockDir}.`, EXIT.FAILED);
  }
  await options.sleep(10);
}

async function acquireMutationLock({ lockDir, ownerPath, token, deadline, options }) {
  for (;;) {
    const staging = await options.mkdtempImpl(join(parse(lockDir).dir, ".mutation-claim-"));
    try {
      await options.writeFileImpl(join(staging, "owner.json"), JSON.stringify({ pid: options.pid, token }), { mode: 0o600 });
      await options.renameImpl(staging, lockDir);
      return;
    } catch (error) {
      await options.rmImpl(staging, { recursive: true, force: true });
      if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
      await waitForMutationLock(lockDir, ownerPath, deadline, options);
    }
  }
}

async function releaseMutationLock(lockDir, ownerPath, token, options) {
  const raw = await readOptionalFile(ownerPath, options.readFileImpl);
  const owner = parseLockOwner(raw);
  if (owner?.token === token) {
    const releasedDir = join(parse(lockDir).dir, `.mutation-release-${token}`);
    await options.renameImpl(lockDir, releasedDir);
    await options.rmImpl(releasedDir, { recursive: true, force: true });
  }
}

async function withMutationLock(workDir, operation, options = {}) {
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  const lockDir = join(workDir, "locks", "mutation");
  const ownerPath = join(lockDir, "owner.json");
  const lockOptions = {
    mkdirImpl: options.mkdir ?? mkdir,
    mkdtempImpl: options.mkdtemp ?? mkdtemp,
    renameImpl: options.rename ?? rename,
    rmImpl: options.rm ?? rm,
    readFileImpl: options.readFile ?? readFile,
    writeFileImpl: options.writeFile ?? writeFile,
    sleep: options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))),
    now,
    pid,
    alive: options.isPidAlive ?? isPidAlive,
  };
  const token = `${pid}-${now()}-${Math.random().toString(36).slice(2)}`;
  const deadline = now() + (options.mutationWaitMs ?? 15_000);
  await lockOptions.mkdirImpl(join(workDir, "locks"), { recursive: true, mode: 0o700 });
  await acquireMutationLock({ lockDir, ownerPath, token, deadline, options: lockOptions });
  try {
    return await operation();
  } finally {
    await releaseMutationLock(lockDir, ownerPath, token, lockOptions);
  }
}

async function laneLockIsActive(file, raw, pid, { readFileImpl, alive, processGroupAlive }) {
  const [ownerText, token] = String(raw).trim().split(/\s+/);
  const owner = Number(ownerText);
  if (!Number.isInteger(owner) || owner <= 0) {
    throw new WorkerError(`Lane lock at ${file} is unreadable; refusing to replace it.`, EXIT.FAILED);
  }
  return owner === pid
    || alive(owner)
    || (token && await processGroupIsActive(file, token, readFileImpl, processGroupAlive));
}

async function reclaimStaleLaneLock(workDir, file, pid, options) {
  const readFileImpl = options.readFile ?? readFile;
  const rmImpl = options.rm ?? rm;
  const alive = options.isPidAlive ?? isPidAlive;
  const processGroupAlive = options.isProcessGroupAlive ?? isProcessGroupAlive;
  await withMutationLock(workDir, async () => {
    const current = await readFileImpl(file, "utf8").catch(() => null);
    if (current === null) return;
    if (await laneLockIsActive(file, current, pid, { readFileImpl, alive, processGroupAlive })) return;
    const [, token] = String(current).trim().split(/\s+/);
    await rmImpl(file, { force: true });
    if (token) await clearProcessGroupMarkers(file, token, rmImpl);
  }, options);
}

/**
 * Atomically claim a lane by linking a complete owner record into place.
 * Readers never observe an empty or partially written lane lock.
 */
async function claimLane(workDir, file, pid, now, options) {
  const rmImpl = options.rm ?? rm;
  const writeFileImpl = options.writeFile ?? writeFile;
  const linkImpl = options.link ?? link;
  const readFileImpl = options.readFile ?? readFile;
  const token = `${pid}-${now()}-${Math.random().toString(36).slice(2)}`;
  const temp = `${file}.claim-${pid}-${now()}-${Math.random().toString(36).slice(2)}`;
  await writeFileImpl(temp, `${pid}\n${token}\n`, { mode: 0o600 });
  try {
    await linkImpl(temp, file);
  } finally {
    await rmImpl(temp, { force: true });
  }
  return {
    release: () => withMutationLock(workDir, async () => {
      const current = await readFileImpl(file, "utf8").catch(() => null);
      const [owner, ownerToken] = String(current ?? "").trim().split(/\s+/);
      if (owner !== String(pid) || ownerToken !== token) return;
      await rmImpl(file, { force: true });
      await clearProcessGroupMarkers(file, token, rmImpl);
    }, options),
    markProcessGroupStarting: () => withMutationLock(workDir, async () => {
      const current = await readOptionalFile(file, readFileImpl);
      const [owner, ownerToken] = String(current ?? "").trim().split(/\s+/);
      if (owner !== String(pid) || ownerToken !== token) {
        throw new WorkerError(`Lane lock at ${file} changed before Devin started.`, EXIT.FAILED);
      }
      const marker = processGroupMarkerPaths(file, token).starting;
      await writeFileImpl(marker, "starting\n", { mode: 0o600, flag: "wx" });
    }, options),
    setProcessGroupId: (processGroupId) => withMutationLock(workDir, async () => {
      if (!Number.isInteger(processGroupId) || processGroupId <= 0) {
        throw new WorkerError("Devin did not provide a valid process-group id.", EXIT.FAILED);
      }
      const current = await readOptionalFile(file, readFileImpl);
      const [owner, ownerToken] = String(current ?? "").trim().split(/\s+/);
      if (owner !== String(pid) || ownerToken !== token) {
        throw new WorkerError(`Lane lock at ${file} changed before Devin started.`, EXIT.FAILED);
      }
      const markers = processGroupMarkerPaths(file, token);
      await writeFileImpl(markers.processGroup, `${processGroupId}\n`, { mode: 0o600, flag: "wx" });
      await rmImpl(markers.starting, { force: true });
    }, options),
  };
}

async function claimLaneOrNull(file, claim) {
  try {
    return await claim(file);
  } catch (error) {
    if (error?.code === "EEXIST") return null;
    throw error;
  }
}

async function tryLaneSlot({
  workDir,
  slot,
  pid,
  options,
  readFileImpl,
  alive,
  processGroupAlive,
  claim,
}) {
  const file = join(workDir, "lanes", String(slot));
  const acquired = await claimLaneOrNull(file, claim);
  if (acquired) return acquired;
  let current;
  try {
    current = await readFileImpl(file, "utf8");
  } catch (readError) {
    if (readError?.code !== "ENOENT") {
      throw new WorkerError(`Lane lock at ${file} is unreadable; refusing to replace it.`, EXIT.FAILED);
    }
    return claimLaneOrNull(file, claim);
  }
  if (await laneLockIsActive(file, current, pid, { readFileImpl, alive, processGroupAlive })) return null;
  await reclaimStaleLaneLock(workDir, file, pid, options);
  return claimLaneOrNull(file, claim);
}

export async function acquireLane(workDir, maxLanes, options = {}) {
  const mkdirImpl = options.mkdir ?? mkdir;
  const readFileImpl = options.readFile ?? readFile;
  const alive = options.isPidAlive ?? isPidAlive;
  const processGroupAlive = options.isProcessGroupAlive ?? isProcessGroupAlive;
  const sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const now = options.now ?? Date.now;
  const assertRunning = () => {
    const signal = options.shutdownSignal?.();
    if (signal) throw new WorkerError(`Worker stopping after ${signal}.`, EXIT.FAILED);
  };
  const waitMs = options.waitMs ?? 0;
  const pid = options.pid ?? process.pid;
  await mkdirImpl(join(workDir, "lanes"), { recursive: true });
  const deadline = now() + waitMs;
  const claim = (file) => claimLane(workDir, file, pid, now, options);

  for (;;) {
    assertRunning();
    for (let slot = 0; slot < maxLanes; slot += 1) {
      const acquired = await tryLaneSlot({
        workDir,
        slot,
        pid,
        options,
        readFileImpl,
        alive,
        processGroupAlive,
        claim,
      });
      if (acquired) {
        try {
          assertRunning();
        } catch (error) {
          await acquired.release();
          throw error;
        }
        return {
          slot,
          release: acquired.release,
          markProcessGroupStarting: acquired.markProcessGroupStarting,
          setProcessGroupId: acquired.setProcessGroupId,
        };
      }
    }
    if (now() >= deadline) {
      throw new WorkerError(`All ${maxLanes} devin-worker lanes are busy.`, EXIT.FAILED);
    }
    await sleep(50);
  }
}

function taskLockPath(workDir, repoRoot, branch) {
  const identity = createHash("sha256").update(`${repoRoot}\0${branch}`).digest("hex");
  return join(workDir, "task-locks", `${identity}.json`);
}

export async function acquireTaskLock(workDir, repoRoot, branch, options = {}) {
  const mkdirImpl = options.mkdir ?? mkdir;
  const rmImpl = options.rm ?? rm;
  const readFileImpl = options.readFile ?? readFile;
  const writeFileImpl = options.writeFile ?? writeFile;
  const linkImpl = options.link ?? link;
  const pid = options.pid ?? process.pid;
  const alive = options.isPidAlive ?? isPidAlive;
  const processGroupAlive = options.isProcessGroupAlive ?? isProcessGroupAlive;
  const file = taskLockPath(workDir, repoRoot, branch);
  const token = `${pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  await withMutationLock(workDir, async () => {
    await mkdirImpl(join(workDir, "task-locks"), { recursive: true, mode: 0o700 });
    const current = await readFileImpl(file, "utf8").catch(() => null);
    if (current !== null) {
      let owner;
      try {
        owner = JSON.parse(current);
      } catch {
        throw new WorkerError(`Task lock at ${file} is unreadable; refusing to replace it.`, EXIT.FAILED);
      }
      if (!Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== "string") {
        throw new WorkerError(`Task lock at ${file} is unreadable; refusing to replace it.`, EXIT.FAILED);
      }
      if (
        owner.pid === pid
        || alive(owner.pid)
        || await processGroupIsActive(file, owner.token, readFileImpl, processGroupAlive)
      ) {
        throw new WorkerError(`A worker already owns this task in ${repoRoot}.`, EXIT.FAILED);
      }
      await rmImpl(file, { force: true });
      await clearProcessGroupMarkers(file, owner.token, rmImpl);
    }

    const temp = `${file}.claim-${token}`;
    await writeFileImpl(temp, JSON.stringify({ pid, token }), { mode: 0o600 });
    try {
      await linkImpl(temp, file);
    } finally {
      await rmImpl(temp, { force: true });
    }
  }, options);

  let released = false;
  const release = async () => {
    if (released) return;
    await withMutationLock(workDir, async () => {
      let current;
      try {
        current = await readFileImpl(file, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") {
          released = true;
          return;
        }
        throw error;
      }
      let owner;
      try {
        owner = JSON.parse(current);
      } catch {
        throw new WorkerError(`Task lock at ${file} is unreadable; refusing to release it.`, EXIT.FAILED);
      }
      if (owner?.token !== token) {
        released = true;
        return;
      }
      await rmImpl(file, { force: true });
      await clearProcessGroupMarkers(file, token, rmImpl);
      released = true;
    }, options);
  };
  release.markProcessGroupStarting = () => withMutationLock(workDir, async () => {
    const current = await readOptionalFile(file, readFileImpl);
    const owner = parseLockOwner(current);
    if (owner?.token !== token) {
      throw new WorkerError(`Task lock at ${file} changed before Devin started.`, EXIT.FAILED);
    }
    const marker = processGroupMarkerPaths(file, token).starting;
    await writeFileImpl(marker, "starting\n", { mode: 0o600, flag: "wx" });
  }, options);
  release.setProcessGroupId = (processGroupId) => withMutationLock(workDir, async () => {
    if (!Number.isInteger(processGroupId) || processGroupId <= 0) {
      throw new WorkerError("Devin did not provide a valid process-group id.", EXIT.FAILED);
    }
    const current = await readOptionalFile(file, readFileImpl);
    const owner = parseLockOwner(current);
    if (owner?.token !== token) {
      throw new WorkerError(`Task lock at ${file} changed before Devin started.`, EXIT.FAILED);
    }
    const markers = processGroupMarkerPaths(file, token);
    await writeFileImpl(markers.processGroup, `${processGroupId}\n`, { mode: 0o600, flag: "wx" });
    await rmImpl(markers.starting, { force: true });
  }, options);
  return release;
}

const TASK_FLAGS = new Set(["tasks", "issue", "repo", "task", "model"]);

function readFlag(argv, index) {
  const arg = argv[index];
  const flagName = arg.split("=", 1)[0];
  if (
    WORKER_CLOUD_FLAGS.has(arg)
    || WORKER_CLOUD_FLAGS.has(flagName)
    || isCloudCliArg(flagName)
    || (!arg.startsWith("-") && isCloudCliArg(arg))
  ) {
    throw new WorkerError(
      `Refusing ${cloudFlagLabel(arg)}: this worker only runs the local Devin CLI (headless devin -p or a herdr-core lane), never Devin cloud, api.devin.ai, or Composio devin_mcp.`,
      EXIT.USAGE,
    );
  }
  if (arg === "--help" || arg === "-h") return { help: true, next: index };
  const name = arg.startsWith("--") ? arg.slice(2) : "";
  const equals = name.indexOf("=");
  const key = equals === -1 ? name : name.slice(0, equals);
  if (!TASK_FLAGS.has(key)) {
    throw new WorkerError(`Unknown argument ${JSON.stringify(key ? `--${key}` : arg)}.`, EXIT.USAGE);
  }
  if (equals !== -1) {
    // Explicit form: --task=--not-a-flag reaches any value, including one that
    // starts with "--". Only the flag name is echoed on refusal.
    const inline = name.slice(equals + 1);
    if (inline === "") throw new WorkerError(`Missing value for --${key}.`, EXIT.USAGE);
    return { key, value: inline, next: index };
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new WorkerError(`Missing value for --${key}.`, EXIT.USAGE);
  }
  return { key, value, next: index + 1 };
}

export function parseArgs(argv) {
  const parsed = { help: false, tasksPath: null, task: null };
  const flags = { issue: null, repo: null, task: null, model: null };
  for (let index = 0; index < argv.length; index += 1) {
    const step = readFlag(argv, index);
    index = step.next;
    if (step.help) {
      parsed.help = true;
      continue;
    }
    if (step.key === "tasks") parsed.tasksPath = step.value;
    else flags[step.key] = step.value;
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
  return cliChildEnv(base);
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
      signal: options.signal,
      windowsHide: true,
      killSignal: "SIGKILL",
    });
    return {
      stdout: String(result?.stdout ?? ""),
      stderr: String(result?.stderr ?? ""),
    };
  } catch (error) {
    if (error instanceof WorkerError) throw error;
    if (options.signal?.aborted) {
      throw new WorkerError(
        `Worker stopping after ${String(options.signal.reason ?? "termination signal")}.`,
        EXIT.FAILED,
      );
    }
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

function isProcessGroupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForProcessGroup(pid, stop) {
  if (!isProcessGroupAlive(pid)) return true;
  stop("SIGTERM");
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(pid)) return true;
    await new Promise((done) => setTimeout(done, 25));
  }
  return !isProcessGroupAlive(pid);
}

function attachChildStreamErrorHandlers(child, fail) {
  child.stdout?.on("error", (error) => {
    fail(new WorkerError(`Could not read Devin stdout stream (${error?.code ?? "I/O error"}).`, EXIT.FAILED));
  });
  child.stderr?.on("error", (error) => {
    fail(new WorkerError(`Could not read Devin stderr stream (${error?.code ?? "I/O error"}).`, EXIT.FAILED));
  });
}

const activeChildren = new Map();

export function installSignalForwarding(signalTarget = process, children = activeChildren) {
  let signal = null;
  const listeners = new Set();
  const forward = (received) => {
    signal ??= received;
    for (const stop of children.values()) stop(received);
    for (const listener of listeners) listener(signal);
  };
  const onInterrupt = () => forward("SIGINT");
  const onTerminate = () => forward("SIGTERM");
  signalTarget.on("SIGINT", onInterrupt);
  signalTarget.on("SIGTERM", onTerminate);
  return {
    get signal() {
      return signal;
    },
    onSignal(listener) {
      if (signal) {
        listener(signal);
        return () => {};
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      signalTarget.removeListener("SIGINT", onInterrupt);
      signalTarget.removeListener("SIGTERM", onTerminate);
      listeners.clear();
    },
  };
}

const LOG_STREAM_CLOSE_TIMEOUT_MS = 5_000;

async function closeStream(stream) {
  if (!stream.writableEnded && !stream.destroyed) stream.end();
  let timer;
  try {
    await Promise.race([
      finished(stream),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          stream.destroy();
          reject(Object.assign(new Error("Timed out closing Devin log stream."), { code: "ETIMEDOUT" }));
        }, LOG_STREAM_CLOSE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForChildClose(childClosed) {
  let timer;
  try {
    return await Promise.race([
      childClosed.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), LOG_STREAM_CLOSE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function defaultExecFile(command, args, options = {}) {
  return execFileAsync(command, args, options);
}

async function runCancelable(ctx, command, args, options) {
  const alreadyStopping = ctx.shutdownSignal?.();
  if (alreadyStopping) {
    throw new WorkerError(`Worker stopping after ${alreadyStopping}.`, EXIT.FAILED);
  }
  const controller = new AbortController();
  const unsubscribe = ctx.onShutdownSignal?.((signal) => controller.abort(signal));
  const signal = ctx.shutdownSignal?.();
  if (signal) {
    controller.abort(signal);
    unsubscribe?.();
    throw new WorkerError(`Worker stopping after ${signal}.`, EXIT.FAILED);
  }
  try {
    return await run(ctx.execFile, command, args, { ...options, signal: controller.signal });
  } finally {
    unsubscribe?.();
  }
}

export function defaultSpawn(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const createStream = options.createWriteStreamImpl ?? createWriteStream;
    const waitForProcessGroupImpl = options.waitForProcessGroupImpl ?? waitForProcessGroup;
    const stdoutStream = createStream(options.stdoutPath, { flags: "w", mode: 0o600 });
    const stderrStream = createStream(options.stderrPath, { flags: "w", mode: 0o600 });
    let settled = false;
    let finishing = false;
    let failure = null;
    let timer;
    let killTimer;
    let child;
    let resolveChildClosed;
    const childClosed = new Promise((resolve) => {
      resolveChildClosed = resolve;
    });
    let processGroupRegistration = Promise.resolve();
    const stop = (signal) => {
      if (!child?.pid || settled) return;
      signalTree(child, signal);
      if (!killTimer) {
        killTimer = setTimeout(() => signalTree(child, "SIGKILL"), 5000);
        killTimer.unref?.();
      }
    };
    const fail = (error) => {
      if (settled || failure) return;
      failure = error;
      child?.stdout?.unpipe(stdoutStream);
      child?.stderr?.unpipe(stderrStream);
      stop("SIGTERM");
    };
    stdoutStream.on("error", (error) => {
      fail(new WorkerError(`Could not write Devin stdout log (${error?.code ?? "I/O error"}).`, EXIT.FAILED));
    });
    stderrStream.on("error", (error) => {
      fail(new WorkerError(`Could not write Devin stderr log (${error?.code ?? "I/O error"}).`, EXIT.FAILED));
    });
    child = (options.spawnImpl ?? spawn)(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    activeChildren.set(child, stop);
    attachChildStreamErrorHandlers(child, fail);
    if (child.pid && options.onProcessGroup) {
      try {
        processGroupRegistration = Promise.resolve(options.onProcessGroup(child.pid)).catch((error) => {
          fail(new WorkerError(
            `Could not record Devin process group (${error?.code ?? "I/O error"}).`,
            EXIT.FAILED,
          ));
        });
      } catch (error) {
        fail(new WorkerError(
          `Could not record Devin process group (${error?.code ?? "I/O error"}).`,
          EXIT.FAILED,
        ));
      }
    }
    child.stdout?.pipe(stdoutStream);
    child.stderr?.pipe(stderrStream);
    let timedOut = false;
    timer = setTimeout(() => {
      const leaderExited = (
        (child?.exitCode !== null && child?.exitCode !== undefined)
        || (child?.signalCode !== null && child?.signalCode !== undefined)
      );
      if (leaderExited) {
        void finish(child.exitCode, child.signalCode).catch(rejectPromise);
        return;
      }
      timedOut = true;
      stop("SIGTERM");
    }, options.timeoutMs);
    const finish = async (code, signal) => {
      if (settled || finishing) return;
      finishing = true;
      clearTimeout(timer);
      if (!(await waitForProcessGroupImpl(child?.pid, stop))) {
        const error = failure ?? new WorkerError("Devin process group did not stop after termination.", EXIT.FAILED);
        error.preserveProcessGroupClaims = true;
        fail(error);
      }
      await processGroupRegistration;
      if (!(await waitForChildClose(childClosed))) {
        fail(failure ?? new WorkerError("Timed out waiting for Devin output streams to close.", EXIT.FAILED));
      }
      const logStreams = [
        ["stdout", stdoutStream],
        ["stderr", stderrStream],
      ];
      await Promise.all(logStreams.map(async ([name, stream]) => {
        try {
          await closeStream(stream);
        } catch (error) {
          fail(new WorkerError(
            `Could not write Devin ${name} log (${error?.code ?? "I/O error"}).`,
            EXIT.FAILED,
          ));
        }
      }));
      settled = true;
      clearTimeout(killTimer);
      activeChildren.delete(child);
      if (failure) rejectPromise(failure);
      else resolvePromise({ code: code ?? 1, signal, timedOut });
    };
    child.once("error", (error) => {
      if (error?.code === "ENOENT") {
        fail(new WorkerError(`Devin executable not found: ${command}.`, EXIT.FAILED));
        return;
      }
      fail(error instanceof Error ? error : new WorkerError(String(error), EXIT.FAILED));
    });
    child.once("exit", (code, signal) => {
      void finish(code, signal).catch(rejectPromise);
    });
    child.once("close", (code, signal) => {
      resolveChildClosed();
      void finish(code, signal).catch(rejectPromise);
    });
  });
}

function failureResult(error) {
  const message = redactSecrets(error instanceof Error ? error.message : String(error));
  const exitCode = error instanceof WorkerError ? error.exitCode : EXIT.FAILED;
  const result = { exitCode, message };
  if (typeof error?.url === "string") result.url = error.url;
  if (typeof error?.pushedBranch === "string") result.pushedBranch = error.pushedBranch;
  return result;
}

async function locateCheckout(task, ctx, env) {
  const repoInfo = await stat(task.repo);
  if (!repoInfo.isDirectory()) {
    throw new WorkerError(`Repo is not a directory: ${task.repo}`, EXIT.USAGE);
  }
  const repo = await realpath(task.repo);
  await run(ctx.execFile, "git", ["rev-parse", "--is-inside-work-tree"], { cwd: repo, timeoutMs: 15_000, env });
  const top = await run(ctx.execFile, "git", ["rev-parse", "--show-toplevel"], { cwd: repo, timeoutMs: 15_000, env });
  const repoRoot = await realpath(top.stdout.trim());
  const workRoot = await realpath(ctx.workDir);
  if (isPathInside(repoRoot, workRoot)) {
    throw new WorkerError("DEVIN_WORKER_WORK_DIR must be outside the target repository.", EXIT.USAGE);
  }
  return { repo, repoRoot, workRoot };
}

export function taskPaths(workRoot, task, repoRoot) {
  const branch = buildBranchName(task.issue, task.task);
  const dirName = branch.slice("devin/".length);
  const repoIdentity = createHash("sha256").update(repoRoot).digest("hex");
  const artifactName = `${repoIdentity}-${dirName}`;
  const paths = {
    branch,
    worktreePath: join(workRoot, "worktrees", artifactName),
    exportPath: join(workRoot, "exports", `${artifactName}.json`),
    stdoutPath: join(workRoot, "logs", `${artifactName}.stdout`),
    stderrPath: join(workRoot, "logs", `${artifactName}.stderr`),
    messagePath: join(workRoot, "messages", `${artifactName}.txt`),
    bodyPath: join(workRoot, "pr-bodies", `${artifactName}.md`),
  };
  if (!isPathInside(workRoot, paths.worktreePath) || !isPathInside(workRoot, paths.exportPath)) {
    throw new WorkerError("Refusing to create a worktree outside the work directory.", EXIT.FAILED);
  }
  return paths;
}

async function ensureLayout(workRoot) {
  for (const name of ["worktrees", "exports", "logs", "messages", "pr-bodies", "task-locks", "locks"]) {
    await mkdir(join(workRoot, name), { recursive: true, mode: 0o700 });
  }
}

async function runDevinSession(ctx, paths, env) {
  if (ctx.shutdownSignal?.()) {
    throw new WorkerError(`Worker stopping after ${ctx.shutdownSignal()}.`, EXIT.FAILED);
  }
  assertPilotOpen({
    modelId: ctx.model,
    now: typeof ctx.now === "function" ? ctx.now() : ctx.now,
    swe2Until: ctx.swe2Until,
    flashUntil: ctx.flashUntil,
  });
  const argv = assertLocalCliArgv(buildDevinArgv({ model: ctx.model, task: ctx.taskText, exportPath: paths.exportPath }));
  assertNoCloudRoute(env);
  let spawned;
  try {
    await ctx.markProcessGroupStarting?.();
    const signal = ctx.shutdownSignal?.();
    if (signal) throw new WorkerError(`Worker stopping after ${signal}.`, EXIT.FAILED);
    spawned = await ctx.spawnCommand(ctx.devinBin, argv, {
      cwd: paths.worktreePath,
      timeoutMs: ctx.timeoutMs,
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
      env,
      shell: false,
      onProcessGroup: (processGroupId) => ctx.setProcessGroupId?.(processGroupId),
    });
  } catch (error) {
    if (error instanceof WorkerError) throw error;
    const failure = new WorkerError(
      `Devin failed to start: ${redactSecrets(error instanceof Error ? error.message : String(error))}. Worktree kept at ${paths.worktreePath}.`,
      EXIT.FAILED,
    );
    if (error?.preserveProcessGroupClaims === true) {
      failure.preserveProcessGroupClaims = true;
    }
    throw failure;
  }
  if (spawned?.timedOut) {
    throw new WorkerError(
      `Devin timed out after ${ctx.timeoutMs}ms. Worktree kept at ${paths.worktreePath}. Export path: ${paths.exportPath}.`,
      EXIT.TIMEOUT,
    );
  }
  if (spawned?.code !== 0) {
    throw new WorkerError(
      `Devin exited ${spawned?.code ?? "unknown"}. Worktree kept at ${paths.worktreePath}. Export path: ${paths.exportPath}.`,
      EXIT.FAILED,
    );
  }
}

function assertCommittable(statusText, issue, paths, hasCommittedChanges = false) {
  const changed = porcelainPaths(statusText);
  if (changed.length === 0 && !hasCommittedChanges) {
    throw new WorkerError(
      `Devin made no changes for ${issue}. No pull request opened. Worktree kept at ${paths.worktreePath}. Export path: ${paths.exportPath}.`,
      EXIT.NO_CHANGES,
    );
  }
  for (const filePath of changed) {
    if (filePath.startsWith("\"") || filePath.includes("\n")) {
      throw new WorkerError("Refusing to commit a quoted or multiline git path. Worktree kept.", EXIT.FAILED);
    }
    if (isSensitivePath(filePath)) {
      throw new WorkerError(
        `Refusing to commit likely secret file ${JSON.stringify(filePath)}. Worktree kept at ${paths.worktreePath}.`,
        EXIT.FAILED,
      );
    }
  }
}

/**
 * A Devin session may commit its own work with the host git config.
 * `git status --porcelain` only sees the working tree, so the pushed commits
 * are diffed against the base branch and refused before anything leaves the
 * machine.
 */
export function assertNoSensitiveCommits(diffText, issue, paths) {
  for (const line of String(diffText).split("\n")) {
    const filePath = line.trim();
    if (filePath === "") continue;
    if (filePath.startsWith("\"")) {
      throw new WorkerError("Refusing to push a quoted git path. Nothing was pushed.", EXIT.FAILED);
    }
    if (isSensitivePath(filePath)) {
      throw new WorkerError(
        `Refusing to push ${issue}: a Devin commit touches likely secret file ${JSON.stringify(filePath)}. Nothing was pushed. Worktree kept at ${paths.worktreePath}.`,
        EXIT.FAILED,
      );
    }
  }
}

async function refuseSensitiveCommits({ ctx, paths, task, base, env, headRef }) {
  const target = headRef ?? `refs/heads/${paths.branch}`;
  const committed = await run(
    ctx.execFile,
    "git",
    ["log", "--diff-merges=separate", "--format=", "--name-only", "--no-renames", `origin/${base}..${target}`],
    { cwd: paths.worktreePath, timeoutMs: 30_000, env },
  );
  assertNoSensitiveCommits(committed.stdout, task.issue, paths);
}

async function publishPullRequest(task, ctx, paths, env) {
  const slug = slugFromTask(task.task);
  const base = ctx.base;
  const writeFileImpl = ctx.writeFile ?? writeFile;
  let pushed = false;
  const assertRunning = () => {
    const signal = ctx.shutdownSignal?.();
    if (signal) {
      const error = new WorkerError(
        pushed
          ? `Worker stopping after ${signal}. Branch ${paths.branch} was pushed, but no pull request was opened.`
          : `Worker stopping after ${signal}.`,
        EXIT.FAILED,
      );
      if (pushed) error.pushedBranch = paths.branch;
      throw error;
    }
  };
  assertRunning();
  await writeFileImpl(paths.messagePath, `devin(${task.issue}): ${slug}\n\nModel: ${task.model}\n`, { mode: 0o600 });
  await run(ctx.execFile, "git", ["add", "-A"], { cwd: paths.worktreePath, timeoutMs: 30_000, env });
  const staged = await run(ctx.execFile, "git", ["diff", "--cached", "--name-only", "--no-renames"], {
    cwd: paths.worktreePath,
    timeoutMs: 30_000,
    env,
  });
  assertNoSensitiveCommits(staged.stdout, task.issue, paths);
  if (staged.stdout.trim() !== "") {
    assertRunning();
    await run(ctx.execFile, "git", ["commit", "-F", paths.messagePath], { cwd: paths.worktreePath, timeoutMs: 30_000, env });
  }
  assertRunning();
  const branchHead = await run(ctx.execFile, "git", ["rev-parse", `refs/heads/${paths.branch}`], {
    cwd: paths.worktreePath,
    timeoutMs: 15_000,
    env,
  });
  const pinnedHead = branchHead.stdout.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(pinnedHead)) {
    throw new WorkerError("Refusing to push: branch head is not a valid Git commit ID.", EXIT.FAILED);
  }
  await refuseSensitiveCommits({ ctx, paths, task, base, env, headRef: pinnedHead });
  try {
    await runCancelable(ctx, "git", [
      "push",
      "--set-upstream",
      "origin",
      `${pinnedHead}:refs/heads/${paths.branch}`,
    ], {
      cwd: paths.worktreePath,
      timeoutMs: 60_000,
      env,
    });
    pushed = true;
  } catch (error) {
    const failure = error instanceof Error
      ? error
      : new WorkerError(String(error), EXIT.FAILED);
    failure.pushedBranch = paths.branch;
    failure.message = `${failure.message} Push outcome for branch ${paths.branch} is unknown; check the remote branch before retrying.`;
    throw failure;
  }
  assertRunning();
  const body = buildPrBody({
    issue: task.issue,
    task: task.task,
    modelId: task.model,
    transcriptPath: paths.exportPath,
  });
  try {
    await writeFileImpl(paths.bodyPath, body, { mode: 0o600 });
  } catch (error) {
    const failure = error instanceof Error
      ? error
      : new WorkerError(String(error), EXIT.FAILED);
    failure.pushedBranch = paths.branch;
    failure.message = `${failure.message} Branch ${paths.branch} was pushed; the pull request body could not be written. No pull request was requested.`;
    throw failure;
  }
  assertRunning();
  let created;
  try {
    created = await runCancelable(
      ctx,
      "gh",
      ["pr", "create", "--base", base, "--head", paths.branch, "--title", buildPrTitle(task.issue, slug), "--body-file", paths.bodyPath],
      { cwd: paths.worktreePath, timeoutMs: 60_000, env },
    );
  } catch (error) {
    const failure = error instanceof Error
      ? error
      : new WorkerError(String(error), EXIT.FAILED);
    failure.pushedBranch = paths.branch;
    failure.message = `${failure.message} Branch ${paths.branch} was pushed; check whether a pull request was opened before retrying.`;
    throw failure;
  }
  const url = created.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
  if (!/^https:\/\/\S+$/.test(url)) {
    const failure = new WorkerError(
      `Pull request command did not return a URL. Branch ${paths.branch} is pushed; check whether a pull request was opened before retrying. Body: ${paths.bodyPath}.`,
      EXIT.FAILED,
    );
    failure.pushedBranch = paths.branch;
    throw failure;
  }
  await run(ctx.execFile, "git", ["worktree", "remove", "--force", "--", paths.worktreePath], {
    cwd: ctx.repo,
    timeoutMs: 30_000,
    env,
  }).catch(() => {
    // The branch and pull request already exist. A leftover worktree is recoverable.
  });
  return { exitCode: EXIT.OK, url, branch: paths.branch, transcriptPath: paths.exportPath };
}

async function refExists(execFile, repo, ref, env) {
  try {
    await run(execFile, "git", ["show-ref", "--verify", "--quiet", ref], { cwd: repo, timeoutMs: 15_000, env });
    return true;
  } catch {
    return false;
  }
}

/**
 * A retry of the same issue+slug finds its own leftovers from the failed run:
 * the branch survives a failure and a timed-out run leaves its worktree in
 * place. Reuse them, so one issue keeps one branch and one pull request.
 * Unique branch names per attempt would open a second pull request and orphan
 * the first.
 */
async function ensureWorktree({ repo, repoRoot, paths, base, execFile, env }) {
  const existing = await stat(paths.worktreePath).then((info) => info.isDirectory(), () => false);
  if (existing) {
    const current = await run(execFile, "git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: paths.worktreePath,
      timeoutMs: 15_000,
      env,
    });
    if (current.stdout.trim() !== paths.branch) {
      throw new WorkerError(
        `Refusing to reuse ${paths.worktreePath}: it is not checked out on ${paths.branch}. Remove it and retry.`,
        EXIT.FAILED,
      );
    }
    const existingCommonDir = await run(execFile, "git", ["rev-parse", "--git-common-dir"], {
      cwd: paths.worktreePath,
      timeoutMs: 15_000,
      env,
    });
    const repoCommonDir = await run(execFile, "git", ["rev-parse", "--git-common-dir"], {
      cwd: repoRoot,
      timeoutMs: 15_000,
      env,
    });
    const [existingGitDir, repoGitDir] = await Promise.all([
      realpath(resolve(paths.worktreePath, existingCommonDir.stdout.trim())),
      realpath(resolve(repoRoot, repoCommonDir.stdout.trim())),
    ]);
    if (existingGitDir !== repoGitDir) {
      throw new WorkerError(
        `Refusing to reuse ${paths.worktreePath}: it belongs to a different repository.`,
        EXIT.FAILED,
      );
    }
    return;
  }
  if (await refExists(execFile, repo, `refs/heads/${paths.branch}`, env)) {
    await run(execFile, "git", ["worktree", "add", "--", paths.worktreePath, paths.branch], {
      cwd: repo,
      timeoutMs: 60_000,
      env,
    });
    return;
  }
  await run(
    execFile,
    "git",
    ["worktree", "add", "-b", paths.branch, "--", paths.worktreePath, `origin/${base}`],
    { cwd: repo, timeoutMs: 60_000, env },
  );
}

async function executeTask(task, ctx) {
  const env = ctx.childEnv ?? commandEnv(process.env);
  const { repo, repoRoot, workRoot } = await locateCheckout(task, ctx, env);
  const paths = taskPaths(workRoot, task, repoRoot);
  await ensureLayout(workRoot);
  await run(ctx.execFile, "git", ["check-ref-format", "--branch", paths.branch], { cwd: repo, timeoutMs: 15_000, env });
  const acquireTaskLockImpl = ctx.acquireTaskLock ?? acquireTaskLock;
  const releaseTask = await acquireTaskLockImpl(workRoot, repoRoot, paths.branch, {
    pid: ctx.pid,
    isPidAlive: ctx.isPidAlive,
    sleep: ctx.sleep,
  });
  const markProcessGroupStarting = async () => {
    await releaseTask.markProcessGroupStarting();
    await ctx.markLaneProcessGroupStarting?.();
  };
  const setProcessGroupId = async (processGroupId) => {
    await releaseTask.setProcessGroupId(processGroupId);
    await ctx.setLaneProcessGroupId?.(processGroupId);
  };
  let publishedResult;
  let operationError;
  const assertRunning = () => {
    const signal = ctx.shutdownSignal?.();
    if (signal) throw new WorkerError(`Worker stopping after ${signal}.`, EXIT.FAILED);
  };
  try {
    // Resolve and fetch the base before any work starts: the worktree must branch
    // off origin/<base>, and the pull request needs the same base later.
    assertRunning();
    const base = await resolveBaseBranch(repo, ctx.execFile, env);
    assertRunning();
    await run(ctx.execFile, "git", ["fetch", "--no-tags", "origin", base], {
      cwd: repo,
      timeoutMs: 120_000,
      env,
    });
    assertRunning();
    await ensureWorktree({ repo, repoRoot, paths, base, execFile: ctx.execFile, env });
    assertRunning();
    await runDevinSession({
      ...ctx,
      model: task.model,
      taskText: task.task,
      markProcessGroupStarting,
      setProcessGroupId,
    }, paths, env);
    await refuseSensitiveCommits({ ctx, paths, task, base, env });
    const status = await run(ctx.execFile, "git", ["status", "--porcelain=v1", "-uall", "-z"], {
      cwd: paths.worktreePath,
      timeoutMs: 30_000,
      env,
    });
    const committedChanges = await run(ctx.execFile, "git", [
      "diff",
      "--name-only",
      "--no-renames",
      `origin/${base}...refs/heads/${paths.branch}`,
    ], {
      cwd: paths.worktreePath,
      timeoutMs: 30_000,
      env,
    });
    assertCommittable(status.stdout, task.issue, paths, committedChanges.stdout.trim() !== "");
    if (ctx.shutdownSignal?.()) {
      throw new WorkerError(`Worker stopping after ${ctx.shutdownSignal()}.`, EXIT.FAILED);
    }
    publishedResult = await publishPullRequest(task, { ...ctx, repo, base }, paths, env);
  } catch (error) {
    operationError = error;
  }
  if (operationError?.preserveProcessGroupClaims !== true) {
    try {
      await releaseTask();
    } catch (error) {
      const releaseMessage = redactSecrets(error instanceof Error ? error.message : String(error));
      const previousMessage = operationError instanceof Error ? operationError.message : String(operationError ?? "");
      const message = publishedResult?.url
        ? `${previousMessage ? `${previousMessage} ` : ""}Pull request ${publishedResult.url} was opened. Task lock release failed: ${releaseMessage}.`
        : previousMessage
          ? `${previousMessage} Task lock release failed: ${releaseMessage}.`
          : `Task lock release failed: ${releaseMessage}.`;
      const exitCode = operationError instanceof WorkerError ? operationError.exitCode : EXIT.FAILED;
      const combinedError = new WorkerError(message, exitCode);
      if (publishedResult?.url) combinedError.url = publishedResult.url;
      combinedError.pushedBranch = operationError?.pushedBranch;
      operationError = combinedError;
    }
  }
  if (operationError) throw operationError;
  return publishedResult;
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
  let result;
  try {
    const model = resolveListedModel(task.model, ctx.catalog);
    assertPilotOpen({
      modelId: model,
      now: typeof ctx.now === "function" ? ctx.now() : ctx.now,
      swe2Until: ctx.swe2Until,
      flashUntil: ctx.flashUntil,
    });
    const lane = await (ctx.acquireLane ?? acquireLane)(ctx.workDir, ctx.lanes, {
      waitMs: ctx.laneWaitMs,
      sleep: ctx.sleep,
      isPidAlive: ctx.isPidAlive,
      shutdownSignal: ctx.shutdownSignal,
    });
    release = lane.release;
    result = await executeTask({
      ...task,
      model,
    }, {
      ...ctx,
      markLaneProcessGroupStarting: lane.markProcessGroupStarting,
      setLaneProcessGroupId: lane.setProcessGroupId,
    });
  } catch (error) {
    if (error?.preserveProcessGroupClaims === true) release = async () => {};
    result = failureResult(error);
  }
  try {
    await release();
  } catch (error) {
    const failure = failureResult(error);
    const prefix = result?.url
      ? `Pull request ${result.url} was opened. `
      : result?.message
        ? `${result.message} `
        : "";
    result = {
      ...result,
      exitCode: EXIT.FAILED,
      message: `${prefix}Lane release failed: ${failure.message}`,
    };
  }
  return result;
}

export async function runWorker(argv, deps = {}) {
  const env = deps.env ?? process.env;
  if (!isWorkerEnabled(env)) return { exitCode: EXIT.OK, results: [], disabled: true };
  const clock = deps.now ?? (() => new Date());
  const now = clock();
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
  assertNoCloudRoute(env);
  const route = resolveExecutionRoute(env);
  deps.log?.(routeLogLine(route));
  const config = loadWorkerConfig(env, now);
  await mkdir(config.workDir, { recursive: true, mode: 0o700 });
  const execFile = deps.execFile ?? defaultExecFile;
  const childEnv = commandEnv(env);
  const catalogArgv = assertCatalogArgv(["models", "list", "--format", "json"]);
  const listed = await run(
    execFile,
    config.devinBin,
    catalogArgv,
    { cwd: process.cwd(), timeoutMs: 30_000, env: childEnv },
  );
  const catalog = parseModelCatalog(listed.stdout);
  const signalForwarder = installSignalForwarding(deps.signalTarget ?? process);
  let results;
  try {
    results = await runWithLanes(tasks, config.lanes, (task) => {
      if (signalForwarder.signal) {
        return Promise.resolve(failureResult(new WorkerError(`Worker stopping after ${signalForwarder.signal}.`, EXIT.FAILED)));
      }
      return runOne(task, {
        ...config,
        now: clock,
        catalog,
        childEnv,
        execFile,
        spawnCommand: deps.spawnCommand ?? defaultSpawn,
        acquireTaskLock: deps.acquireTaskLock,
        writeFile: deps.writeFile,
        sleep: deps.sleep,
        isPidAlive: deps.isPidAlive,
        acquireLane: deps.acquireLane,
        shutdownSignal: () => signalForwarder.signal,
        onShutdownSignal: signalForwarder.onSignal,
      });
    });
  } finally {
    signalForwarder.dispose();
  }
  return {
    exitCode: combineExitCodes(results.map((result) => result.exitCode)),
    results,
    disabled: false,
    route,
  };
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
    const outcome = await runWorker(argv, { ...deps, log });
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
