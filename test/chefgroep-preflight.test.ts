import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHEFGROEP_PREFLIGHT_MAX_BYTES,
  loadChefGroepPreflight,
  resolveChefGroepContextPath,
} from "../src/chefgroep-preflight.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "chefgroep-preflight-"));
  temporaryDirectories.push(directory);
  return directory;
}

function validContext(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    generated_at: "2026-07-25T15:00:00+00:00",
    instruction: "mandatory preflight",
    release: { desired: { version: "1.3.0" }, source_commit: "a".repeat(40) },
    fleet: { control_plane: "joep", nodes: [{ id: "sofie-1", managed: true }] },
    datastores: [{ id: "example", status: "active" }],
    github: { repositories: 10 },
    audit: { ok: true, issues: [] },
    paths: { snapshot: "/state/current.json" },
    ...extra,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolveChefGroepContextPath", () => {
  it("uses the XDG state directory by default", () => {
    expect(resolveChefGroepContextPath({ env: { XDG_STATE_HOME: "/state" }, homeDir: "/home/test" }))
      .toBe(resolve("/state", "chefgroep-os", "inventory", "agent-context.json"));
  });

  it("uses the explicit context override", () => {
    expect(resolveChefGroepContextPath({
      env: { CHEF_AGENT_CONTEXT_FILE: "/tmp/custom-context.json" },
      homeDir: "/home/test",
    })).toBe(resolve("/tmp/custom-context.json"));
  });
});

describe("loadChefGroepPreflight", () => {
  it("loads valid context and injects mutation logging rules", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "context.json");
    writeFileSync(path, JSON.stringify(validContext({ secret_value: "must-not-be-injected" })));

    const result = loadChefGroepPreflight({
      env: { CHEF_AGENT_CONTEXT_FILE: path },
      agentId: "agent-run-123",
    });

    expect(result.status).toBe("loaded");
    expect(result.systemPromptAddition).toContain("ChefGroep Operational Preflight");
    expect(result.systemPromptAddition).toContain("CHEF_AGENT_RUN_ID=agent-run-123");
    expect(result.systemPromptAddition).toContain("chef-inventory record");
    expect(result.systemPromptAddition).toContain('"control_plane":"joep"');
    expect(result.systemPromptAddition).not.toContain("secret_value");
    expect(result.systemPromptAddition).not.toContain("must-not-be-injected");
  });

  it("fails open when the context file is absent", () => {
    const result = loadChefGroepPreflight({
      env: { CHEF_AGENT_CONTEXT_FILE: "/definitely/missing/context.json" },
    });
    expect(result).toMatchObject({ status: "missing" });
    expect(result.systemPromptAddition).toBeUndefined();
  });

  it("can be disabled explicitly", () => {
    const result = loadChefGroepPreflight({
      env: { CHEF_AGENT_PREFLIGHT: "off", CHEF_AGENT_CONTEXT_FILE: "/missing.json" },
    });
    expect(result.status).toBe("disabled");
  });

  it("rejects malformed JSON without throwing", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "context.json");
    writeFileSync(path, "{not-json");

    expect(() => loadChefGroepPreflight({ env: { CHEF_AGENT_CONTEXT_FILE: path } })).not.toThrow();
    expect(loadChefGroepPreflight({ env: { CHEF_AGENT_CONTEXT_FILE: path } }).status).toBe("invalid");
  });

  it("rejects a context missing mandatory operational sections", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "context.json");
    writeFileSync(path, JSON.stringify({ schema_version: 1, fleet: {} }));

    const result = loadChefGroepPreflight({ env: { CHEF_AGENT_CONTEXT_FILE: path } });
    expect(result.status).toBe("invalid");
    expect(result.error).toMatch(/fleet, datastores, and audit/);
  });

  it("rejects oversized context before parsing it", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "context.json");
    writeFileSync(path, "x".repeat(CHEFGROEP_PREFLIGHT_MAX_BYTES + 1));

    const result = loadChefGroepPreflight({ env: { CHEF_AGENT_CONTEXT_FILE: path } });
    expect(result.status).toBe("oversize");
    expect(result.error).toMatch(/limit/);
  });

  it("rejects directories as non-regular context files", () => {
    const directory = temporaryDirectory();
    const result = loadChefGroepPreflight({ env: { CHEF_AGENT_CONTEXT_FILE: directory } });
    expect(result.status).toBe("invalid");
    expect(result.error).toMatch(/regular file/);
  });

  if (process.platform !== "win32") {
    it("rejects a FIFO without blocking on an unbounded read", () => {
      const directory = temporaryDirectory();
      const path = join(directory, "context.pipe");
      const created = spawnSync("mkfifo", [path], { encoding: "utf8" });
      expect(created.status, created.stderr).toBe(0);

      const startedAt = Date.now();
      const result = loadChefGroepPreflight({ env: { CHEF_AGENT_CONTEXT_FILE: path } });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(result.status).toBe("invalid");
      expect(result.error).toMatch(/regular file/);
    });
  }
});

describe("agent runner integration", () => {
  it("injects the ChefGroep preflight for every subagent spawn", () => {
    const runner = readFileSync(new URL("../src/agent-runner.ts", import.meta.url), "utf8");
    expect(runner).toContain("loadChefGroepPreflight({ agentId: options.agentId })");
    expect(runner).toContain("ChefGroep operational preflight injected");
    expect(runner.indexOf("loadChefGroepPreflight")).toBeLessThan(runner.indexOf("buildCtxInjection()"));
  });
});
