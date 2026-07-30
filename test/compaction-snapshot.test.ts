import { describe, expect, it } from "vitest";
import { buildCompactionSnapshot } from "../src/compaction-snapshot.js";

describe("buildCompactionSnapshot", () => {
  it("maps a successful upstream compaction_end with after/usage metrics", () => {
    const snapshot = buildCompactionSnapshot({
      reason: "threshold",
      aborted: false,
      willRetry: false,
      result: {
        tokensBefore: 20000,
        estimatedTokensAfter: 8000,
        firstKeptEntryId: "entry-9",
        usage: { input: 1200, output: 400, cacheWrite: 50 },
      },
    });

    expect(snapshot).toEqual({
      reason: "threshold",
      tokensBefore: 20000,
      tokensAfter: 8000,
      reductionPercent: 60,
      firstKeptEntryId: "entry-9",
      usage: { input: 1200, output: 400, cacheWrite: 50 },
      aborted: false,
      willRetry: false,
    });
  });

  it("preserves aborted/retry failure fields without requiring result.usage", () => {
    const snapshot = buildCompactionSnapshot({
      reason: "overflow",
      aborted: true,
      willRetry: true,
      errorMessage: "provider timeout",
      result: { tokensBefore: 1000 },
    });

    expect(snapshot).toMatchObject({
      reason: "overflow",
      tokensBefore: 1000,
      aborted: true,
      willRetry: true,
      errorMessage: "provider timeout",
    });
    expect(snapshot.usage).toBeUndefined();
    expect(snapshot.reductionPercent).toBeUndefined();
  });
});
