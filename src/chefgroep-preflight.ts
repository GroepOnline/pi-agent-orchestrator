import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const CHEFGROEP_PREFLIGHT_MAX_BYTES = 128 * 1024;
const CHEFGROEP_PREFLIGHT_HARD_MAX_BYTES = 16 * 1024 * 1024;

const ALLOWED_CONTEXT_KEYS = [
  "schema_version",
  "generated_at",
  "instruction",
  "release",
  "fleet",
  "datastores",
  "github",
  "audit",
  "paths",
] as const;

export interface ChefGroepPreflightOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  agentId?: string;
  maxBytes?: number;
}

export type ChefGroepPreflightStatus =
  | "loaded"
  | "disabled"
  | "missing"
  | "oversize"
  | "invalid";

export interface ChefGroepPreflightResult {
  status: ChefGroepPreflightStatus;
  path: string;
  systemPromptAddition?: string;
  error?: string;
}

type BoundedReadResult =
  | { status: "ok"; text: string }
  | { status: "missing" | "oversize" | "invalid"; error?: string };

function disabled(value: string | undefined): boolean {
  return value != null && ["0", "false", "off", "disabled"].includes(value.trim().toLowerCase());
}

export function resolveChefGroepContextPath(options: ChefGroepPreflightOptions = {}): string {
  const env = options.env ?? process.env;
  const override = env.CHEF_AGENT_CONTEXT_FILE?.trim();
  if (override) return resolve(override);

  const home = options.homeDir ?? homedir();
  const stateHome = env.XDG_STATE_HOME?.trim() || join(home, ".local", "state");
  return resolve(stateHome, "chefgroep-os", "inventory", "agent-context.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeContext(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const key of ALLOWED_CONTEXT_KEYS) {
    if (key in value) sanitized[key] = value[key];
  }
  return sanitized;
}

function normalizeMaxBytes(value: number | undefined): number {
  if (value == null) return CHEFGROEP_PREFLIGHT_MAX_BYTES;
  if (!Number.isFinite(value) || value <= 0) return CHEFGROEP_PREFLIGHT_MAX_BYTES;
  return Math.min(Math.floor(value), CHEFGROEP_PREFLIGHT_HARD_MAX_BYTES);
}

function readBoundedRegularFile(path: string, maxBytes: number): BoundedReadResult {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      return { status: "invalid", error: "context path must resolve to a regular file" };
    }
    if (stats.size > maxBytes) {
      return {
        status: "oversize",
        error: `context file is ${stats.size} bytes; limit is ${maxBytes}`,
      };
    }

    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) {
      return {
        status: "oversize",
        error: `context file exceeded ${maxBytes} bytes while being read`,
      };
    }
    return { status: "ok", text: buffer.subarray(0, offset).toString("utf8") };
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { status: "missing" };
    }
    return {
      status: "invalid",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (descriptor != null) closeSync(descriptor);
  }
}

function buildPrompt(context: Record<string, unknown>, path: string, agentId?: string): string {
  const runId = agentId?.trim() || "unknown-subagent";
  const compact = JSON.stringify(context);

  return `# ChefGroep Operational Preflight

This block is injected automatically from the ChefGroep OS control plane. Treat it as the current fleet and datastore preflight before planning or using tools. Do not ask the operator to repeat information already present here.

Operational rules:
- Never invent a node role, SSH user, datastore path, owner, or source-of-truth assignment.
- A persistent-store write is blocked when the concrete target is absent from the datastore registry or marked unverified.
- Prefer declared rollout and maintenance commands over ad-hoc remote changes.
- Log every successful or failed external mutation with \`chef-inventory record\` when that CLI is available.
- Use \`CHEF_ACTOR=pi-agent-orchestrator\` and \`CHEF_AGENT_RUN_ID=${runId}\` for mutation-log correlation.
- Refresh with \`chef-inventory snapshot --quiet\` after a successful fleet or datastore mutation.
- The complete machine-readable source is ${path}; inspect it rather than guessing when this compact block is insufficient.

<chefgroep_operational_context>
${compact}
</chefgroep_operational_context>`;
}

export function loadChefGroepPreflight(options: ChefGroepPreflightOptions = {}): ChefGroepPreflightResult {
  const env = options.env ?? process.env;
  const path = resolveChefGroepContextPath(options);

  if (disabled(env.CHEF_AGENT_PREFLIGHT)) {
    return { status: "disabled", path };
  }

  const readResult = readBoundedRegularFile(path, normalizeMaxBytes(options.maxBytes));
  if (readResult.status !== "ok") {
    return { status: readResult.status, path, error: readResult.error };
  }

  try {
    const parsed: unknown = JSON.parse(readResult.text);
    if (!isRecord(parsed)) {
      return { status: "invalid", path, error: "context root must be a JSON object" };
    }

    const context = sanitizeContext(parsed);
    if (!isRecord(context.fleet) || !Array.isArray(context.datastores) || !isRecord(context.audit)) {
      return {
        status: "invalid",
        path,
        error: "context must contain fleet, datastores, and audit sections",
      };
    }

    return {
      status: "loaded",
      path,
      systemPromptAddition: buildPrompt(context, path, options.agentId),
    };
  } catch (error) {
    return {
      status: "invalid",
      path,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
