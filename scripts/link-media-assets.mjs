/**
 * link-media-assets.mjs — Point docs/images binary media at an external
 * checkout so the orchestrator repo stays source-sized.
 *
 * Resolution order for the external root:
 *   1. ORCHESTRATOR_MEDIA_DIR
 *   2. ../pi-agent-orchestrator-assets
 *   3. ../showcase-videos/orchestrator (optional layout)
 *
 * Usage:
 *   node scripts/link-media-assets.mjs          # symlink docs/images -> external/images
 *   node scripts/link-media-assets.mjs --status # print resolved paths
 *   node scripts/link-media-assets.mjs --unlink # restore an empty tracked stub dir
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LINK_PATH = join(ROOT, "docs", "images");

export function candidateMediaRoots(env = process.env, home = homedir()) {
  const fromEnv = typeof env.ORCHESTRATOR_MEDIA_DIR === "string" ? env.ORCHESTRATOR_MEDIA_DIR.trim() : "";
  const candidates = [];
  if (fromEnv) candidates.push(isAbsolute(fromEnv) ? fromEnv : resolve(ROOT, fromEnv));
  candidates.push(resolve(ROOT, "..", "pi-agent-orchestrator-assets"));
  candidates.push(resolve(ROOT, "..", "showcase-videos", "orchestrator"));
  candidates.push(join(home, "OrgChefgroep", "pi-agent-orchestrator-assets"));
  return candidates;
}

export function resolveMediaRoot(env = process.env, home = homedir()) {
  for (const candidate of candidateMediaRoots(env, home)) {
    const images = join(candidate, "images");
    if (existsSync(images)) return { root: candidate, images };
    if (existsSync(candidate) && existsSync(join(candidate, "dashboard_preview.mp4"))) {
      return { root: candidate, images: candidate };
    }
  }
  return null;
}

export function describeLinkState(linkPath = LINK_PATH) {
  if (!existsSync(linkPath)) return { state: "missing", target: null };
  const stat = lstatSync(linkPath);
  if (stat.isSymbolicLink()) {
    return { state: "symlink", target: readlinkSync(linkPath) };
  }
  return { state: "directory", target: null };
}

function printStatus() {
  const resolved = resolveMediaRoot();
  const link = describeLinkState();
  console.log(`checkout     ${ROOT}`);
  console.log(`docs/images  ${link.state}${link.target ? ` -> ${link.target}` : ""}`);
  console.log(`media root   ${resolved ? resolved.root : "(not found)"}`);
  console.log(`media images ${resolved ? resolved.images : "(not found)"}`);
  if (!resolved) {
    console.log("\nClone or create the assets repo next to this checkout:");
    console.log("  git clone git@github.com:GroepOnline/pi-agent-orchestrator-assets.git ../pi-agent-orchestrator-assets");
    console.log("Or set ORCHESTRATOR_MEDIA_DIR to an absolute path.");
  }
}

function link() {
  const resolved = resolveMediaRoot();
  if (!resolved) {
    throw new Error(
      "No external media root found. Set ORCHESTRATOR_MEDIA_DIR or clone pi-agent-orchestrator-assets as a sibling.",
    );
  }
  const current = describeLinkState();
  if (current.state === "symlink" && resolve(dirname(LINK_PATH), current.target) === resolved.images) {
    console.log(`Already linked: ${LINK_PATH} -> ${resolved.images}`);
    return;
  }
  if (current.state === "directory") {
    throw new Error(
      `${LINK_PATH} is still a tracked directory. Move binaries to the assets repo first, remove docs/images from git, then re-run.`,
    );
  }
  if (current.state === "symlink") rmSync(LINK_PATH, { force: true });
  mkdirSync(dirname(LINK_PATH), { recursive: true });
  symlinkSync(resolved.images, LINK_PATH, "dir");
  console.log(`Linked ${LINK_PATH} -> ${resolved.images}`);
}

function unlink() {
  const current = describeLinkState();
  if (current.state !== "symlink") {
    console.log("docs/images is not a symlink; nothing to unlink.");
    return;
  }
  rmSync(LINK_PATH, { force: true });
  mkdirSync(LINK_PATH, { recursive: true });
  console.log("Removed symlink; left an empty docs/images directory.");
}

async function main() {
  const cmd = process.argv[2] ?? "status";
  if (cmd === "status" || cmd === "--status") return printStatus();
  if (cmd === "link" || cmd === "--link") return link();
  if (cmd === "unlink" || cmd === "--unlink") return unlink();
  throw new Error(`unknown command ${JSON.stringify(cmd)}; expected status|link|unlink`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
