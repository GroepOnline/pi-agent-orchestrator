/**
 * dev-runner.test.ts — Unit coverage for the local dev-run helper: agent
 * directory resolution, checkout registration lookup, and build staleness.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRunArgs,
  describeBuildState,
  findRegistration,
  resolveAgentDir,
  resolvePackageEntry,
} from "../scripts/dev.mjs";

describe("resolveAgentDir", () => {
  it("prefers PI_CODING_AGENT_DIR when set", () => {
    expect(resolveAgentDir({ PI_CODING_AGENT_DIR: "/custom/agent" }, "/home/dev")).toBe(resolve("/custom/agent"));
  });

  it("ignores a blank override and falls back to the default location", () => {
    expect(resolveAgentDir({ PI_CODING_AGENT_DIR: "   " }, "/home/dev")).toBe(join("/home/dev", ".pi", "agent"));
  });

  it("defaults to ~/.pi/agent when no override is present", () => {
    expect(resolveAgentDir({}, "/home/dev")).toBe(join("/home/dev", ".pi", "agent"));
  });

  it("uses the real home directory when no arguments are supplied", () => {
    expect(resolveAgentDir()).toBe(resolveAgentDir(process.env, homedir()));
  });
});

describe("resolvePackageEntry", () => {
  it("resolves relative entries against the agent directory", () => {
    expect(resolvePackageEntry("../../work/orchestrator", "/home/dev/.pi/agent")).toBe(
      resolve("/home/dev/.pi/agent", "../../work/orchestrator"),
    );
  });

  it("keeps absolute entries untouched", () => {
    expect(resolvePackageEntry("/opt/orchestrator", "/home/dev/.pi/agent")).toBe(resolve("/opt/orchestrator"));
  });

  it("returns null for empty entries", () => {
    expect(resolvePackageEntry("   ", "/home/dev/.pi/agent")).toBeNull();
    expect(resolvePackageEntry(undefined, "/home/dev/.pi/agent")).toBeNull();
  });
});

describe("findRegistration", () => {
  const agentDir = resolve("/home/dev/.pi/agent");
  const checkout = resolve("/home/dev/work/orchestrator");

  it("matches a relative entry that points at the checkout", () => {
    const settings = { packages: ["../../work/orchestrator"] };
    expect(findRegistration(settings, checkout, agentDir)).toBe("../../work/orchestrator");
  });

  it("matches an absolute entry that points at the checkout", () => {
    const absolute = resolve("/home/work/orchestrator");
    const settings = { packages: [absolute] };
    expect(findRegistration(settings, absolute, agentDir)).toBe(absolute);
  });

  it("returns null when a different package is registered", () => {
    const settings = { packages: ["../../work/other-extension"] };
    expect(findRegistration(settings, resolve("/home/work/orchestrator"), agentDir)).toBeNull();
  });

  it("tolerates missing or malformed settings", () => {
    const target = resolve("/home/work/orchestrator");
    expect(findRegistration(null, target, agentDir)).toBeNull();
    expect(findRegistration({}, target, agentDir)).toBeNull();
    expect(findRegistration({ packages: "nope" }, target, agentDir)).toBeNull();
  });
});

describe("describeBuildState", () => {
  it("reports missing when dist has never been built", () => {
    expect(describeBuildState({ distEntryMtimeMs: null, newestSourceMtimeMs: 10 })).toEqual({
      state: "missing",
      stale: true,
    });
  });

  it("reports stale when a source file is newer than the build output", () => {
    expect(describeBuildState({ distEntryMtimeMs: 10, newestSourceMtimeMs: 20 })).toEqual({
      state: "stale",
      stale: true,
    });
  });

  it("reports fresh when the build output is newer than every source file", () => {
    expect(describeBuildState({ distEntryMtimeMs: 30, newestSourceMtimeMs: 20 })).toEqual({
      state: "fresh",
      stale: false,
    });
  });

  it("treats an equal timestamp as fresh so an in-place rebuild is not looped", () => {
    expect(describeBuildState({ distEntryMtimeMs: 20, newestSourceMtimeMs: 20 })).toEqual({
      state: "fresh",
      stale: false,
    });
  });

  it("reports fresh when no sources were found", () => {
    expect(describeBuildState({ distEntryMtimeMs: 20, newestSourceMtimeMs: null })).toEqual({
      state: "fresh",
      stale: false,
    });
  });
});

describe("buildRunArgs", () => {
  it("loads the built entry through the host --extension flag", () => {
    expect(buildRunArgs("/repo/dist/index.js")).toEqual(["--extension", "/repo/dist/index.js"]);
  });

  it("forwards additional pi arguments after the extension flag", () => {
    expect(buildRunArgs("/repo/dist/index.js", ["--model", "anthropic/claude-haiku-4-5"])).toEqual([
      "--extension",
      "/repo/dist/index.js",
      "--model",
      "anthropic/claude-haiku-4-5",
    ]);
  });
});

describe("dev script wiring", () => {
  const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"));

  it("exposes the documented dev commands", () => {
    expect(pkg.scripts.dev).toContain("--watch");
    expect(pkg.scripts["dev:status"]).toBe("node scripts/dev.mjs status");
    expect(pkg.scripts["dev:link"]).toBe("node scripts/dev.mjs link");
    expect(pkg.scripts["dev:unlink"]).toBe("node scripts/dev.mjs unlink");
    expect(pkg.scripts["dev:run"]).toBe("node scripts/dev.mjs run");
  });

  it("keeps the watch build writing to the same entry the host loads", () => {
    expect(pkg.pi.extensions).toContain("./dist/index.js");
  });
});
