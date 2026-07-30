import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_TOOL_NAMES } from "../src/agent-types.js";
import { loadCustomAgents, parseBooleanOptional, parseBooleanWithDefault } from "../src/custom-agents.js";
import { onTelemetry } from "../src/telemetry.js";

describe("loadCustomAgents", () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAgent(name: string, content: string) {
    const dir = join(tmpDir, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), content);
  }

  it("returns empty map when .pi/agents/ does not exist", async () => {
    const result = await loadCustomAgents(tmpDir);
    expect(result.size).toBe(0);
  });

  it("loads a basic agent with all frontmatter fields", async () => {
    writeAgent("auditor", `---
description: Security Auditor
tools: read, grep
model: anthropic/claude-opus-4-6
thinking: high
max_turns: 30
prompt_mode: replace
inherit_context: true
run_in_background: true
isolated: true
---

You are a security auditor.`);

    const result = await loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);

    const agent = result.get("auditor")!;
    expect(agent.name).toBe("auditor");
    expect(agent.description).toBe("Security Auditor");
    expect(agent.builtinToolNames).toEqual(["read", "grep"]);
    expect(agent.model).toBe("anthropic/claude-opus-4-6");
    expect(agent.thinking).toBe("high");
    expect(agent.maxTurns).toBe(30);
    expect(agent.promptMode).toBe("replace");
    expect(agent.inheritContext).toBe(true);
    expect(agent.runInBackground).toBe(true);
    expect(agent.isolated).toBe(true);
    expect(agent.systemPrompt).toBe("You are a security auditor.");
  });

  it("uses sensible defaults when frontmatter is empty", async () => {
    writeAgent("minimal", `---
---

Just a prompt.`);

    const result = await loadCustomAgents(tmpDir);
    const agent = result.get("minimal")!;

    expect(agent.name).toBe("minimal");
    expect(agent.description).toBe("minimal"); // defaults to filename
    expect(agent.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES); // all tools
    expect(agent.extensions).toBe(true); // inherit all
    expect(agent.skills).toBe(true); // inherit all
    expect(agent.model).toBeUndefined();
    expect(agent.thinking).toBeUndefined();
    expect(agent.maxTurns).toBeUndefined();
    expect(agent.promptMode).toBe("replace");
    expect(agent.inheritContext).toBeUndefined();
    expect(agent.runInBackground).toBeUndefined();
    expect(agent.isolated).toBeUndefined();
    expect(agent.systemPrompt).toBe("Just a prompt.");
  });

  it("uses sensible defaults when no frontmatter at all", async () => {
    writeAgent("bare", "Just a system prompt, no frontmatter.");

    const result = await loadCustomAgents(tmpDir);
    const agent = result.get("bare")!;

    expect(agent.name).toBe("bare");
    expect(agent.description).toBe("bare");
    expect(agent.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
    expect(agent.systemPrompt).toBe("Just a system prompt, no frontmatter.");
  });

  it("handles tools: none → empty array", async () => {
    writeAgent("notool", `---
tools: none
---

No tools.`);

    const result = await loadCustomAgents(tmpDir);
    expect(result.get("notool")!.builtinToolNames).toEqual([]);
  });

  it("handles extensions: false → no extensions", async () => {
    writeAgent("noext", `---
extensions: false
skills: false
---

No extensions.`);

    const result = await loadCustomAgents(tmpDir);
    const agent = result.get("noext")!;
    expect(agent.extensions).toBe(false);
    expect(agent.skills).toBe(false);
  });

  it("handles extension allowlist", async () => {
    writeAgent("partial", `---
extensions: web-search, mcp-server
skills: planning, review
---

Partial access.`);

    const result = await loadCustomAgents(tmpDir);
    const agent = result.get("partial")!;
    expect(agent.extensions).toEqual(["web-search", "mcp-server"]);
    expect(agent.skills).toEqual(["planning", "review"]);
  });

  it("emits telemetry for unknown tool names without blocking custom tools", async () => {
    const unknownToolsEvents: { name: string; tools: string[] }[] = [];
    const unsubscribe = onTelemetry("agent:unknown-tools", payload => {
      unknownToolsEvents.push(payload as { name: string; tools: string[] });
    });

    writeAgent("custom-tools", `---
tools: read, my_custom_tool, grep
---

Custom tools.`);

    try {
      const result = await loadCustomAgents(tmpDir);
      const agent = result.get("custom-tools")!;

      expect(agent.enabled).toBe(true);
      expect(agent.builtinToolNames).toEqual(["read", "my_custom_tool", "grep"]);
      expect(unknownToolsEvents).toEqual([{ name: "custom-tools", tools: ["my_custom_tool"] }]);
    } finally {
      unsubscribe();
    }
  });

  it("drops unknown thinking levels and keeps the Pi allowlist (incl. max)", async () => {
    writeAgent("anythink", `---
thinking: turbo
---

Any thinking.`);
    writeAgent("maxthink", `---
thinking: max
---

Max thinking.`);

    const result = await loadCustomAgents(tmpDir);
    expect(result.get("anythink")!.thinking).toBeUndefined();
    expect(result.get("maxthink")!.thinking).toBe("max");
  });

  it("accepts max_turns: 0 as unlimited", async () => {
    writeAgent("unlimited", `---
max_turns: 0
---

Unlimited turns.`);

    const result = await loadCustomAgents(tmpDir);
    expect(result.get("unlimited")!.maxTurns).toBe(0);
  });

  it("rejects negative max_turns", async () => {
    writeAgent("negturns", `---
max_turns: -5
---

Negative turns.`);

    const result = await loadCustomAgents(tmpDir);
    expect(result.get("negturns")!.maxTurns).toBeUndefined();
  });

  it("handles prompt_mode: append", async () => {
    writeAgent("appender", `---
prompt_mode: append
---

Extra instructions.`);

    const result = await loadCustomAgents(tmpDir);
    expect(result.get("appender")!.promptMode).toBe("append");
  });

  it("defaults unknown prompt_mode to replace", async () => {
    writeAgent("badmode", `---
prompt_mode: merge
---

Unknown mode.`);

    const result = await loadCustomAgents(tmpDir);
    expect(result.get("badmode")!.promptMode).toBe("replace");
  });

  it("loads multiple agents", async () => {
    writeAgent("agent1", `---
description: First
---

First agent.`);
    writeAgent("agent2", `---
description: Second
---

Second agent.`);

    const result = await loadCustomAgents(tmpDir);
    expect(result.size).toBe(2);
    expect(result.has("agent1")).toBe(true);
    expect(result.has("agent2")).toBe(true);
  });

  it("skips non-.md files", async () => {
    const dir = join(tmpDir, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.txt"), "not an agent");
    writeFileSync(join(dir, "real.md"), `---
description: Real Agent
---

Real.`);

    const result = await loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);
    expect(result.has("real")).toBe(true);
  });

  it("allows agents with names matching defaults (overrides them)", async () => {
    writeAgent("Explore", `---
description: Custom Explore
---

Custom explore agent.`);
    writeAgent("custom", `---
description: Custom Agent
---

Should be loaded.`);

    const result = await loadCustomAgents(tmpDir);
    expect(result.has("Explore")).toBe(true);
    expect(result.get("Explore")!.description).toBe("Custom Explore");
    expect(result.has("custom")).toBe(true);
  });

  it("handles empty body with frontmatter", async () => {
    writeAgent("nobody", `---
description: No body
tools: read
---
`);

    const result = await loadCustomAgents(tmpDir);
    expect(result.get("nobody")!.systemPrompt).toBe("");
  });

  it("supports inherit_extensions as alternative to extensions", async () => {
    writeAgent("altkey", `---
inherit_extensions: false
inherit_skills: false
---

Alt keys.`);

    const result = await loadCustomAgents(tmpDir);
    const agent = result.get("altkey")!;
    expect(agent.extensions).toBe(false);
    expect(agent.skills).toBe(false);
  });

  it("extensions: none → false", async () => {
    writeAgent("extnone", `---
extensions: none
skills: none
---

None.`);

    const result = await loadCustomAgents(tmpDir);
    const agent = result.get("extnone")!;
    expect(agent.extensions).toBe(false);
    expect(agent.skills).toBe(false);
  });

  it("extensions: true → true (inherit all)", async () => {
    writeAgent("exttrue", `---
extensions: true
skills: true
---

All.`);

    const result = await loadCustomAgents(tmpDir);
    const agent = result.get("exttrue")!;
    expect(agent.extensions).toBe(true);
    expect(agent.skills).toBe(true);
  });

  it("handles enabled: false frontmatter", async () => {
    writeAgent("disabled", `---
enabled: false
---
`);

    const result = await loadCustomAgents(tmpDir);
    const agent = result.get("disabled")!;
    expect(agent.enabled).toBe(false);
  });

  it("parses display_name frontmatter", async () => {
    writeAgent("myagent", `---
description: My Agent
display_name: MyAgent
---

Agent prompt.`);

    const result = await loadCustomAgents(tmpDir);
    expect(result.get("myagent")!.displayName).toBe("MyAgent");
  });

  it("parses disallowed_tools as csv list", async () => {
    writeAgent("restricted", `---
description: Restricted Agent
disallowed_tools: bash, write
---

No bash or write.`);

    const result = await loadCustomAgents(tmpDir);
    const agent = result.get("restricted")!;
    expect(agent.disallowedTools).toEqual(["bash", "write"]);
  });

  it("disallowed_tools defaults to undefined when omitted", async () => {
    writeAgent("unrestricted", `---
description: Unrestricted
---

All tools.`);

    const result = await loadCustomAgents(tmpDir);
    expect(result.get("unrestricted")!.disallowedTools).toBeUndefined();
  });

  it("parses memory scope", async () => {
    writeAgent("rememberer", `---
description: Agent with memory
memory: project
---

Remember things.`);

    const result = await loadCustomAgents(tmpDir);
    expect(result.get("rememberer")!.memory).toBe("project");
  });

  it("parses memory: user scope", async () => {
    writeAgent("global-mem", `---
memory: user
---

User memory.`);

    const result = await loadCustomAgents(tmpDir);
    expect(result.get("global-mem")!.memory).toBe("user");
  });

  it("memory defaults to undefined when omitted", async () => {
    writeAgent("no-mem", `---
description: No memory
---

Stateless.`);

    const result = await loadCustomAgents(tmpDir);
    expect(result.get("no-mem")!.memory).toBeUndefined();
  });

  it("rejects invalid memory scope", async () => {
    writeAgent("bad-mem", `---
memory: invalid
---

Bad memory.`);

    const result = await loadCustomAgents(tmpDir);
    expect(result.get("bad-mem")!.memory).toBeUndefined();
  });

  it("parses isolation: worktree", async () => {
    writeAgent("isolated-wt", `---
description: Worktree agent
isolation: worktree
---

Isolated.`);

    const result = await loadCustomAgents(tmpDir);
    expect(result.get("isolated-wt")!.isolation).toBe("worktree");
  });

  it("isolation defaults to undefined when omitted", async () => {
    writeAgent("no-isolation", `---
description: Normal
---

Normal.`);

    const result = await loadCustomAgents(tmpDir);
    expect(result.get("no-isolation")!.isolation).toBeUndefined();
  });

  it("rejects invalid isolation mode", async () => {
    writeAgent("bad-isolation", `---
isolation: docker
---

Bad isolation.`);

    const result = await loadCustomAgents(tmpDir);
    expect(result.get("bad-isolation")!.isolation).toBeUndefined();
  });

  it("handoff: \"false\" (string) parses as false (regression — was truthy before strict parsing)", async () => {
    writeAgent("string-false", `---\nhandoff: "false"\n---\n\nString false.`);
    const result = await loadCustomAgents(tmpDir);
    expect(result.get("string-false")!.handoff).toBe(false);
  });

  it("handoff: false (boolean) parses as false", async () => {
    writeAgent("bool-false", `---\nhandoff: false\n---\n\nBoolean false.`);
    const result = await loadCustomAgents(tmpDir);
    expect(result.get("bool-false")!.handoff).toBe(false);
  });

  it("handoff defaults to false when omitted from frontmatter", async () => {
    writeAgent("no-handoff-key", `---\ndescription: Missing handoff key\n---\n\nDefault.`);
    const result = await loadCustomAgents(tmpDir);
    expect(result.get("no-handoff-key")!.handoff).toBe(false);
  });

  it("parses prompt_compression: aggressive into AgentConfig.promptCompressionLevel", async () => {
    writeAgent("aggressive-agent", `---\nprompt_compression: aggressive\n---\n\nAggressive agent.`);
    const result = await loadCustomAgents(tmpDir);
    expect(result.get("aggressive-agent")!.promptCompressionLevel).toBe("aggressive");
  });

  describe("parseBooleanOptional", () => {
    it("returns undefined for null", () => {
      expect(parseBooleanOptional(null)).toBeUndefined();
    });
    it("returns undefined for undefined", () => {
      expect(parseBooleanOptional(undefined)).toBeUndefined();
    });
    it("returns undefined for empty string", () => {
      expect(parseBooleanOptional("")).toBeUndefined();
    });
    it("parses 'TRUE' (uppercase) as true", () => {
      expect(parseBooleanOptional("TRUE")).toBe(true);
    });
    it("parses 'False' (mixed case) as false", () => {
      expect(parseBooleanOptional("False")).toBe(false);
    });
    it("parses native boolean true", () => {
      expect(parseBooleanOptional(true)).toBe(true);
    });
    it("parses native boolean false", () => {
      expect(parseBooleanOptional(false)).toBe(false);
    });
  });

  describe("parseBooleanWithDefault", () => {
    it("returns default for null", () => {
      expect(parseBooleanWithDefault(null, true)).toBe(true);
    });
    it("returns default for undefined", () => {
      expect(parseBooleanWithDefault(undefined, false)).toBe(false);
    });
    it("returns default for empty string", () => {
      expect(parseBooleanWithDefault("", false)).toBe(false);
    });
    it("throws on number 42 (invalid type)", () => {
      expect(() => parseBooleanWithDefault(42, false)).toThrow();
    });
    it("throws on string 'maybe' (unrecognised)", () => {
      expect(() => parseBooleanWithDefault("maybe", true)).toThrow();
    });
  });

  it("honors PI_CODING_AGENT_DIR for global custom agent discovery", async () => {
    const altAgentDir = mkdtempSync(join(tmpdir(), "pi-alt-agent-"));
    const originalEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = altAgentDir;
    try {
      const globalAgentsDir = join(altAgentDir, "agents");
      mkdirSync(globalAgentsDir, { recursive: true });
      writeFileSync(
        join(globalAgentsDir, "via-env.md"),
        "---\ndescription: Discovered via env var\n---\n\nTest body.",
      );

      const result = await loadCustomAgents(tmpDir);

      // Agent is found at $PI_CODING_AGENT_DIR/agents, not at $HOME/.pi/agent/agents
      expect(result.has("via-env")).toBe(true);
      expect(result.get("via-env")!.description).toBe("Discovered via env var");
    } finally {
      if (originalEnv == null) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalEnv;
      rmSync(altAgentDir, { recursive: true, force: true });
    }
  });

  it("rejects agents with unsafe characters in the middle of the name", async () => {
    writeAgent("agent..traversal", `---
description: Unsafe
---

Unsafe agent.`);

    const result = await loadCustomAgents(tmpDir);
    expect(result.get("agent..traversal")!.enabled).toBe(false);
  });

  it("parses validators frontmatter as an array of {agentId, criteria}", async () => {
    writeAgent("chain-validator", `---
description: Chain validator
validators:
  - agentId: security-check
    criteria:
      - "no secrets in output"
      - "input is sanitized"
  - agentId: style-check
    criteria:
      - "uses project linter"
      - "no eslint disable comments"
---

You are a chain validator.`);
    const result = await loadCustomAgents(tmpDir);
    const agent = result.get("chain-validator")!;
    expect(agent.validators).toEqual([
      { agentId: "security-check", criteria: ["no secrets in output", "input is sanitized"] },
      { agentId: "style-check", criteria: ["uses project linter", "no eslint disable comments"] },
    ]);
  });

  it("validators defaults to undefined when omitted from frontmatter", async () => {
    writeAgent("no-validators", `---
description: No validators
---

Plain agent.`);
    const result = await loadCustomAgents(tmpDir);
    expect(result.get("no-validators")!.validators).toBeUndefined();
  });

  it("validators: [] (empty array) parses as undefined (no validators)", async () => {
    writeAgent("empty-validators", `---
description: Empty validators
validators: []
---

Plain agent.`);
    const result = await loadCustomAgents(tmpDir);
    expect(result.get("empty-validators")!.validators).toBeUndefined();
  });

  it("strict-rejects validator with non-string agentId (whole array dropped, agent remains enabled)", async () => {
    writeAgent("bad-validator", `---
description: Malformed validator
validators:
  - agentId: 42
    criteria:
      - "some criterion"
---

Malformed.`);
    const result = await loadCustomAgents(tmpDir);
    const agent = result.get("bad-validator")!;
    expect(agent.validators).toBeUndefined();
    // Permissive parser — does NOT disable the agent; validateAgentConfig handles security flags separately.
    expect(agent.enabled).toBe(true);
  });

  it("strict-rejects mixed valid/invalid validator entries (whole array dropped)", async () => {
    writeAgent("mixed-validators", `---
description: One good, one bad
validators:
  - agentId: good
    criteria:
      - "ok"
  - agentId: 42
    criteria:
      - "bad entry"
---

Mixed.`);
    const result = await loadCustomAgents(tmpDir);
    const agent = result.get("mixed-validators")!;
    // Strict-reject: the bad entry drops the whole array (conscious design choice,
    // see parseValidators JSDoc).
    expect(agent.validators).toBeUndefined();
  });

});
