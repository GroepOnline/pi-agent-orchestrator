import { describe, expect, it } from "vitest";
import { estimateCostUsd, formatSpend, totalTokens } from "../src/spend.js";

describe("estimateCostUsd", () => {
  it("computes input+output at per-million rates", () => {
    const cost = { input: 1, output: 3 };
    // 100k input @ $1/Mtok = $0.10; 10k output @ $3/Mtok = $0.03
    expect(estimateCostUsd(cost, { input: 100_000, output: 10_000, cacheWrite: 0 })).toBeCloseTo(0.13);
  });

  it("includes cacheRead and cacheWrite when present", () => {
    const cost = { input: 0, output: 0, cacheRead: 0.5, cacheWrite: 2 };
    // 200k cacheRead @ $0.5/M = $0.10; 50k cacheWrite @ $2/M = $0.10
    expect(estimateCostUsd(cost, { input: 0, output: 0, cacheWrite: 50_000, cacheRead: 200_000 })).toBeCloseTo(0.20);
  });

  it("treats missing cost as free", () => {
    expect(estimateCostUsd(undefined, { input: 999, output: 999, cacheWrite: 999 })).toBe(0);
    expect(estimateCostUsd({}, { input: 999, output: 999, cacheWrite: 999 })).toBe(0);
  });
});

describe("formatSpend", () => {
  it("formats compact USD amounts", () => {
    expect(formatSpend(0)).toBe("$0.00");
    expect(formatSpend(-1)).toBe("$0.00");
    expect(formatSpend(0.004)).toBe("<$0.01");
    expect(formatSpend(1.234)).toBe("$1.23");
  });
});

describe("totalTokens", () => {
  it("sums input and output only", () => {
    expect(totalTokens({ input: 10, output: 5, cacheWrite: 100, cacheRead: 7 })).toBe(15);
  });
});
