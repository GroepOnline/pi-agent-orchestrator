import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

describe("lowest supported peer dependency CI", () => {
  it("rewrites the host dev dependencies before the first install", () => {
    const start = workflow.indexOf("      - name: Install lowest supported peer dependencies");
    const end = workflow.indexOf("\n      - name: Typecheck", start);
    const step = workflow.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(step).not.toMatch(/^\s+npm ci$/m);
    expect(step).toContain('pkg.devDependencies["@earendil-works/pi-ai"] = "0.81.1"');
    expect(step).toContain('pkg.devDependencies["@earendil-works/pi-coding-agent"] = "0.81.1"');
    expect(step).toContain('pkg.devDependencies["@earendil-works/pi-agent-core"] = "0.81.1"');
    expect(step).toContain("npm install --package-lock=false --include=dev");
  });
});
