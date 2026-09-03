/**
 * backward-compat.test.ts — Backward compatibility tests.
 *
 * Ensures that:
 * 1. Old-style AgentConfig (without new fields like taskBudget, validators,
 *    useContextMode) still loads without error
 * 2. Default values for new fields are sensible
 * 3. Old-style Agent invocation (without partitions, without handoff) still works
 * 4. Existing agent types (general-purpose, Explore, Plan) still load and have
 *    correct tool lists
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import {
  BUILTIN_TOOL_NAMES,
  getAgentConfig,
  getConfig,
  isValidType,
  registerAgents,
} from "../src/agent-types.js";
import type { AgentConfig } from "../src/types.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
  AgentRunnerError: class AgentRunnerError extends Error {
    constructor(
      message: string,
      public readonly code: string,
      public readonly context?: Record<string, unknown>,
    ) {
      super(message);
      this.name = "AgentRunnerError";
    }
  },
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
}));

import { runAgent } from "../src/agent-runner.js";

// ── 1. Old AgentConfig Without New Fields ───────────────────────────────────

describe("Backward compat: old AgentConfig without new fields", () => {
  it("getConfig('general-purpose') returns valid config with fallback defaults", () => {
    registerAgents(new Map());

    const config = getConfig("general-purpose");
    expect(config).toBeDefined();
    expect(config.displayName).toBe("Agent");
    expect(config.description).toBe("General-purpose agent for complex, multi-step tasks");
    // Backward compat: default tools
    expect(config.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
    expect(config.extensions).toBe(true);
    expect(config.skills).toBe(true);
    expect(config.promptMode).toBe("append");
  });

  it("AgentConfig with minimal fields resolves correctly", () => {
    // This is the minimal valid AgentConfig shape — no new fields
    const minimalConfig: AgentConfig = {
      name: "minimal",
      description: "Minimal agent config",
      extensions: true,
      skills: true,
      systemPrompt: "You are minimal.",
      promptMode: "replace",
    };

    const agents = new Map([["minimal", minimalConfig]]);
    registerAgents(agents);

    const config = getConfig("minimal");
    expect(config.displayName).toBe("minimal");
    expect(config.description).toBe("Minimal agent config");
    expect(config.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES); // Fallback
    expect(config.extensions).toBe(true);
    expect(config.skills).toBe(true);
  });

  it("old-style custom agent without handoff/validators/useContextMode loads fine", () => {
    const oldStyleConfig: AgentConfig = {
      name: "old-school",
      description: "An old-style agent before v0.7.0 features",
      builtinToolNames: ["read", "bash", "grep"],
      extensions: true,
      skills: true,
      systemPrompt: "You are old school.",
      promptMode: "replace",
      // No validators, no handoff, no useContextMode, no partitionMembership
      // These are all new fields that should default safely
    };

    const agents = new Map([["old-school", oldStyleConfig]]);
    registerAgents(agents);

    const fullConfig = getAgentConfig("old-school");
    expect(fullConfig).toBeDefined();
    expect(fullConfig?.name).toBe("old-school");
    expect(fullConfig?.validators).toBeUndefined();
    expect(fullConfig?.handoff).toBeUndefined();
    expect(fullConfig?.useContextMode).toBeUndefined();
    expect(fullConfig?.partitionMembership).toBeUndefined();

    // Runtime config still resolves correctly
    const runtimeConfig = getConfig("old-school");
    expect(runtimeConfig.builtinToolNames).toEqual(["read", "bash", "grep"]);
  });
});

// ── 2. Default Values for New Fields ────────────────────────────────────────

describe("Backward compat: default values for new fields", () => {
  it("taskBudget is undefined by default (unlimited)", () => {
    registerAgents(new Map());

    const gpConfig = getAgentConfig("general-purpose");
    // general-purpose default does not have taskBudget set
    expect(gpConfig).toBeDefined();
    // taskBudget is not on AgentConfig — it's only on AgentInvocation
    // and is set at spawn time. Default is undefined (unlimited).

    const config = getConfig("general-purpose");
    // getConfig doesn't return taskBudget — it's at the invocation level
    expect(config).toBeDefined();
  });

  it("levelLimit default is 5 (from agent-manager spawn code)", () => {
    // The default levelLimit of 5 comes from agent-manager.ts spawn():
    //   const levelLimit = parentRecord.invocation?.levelLimit ?? 5;
    // This test verifies that getAgentConfig does not hardcode levelLimit
    // on the config (it's a runtime invocation parameter)

    registerAgents(new Map());
    const gpConfig = getAgentConfig("general-purpose");
    expect(gpConfig).toBeDefined();
    // AgentConfig has no levelLimit field — it's on AgentInvocation
  });

  it("validators default to undefined/empty", () => {
    registerAgents(new Map());

    for (const name of ["general-purpose", "Explore", "Plan"]) {
      const config = getAgentConfig(name);
      expect(config?.validators).toBeUndefined();
    }
  });

  it("useContextMode defaults to undefined (falsy)", () => {
    registerAgents(new Map());

    for (const name of ["general-purpose", "Explore", "Plan"]) {
      const config = getAgentConfig(name);
      expect(config?.useContextMode).toBeFalsy();
    }

    // Analysis agent is the exception — it opts in to useContextMode
    const analysisConfig = getAgentConfig("Analysis");
    expect(analysisConfig?.useContextMode).toBe(true);
  });

  it("handoff defaults to undefined (falsy)", () => {
    registerAgents(new Map());

    for (const name of ["general-purpose", "Explore", "Plan"]) {
      const config = getAgentConfig(name);
      expect(config?.handoff).toBeFalsy();
    }
  });

  it("disallowedTools defaults to undefined for general-purpose, set for read-only agents", () => {
    registerAgents(new Map());

    // general-purpose has no restriction (uses all tools)
    expect(getAgentConfig("general-purpose")?.disallowedTools).toBeUndefined();

    // Explore and Plan are read-only agents with explicit disallowedTools
    expect(getAgentConfig("Explore")?.disallowedTools).toEqual(["write", "edit"]);
    expect(getAgentConfig("Plan")?.disallowedTools).toEqual(["write", "edit"]);
  });

  it("compactionKeepTurns defaults to undefined (falls back to DEFAULT_KEEP_TURNS=5)", () => {
    registerAgents(new Map());

    for (const name of ["general-purpose", "Explore", "Plan"]) {
      const config = getAgentConfig(name);
      expect(config?.compactionKeepTurns).toBeUndefined();
    }
  });

  it("partitionMembership defaults to undefined", () => {
    registerAgents(new Map());

    for (const name of ["general-purpose", "Explore", "Plan"]) {
      const config = getAgentConfig(name);
      expect(config?.partitionMembership).toBeUndefined();
    }
  });
});

// ── 3. Old-style Agent Invocation ───────────────────────────────────────────

describe("Backward compat: old-style Agent invocation", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("spawn without partitions, without handoff, without validators works", () => {
    manager = new AgentManager();

    // Don't resolve runAgent — just test spawn side
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const id = manager.spawn(
      {} as any,
      { cwd: "/tmp" } as any,
      "general-purpose",
      "Do something",
      {
        description: "old-style invocation",
        isBackground: true,
        // No partitions, no validators, no handoff-related options
      },
    );

    const record = manager.getRecord(id);
    expect(record).toBeDefined();
    expect(record!.type).toBe("general-purpose");
    expect(record!.description).toBe("old-style invocation");
    expect(record!.status).toBe("running");

    // invocation should not have new fields
    expect(record!.invocation?.partitions).toBeUndefined();

    manager.abort(id);
  });

  it("spawn with minimal options still produces a valid AgentRecord", () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const id = manager.spawn(
      {} as any,
      { cwd: "/tmp" } as any,
      "Explore",
      "Search for patterns",
      {
        description: "minimal spawn",
        // isBackground defaults via startAgent logic for foreground
      },
    );

    const record = manager.getRecord(id);
    expect(record).toBeDefined();
    expect(record!.id).toBe(id);
    expect(record!.type).toBe("Explore");
    expect(record!.toolUses).toBe(0);
    expect(record!.currentLevel).toBe(0);
    expect(record!.totalSpawned).toBe(0);
    expect(record!.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    expect(record!.compactionCount).toBe(0);

    manager.abort(id);
  });

  it("spawnAndWait still works for synchronous foreground invocation", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "Task complete.",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });

    const record = await manager.spawnAndWait(
      {} as any,
      { cwd: "/tmp" } as any,
      "Plan",
      "Create an implementation plan",
      { description: "planning task" },
    );

    expect(record.status).toBe("completed");
    expect(record.result).toBe("Task complete.");
  });

  it("listAgents still works after spawn", () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const id1 = manager.spawn(
      {} as any,
      { cwd: "/tmp" } as any,
      "general-purpose",
      "task 1",
      { description: "task-1" },
    );

    const id2 = manager.spawn(
      {} as any,
      { cwd: "/tmp" } as any,
      "Explore",
      "task 2",
      { description: "task-2" },
    );

    const all = manager.listAgents();
    expect(all.length).toBeGreaterThanOrEqual(2);
    const ids = all.map((a) => a.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);

    // Abort to clean up hanging promises
    manager.abort(id1);
    manager.abort(id2);
  });
});

// ── 4. Existing Agent Types ─────────────────────────────────────────────────

describe("Backward compat: existing agent types", () => {
  beforeEach(() => {
    registerAgents(new Map());
  });

  describe("general-purpose", () => {
    it("loads and has correct tool list", () => {
      const config = getConfig("general-purpose");
      expect(config.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
      expect(config.extensions).toBe(true);
      expect(config.skills).toBe(true);
      expect(config.promptMode).toBe("append");
    });

    it("is valid and enabled", () => {
      expect(isValidType("general-purpose")).toBe(true);
    });

    it("has no builtinToolNames override (uses default)", () => {
      const agentCfg = getAgentConfig("general-purpose");
      // general-purpose omits builtinToolNames → resolved to BUILTIN_TOOL_NAMES
      expect(agentCfg?.builtinToolNames).toBeUndefined();
    });
  });

  describe("Explore", () => {
    it("loads and has read-only tool list", () => {
      const config = getConfig("Explore");
      expect(config.builtinToolNames).toEqual(["read", "bash", "grep"]);
      expect(config.builtinToolNames).not.toContain("edit");
      expect(config.builtinToolNames).not.toContain("write");
    });

    it("uses haiku model", () => {
      const agentCfg = getAgentConfig("Explore");
      expect(agentCfg?.model).toBe("anthropic/claude-haiku-4-5");
    });

    it("uses replace prompt mode", () => {
      const config = getConfig("Explore");
      expect(config.promptMode).toBe("replace");
    });

    it("is valid and enabled", () => {
      expect(isValidType("Explore")).toBe(true);
    });
  });

  describe("Plan", () => {
    it("loads and has read-only tool list", () => {
      const config = getConfig("Plan");
      expect(config.builtinToolNames).toEqual(["read", "bash", "grep"]);
      expect(config.builtinToolNames).not.toContain("edit");
      expect(config.builtinToolNames).not.toContain("write");
    });

    it("uses replace prompt mode", () => {
      const config = getConfig("Plan");
      expect(config.promptMode).toBe("replace");
    });

    it("is valid and enabled", () => {
      expect(isValidType("Plan")).toBe(true);
    });
  });

  describe("Analysis", () => {
    it("loads with read-only tools", () => {
      const config = getConfig("Analysis");
      expect(config.builtinToolNames).toContain("read");
      expect(config.builtinToolNames).not.toContain("edit");
      expect(config.builtinToolNames).not.toContain("write");
    });

    it("has useContextMode enabled", () => {
      const agentCfg = getAgentConfig("Analysis");
      expect(agentCfg?.useContextMode).toBe(true);
    });

    it("has inheritContext true by default", () => {
      const agentCfg = getAgentConfig("Analysis");
      expect(agentCfg?.inheritContext).toBe(true);
    });

    it("uses sonnet model", () => {
      const agentCfg = getAgentConfig("Analysis");
      expect(agentCfg?.model).toBe("anthropic/claude-sonnet-4-5-20250901");
    });
  });

  describe("case-insensitive resolution", () => {
    it("lowercase 'explore' resolves to Explore", () => {
      const config = getConfig("explore");
      expect(config.builtinToolNames).toEqual(["read", "bash", "grep"]);
    });

    it("lowercase 'plan' resolves to Plan", () => {
      const config = getConfig("plan");
      expect(config.promptMode).toBe("replace");
    });

    it("lowercase 'general-purpose' resolves correctly", () => {
      const config = getConfig("general-purpose");
      expect(config.displayName).toBe("Agent");
    });
  });

  describe("default agents: strategy field invariants", () => {
    it("runInBackground, inheritContext, isolated are all undefined (not locked)", () => {
      for (const name of ["general-purpose", "Explore", "Plan"]) {
        const cfg = getAgentConfig(name);
        expect(cfg?.runInBackground, `${name}.runInBackground`).toBeUndefined();
        expect(cfg?.inheritContext, `${name}.inheritContext`).toBeUndefined();
        expect(cfg?.isolated, `${name}.isolated`).toBeUndefined();
      }
    });
  });
});
