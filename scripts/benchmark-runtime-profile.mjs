import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = Math.max(3, Number.parseInt(process.env.BENCH_RUNS ?? "5", 10) || 5);

const FEATURE_MODULES = {
  host: ["@earendil-works/pi-coding-agent"],
  core: [
    "./dist/agent-manager.js",
    "./dist/agent-runner.js",
    "./dist/tools/agent.js",
    "./dist/tools/get-result.js",
    "./dist/tools/steer.js",
  ],
  worktrees: ["./dist/worktree.js"],
  "swarms-groups": [
    "./dist/batch-orchestrator.js",
    "./dist/group-join.js",
    "./dist/swarm-join.js",
    "./dist/orchestration-dispatch.js",
  ],
  scheduling: ["./dist/schedule.js", "./dist/schedule-store.js"],
  observability: [
    "./dist/telemetry.js",
    "./dist/debug-capture.js",
  ],
  tui: [
    "./dist/ui/agent-dashboard.js",
    "./dist/ui/live-widgets.js",
    "./dist/ui/notification-renderer.js",
  ],
  full: ["./dist/index.js"],
};

const FEATURE_DEPENDENCIES = {
  "@sinclair/typebox": "core",
  croner: "scheduling",
};

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

function measureImports(modules) {
  const samples = [];
  const imports = modules.map((specifier) => `await import(${JSON.stringify(specifier)});`).join("");
  const program = `const before=process.memoryUsage().rss;const start=performance.now();${imports}const after=process.memoryUsage().rss;console.log(JSON.stringify({ms:performance.now()-start,rssDelta:after-before,rss:after}));`;

  for (let attempt = 0; attempt < RUNS; attempt++) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
      cwd: ROOT,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`cold import failed: ${result.stderr || result.stdout}`);
    }
    samples.push(JSON.parse(result.stdout.trim()));
  }

  return {
    runs: RUNS,
    medianMs: Number(median(samples.map((sample) => sample.ms)).toFixed(2)),
    medianRssDeltaMiB: Number((median(samples.map((sample) => sample.rssDelta)) / 1048576).toFixed(2)),
    medianRssAfterMiB: Number((median(samples.map((sample) => sample.rss)) / 1048576).toFixed(2)),
  };
}

function featureForPath(path) {
  const normalized = path.replace(/^src\//, "dist/").replace(/\.ts$/, ".js");
  if (normalized.startsWith("showcase/") || normalized.startsWith("site/") || normalized.startsWith("docs/images/")) return "showcase";
  if (normalized.startsWith("dist/ui/") || normalized.startsWith("dist/commands/")) return "tui";
  if (/dist\/(?:schedule|schedule-store)\./.test(normalized)) return "scheduling";
  if (/dist\/(?:telemetry|debug-capture|health-report)\./.test(normalized)) return "observability";
  if (/dist\/worktree\./.test(normalized)) return "worktrees";
  if (/dist\/(?:batch-orchestrator|group-join|swarm-join|orchestration-dispatch)\./.test(normalized)) return "swarms-groups";
  if (normalized.startsWith("dist/")) return "core";
  return "other";
}

function getPackMetrics() {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const packed = JSON.parse(raw)[0];
  const byFeature = {};
  for (const file of packed.files ?? []) {
    const feature = featureForPath(file.path);
    byFeature[feature] = (byFeature[feature] ?? 0) + file.size;
  }
  return {
    packedBytes: packed.size,
    unpackedBytes: packed.unpackedSize,
    fileCount: packed.entryCount,
    unpackedFileBytesByFeature: byFeature,
  };
}

function packageEngines(name) {
  try {
    const manifest = JSON.parse(readFileSync(resolve(ROOT, "node_modules", name, "package.json"), "utf8"));
    return manifest.engines?.node ?? null;
  } catch {
    return null;
  }
}

const packageJson = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(resolve(ROOT, "package-lock.json"), "utf8"));
const lockPackages = Object.entries(lock.packages ?? {}).filter(([path]) => path !== "");
const installGraph = {
  totalPackages: lockPackages.length,
  productionPackages: lockPackages.filter(([, value]) => !value.dev && !value.optional).length,
  runtimeOptionalPackages: lockPackages.filter(([, value]) => !value.dev && value.optional).length,
  developmentPackages: lockPackages.filter(([, value]) => value.dev).length,
  directRuntimeDependencies: Object.keys(packageJson.dependencies ?? {}).map((name) => ({
    name,
    feature: FEATURE_DEPENDENCIES[name] ?? "core",
    version: lock.packages?.[`node_modules/${name}`]?.version ?? null,
    node: packageEngines(name),
  })),
  peerNodeFloors: Object.keys(packageJson.peerDependencies ?? {}).map((name) => ({
    name,
    node: packageEngines(name),
  })),
};

const coldImports = Object.fromEntries(
  Object.entries(FEATURE_MODULES).map(([feature, modules]) => [feature, measureImports(modules)]),
);

const report = {
  package: `${packageJson.name}@${packageJson.version}`,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  packageEngine: packageJson.engines?.node ?? null,
  pack: getPackMetrics(),
  installGraph,
  coldImports,
  nodeFloorFinding: {
    piHost: packageEngines("@earendil-works/pi-coding-agent"),
    piCore: packageEngines("@earendil-works/pi-agent-core"),
    piAi: packageEngines("@earendil-works/pi-ai"),
    conclusion: "The Pi execution stack supports Node >=22.19.0; the stricter package floor (>=22.22.3) follows release runtime policy aligned with Pi host engine requirements, not core agent execution overhead.",
  },
};

console.log(JSON.stringify(report, null, 2));
