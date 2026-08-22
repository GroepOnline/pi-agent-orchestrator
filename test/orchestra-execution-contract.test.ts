import { describe, expect, it } from "vitest";
import {
  buildMissionExecutionCorrelation,
  buildMissionExecutionIdempotencyKey,
  ORCHESTRA_EXECUTION_CONTRACT_VERSION,
  validateOrchestraExecutionCorrelation,
} from "../src/orchestra-execution-contract.js";

describe("Orchestra execution correlation contract", () => {
  it("builds a deterministic mission idempotency key", () => {
    const identity = {
      missionId: "mission-42",
      taskId: "feature/auth",
      attemptId: "attempt-3",
    };

    const first = buildMissionExecutionIdempotencyKey(identity);
    const retry = buildMissionExecutionIdempotencyKey(identity);

    expect(first).toBe(retry);
    expect(first).toContain(`v${ORCHESTRA_EXECUTION_CONTRACT_VERSION}`);
    expect(first).toContain("feature%2Fauth");
  });

  it("changes the idempotency key for a new logical mission attempt", () => {
    const base = { missionId: "m1", taskId: "f1" };

    expect(buildMissionExecutionIdempotencyKey({ ...base, attemptId: "1" }))
      .not.toBe(buildMissionExecutionIdempotencyKey({ ...base, attemptId: "2" }));
  });

  it("builds a valid pi-missions correlation envelope", () => {
    const correlation = buildMissionExecutionCorrelation({
      missionId: "m1",
      taskId: "f1",
      attemptId: "a1",
    });

    expect(correlation.caller).toBe("pi-missions");
    expect(validateOrchestraExecutionCorrelation(correlation)).toEqual({ ok: true });
  });

  it("rejects partial mission correlation", () => {
    expect(validateOrchestraExecutionCorrelation({
      caller: "pi-missions",
      missionId: "m1",
      taskId: "f1",
    })).toEqual({ ok: false, reason: "partial_mission_correlation" });
  });

  it("rejects a non-canonical mission idempotency key", () => {
    expect(validateOrchestraExecutionCorrelation({
      caller: "pi-missions",
      missionId: "m1",
      taskId: "f1",
      attemptId: "a1",
      idempotencyKey: "random-key",
    })).toEqual({ ok: false, reason: "invalid_idempotency_key" });
  });

  it("allows non-mission callers without mission-scoped identity", () => {
    expect(validateOrchestraExecutionCorrelation({ caller: "interactive" }))
      .toEqual({ ok: true });
  });
});
