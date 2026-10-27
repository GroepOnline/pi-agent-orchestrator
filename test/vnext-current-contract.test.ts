import { describe, expect, it, vi } from "vitest";
import { BatchOrchestrator } from "../src/batch-orchestrator.js";
import {
  buildCrewPlan,
  buildSwarmPlan,
  resolveOrchestrationMode,
} from "../src/orchestration-dispatch.js";

vi.mock("../src/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

function batchHarness() {
  const groupJoin = {
    registerGroup: vi.fn(),
    onAgentComplete: vi.fn(() => "pass" as const),
  };
  const swarmJoin = {
    createSwarm: vi.fn(() => "swarm-current-contract"),
    addAgentToSwarm: vi.fn(() => true),
    onAgentComplete: vi.fn(() => "pass" as const),
  };
  const deps = {
    manager: { getRecord: vi.fn(() => undefined) },
    groupJoin,
    swarmJoin,
    onAgentHandled: vi.fn(),
    onWidgetUpdate: vi.fn(),
  };
  return {
    orchestrator: new BatchOrchestrator(deps as any, { debounceMs: 100 }),
    groupJoin,
    swarmJoin,
  };
}

describe("pre-vNext orchestration contract", () => {
  it("CURRENT_CONTRACT: explicit crew means 3 members and forces group delivery", () => {
    const decision = resolveOrchestrationMode({
      mode: "crew",
      prompt: "Implement the authentication refactor",
      description: "Auth refactor",
      subagentType: "general-purpose",
      runInBackground: false,
    });

    expect(decision.kind).toBe("crew");
    if (decision.kind !== "crew") throw new Error("expected crew decision");
    expect(decision.roles.map((role) => role.role)).toEqual([
      "planner",
      "executor",
      "reviewer",
    ]);
    expect(decision.joinMode).toBe("group");
  });

  it("KNOWN_MISMATCH: crew plan text claims ordering that the plan itself does not encode", () => {
    const original = "Implement auth and verify the result";
    const roles = buildCrewPlan(original, "Auth", "general-purpose");
    const planner = roles.find((role) => role.role === "planner")!;
    const executor = roles.find((role) => role.role === "executor")!;
    const reviewer = roles.find((role) => role.role === "reviewer")!;

    // Current plan objects are three independent prompts: there are no dependency
    // ids, input mappings, or artifact references linking the roles together.
    expect(Object.keys(planner).sort()).toEqual(["description", "prompt", "role"]);
    expect(Object.keys(executor).sort()).toEqual(["description", "prompt", "role"]);
    expect(Object.keys(reviewer).sort()).toEqual(["description", "prompt", "role"]);

    // Yet the current reviewer prompt asserts a state the runtime does not encode.
    expect(reviewer.prompt).toContain("executor has just completed");
    expect(reviewer.prompt).toContain(original);
  });

  it("CURRENT_CONTRACT: swarm is two same-prompt independent attempts by default", () => {
    const prompt = "Compare provider latency";
    const members = buildSwarmPlan(prompt, "Provider comparison");

    expect(members).toHaveLength(2);
    expect(members.map((member) => member.prompt)).toEqual([prompt, prompt]);
    expect(members[0]!.description).toContain("1/2");
    expect(members[1]!.description).toContain("2/2");
  });

  it("KNOWN_MISMATCH: smart and group use the same fixed-group batching path", async () => {
    const smart = batchHarness();
    smart.orchestrator.addToBatch("smart-1", "smart");
    smart.orchestrator.addToBatch("smart-2", "smart");
    await smart.orchestrator.flush();

    expect(smart.groupJoin.registerGroup).toHaveBeenCalledTimes(1);
    expect(smart.swarmJoin.createSwarm).not.toHaveBeenCalled();

    const group = batchHarness();
    group.orchestrator.addToBatch("group-1", "group");
    group.orchestrator.addToBatch("group-2", "group");
    await group.orchestrator.flush();

    expect(group.groupJoin.registerGroup).toHaveBeenCalledTimes(1);
    expect(group.swarmJoin.createSwarm).not.toHaveBeenCalled();

    // Both choices satisfy the same threshold and invoke the same coordinator.
    expect(smart.groupJoin.registerGroup.mock.calls[0]![1]).toEqual(["smart-1", "smart-2"]);
    expect(group.groupJoin.registerGroup.mock.calls[0]![1]).toEqual(["group-1", "group-2"]);
  });

  it("CURRENT_CONTRACT: explicit swarm forces swarm delivery independent of default JOIN", () => {
    const decision = resolveOrchestrationMode({
      mode: "swarm",
      prompt: "Do the work",
      description: "Work",
      subagentType: "general-purpose",
      runInBackground: true,
    });

    expect(decision.kind).toBe("swarm");
    if (decision.kind !== "swarm") throw new Error("expected swarm decision");
    expect(decision.joinMode).toBe("swarm");
    expect(decision.agents).toHaveLength(2);
  });
});
