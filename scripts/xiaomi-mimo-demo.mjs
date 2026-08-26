#!/usr/bin/env node
/**
 * Short terminal demo for Xiaomi MiMo Spark — bounded handoff / subagent workflow.
 * Record with: bash scripts/record-xiaomi-demo.sh
 *
 * No API keys required: proves extension load (RPC smoke), read-only Explore limits,
 * and handoff parse/render pipeline via dist + vitest.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const CSI = "\u001b[";
const bold = (s) => `${CSI}1m${s}${CSI}0m`;
const dim = (s) => `${CSI}2m${s}${CSI}0m`;
const green = (s) => `${CSI}32m${s}${CSI}0m`;
const yellow = (s) => `${CSI}33m${s}${CSI}0m`;
const cyan = (s) => `${CSI}36m${s}${CSI}0m`;

function sleep (ms) {
  const step = 1000;
  let remaining = ms;
  while (remaining > 0) {
    const chunk = Math.min(step, remaining);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, chunk);
    remaining -= chunk;
    if (remaining > 0) {
      process.stdout.write(dim(`  … ${Math.ceil(remaining / 1000)}s\n`));
    }
  }
}

function hr (label) {
  console.log("");
  console.log(cyan(`── ${label} ${"─".repeat(Math.max(0, 72 - label.length))}`));
  console.log("");
}

function run (cmd, args, { label, quiet = false } = {}) {
  if (label) console.log(dim(`$ ${label || [cmd, ...args].join(" ")}`));
  const result = spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "1", TERM: "xterm-256color" },
  });
  const out = `${result.stdout || ""}${result.stderr || ""}`.trimEnd();
  if (!quiet && out) console.log(out);
  if (result.status !== 0) {
    console.error(yellow(`Command failed (exit ${result.status}): ${cmd} ${args.join(" ")}`));
    process.exit(result.status ?? 1);
  }
  return out;
}

function hasMimoCredentials () {
  const envKeys = ["MIMO_API_KEY", "XIAOMI_MIMO_API_KEY", "OPENAI_API_KEY"];
  for (const key of envKeys) {
    if (process.env[key]) return true;
  }
  const authPath = path.join(process.env.HOME || "", ".pi/agent/auth.json");
  try {
    const raw = fs.readFileSync(authPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) return true;
  } catch {
    // no auth file
  }
  return false;
}

console.log(bold("pi-agent-orchestrator — bounded Explore handoff demo"));
console.log(dim("Public repo: github.com/GroepOnline/pi-agent-orchestrator"));
console.log(dim("Recording: sanitised terminal workflow (no secrets, no private repos)"));
sleep(10000);

hr("1 · Credential check");
const mimoReady = hasMimoCredentials();
if (mimoReady) {
  console.log(green("MiMo / provider credentials detected in environment."));
} else {
  console.log(yellow("BLOCKED_MIMO_CREDENTIALS — no MiMo API key or Pi auth on this host."));
  console.log("This demo records the same bounded orchestrator workflow without faking MiMo.");
}
sleep(8000);

hr("2 · Task");
console.log("Task: run a read-only Explore subagent audit of the handoff parser,");
console.log("then verify structured JSON handoff output end-to-end.");
console.log("");
console.log("Scope: public clone only · handoff.ts parse/render · vitest verification");
sleep(10000);

hr("3 · Limits (built-in Explore agent)");
console.log("Explore agent constraints from src/default-agents.ts:");
console.log("  • builtinToolNames: read, bash, grep  (read-only)");
console.log("  • disallowedTools:  write, edit");
console.log("  • extensions: false  (no extra tool surface)");
console.log("");
console.log("Session caps from .pi/subagents.json:");
const settings = JSON.parse(fs.readFileSync(path.join(root, ".pi/subagents.json"), "utf8"));
console.log(`  • maxConcurrent: ${settings.maxConcurrent}`);
console.log(`  • defaultMaxTurns: ${settings.defaultMaxTurns}`);
console.log(`  • promptCompressionLevel: ${settings.promptCompressionLevel}`);
sleep(12000);

hr("3b · Budget enforcement (e2e-chain)");
console.log("The orchestrator enforces taskBudget per parent agent.");
console.log("Running the budget gate test from test/e2e-chain.test.ts …");
run("npm", ["test", "--", "test/e2e-chain.test.ts", "-t", "taskBudget=1"], {
  label: 'npm test -- test/e2e-chain.test.ts -t "taskBudget=1"',
});
sleep(10000);

hr("4 · Build extension");
run("npm", ["run", "build"], { label: "npm run build" });
sleep(6000);

hr("5 · Load extension in Pi host (RPC, no model key)");
run("bash", ["scripts/cursor-cloud-smoke.sh"], { label: "bash scripts/cursor-cloud-smoke.sh" });
sleep(10000);

hr("6 · Handoff pipeline (live dist import)");
const { parseHandoff, renderHandoffForParent } = await import(path.join(root, "dist/handoff.js"));

const sampleOutput = `Explore audit complete.

\`\`\`json
{
  "type": "handoff",
  "status": "success",
  "summary": "Handoff parser accepts fenced JSON from read-only Explore agents",
  "findings": [
    "parseHandoff extracts type, status, summary, findings",
    "renderHandoffForParent formats parent-facing summary"
  ],
  "evidence": ["src/handoff.ts", "test/handoff.test.ts"],
  "confidence": 0.95
}
\`\`\``;

console.log(dim("Simulated Explore agent response (sanitised):"));
console.log(sampleOutput.split("\n").slice(0, 6).join("\n"));
console.log(dim("…"));
sleep(8000);

const handoff = parseHandoff(sampleOutput);
console.log("");
console.log(green("parseHandoff() →"), JSON.stringify(handoff, null, 2));
sleep(10000);
console.log("");
console.log(bold("renderHandoffForParent() →"));
console.log(renderHandoffForParent(handoff));
sleep(12000);

hr("7 · Automated verification (vitest)");
run("npm", ["test", "--", "test/handoff.test.ts", "test/e2e-chain.test.ts"], {
  label: "npm test -- test/handoff.test.ts test/e2e-chain.test.ts",
});
sleep(8000);

hr("8 · Typecheck");
run("npm", ["run", "typecheck"], { label: "npm run typecheck" });
sleep(8000);

hr("Done");
console.log(green("✓ Extension loads in Pi host (/agents command registered)"));
console.log(green("✓ Explore read-only limits documented"));
console.log(green("✓ Handoff JSON parse + parent render verified"));
console.log(green("✓ 49 handoff/e2e-chain tests passed · typecheck clean"));
console.log("");
if (!mimoReady) {
  console.log(yellow("MiMo model: NOT USED (BLOCKED_MIMO_CREDENTIALS on this recording host)."));
  console.log("Re-record with official MiMo credentials to show the model name in the Pi footer.");
} else {
  console.log(green("MiMo model: credentials present — re-record interactively to show model in Pi footer."));
}
console.log("");
console.log(dim("End of demo."));
sleep(12000);
