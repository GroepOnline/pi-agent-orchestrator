import { describe, expect, it } from "vitest";
import {
  buildAgentSystemPrompt,
  normalizeWizardName,
  parseAgentSystemBlueprint,
  validateBlueprintForSelections,
} from "../src/ui/agent-blueprint.js";

function agentContent(
  description = "Primary test agent",
  extraFrontmatter = "",
): string {
  return `---
description: ${description}
tools: read, bash, grep
disallowed_tools: write, edit
extensions: false
isolated: true
prompt_mode: replace
${extraFrontmatter}---

Perform the requested work and return evidence.
`;
}

function blueprintJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    summary: "Test system",
    warnings: [],
    agents: [{ name: "ChefSystem", primary: true, content: agentContent() }],
    skills: [],
    schedule: null,
    ...overrides,
  });
}

describe("normalizeWizardName", () => {
  it("removes terminal control characters including DEL", () => {
    expect(normalizeWizardName("\u007fC\u007fh\u007fe\u007ffSys\u0008tem")).toBe("ChefSystem");
  });

  it("rejects spaces and paths", () => {
    expect(() => normalizeWizardName("bad name")).toThrow(/no spaces or paths/);
    expect(() => normalizeWizardName("../escape")).toThrow(/no spaces or paths/);
  });
});

describe("parseAgentSystemBlueprint", () => {
  it("parses fenced JSON and assigns the requested agent as primary", () => {
    const raw = `\`\`\`json
${JSON.stringify({
  summary: "One read-only specialist",
  warnings: [],
  agents: [{ name: "ChefSystem", content: agentContent(), primary: false }],
  skills: [],
  schedule: null,
})}
\`\`\``;

    const result = parseAgentSystemBlueprint(raw, "ChefSystem");
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].primary).toBe(true);
    expect(result.schedule).toBeUndefined();
  });

  it("parses companion agents, skills, and a schedule", () => {
    const result = parseAgentSystemBlueprint(JSON.stringify({
      summary: "Scheduled validation loop",
      warnings: ["Scheduler is session-scoped"],
      agents: [
        { name: "ChefSystem", primary: true, content: agentContent("Primary", "handoff: true\n") },
        { name: "ChefReviewer", primary: false, content: agentContent("Reviewer") },
      ],
      skills: [{
        name: "evidence-check",
        content: `---
name: evidence-check
description: Verify evidence
---

Require file paths and concrete verification.
`,
      }],
      schedule: {
        name: "ChefSystem-hourly",
        description: "Hourly validation",
        schedule: "1h",
        prompt: "Inspect the current project and validate the target.",
        thinking: "high",
        max_turns: 20,
        isolated: true,
        isolation: "worktree",
      },
    }), "ChefSystem");

    expect(result.agents.map((agent) => agent.name)).toEqual(["ChefSystem", "ChefReviewer"]);
    expect(result.skills[0].name).toBe("evidence-check");
    expect(result.schedule?.schedule).toBe("1h");
    expect(result.schedule?.thinking).toBe("high");
  });

  it("rejects malformed YAML and unsupported runtime fields", () => {
    expect(() => parseAgentSystemBlueprint(blueprintJson({
      agents: [{
        name: "ChefSystem",
        primary: true,
        content: "---\ndescription: [unterminated\n---\n\nBody\n",
      }],
    }), "ChefSystem")).toThrow(/invalid YAML frontmatter/);

    expect(() => parseAgentSystemBlueprint(blueprintJson({
      agents: [{
        name: "ChefSystem",
        primary: true,
        content: agentContent("Bad field", "invented_runtime_option: true\n"),
      }],
    }), "ChefSystem")).toThrow(/unsupported frontmatter field/);
  });

  it("rejects a missing or out-of-order requested primary agent", () => {
    expect(() => parseAgentSystemBlueprint(JSON.stringify({
      agents: [{ name: "Other", primary: true, content: agentContent() }],
      skills: [],
    }), "ChefSystem")).toThrow(/must contain the requested primary agent/);

    expect(() => parseAgentSystemBlueprint(JSON.stringify({
      agents: [
        { name: "Other", primary: false, content: agentContent() },
        { name: "ChefSystem", primary: true, content: agentContent() },
      ],
      skills: [],
    }), "ChefSystem")).toThrow(/must be first/);
  });

  it("rejects duplicate or unsafe resource names", () => {
    expect(() => parseAgentSystemBlueprint(JSON.stringify({
      agents: [
        { name: "ChefSystem", primary: true, content: agentContent() },
        { name: "ChefSystem", primary: false, content: agentContent() },
      ],
      skills: [],
    }), "ChefSystem")).toThrow(/Duplicate agent name/);

    expect(() => parseAgentSystemBlueprint(blueprintJson({
      skills: [{ name: "../escape", content: agentContent() }],
    }), "ChefSystem")).toThrow(/no spaces or paths/);
  });

  it("rejects definitions without frontmatter and instruction bodies", () => {
    expect(() => parseAgentSystemBlueprint(blueprintJson({
      agents: [{ name: "ChefSystem", primary: true, content: "plain text" }],
    }), "ChefSystem")).toThrow(/must start with YAML frontmatter/);

    expect(() => parseAgentSystemBlueprint(blueprintJson({
      agents: [{ name: "ChefSystem", primary: true, content: "---\ndescription: empty\n---\n" }],
    }), "ChefSystem")).toThrow(/instruction body/);
  });

  it("rejects validators that reference a nonexistent agent", () => {
    const validatorFrontmatter = "validators:\n  - agentId: MissingReviewer\n    criteria:\n      - Verify evidence\n";
    expect(() => parseAgentSystemBlueprint(blueprintJson({
      agents: [{ name: "ChefSystem", primary: true, content: agentContent("Primary", validatorFrontmatter) }],
    }), "ChefSystem")).toThrow(/unknown validator agent/);

    const result = parseAgentSystemBlueprint(JSON.stringify({
      agents: [
        { name: "ChefSystem", primary: true, content: agentContent("Primary", validatorFrontmatter.replace("MissingReviewer", "ChefReviewer")) },
        { name: "ChefReviewer", primary: false, content: agentContent("Reviewer") },
      ],
      skills: [],
    }), "ChefSystem");
    expect(result.agents.map((agent) => agent.name)).toEqual(["ChefSystem", "ChefReviewer"]);
  });
});

describe("validateBlueprintForSelections", () => {
  it("rejects mutation permissions under strictly read-only selection", () => {
    const blueprint = parseAgentSystemBlueprint(blueprintJson({
      agents: [{
        name: "ChefSystem",
        primary: true,
        content: `---
description: Unsafe agent
tools: read, edit, write
prompt_mode: replace
---

Mutate files.
`,
      }],
    }), "ChefSystem");

    expect(validateBlueprintForSelections(blueprint, {
      architecture: "single",
      autonomy: "read-only",
      skillPolicy: "never",
      scheduleRequest: { mode: "none", hint: "On demand only" },
    })).toMatch(/may not grant edit or write/);
  });

  it("enforces an exact one-shot or recurring expression", () => {
    const blueprint = parseAgentSystemBlueprint(blueprintJson({
      schedule: {
        name: "ChefSystem-schedule",
        description: "Wrong timing",
        schedule: "1h",
        prompt: "Run once.",
        isolated: true,
      },
    }), "ChefSystem");

    expect(validateBlueprintForSelections(blueprint, {
      architecture: "scheduled",
      autonomy: "read-only",
      skillPolicy: "never",
      scheduleRequest: {
        mode: "exact",
        hint: "Run once exactly at the requested time",
        expectedExpression: "2099-01-01T12:00:00Z",
      },
    })).toContain("must exactly match");
  });

  it("requires handoffs for chains and validators for agentic loops", () => {
    const twoAgents = parseAgentSystemBlueprint(blueprintJson({
      agents: [
        { name: "ChefSystem", primary: true, content: agentContent() },
        { name: "ChefReviewer", primary: false, content: agentContent("Reviewer") },
      ],
    }), "ChefSystem");
    expect(validateBlueprintForSelections(twoAgents, {
      architecture: "chain",
      autonomy: "safe",
      skillPolicy: "never",
      scheduleRequest: { mode: "none", hint: "On demand" },
    })).toMatch(/handoff: true/);

    const single = parseAgentSystemBlueprint(blueprintJson(), "ChefSystem");
    expect(validateBlueprintForSelections(single, {
      architecture: "loop",
      autonomy: "safe",
      skillPolicy: "never",
      scheduleRequest: { mode: "none", hint: "On demand" },
    })).toMatch(/requires adversarial validators/);
  });
});

describe("buildAgentSystemPrompt", () => {
  it("describes agents, skills, loops, and exact scheduling without granting file writes", () => {
    const prompt = buildAgentSystemPrompt({
      requestedName: "ChefSystem",
      description: "Build a scheduled review and repair loop",
      architecture: "full",
      autonomy: "full",
      skillPolicy: "always",
      scheduleRequest: {
        mode: "exact",
        hint: 'Create a cron schedule using exactly "0 9 * * 1-5".',
        expectedExpression: "0 9 * * 1-5",
      },
      targetAgentDir: "/repo/.pi/agents",
      targetSkillDir: "/repo/.pi/skills",
    });

    expect(prompt).toContain("REQUESTED PRIMARY AGENT NAME: ChefSystem");
    expect(prompt).toContain("validators");
    expect(prompt).toContain("handoff");
    expect(prompt).toContain('exactly "0 9 * * 1-5"');
    expect(prompt).toContain("/repo/.pi/skills/<name>/SKILL.md");
    expect(prompt).toContain("You must NOT call write/edit or create files yourself.");
    expect(prompt).toContain("Return strict JSON only");
  });
});
