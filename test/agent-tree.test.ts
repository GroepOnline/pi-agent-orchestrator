import { describe, expect, it } from "vitest";

import {
  buildAgentTreeJson,
  buildAgentTreeMermaid,
  buildAgentTreeText,
} from "../src/agent-tree.js";
import type { AgentRecord } from "../src/types.js";

/**
 * Tests for the REAL tree builders in src/agent-tree.ts.
 *
 * Regression note: this suite previously tested a stale inline copy of the
 * implementation ("inlined for testability"). The copy drifted from the real
 * module (graph TD vs flowchart TD, no groupId edges). These tests exercise
 * the actual exports so drift is caught instead of enshrined.
 */

function makeRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-1",
    type: "Explore",
    status: "completed",
    description: "Searched files",
    spawnedAt: Date.now(),
    swarmId: undefined,
    handoff: undefined,
    invocation: undefined,
    compactionCount: 0,
    toolUses: 0,
    lifetimeUsage: { input: 100, output: 50, cacheWrite: 0 },
    ...overrides,
  } as AgentRecord;
}

describe("buildAgentTreeJson", () => {
  it("returns a JSON array of root nodes", () => {
    const parsed = JSON.parse(buildAgentTreeJson([makeRecord({ id: "a1" }), makeRecord({ id: "a2" })]));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
  });

  it("includes node properties and builds parent-child relationships", () => {
    const parent = makeRecord({ id: "parent" });
    const child = makeRecord({ id: "child", parentId: "parent" });
    const parsed = JSON.parse(buildAgentTreeJson([parent, child]));
    expect(parsed.length).toBe(1);
    expect(parsed[0].id).toBe("parent");
    expect(parsed[0].children[0].id).toBe("child");
  });

  it("treats orphaned children (missing parent) as roots", () => {
    const parsed = JSON.parse(buildAgentTreeJson([makeRecord({ id: "orphan", parentId: "missing" })]));
    expect(parsed.length).toBe(1);
    expect(parsed[0].id).toBe("orphan");
  });

  it("returns [] for an empty record list", () => {
    expect(JSON.parse(buildAgentTreeJson([]))).toEqual([]);
  });
});

describe("buildAgentTreeMermaid", () => {
  it("starts with a flowchart TD header", () => {
    expect(buildAgentTreeMermaid([makeRecord()])).toContain("flowchart TD");
  });

  it("creates parent → child edges with sanitized ids", () => {
    const parent = makeRecord({ id: "agent-parent" });
    const child = makeRecord({ id: "agent-child", parentId: "agent-parent" });
    const out = buildAgentTreeMermaid([parent, child]);
    expect(out).toContain("agent_parent --> agent_child");
  });

  it("renders an empty-session placeholder when there are no records", () => {
    const out = buildAgentTreeMermaid([]);
    expect(out).toContain("No agents in this session");
  });
});

describe("buildAgentTreeText", () => {
  it("renders root nodes with no indent", () => {
    const out = buildAgentTreeText([makeRecord({ id: "a1", type: "Explore", status: "completed" })]);
    expect(out).toContain("a1 (Explore) [completed]");
  });

  it("renders children hierarchically after their parent", () => {
    const parent = makeRecord({ id: "p1", type: "Explore", status: "completed" });
    const child = makeRecord({ id: "c1", type: "Plan", status: "running", parentId: "p1" });
    const out = buildAgentTreeText([parent, child]);
    expect(out.indexOf("p1")).toBeLessThan(out.indexOf("c1"));
    expect(out).toContain("\u2514\u2500 c1");
  });

  it("shows the fallback message for empty records", () => {
    expect(buildAgentTreeText([])).toBe("No execution tree available.");
  });
});
