import { describe, expect, it } from "vitest";
import { classifyNpmViewResult } from "../scripts/npm-version-state.mjs";

const VERSION = "0.18.1";

describe("classifyNpmViewResult", () => {
  it("treats an exact version match as present", () => {
    expect(classifyNpmViewResult({ status: 0, stdout: `${VERSION}\n`, stderr: "" }, VERSION)).toEqual({
      state: "present",
    });
  });

  it("fails closed on a clean query for another version", () => {
    const outcome = classifyNpmViewResult(
      { status: 0, stdout: "0.18.0\n", stderr: "" },
      VERSION,
    );
    expect(outcome.state).toBe("unknown");
  });

  it("fails closed on an empty clean query", () => {
    expect(classifyNpmViewResult({ status: 0, stdout: "\n", stderr: "" }, VERSION).state).toBe(
      "unknown",
    );
  });

  it("fails closed on JSON-quoted output from inherited npm_config_json", () => {
    const outcome = classifyNpmViewResult(
      { status: 0, stdout: `"${VERSION}"\n`, stderr: "" },
      VERSION,
    );
    expect(outcome.state).toBe("unknown");
  });

  it("treats an E404 as absent", () => {
    const outcome = classifyNpmViewResult(
      { status: 1, stdout: "", stderr: "npm error code E404\nnpm error 404 Not Found" },
      VERSION,
    );
    expect(outcome.state).toBe("absent");
  });

  it("fails closed on a network error instead of reporting absent", () => {
    const outcome = classifyNpmViewResult(
      { status: 1, stdout: "", stderr: "npm error code ETIMEDOUT" },
      VERSION,
    );
    expect(outcome.state).toBe("unknown");
    expect(outcome.reason).toContain("ETIMEDOUT");
  });

  it("fails closed when npm could not be spawned", () => {
    const outcome = classifyNpmViewResult(
      { status: null, stdout: null, stderr: null, error: new Error("spawn npm ENOENT") },
      VERSION,
    );
    expect(outcome.state).toBe("unknown");
    expect(outcome.reason).toContain("ENOENT");
  });

  it("fails closed on an auth failure", () => {
    const outcome = classifyNpmViewResult(
      { status: 1, stdout: "", stderr: "npm error code E401\nUnable to authenticate" },
      VERSION,
    );
    expect(outcome.state).toBe("unknown");
  });
});
