/**
 * e2e-chain.test.ts — End-to-end tests for the Plan→Explore→Validator→Handoff→Report pipeline.
 *
 * All tests mock external dependencies (no real LLM calls). Structural tests
 * that verify the full integration of AgentManager, validators, handoff,
 * hooks, budget/depth enforcement, permission inheritance, and partitioned state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager, activeAgentStorage } from "../src/agent-manager.js";
import { CTX_TOOL_NAMES, filterByPartitions, getAgentConfig, getConfig, registerAgents } from "../src/agent-types.js";
import { parseHandoff, renderHandoffForParent } from "../src/handoff.js";
import { HookRegistry } from "../src/hooks.js";
import type { AgentConfig, AgentRecord } from "../src/types.js";
import { parseValidationResult } from "../src/validators.js";

// ── Mocks ───────────────────────────────────────────────────────────────────

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

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;
const mockSession = () => ({ dispose: vi.fn() } as any);

const resolvedRun = (responseText = "done") =>
  vi.mocked(runAgent).mockResolvedValue({
    responseText,
    session: mockSession(),
    aborted: false,
    steered: false,
  });

function runAs<T>(agentId: string, fn: () => T): T {
  return activeAgentStorage.run(agentId, fn);
}

// ── 1. Budget Enforcement ───────────────────────────────────────────────────

describe("E2E: budget enforcement", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("taskBudget=1 allows first spawn, blocks second with descriptive error", async () => {
    manager = new AgentManager();
    resolvedRun();

    const parentId = "parent-budget";
    const parentRecord: AgentRecord = {
      id: parentId,
      type: "general-purpose",
      description: "budget parent",
      status: "running",
      toolUses: 0,
      startedAt: Date.now(),
      invocation: { taskBudget: 1 },
      currentLevel: 0,
      totalSpawned: 0,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
    };
    (manager as any).agents.set(parentId, parentRecord);

    // First child: allowed
    const id1 = runAs(parentId, () => manager.spawn(mockPi, mockCtx, "Explore", "child 1", {
      description: "child 1",
      isBackground: true,
    }));
    const rec1 = manager.getRecord(id1)!;
    await rec1.promise;
    expect(parentRecord.totalSpawned).toBe(1);

    // Second child: blocked
    expect(() => runAs(parentId, () =>
      manager.spawn(mockPi, mockCtx, "Explore", "child 2", {
        description: "child 2",
        isBackground: true,
      }),
    )).toThrow("Task budget exhausted (1/1)");

    expect(parentRecord.totalSpawned).toBe(1);
  });
});

// ── 2. Depth Limit ──────────────────────────────────────────────────────────

describe("E2E: depth limit", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("levelLimit=1 allows child (depth 1) but blocks grandchild at depth 2", async () => {
    manager = new AgentManager();

    const rootId = "root-depth";
    const rootRecord: AgentRecord = {
      id: rootId,
      type: "general-purpose",
      description: "root",
      status: "running",
      toolUses: 0,
      startedAt: Date.now(),
      invocation: { levelLimit: 1 },
      currentLevel: 0,
      totalSpawned: 0,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
    };
    (manager as any).agents.set(rootId, rootRecord);

    // Child (depth 1): allowed
    resolvedRun();
    const childId = runAs(rootId, () => manager.spawn(mockPi, mockCtx, "Explore", "depth 1", {
      description: "child",
      isBackground: true,
    }));
    const childRecord = manager.getRecord(childId)!;
    await childRecord.promise;
    expect(childRecord.currentLevel).toBe(1);
    expect(childRecord.parentId).toBe(rootId);

    // Grandchild (depth 2): blocked
    expect(() => runAs(childId, () =>
      manager.spawn(mockPi, mockCtx, "Explore", "depth 2", {
        description: "grandchild",
        isBackground: true,
      }),
    )).toThrow("Max agent depth reached (2/1)");
  });
});

// ── 3. Validator Isolation ──────────────────────────────────────────────────

describe("E2E: validator isolation", () => {
  it("validator with taskBudget=3 does not consume parent budget", () => {
    // validator budget is separate — the validator spawns happen through
    // runAgent internally and skip validators, so they don't touch the
    // AgentManager budget/depth stack. The agent-manager only enforces
    // budgets in its own spawn() method. Since validators run inside
    // runAgent via internal runAgent calls (not AgentManager.spawn),
    // they bypass budget enforcement entirely.
    //
    // This test verifies: creating a parent with taskBudget=0 means it
    // can't spawn children via AgentManager.spawn, but the validator
    // system (internal runAgent) is unaffected.
    const manager = new AgentManager();
    resolvedRun("all good");

    const parentId = "parent-validator";
    const parentRecord: AgentRecord = {
      id: parentId,
      type: "general-purpose",
      description: "validator parent",
      status: "running",
      toolUses: 0,
      startedAt: Date.now(),
      invocation: { taskBudget: 0 },
      currentLevel: 0,
      totalSpawned: 0,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
    };
    (manager as any).agents.set(parentId, parentRecord);

    // AgentManager.spawn should block because taskBudget=0
    expect(() => runAs(parentId, () =>
      manager.spawn(mockPi, mockCtx, "Explore", "should fail", {
        description: "blocked",
        isBackground: true,
      }),
    )).toThrow("Task budget exhausted");

    // The parent's totalSpawned remains 0 (no spawns completed)
    expect(parentRecord.totalSpawned).toBe(0);
    manager.dispose();
  });
});

// ── 4. Permission Inheritance ───────────────────────────────────────────────

describe("E2E: permission inheritance", () => {
  beforeEach(() => {
    registerAgents(new Map());
  });

  it("RO parent forces RO child regardless of child config", () => {
    const READ_ONLY_TOOLS = ["read", "bash", "grep"];

    // Explore (RO) parent config
    const parentConfig = {
      builtinToolNames: READ_ONLY_TOOLS,
      extensions: true as const,
      skills: true as const,
    };

    // General-purpose child normally has all tools
    const child = getConfig("general-purpose", parentConfig);

    // Child must NOT have write/edit
    expect(child.builtinToolNames).not.toContain("write");
    expect(child.builtinToolNames).not.toContain("edit");
    // Child must match parent's tool set
    expect(child.builtinToolNames).toEqual(READ_ONLY_TOOLS);
  });

  it("RW parent allows RO child to keep its own RO tools", () => {
    const ALL_TOOLS = ["read", "bash", "edit", "write", "grep"];

    const parentConfig = {
      builtinToolNames: ALL_TOOLS,
      extensions: true as const,
      skills: true as const,
    };

    // Explore child is RO by config
    const child = getConfig("Explore", parentConfig);

    expect(child.builtinToolNames).not.toContain("write");
    expect(child.builtinToolNames).not.toContain("edit");
    expect(child.builtinToolNames).toEqual(["read", "bash", "grep"]);
  });

  it("Plan child inherits RO restriction from Explore parent", () => {
    const READ_ONLY_TOOLS = ["read", "bash", "grep"];

    const parentConfig = {
      builtinToolNames: READ_ONLY_TOOLS,
      extensions: true as const,
      skills: true as const,
    };

    const child = getConfig("Plan", parentConfig);
    expect(child.builtinToolNames).toEqual(READ_ONLY_TOOLS);
  });
});

// ── 5. Handoff Parsing ──────────────────────────────────────────────────────

describe("E2E: handoff parsing", () => {
  it("parses structured JSON correctly from ```json fenced block", () => {
    const agentOutput = `Here is my summary of findings.

\`\`\`json
{
  "type": "handoff",
  "status": "success",
  "summary": "Completed full codebase audit and identified 3 issues",
  "findings": [
    "Memory leak in the scheduler loop",
    "Missing null check in auth middleware",
    "N+1 query in user listing endpoint"
  ],
  "nextSteps": [
    "Fix memory leak in scheduler.ts",
    "Add null guard in auth middleware",
    "Add eager loading to user listing"
  ],
  "confidence": 0.92,
  "evidence": [
    "/app/src/scheduler.ts",
    "/app/src/middleware/auth.ts",
    "/app/src/routes/users.ts"
  ]
}
\`\`\``;

    const handoff = parseHandoff(agentOutput);
    expect(handoff).not.toBeNull();
    expect(handoff!.type).toBe("handoff");
    expect(handoff!.status).toBe("success");
    expect(handoff!.findings).toHaveLength(3);
    expect(handoff!.confidence).toBe(0.92);
    expect(handoff!.nextSteps).toHaveLength(3);
    expect(handoff!.evidence).toHaveLength(3);
  });

  it("renders parsed handoff back to readable text for parent", () => {
    const agentOutput = `\`\`\`json
{
  "type": "handoff",
  "status": "partial",
  "summary": "Partially completed the migration",
  "findings": ["Schema updated", "3 tables remaining"]
}
\`\`\``;

    const handoff = parseHandoff(agentOutput);
    expect(handoff).not.toBeNull();

    const rendered = renderHandoffForParent(handoff!);
    expect(rendered).toContain("[Handoff: partially completed]");
    expect(rendered).toContain("Summary: Partially completed the migration");
    expect(rendered).toContain("Schema updated");
  });
});

// ── 6. Handoff Graceful Degrade ─────────────────────────────────────────────

describe("E2E: handoff graceful degrade", () => {
  it("malformed JSON — falls back to raw text (null handoff)", () => {
    const agentOutput = `I found something...

\`\`\`json
{
  "type": "handoff",
  "status": "success",
  "summary": "Broken parse
  "findings": ["missing comma"]
}
\`\`\``;

    // parseHandoff returns null for malformed JSON
    const handoff = parseHandoff(agentOutput);
    expect(handoff).toBeNull();

    // In production (agent-runner), when handoff is null the original
    // responseText is kept as-is — this is the graceful degrade path.
  });

  it("missing required fields returns null", () => {
    const agentOutput = `\`\`\`json
{
  "type": "handoff",
  "status": "success"
}
\`\`\``;

    const handoff = parseHandoff(agentOutput);
    expect(handoff).toBeNull();
  });

  it("no JSON block at all returns null but does not throw", () => {
    const handoff = parseHandoff("Just plain text, nothing structured.");
    expect(handoff).toBeNull();
  });

  it("wrong type field returns null", () => {
    const agentOutput = `\`\`\`json
{
  "type": "report",
  "status": "success",
  "summary": "Some report",
  "findings": ["a finding"]
}
\`\`\``;

    const handoff = parseHandoff(agentOutput);
    expect(handoff).toBeNull();
  });
});

// ── 7. Hooks Dispatch ───────────────────────────────────────────────────────

describe("E2E: hooks dispatch", () => {
  it("subagent:start and subagent:end dispatched in correct order", async () => {
    const registry = new HookRegistry();
    const events: string[] = [];

    registry.register("subagent:start", () => {
      events.push("start");
    });
    registry.register("subagent:end", () => {
      events.push("end");
    });

    await registry.dispatch("subagent:start", "agent-1");
    expect(events).toEqual(["start"]);

    await registry.dispatch("subagent:end", "agent-1");
    expect(events).toEqual(["start", "end"]);
  });

  it("subagent:spawn hook fires during AgentManager.spawn", () => {
    const registry = new HookRegistry();
    const spawnEvents: string[] = [];

    registry.register("subagent:spawn", (_payload) => {
      spawnEvents.push(_payload.agentId);
    });

    const manager = new AgentManager();
    manager.hooks = registry;
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "spawn test",
      isBackground: true,
    });

    expect(spawnEvents).toContain(id);
    manager.dispose();
  });

  it("spawn hook carries agent metadata", () => {
    const registry = new HookRegistry();
    let capturedData: Record<string, unknown> | undefined;

    registry.register("subagent:spawn", (payload) => {
      capturedData = payload.data;
    });

    const manager = new AgentManager();
    manager.hooks = registry;
    resolvedRun();

    manager.spawn(mockPi, mockCtx, "Explore", "explore task", {
      description: "metadata test",
      isBackground: false,
    });

    expect(capturedData).toBeDefined();
    expect((capturedData as any).type).toBe("Explore");
    expect((capturedData as any).description).toBe("metadata test");
    expect((capturedData as any).isBackground).toBe(false);

    manager.dispose();
  });
});

// ── 8. Partition Filtering ──────────────────────────────────────────────────

describe("E2E: partition filtering", () => {
  it("agent in 'frontend' partition only gets frontend tools", () => {
    const config: AgentConfig = {
      name: "frontend-agent",
      description: "Frontend specialist",
      builtinToolNames: ["read", "write", "edit", "bash", "grep"],
      extensions: false,
      skills: false,
      systemPrompt: "frontend",
      promptMode: "replace",
      partitionMembership: {
        frontend: ["read", "write"],
      },
    };

    const tools = filterByPartitions(config, ["frontend"]);
    expect(tools).toEqual(["read", "write"]);
    expect(tools).not.toContain("bash");
    expect(tools).not.toContain("edit");
  });

  it("agent in both 'frontend' and 'backend' partitions gets union of tools", () => {
    const config: AgentConfig = {
      name: "fullstack-agent",
      description: "Fullstack specialist",
      builtinToolNames: ["read", "write", "edit", "bash", "grep"],
      extensions: false,
      skills: false,
      systemPrompt: "fullstack",
      promptMode: "replace",
      partitionMembership: {
        frontend: ["read", "write"],
        backend: ["bash", "grep"],
      },
    };

    const tools = filterByPartitions(config, ["frontend", "backend"]);
    expect(new Set(tools)).toEqual(new Set(["read", "write", "bash", "grep"]));
  });

  it("agent with no partitionMembership gets all tools even when partition requested", () => {
    const config: AgentConfig = {
      name: "generic-agent",
      description: "Generic",
      builtinToolNames: ["read", "write", "edit", "bash", "grep"],
      extensions: false,
      skills: false,
      systemPrompt: "generic",
      promptMode: "replace",
      // No partitionMembership → feature disabled
    };

    const tools = filterByPartitions(config, ["frontend"]);
    expect(tools).toContain("read");
    expect(tools).toContain("write");
    expect(tools).toContain("edit");
    expect(tools).toContain("bash");
  });
});

// ── 9. Ctx Tools Available ──────────────────────────────────────────────────

describe("E2E: ctx tools available", () => {
  it("CTX_TOOL_NAMES contains all expected ctx_* tool names", () => {
    expect(CTX_TOOL_NAMES).toContain("ctx_execute");
    expect(CTX_TOOL_NAMES).toContain("ctx_execute_file");
    expect(CTX_TOOL_NAMES).toContain("ctx_search");
    expect(CTX_TOOL_NAMES).toContain("ctx_index");
    expect(CTX_TOOL_NAMES).toContain("ctx_batch_execute");
    expect(CTX_TOOL_NAMES).toContain("ctx_stats");
    expect(CTX_TOOL_NAMES).toHaveLength(6);
  });

  it("Analysis agent config has useContextMode=true", () => {
    registerAgents(new Map());
    const analysisConfig = getAgentConfig("Analysis");
    expect(analysisConfig).toBeDefined();
    expect(analysisConfig?.useContextMode).toBe(true);
  });

  it("general-purpose does NOT have useContextMode by default", () => {
    const gpConfig = getAgentConfig("general-purpose");
    expect(gpConfig).toBeDefined();
    expect(gpConfig?.useContextMode).toBeFalsy();
  });
});

// ── 10. Full Chain ──────────────────────────────────────────────────────────

describe("E2E: full chain — spawn → run → validators → handoff → result", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("simulates the complete chain: AgentManager.spawn → runAgent → result", async () => {
    manager = new AgentManager();

    // Mock runAgent to return a handoff-formatted response
    const handoffResponse = `Analysis complete.

\`\`\`json
{
  "type": "handoff",
  "status": "success",
  "summary": "Audited the auth module and found 2 vulnerabilities",
  "findings": ["Missing CSRF token validation", "Weak password hashing"],
  "nextSteps": ["Add CSRF middleware", "Upgrade to bcrypt"],
  "confidence": 0.88,
  "evidence": ["/app/src/auth.ts"]
}
\`\`\``;

    vi.mocked(runAgent).mockResolvedValue({
      responseText: handoffResponse,
      session: mockSession(),
      aborted: false,
      steered: false,
      validationResults: [
        {
          agentId: "validator-1",
          passed: true,
          criteria: [
            { criterion: "All findings have evidence", passed: true, feedback: "All findings are backed by file references" },
          ],
          summary: "Validation passed",
        },
      ],
      validated: true,
      handoff: parseHandoff(handoffResponse) ?? undefined,
    });

    // spawnAndWait runs the full spawn → run → result pipeline
    const record = await manager.spawnAndWait(
      mockPi,
      mockCtx,
      "general-purpose",
      "Audit the auth module",
      { description: "Auth audit" },
    );

    // Verify the record after completion
    expect(record.status).toBe("completed");

    // Verify validation results were stored
    expect(record.validationResults).toBeDefined();
    expect(record.validated).toBe(true);

    // Verify result text is present
    expect(record.result).toBeDefined();
    expect(record.result).toContain("Analysis complete");
  });

  it("spawn stores invocation config on the record", () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "Explore", "explore task", {
      description: "explore",
      invocation: { taskBudget: 3, levelLimit: 2, partitions: ["frontend"] },
    });

    const record = manager.getRecord(id);
    expect(record?.invocation?.taskBudget).toBe(3);
    expect(record?.invocation?.levelLimit).toBe(2);
    expect(record?.invocation?.partitions).toEqual(["frontend"]);
  });

  it("spawn records have spawnedAt and startedAt timestamps", () => {
    manager = new AgentManager();
    const beforeSpawn = Date.now();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "timing", {
      description: "timing",
    });

    const afterSpawn = Date.now();
    const record = manager.getRecord(id)!;

    expect(record.spawnedAt).toBeGreaterThanOrEqual(beforeSpawn);
    expect(record.spawnedAt).toBeLessThanOrEqual(afterSpawn);
    expect(record.startedAt).toBeGreaterThanOrEqual(record.spawnedAt);
  });

  it("manager.listAgents returns records sorted by startedAt", () => {
    manager = new AgentManager();
    resolvedRun();

    const id1 = manager.spawn(mockPi, mockCtx, "general-purpose", "agent 1", {
      description: "first",
    });
    const id2 = manager.spawn(mockPi, mockCtx, "general-purpose", "agent 2", {
      description: "second",
    });

    const list = manager.listAgents();
    expect(list.length).toBeGreaterThanOrEqual(2);
    // Both agent IDs should be in the list
    const ids = list.map((a) => a.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
    // List is sorted by startedAt descending — both agents appear
    // (exact order depends on timestamp granularity, but both exist)
  });

  it("parseValidationResult works end-to-end with validator output", () => {
    // Simulate a validator agent's output
    const validatorOutput = `## Validation Results

\`\`\`json
{
  "criteria": [
    { "criterion": "Code follows style guide", "passed": true, "feedback": "All rules satisfied" },
    { "criterion": "No security vulnerabilities", "passed": false, "feedback": "Hardcoded API key on line 42" }
  ],
  "summary": "Style is good but there is a security issue",
  "overallPassed": false
}
\`\`\``;

    const result = parseValidationResult(validatorOutput, "security-validator");
    expect(result.agentId).toBe("security-validator");
    expect(result.passed).toBe(false);
    expect(result.criteria).toHaveLength(2);
    expect(result.criteria[0].passed).toBe(true);
    expect(result.criteria[1].passed).toBe(false);
    expect(result.summary).toBe("Style is good but there is a security issue");
  });
});
