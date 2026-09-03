import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRecord } from "../src/types.js";

// Mock logger
vi.mock("../src/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { GroupJoinManager } = await import("../src/group-join.js");

function makeRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-1",
    type: "Explore",
    status: "completed",
    description: "Done",
    spawnedAt: Date.now(),
    startedAt: Date.now() - 1000,
    completedAt: Date.now(),
    swarmId: undefined,
    handoff: undefined,
    invocation: undefined,
    compactionCount: 0,
    toolUses: 0,
    lifetimeUsage: { input: 100, output: 50, cacheWrite: 0 },
    ...overrides,
  } as AgentRecord;
}

describe("GroupJoinManager", () => {
  let deliverCb: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    deliverCb = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("registerGroup", () => {
    it("registers a group with string shorthand", () => {
      const gjm = new GroupJoinManager(deliverCb);
      gjm.registerGroup("group-1", ["agent-1", "agent-2"]);
      expect(gjm.isGrouped("agent-1")).toBe(true);
      expect(gjm.isGrouped("agent-2")).toBe(true);
      expect(gjm.isGrouped("agent-3")).toBe(false);
    });

    it("registers a group with full config", () => {
      const gjm = new GroupJoinManager(deliverCb);
      gjm.registerGroup({
        groupId: "group-1",
        agentIds: ["a1", "a2"],
        timeout: 10000,
        progressiveDelivery: true,
      });
      expect(gjm.isGrouped("a1")).toBe(true);
    });

    it("emits group:created event", () => {
      const onEvent = vi.fn();
      const gjm = new GroupJoinManager(deliverCb);
      gjm.registerGroup({
        groupId: "group-1",
        agentIds: ["a1"],
        onEvent,
      });

      expect(onEvent).toHaveBeenCalledWith("group-1", expect.objectContaining({
        type: "group:created",
      }));
    });
  });

  describe("onAgentComplete", () => {
    it("returns pass for ungrouped agent", () => {
      const gjm = new GroupJoinManager(deliverCb);
      const rec = makeRecord({ id: "a1" });
      expect(gjm.onAgentComplete(rec)).toBe("pass");
    });

    it("returns held when group not yet complete", () => {
      const gjm = new GroupJoinManager(deliverCb);
      gjm.registerGroup("group-1", ["a1", "a2"]);

      const rec = makeRecord({ id: "a1" });
      expect(gjm.onAgentComplete(rec)).toBe("held");
    });

    it("returns delivered when all agents complete", () => {
      const gjm = new GroupJoinManager(deliverCb);
      gjm.registerGroup("group-1", ["a1", "a2"]);

      const r1 = makeRecord({ id: "a1" });
      const r2 = makeRecord({ id: "a2" });

      expect(gjm.onAgentComplete(r1)).toBe("held");
      expect(gjm.onAgentComplete(r2)).toBe("delivered");
    });

    it("calls delivery callback when all complete", () => {
      const gjm = new GroupJoinManager(deliverCb);
      gjm.registerGroup("group-1", ["a1", "a2"]);

      const r1 = makeRecord({ id: "a1" });
      const r2 = makeRecord({ id: "a2" });

      gjm.onAgentComplete(r1);
      gjm.onAgentComplete(r2);

      expect(deliverCb).toHaveBeenCalledWith(
        expect.arrayContaining([r1, r2]),
        false,
        expect.objectContaining({ groupId: "group-1" }),
      );
    });
  });

  describe("missingMembers (mid-fanout partial finalization)", () => {
    it("reports missingMembers in delivery meta when the surviving members complete", () => {
      const gjm = new GroupJoinManager(deliverCb);
      gjm.registerGroup("group-1", ["a1", "a2"], { missingMembers: 1 });

      expect(gjm.onAgentComplete(makeRecord({ id: "a1" }))).toBe("held");
      expect(gjm.onAgentComplete(makeRecord({ id: "a2" }))).toBe("delivered");

      expect(deliverCb).toHaveBeenCalledTimes(1);
      const [records, partial, meta] = deliverCb.mock.calls[0]!;
      expect(records.map((r: AgentRecord) => r.id)).toEqual(["a1", "a2"]);
      // All spawned members completed — not a timeout partial.
      expect(partial).toBe(false);
      // But the delivery is explicit about the member that never spawned.
      expect(meta).toMatchObject({ missingMembers: 1, completedAgents: 2 });
      // Fully finalized: the group does not leak after delivery.
      expect(gjm.listGroups()).toEqual([]);
      expect(gjm.isGrouped("a1")).toBe(false);
    });

    it("accepts missingMembers via the full config form", () => {
      const gjm = new GroupJoinManager(deliverCb);
      gjm.registerGroup({ groupId: "group-1", agentIds: ["a1"], missingMembers: 2 });

      gjm.onAgentComplete(makeRecord({ id: "a1" }));

      const meta = deliverCb.mock.calls[0]![2];
      expect(meta).toMatchObject({ missingMembers: 2, completedAgents: 1 });
    });

    it("omits missingMembers for groups that spawned complete (characterization)", () => {
      const gjm = new GroupJoinManager(deliverCb);
      gjm.registerGroup("group-1", ["a1", "a2"]);

      gjm.onAgentComplete(makeRecord({ id: "a1" }));
      gjm.onAgentComplete(makeRecord({ id: "a2" }));

      const meta = deliverCb.mock.calls[0]![2];
      expect(meta).not.toHaveProperty("missingMembers");
      expect(meta.completedAgents).toBe(2);
    });
  });

  describe("isGrouped", () => {
    it("returns true for registered agents", () => {
      const gjm = new GroupJoinManager(deliverCb);
      gjm.registerGroup("group-1", ["a1"]);
      expect(gjm.isGrouped("a1")).toBe(true);
    });

    it("returns false for unregistered agents", () => {
      const gjm = new GroupJoinManager(deliverCb);
      expect(gjm.isGrouped("a1")).toBe(false);
    });
  });

  describe("getGroupInfo", () => {
    it("returns group info", () => {
      const gjm = new GroupJoinManager(deliverCb);
      gjm.registerGroup("group-1", ["a1", "a2"]);

      const info = gjm.getGroupInfo("group-1");
      expect(info).toBeDefined();
      expect(info!.total).toBe(2);
      expect(info!.completed).toBe(0);
      expect(info!.delivered).toBe(false);
    });

    it("tracks completed count", () => {
      const gjm = new GroupJoinManager(deliverCb);
      gjm.registerGroup("group-1", ["a1", "a2"]);
      gjm.onAgentComplete(makeRecord({ id: "a1" }));

      const info = gjm.getGroupInfo("group-1");
      expect(info!.completed).toBe(1);
    });

    it("returns undefined for unknown group", () => {
      const gjm = new GroupJoinManager(deliverCb);
      expect(gjm.getGroupInfo("nonexistent")).toBeUndefined();
    });
  });

  describe("listGroups", () => {
    it("returns all group IDs", () => {
      const gjm = new GroupJoinManager(deliverCb);
      gjm.registerGroup("group-1", ["a1"]);
      gjm.registerGroup("group-2", ["a2"]);
      expect(gjm.listGroups()).toEqual(["group-1", "group-2"]);
    });

    it("returns empty array when no groups", () => {
      const gjm = new GroupJoinManager(deliverCb);
      expect(gjm.listGroups()).toEqual([]);
    });
  });

  describe("dispose", () => {
    it("clears all groups", () => {
      const gjm = new GroupJoinManager(deliverCb);
      gjm.registerGroup("group-1", ["a1"]);
      gjm.dispose();
      expect(gjm.listGroups()).toEqual([]);
      expect(gjm.isGrouped("a1")).toBe(false);
    });
  });
});
