import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Mirrors the host's agent-directory resolution without importing a host package. */
export function resolveAgentDir(env = process.env, home = homedir()) {
  const override = env.PI_CODING_AGENT_DIR;
  if (typeof override === "string" && override.trim().length > 0) return resolve(override.trim());
  return join(home, ".pi", "agent");
}

/** Settings `packages` entries are stored relative to the agent directory. */
export function resolvePackageEntry(entry, agentDir) {
  const value = String(entry ?? "").trim();
  if (value.length === 0) return null;
  return isAbsolute(value) ? resolve(value) : resolve(agentDir, value);
}

export function findRegistration(settings, checkoutRoot, agentDir) {
  const target = resolve(checkoutRoot);
  const entries = Array.isArray(settings?.packages) ? settings.packages : [];
  for (const entry of entries) {
    if (resolvePackageEntry(entry, agentDir) === target) return String(entry);
  }
  return null;
}

/**
 * dist/ is stale when any source file is newer than the oldest build output,
 * which is what makes a dev run silently execute yesterday's code.
 */
export function describeBuildState({ distEntryMtimeMs, newestSourceMtimeMs }) {
  if (distEntryMtimeMs === null) return { state: "missing", stale: true };
  if (newestSourceMtimeMs === null) return { state: "fresh", stale: false };
  if (newestSourceMtimeMs > distEntryMtimeMs) return { state: "stale", stale: true };
  return { state: "fresh", stale: false };
}

export function buildRunArgs(entryPath, passthrough = []) {
  return ["--extension", entryPath, ...passthrough];
}

async function mtimeMs(path) {
  return await stat(path)
    .then((info) => info.mtimeMs)
    .catch(() => null);
}

async function newestSourceMtime(root) {
  const { readdir } = await import("node:fs/promises");
  let newest = null;
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const value = await mtimeMs(full);
      if (value !== null && (newest === null || value > newest)) newest = value;
    }
  };
  await walk(join(root, "src"));
  return newest;
}

async function readJson(path) {
  return await readFile(path, "utf8")
    .then((raw) => JSON.parse(raw))
    .catch(() => null);
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: "inherit", cwd: ROOT, ...options });
    child.on("error", rejectRun);
    child.on("exit", (code, signal) => {
      if (signal) return rejectRun(new Error(`${command} terminated with ${signal}`));
      resolveRun(code ?? 0);
    });
  });
}

async function readState() {
  const agentDir = resolveAgentDir();
  const globalSettings = await readJson(join(agentDir, "settings.json"));
  const projectSettings = await readJson(join(ROOT, ".pi", "settings.json"));
  const pkg = await readJson(join(ROOT, "package.json"));
  const distEntry = join(ROOT, "dist", "index.js");
  const build = describeBuildState({
    distEntryMtimeMs: await mtimeMs(distEntry),
    newestSourceMtimeMs: await newestSourceMtime(ROOT),
  });
  return {
    agentDir,
    distEntry,
    version: pkg?.version ?? "unknown",
    build,
    globalEntry: findRegistration(globalSettings, ROOT, agentDir),
    projectEntry: findRegistration(projectSettings, ROOT, agentDir),
  };
}

async function ensureBuilt(state) {
  if (!state.build.stale) return;
  console.log(`dist/ is ${state.build.state}; building once before launching.`);
  const code = await run(process.execPath, [
    "--max-old-space-size=4096",
    join(ROOT, "node_modules", "typescript", "bin", "tsc"),
  ]);
  if (code !== 0) throw new Error(`build failed with exit code ${code}`);
}

async function commandStatus() {
  const state = await readState();
  console.log(`checkout       ${ROOT}`);
  console.log(`version        ${state.version}`);
  console.log(`agent dir      ${state.agentDir}`);
  console.log(`dist/index.js  ${state.build.state}`);
  console.log(`linked (user)  ${state.globalEntry ?? "no"}`);
  console.log(`linked (proj)  ${state.projectEntry ?? "no"}`);
  if (state.build.stale) console.log("\nRun `npm run dev` to rebuild on every change.");
  if (!state.globalEntry && !state.projectEntry) {
    console.log("Run `npm run dev:link` to load this checkout in every pi session.");
  }
}

async function commandLink(argv) {
  const local = argv.includes("--local") || argv.includes("-l");
  const state = await readState();
  const existing = local ? state.projectEntry : state.globalEntry;
  if (existing) {
    console.log(`Already linked as ${existing}; nothing to do.`);
    return;
  }
  await ensureBuilt(state);
  const args = ["install", ROOT];
  if (local) args.push("--local");
  await run("pi", args);
  await commandStatus();
}

async function commandUnlink(argv) {
  const local = argv.includes("--local") || argv.includes("-l");
  const state = await readState();
  const existing = local ? state.projectEntry : state.globalEntry;
  if (!existing) {
    console.log("Not linked; nothing to do.");
    return;
  }
  const args = ["remove", existing];
  if (local) args.push("--local");
  await run("pi", args);
  await commandStatus();
}

async function commandRun(argv) {
  const state = await readState();
  await ensureBuilt(state);
  if (state.globalEntry || state.projectEntry) {
    console.log("Note: this checkout is also linked, so pi would load it anyway.");
  }
  const code = await run("pi", buildRunArgs(state.distEntry, argv), { cwd: process.cwd() });
  process.exitCode = code;
}

const COMMANDS = {
  status: commandStatus,
  link: commandLink,
  unlink: commandUnlink,
  run: commandRun,
};

async function main() {
  const [command = "status", ...argv] = process.argv.slice(2);
  const handler = COMMANDS[command];
  if (!handler) {
    throw new Error(`unknown command ${JSON.stringify(command)}; expected one of ${Object.keys(COMMANDS).join(", ")}`);
  }
  await handler(argv);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
