import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSystemBlueprint } from "../src/ui/agent-blueprint.js";
import { writeBlueprintFilesAtomically } from "../src/ui/agent-blueprint-writer.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-blueprint-writer-"));
  roots.push(root);
  return root;
}

function blueprint(agentContent: string, withSkill = false): AgentSystemBlueprint {
  return {
    summary: "Test",
    warnings: [],
    agents: [{ name: "ChefSystem", primary: true, content: agentContent }],
    skills: withSkill
      ? [{
        name: "evidence-check",
        content: "---\nname: evidence-check\ndescription: Verify evidence\n---\n\nVerify evidence.\n",
      }]
      : [],
  };
}

describe("writeBlueprintFilesAtomically", () => {
  it("does not overwrite an existing agent when a later resource cannot be staged", () => {
    const root = makeRoot();
    const agents = join(root, ".pi", "agents");
    mkdirSync(agents, { recursive: true });
    const agentPath = join(agents, "ChefSystem.md");
    writeFileSync(agentPath, "old-agent", "utf-8");

    // Blocks creation of .pi/skills/evidence-check before any destination is replaced.
    writeFileSync(join(root, ".pi", "skills"), "not-a-directory", "utf-8");

    expect(() => writeBlueprintFilesAtomically(agents, blueprint("new-agent", true))).toThrow(/not a real directory/);
    expect(readFileSync(agentPath, "utf-8")).toBe("old-agent");
  });

  it("restores previous files and removes new files when the caller rolls back", () => {
    const root = makeRoot();
    const agents = join(root, ".pi", "agents");
    mkdirSync(agents, { recursive: true });
    const existingPath = join(agents, "ChefSystem.md");
    writeFileSync(existingPath, "old-agent", "utf-8");

    const transaction = writeBlueprintFilesAtomically(agents, blueprint("new-agent", true));
    const skillPath = join(root, ".pi", "skills", "evidence-check", "SKILL.md");
    expect(readFileSync(existingPath, "utf-8")).toBe("new-agent");
    expect(existsSync(skillPath)).toBe(true);

    transaction.rollback();
    expect(readFileSync(existingPath, "utf-8")).toBe("old-agent");
    expect(existsSync(skillPath)).toBe(false);
  });

  it("finalizes committed files and removes backups", () => {
    const root = makeRoot();
    const agents = join(root, ".pi", "agents");
    const transaction = writeBlueprintFilesAtomically(agents, blueprint("new-agent"));
    transaction.finalize();

    expect(readFileSync(join(agents, "ChefSystem.md"), "utf-8")).toBe("new-agent");
    expect(existsSync(agents)).toBe(true);
  });
});
