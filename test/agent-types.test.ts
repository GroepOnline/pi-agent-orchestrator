import { beforeEach, describe, expect, it } from "vitest";
import {
  BUILTIN_TOOL_NAMES,
  type EffectiveConfig,
  filterByPartitions,
  getAgentConfig,
  getAvailableTypes,
  getConfig,
  getDefaultAgentNames,
  getMemoryToolNames,
  getReadOnlyMemoryToolNames,
  getToolNamesForType,
  getUserAgentNames,
  isValidType,
  normalizeBuiltinToolNames,
  registerAgents,
  resolveType,
} from "../src/agent-types.js";
import type { AgentConfig } from "../src/types.js";

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    description: "Test agent",
    builtinToolNames: ["read", "grep"],
    extensions: false,
    skills: false,
    systemPrompt: "You are a test agent.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
    ...overrides,
  };
}

describe("agent type registry", () => {
  beforeEach(() => {
    registerAgents(new Map());
  });

  describe("default agents", () => {
    it("recognizes all default agent types", () => {
      expect(isValidType("general-purpose")).toBe(true);
      expect(isValidType("Explore")).toBe(true);
      expect(isValidType("Plan")).toBe(true);
    });

    it("does not include removed agents", () => {
      expect(isValidType("statusline-setup")).toBe(false);
      expect(isValidType("claude-code-guide")).toBe(false);
    });

    it("rejects unknown types", () => {
      expect(isValidType("nonexistent")).toBe(false);
      expect(isValidType("")).toBe(false);
    });

    it("case-insensitive lookup works for isValidType", () => {
      expect(isValidType("explore")).toBe(true);
      expect(isValidType("EXPLORE")).toBe(true);
      expect(isValidType("General-Purpose")).toBe(true);
      expect(isValidType("plan")).toBe(true);
    });

    it("case-insensitive lookup works for getAgentConfig", () => {
      const config = getAgentConfig("explore");
      expect(config?.name).toBe("Explore");
      expect(config?.model).toBe("anthropic/claude-haiku-4-5");
    });

    it("resolveType returns canonical key or undefined", () => {
      expect(resolveType("Explore")).toBe("Explore");
      expect(resolveType("explore")).toBe("Explore");
      expect(resolveType("GENERAL-PURPOSE")).toBe("general-purpose");
      expect(resolveType("nonexistent")).toBeUndefined();
    });

    it("returns correct config for default types", () => {
      const config = getConfig("general-purpose");
      expect(config.displayName).toBe("Agent");
      expect(config.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
      expect(config.extensions).toBe(true);
      expect(config.skills).toBe(true);
    });

    it("Explore has read-only tools", () => {
      const config = getConfig("Explore");
      expect(config.builtinToolNames).toEqual(["read", "bash", "grep"]);
      expect(config.builtinToolNames).not.toContain("edit");
      expect(config.builtinToolNames).not.toContain("write");
    });

    it("Explore has haiku model in config", () => {
      const cfg = getAgentConfig("Explore");
      expect(cfg?.model).toBe("anthropic/claude-haiku-4-5");
    });

    it("default agents are marked isDefault", () => {
      const cfg = getAgentConfig("general-purpose");
      expect(cfg?.isDefault).toBe(true);
    });

    // Regression guard for #37 — default agents must not bake in callsite-strategy fields.
    // An explicit `false` here would silently win over the caller's `true` via `??` in
    // resolveAgentInvocationConfig, breaking documented Agent tool params.
    it("default agents do not lock strategy fields (run_in_background / inherit_context / isolated)", () => {
      for (const name of ["general-purpose", "Explore", "Plan"]) {
        const cfg = getAgentConfig(name);
        expect(cfg?.runInBackground, `${name}.runInBackground`).toBeUndefined();
        expect(cfg?.inheritContext, `${name}.inheritContext`).toBeUndefined();
        expect(cfg?.isolated, `${name}.isolated`).toBeUndefined();
      }
    });

    it("getDefaultAgentNames returns default agent names", () => {
      const names = getDefaultAgentNames();
      expect(names).toContain("general-purpose");
      expect(names).toContain("Explore");
      expect(names).toContain("Plan");
    });

    it("BUILTIN_TOOL_NAMES includes all built-in tools", () => {
      expect(BUILTIN_TOOL_NAMES).toContain("read");
      expect(BUILTIN_TOOL_NAMES).toContain("bash");
      expect(BUILTIN_TOOL_NAMES).toContain("edit");
      expect(BUILTIN_TOOL_NAMES).toContain("write");
      expect(BUILTIN_TOOL_NAMES).toContain("grep");
      expect(BUILTIN_TOOL_NAMES).not.toContain("find");
      expect(BUILTIN_TOOL_NAMES).not.toContain("ls");
      expect(BUILTIN_TOOL_NAMES).toEqual(["read", "bash", "edit", "write", "grep"]);
    });

    // Audit B8: `find` and `ls` were never real pi tools — they were Claude
    // Code carry-over. This test pins the post-fix BUILTIN_TOOL_NAMES list
    // explicitly so a future regression that re-adds them is caught.
    it("BUILTIN_TOOL_NAMES excludes non-pi tools (audit B8)", () => {
      expect(BUILTIN_TOOL_NAMES).not.toContain("find");
      expect(BUILTIN_TOOL_NAMES).not.toContain("ls");
      expect(new Set(BUILTIN_TOOL_NAMES)).toEqual(
        new Set(["read", "bash", "edit", "write", "grep"]),
      );
    });
  });

  describe("user agents", () => {
    it("registers and retrieves user agents", () => {
      const agents = new Map([["auditor", makeAgentConfig({ name: "auditor", description: "Auditor" })]]);
      registerAgents(agents);

      expect(isValidType("auditor")).toBe(true);
      expect(getAgentConfig("auditor")?.description).toBe("Auditor");
    });

    it("includes user agents in available types", () => {
      const agents = new Map([["auditor", makeAgentConfig({ name: "auditor" })]]);
      registerAgents(agents);

      const types = getAvailableTypes();
      expect(types).toContain("general-purpose");
      expect(types).toContain("Explore");
      expect(types).toContain("auditor");
    });

    it("lists user agent names separately", () => {
      const agents = new Map([
        ["auditor", makeAgentConfig({ name: "auditor" })],
        ["reviewer", makeAgentConfig({ name: "reviewer" })],
      ]);
      registerAgents(agents);

      const names = getUserAgentNames();
      expect(names).toEqual(["auditor", "reviewer"]);
      expect(names).not.toContain("general-purpose");
    });

    it("getConfig returns config for user agents", () => {
      const agents = new Map([["auditor", makeAgentConfig({
        name: "auditor",
        description: "Security auditor",
        builtinToolNames: ["read", "grep"],
        extensions: false,
        skills: true,
      })]]);
      registerAgents(agents);

      const config = getConfig("auditor");
      expect(config.displayName).toBe("auditor");
      expect(config.description).toBe("Security auditor");
      expect(config.builtinToolNames).toEqual(["read", "grep"]);
      expect(config.extensions).toBe(false);
      expect(config.skills).toBe(true);
    });

    it("getConfig returns extension allowlist for user agents", () => {
      const agents = new Map([["partial", makeAgentConfig({
        name: "partial",
        extensions: ["web-search"],
        skills: ["planning"],
      })]]);
      registerAgents(agents);

      const config = getConfig("partial");
      expect(config.extensions).toEqual(["web-search"]);
      expect(config.skills).toEqual(["planning"]);
    });

    it("getToolNamesForType works for user agents", () => {
      const agents = new Map([["auditor", makeAgentConfig({
        name: "auditor",
        builtinToolNames: ["read", "grep"],
      })]]);
      registerAgents(agents);

      const names = getToolNamesForType("auditor");
      expect(names).toEqual(["read", "grep"]);
    });

    it("getConfig falls back to safe-minimal config for unknown types (audit A2)", () => {
      const config = getConfig("nonexistent");
      expect(config.displayName).toBe("Agent");
      expect(config.description).toBe("Safe fallback agent with minimal read-only permissions");
      // Safe-minimal allowlist: read-only, no file modifications.
      expect(config.builtinToolNames).toEqual(["read", "bash", "grep"]);
      // No extension or skills exposure (audit A2).
      expect(config.extensions).toBe(false);
      expect(config.skills).toBe(false);
    });

    it("clearing user agents works (defaults remain)", () => {
      const agents = new Map([["auditor", makeAgentConfig({ name: "auditor" })]]);
      registerAgents(agents);
      expect(isValidType("auditor")).toBe(true);

      registerAgents(new Map());
      expect(isValidType("auditor")).toBe(false);
      expect(isValidType("general-purpose")).toBe(true);
    });

    it("user agent overrides default with same name", () => {
      const agents = new Map([["Explore", makeAgentConfig({
        name: "Explore",
        description: "Custom Explore",
        builtinToolNames: BUILTIN_TOOL_NAMES,
      })]]);
      registerAgents(agents);

      const config = getConfig("Explore");
      expect(config.description).toBe("Custom Explore");
      expect(config.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
    });

    it("disabled agent is excluded from available types", () => {
      const agents = new Map([["Plan", makeAgentConfig({
        name: "Plan",
        enabled: false,
      })]]);
      registerAgents(agents);

      expect(isValidType("Plan")).toBe(false);
      expect(getAvailableTypes()).not.toContain("Plan");
    });

    it("general-purpose can be disabled but fallback still works", () => {
      const agents = new Map([["general-purpose", makeAgentConfig({
        name: "general-purpose",
        enabled: false,
      })]]);
      registerAgents(agents);

      expect(isValidType("general-purpose")).toBe(false);
      // getConfig fallback should still return something reasonable
      const config = getConfig("general-purpose");
      expect(config.displayName).toBe("Agent");
    });
  });

  describe("getMemoryToolNames", () => {
    it("returns read, write, edit when none exist", () => {
      const names = getMemoryToolNames(new Set());
      expect(names).toContain("read");
      expect(names).toContain("write");
      expect(names).toContain("edit");
      expect(names).toHaveLength(3);
    });

    it("skips tools that already exist", () => {
      const names = getMemoryToolNames(new Set(["read", "edit"]));
      expect(names).toEqual(["write"]);
    });

    it("returns empty when all memory tools already exist", () => {
      const names = getMemoryToolNames(new Set(["read", "write", "edit"]));
      expect(names).toHaveLength(0);
    });
  });

  describe("getReadOnlyMemoryToolNames", () => {
    it("returns only read when missing", () => {
      const names = getReadOnlyMemoryToolNames(new Set());
      expect(names).toEqual(["read"]);
    });

    it("returns empty when read already exists", () => {
      const names = getReadOnlyMemoryToolNames(new Set(["read"]));
      expect(names).toHaveLength(0);
    });
  });

  describe("permission inheritance", () => {
    const READ_ONLY_TOOLS = ["read", "bash", "grep"];
    const ALL_TOOLS = BUILTIN_TOOL_NAMES;

    it("RO parent spawns child → child tools are subset of parent RO tools", () => {
      // Explore (RO) spawns general-purpose (RW-configured) child
      // Child must be restricted to parent's RO tool set
      const parentConfig: EffectiveConfig = {
        builtinToolNames: READ_ONLY_TOOLS,
        extensions: true,
        skills: true,
      };

      const child = getConfig("general-purpose", parentConfig);

      // Child should not have write/edit (parent doesn't have them)
      expect(child.builtinToolNames).not.toContain("write");
      expect(child.builtinToolNames).not.toContain("edit");
      // Child should have read-only tools (intersection with parent)
      expect(child.builtinToolNames).toContain("read");
      expect(child.builtinToolNames).toContain("grep");
      // Child's tool count should equal parent's (intersection = parent's smaller set)
      expect(child.builtinToolNames).toEqual(READ_ONLY_TOOLS);
    });

    it("RO parent → RO child: child keeps RO tools (no further restriction needed)", () => {
      // Explore (RO) spawns Plan (also RO) child
      const parentConfig: EffectiveConfig = {
        builtinToolNames: READ_ONLY_TOOLS,
        extensions: true,
        skills: true,
      };

      const child = getConfig("Plan", parentConfig);

      // Plan is already RO, intersection with RO parent = still RO
      expect(child.builtinToolNames).not.toContain("write");
      expect(child.builtinToolNames).not.toContain("edit");
      expect(child.builtinToolNames).toEqual(READ_ONLY_TOOLS);
    });

    it("RW parent spawns RO child → child has only RO tools", () => {
      // General-purpose (RW) spawns Explore (RO) child
      const parentConfig: EffectiveConfig = {
        builtinToolNames: ALL_TOOLS,
        extensions: true,
        skills: true,
      };

      const child = getConfig("Explore", parentConfig);

      // Child's own config restricts to RO; parent allows all; intersection = RO
      expect(child.builtinToolNames).not.toContain("write");
      expect(child.builtinToolNames).not.toContain("edit");
      expect(child.builtinToolNames).toEqual(READ_ONLY_TOOLS);
    });

    it("RO parent → RW child: child is FORCED to RO (key security guarantee)", () => {
      // Explore (RO) spawns general-purpose (RW-configured) child
      // Parent's restriction wins: child can only use what parent can use
      const parentConfig: EffectiveConfig = {
        builtinToolNames: READ_ONLY_TOOLS,
        extensions: true,
        skills: true,
      };

      const child = getConfig("general-purpose", parentConfig);

      // Even though general-purpose is configured with all tools,
      // the intersection with RO parent forces RO
      expect(child.builtinToolNames).not.toContain("write");
      expect(child.builtinToolNames).not.toContain("edit");
      expect(child.builtinToolNames).toEqual(READ_ONLY_TOOLS);
    });

    it("restricted parent (deny write_file) spawns child → child cannot use write_file even if configured", () => {
      // Parent has all tools except "write"
      const parentTools = ALL_TOOLS.filter((t) => t !== "write");
      const parentConfig: EffectiveConfig = {
        builtinToolNames: parentTools,
        extensions: true,
        skills: true,
      };

      const child = getConfig("general-purpose", parentConfig);

      // Child should NOT have write
      expect(child.builtinToolNames).not.toContain("write");
      // Child should have all other tools
      expect(child.builtinToolNames).toContain("read");
      expect(child.builtinToolNames).toContain("bash");
      expect(child.builtinToolNames).toContain("edit");
      expect(child.builtinToolNames).toContain("grep");
    });

    it("parent with no restrictions → child gets full configured tools (no inheritance when no restrictions)", () => {
      // No parentConfig passed
      const child = getConfig("general-purpose");

      // Child gets full tool set (general-purpose has no builtinToolNames → BUILTIN_TOOL_NAMES fallback)
      expect(child.builtinToolNames).toContain("read");
      expect(child.builtinToolNames).toContain("write");
      expect(child.builtinToolNames).toContain("edit");
      expect(child.builtinToolNames).toContain("bash");
    });

    it("parent restricts extensions → child inherits restriction", () => {
      // Register a user agent with extensions: true
      const agents = new Map([["worker", makeAgentConfig({
        name: "worker",
        description: "Worker agent",
        extensions: true,
        skills: true,
      })]]);
      registerAgents(agents);

      // Parent only allows web-search extension
      const parentConfig: EffectiveConfig = {
        builtinToolNames: ALL_TOOLS,
        extensions: ["web-search"],
        skills: true,
      };

      const child = getConfig("worker", parentConfig);

      // Child's extensions: true → intersected with parent's ["web-search"] → ["web-search"]
      expect(child.extensions).toEqual(["web-search"]);
    });

    it("parent denies all extensions → child gets none", () => {
      const agents = new Map([["worker", makeAgentConfig({
        name: "worker",
        description: "Worker agent",
        extensions: true,
        skills: true,
      })]]);
      registerAgents(agents);

      const parentConfig: EffectiveConfig = {
        builtinToolNames: ALL_TOOLS,
        extensions: false,
        skills: true,
      };

      const child = getConfig("worker", parentConfig);

      expect(child.extensions).toBe(false);
    });

    it("parent restricts skills → child inherits restriction", () => {
      const agents = new Map([["worker", makeAgentConfig({
        name: "worker",
        description: "Worker agent",
        extensions: true,
        skills: true,
      })]]);
      registerAgents(agents);

      // Parent only allows specific skills
      const parentConfig: EffectiveConfig = {
        builtinToolNames: ALL_TOOLS,
        extensions: true,
        skills: ["planning", "code-review"],
      };

      const child = getConfig("worker", parentConfig);

      // Child's skills: true → intersected with parent's ["planning","code-review"] → parent's list
      expect(child.skills).toEqual(["planning", "code-review"]);
    });

    it("both parent and child have extension allowlists → intersection", () => {
      const agents = new Map([["worker", makeAgentConfig({
        name: "worker",
        description: "Worker agent",
        extensions: ["web-search", "file-ops", "tools"],
        skills: true,
      })]]);
      registerAgents(agents);

      const parentConfig: EffectiveConfig = {
        builtinToolNames: ALL_TOOLS,
        extensions: ["web-search", "data-fetch"],
        skills: true,
      };

      const child = getConfig("worker", parentConfig);

      // Intersection of ["web-search","file-ops","tools"] ∩ ["web-search","data-fetch"] = ["web-search"]
      expect(child.extensions).toEqual(["web-search"]);
    });

    it("existing tests are not broken: getConfig without parentConfig works as before", () => {
      // This tests the backward-compatible path
      const withoutParent = getConfig("Explore");
      expect(withoutParent.builtinToolNames).toEqual(READ_ONLY_TOOLS);
      expect(withoutParent.extensions).toBe(false);
      expect(withoutParent.skills).toBe(true);

      const gp = getConfig("general-purpose");
      expect(gp.builtinToolNames).toEqual(ALL_TOOLS);
      expect(gp.extensions).toBe(true);
      expect(gp.skills).toBe(true);
    });

    it("fallback configs also respect parent restrictions", () => {
      // When type is unknown, fallback to general-purpose. Parent restrictions still apply.
      const parentConfig: EffectiveConfig = {
        builtinToolNames: READ_ONLY_TOOLS,
        extensions: false,
        skills: false,
      };

      const child = getConfig("nonexistent", parentConfig);

      // Fallback general-purpose config, restricted by parent
      expect(child.builtinToolNames).toEqual(READ_ONLY_TOOLS);
      expect(child.extensions).toBe(false);
      expect(child.skills).toBe(false);
    });
  });

  // Audit A1: the wildcard `*` in a custom agent's `builtinToolNames` must be
  // expanded to a copy of BUILTIN_TOOL_NAMES before any inheritance/filtering
  // step. Without this fix, the literal string `"*"` flows through to the
  // agent's tool list, leaving it with zero working tools and no error.
  describe("wildcard (*) expansion in builtinToolNames", () => {
    describe("normalizeBuiltinToolNames helper", () => {
      it("expands `[\"*\"]` to a copy of BUILTIN_TOOL_NAMES", () => {
        const result = normalizeBuiltinToolNames(["*"]);
        expect(result).toEqual(BUILTIN_TOOL_NAMES);
      });

      it("expands `[\"*\"]` to a fresh array (not a reference to BUILTIN_TOOL_NAMES)", () => {
        const result = normalizeBuiltinToolNames(["*"]);
        expect(result).not.toBe(BUILTIN_TOOL_NAMES);
      });

      it("returns undefined when input is undefined", () => {
        expect(normalizeBuiltinToolNames(undefined)).toBeUndefined();
      });

      it("passes through concrete names without wildcard (cloned, not referenced)", () => {
        const input = ["read", "bash"];
        const result = normalizeBuiltinToolNames(input);
        expect(result).toEqual(["read", "bash"]);
        expect(result).not.toBe(input);
      });

      it("does not mutate the caller's input array (wildcard case)", () => {
        const input = ["*"];
        const snapshot = [...input];
        normalizeBuiltinToolNames(input);
        expect(input).toEqual(snapshot);
      });

      it("does not mutate the caller's input array (concrete case)", () => {
        const input = ["read", "bash"];
        const snapshot = [...input];
        normalizeBuiltinToolNames(input);
        expect(input).toEqual(snapshot);
      });

      it("deduplicates when wildcard is mixed with built-in names", () => {
        // ["*", "bash"] should yield BUILTIN_TOOL_NAMES — bash is already in
        // the list, and `*` covers everything, so the result has no duplicate.
        const result = normalizeBuiltinToolNames(["*", "bash"]);
        expect(result).toEqual(BUILTIN_TOOL_NAMES);
        expect(result).toHaveLength(BUILTIN_TOOL_NAMES.length);
      });

      it("preserves custom tool names mixed with the wildcard", () => {
        // `*` covers all built-in tools; the custom tool is kept alongside.
        const result = normalizeBuiltinToolNames(["*", "my_custom_tool"]);
        expect(result).toEqual([...BUILTIN_TOOL_NAMES, "my_custom_tool"]);
        expect(result).toContain("my_custom_tool");
      });

      it("deduplicates multiple wildcard entries", () => {
        const result = normalizeBuiltinToolNames(["*", "*", "read"]);
        expect(result).toEqual(BUILTIN_TOOL_NAMES);
        expect(result).toHaveLength(BUILTIN_TOOL_NAMES.length);
      });
    });

    describe("getConfig resolution with wildcard", () => {
      it("custom agent with `[\"*\"]` resolves to BUILTIN_TOOL_NAMES", () => {
        const agents = new Map([["wildcard-agent", makeAgentConfig({
          name: "wildcard-agent",
          builtinToolNames: ["*"],
        })]]);
        registerAgents(agents);

        const config = getConfig("wildcard-agent");
        expect(config.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
        expect(config.builtinToolNames).not.toContain("*");
        expect(config.builtinToolNames).toHaveLength(BUILTIN_TOOL_NAMES.length);
      });

      it("custom agent with `[\"*\", \"bash\"]` resolves to BUILTIN_TOOL_NAMES (no duplicates)", () => {
        const agents = new Map([["wildcard-mixed", makeAgentConfig({
          name: "wildcard-mixed",
          builtinToolNames: ["*", "bash"],
        })]]);
        registerAgents(agents);

        const config = getConfig("wildcard-mixed");
        expect(config.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
        expect(config.builtinToolNames).toHaveLength(BUILTIN_TOOL_NAMES.length);
      });

      it("getConfig does not mutate the agent's stored builtinToolNames array", () => {
        const inputNames: string[] = ["*"];
        const agents = new Map([["immutable-wildcard", makeAgentConfig({
          name: "immutable-wildcard",
          builtinToolNames: inputNames,
        })]]);
        registerAgents(agents);

        // Call getConfig a few times — the stored array must remain untouched.
        getConfig("immutable-wildcard");
        getConfig("immutable-wildcard");
        expect(inputNames).toEqual(["*"]);

        // The registered config's array is also untouched.
        const stored = getAgentConfig("immutable-wildcard");
        expect(stored?.builtinToolNames).toEqual(["*"]);
      });

      it("wildcard child is intersected with parent's concrete tools (not yielding empty set)", () => {
        const READ_ONLY_TOOLS = ["read", "bash", "grep"];
        // Without the fix: intersectToolNames(["*"], READ_ONLY_TOOLS) = []
        // With the fix: normalize(["*"]) = BUILTIN_TOOL_NAMES, then
        // intersected with READ_ONLY_TOOLS = READ_ONLY_TOOLS.
        const parentConfig: EffectiveConfig = {
          builtinToolNames: READ_ONLY_TOOLS,
          extensions: true,
          skills: true,
        };

        const agents = new Map([["wildcard-child", makeAgentConfig({
          name: "wildcard-child",
          builtinToolNames: ["*"],
        })]]);
        registerAgents(agents);

        const child = getConfig("wildcard-child", parentConfig);
        expect(child.builtinToolNames).toEqual(READ_ONLY_TOOLS);
        expect(child.builtinToolNames).not.toContain("*");
        expect(child.builtinToolNames).not.toContain("write");
        expect(child.builtinToolNames).not.toContain("edit");
      });

      it("wildcard child with RW parent gets all built-in tools", () => {
        const parentConfig: EffectiveConfig = {
          builtinToolNames: BUILTIN_TOOL_NAMES,
          extensions: true,
          skills: true,
        };

        const agents = new Map([["wildcard-rw", makeAgentConfig({
          name: "wildcard-rw",
          builtinToolNames: ["*"],
        })]]);
        registerAgents(agents);

        const child = getConfig("wildcard-rw", parentConfig);
        expect(child.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
      });

      it("general-purpose override with wildcard does NOT escalate fallback (audit A2)", () => {
        // After audit A2, the unknown-type fallback returns a hard-coded
        // safe-minimal allowlist regardless of what general-purpose is
        // configured with. This is the security guarantee: a caller that
        // triggers the fallback (e.g. with a malicious or unregistered
        // type name) cannot escalate permissions by mutating the
        // general-purpose config in the registry.
        const agents = new Map([["general-purpose", makeAgentConfig({
          name: "general-purpose",
          builtinToolNames: ["*"],
          extensions: true,
          skills: true,
        })]]);
        registerAgents(agents);

        const config = getConfig("nonexistent-type");
        // Fallback is the safe-minimal allowlist, not the wildcard expansion.
        expect(config.builtinToolNames).toEqual(["read", "bash", "grep"]);
        expect(config.builtinToolNames).not.toContain("*");
        expect(config.builtinToolNames).not.toContain("write");
        expect(config.builtinToolNames).not.toContain("edit");
        // Extensions and skills are explicitly disabled on the fallback path.
        expect(config.extensions).toBe(false);
        expect(config.skills).toBe(false);
      });
    });

    describe("getToolNamesForType with wildcard", () => {
      it("returns BUILTIN_TOOL_NAMES for an agent configured with `[\"*\"]`", () => {
        const agents = new Map([["wildcard-names", makeAgentConfig({
          name: "wildcard-names",
          builtinToolNames: ["*"],
        })]]);
        registerAgents(agents);

        const names = getToolNamesForType("wildcard-names");
        expect(names).toEqual(BUILTIN_TOOL_NAMES);
        expect(names).not.toContain("*");
      });
    });

    describe("filterByPartitions with wildcard", () => {
      it("normalizes `[\"*\"]` on a config before partition filtering", () => {
        const config: AgentConfig = makeAgentConfig({
          name: "wildcard-partition",
          builtinToolNames: ["*"],
        });

        const tools = filterByPartitions(config);
        expect(tools).toEqual(BUILTIN_TOOL_NAMES);
        expect(tools).not.toContain("*");
      });

      it("normalizes `[\"*\"]` even when partitions are specified", () => {
        const config: AgentConfig = makeAgentConfig({
          name: "wildcard-partition-filtered",
          builtinToolNames: ["*"],
          partitionMembership: { secure: ["read", "bash", "grep"] },
        });

        const tools = filterByPartitions(config, ["secure"]);
        expect(tools).toEqual(["read", "bash", "grep"]);
        expect(tools).not.toContain("*");
        expect(tools).not.toContain("write");
        expect(tools).not.toContain("edit");
        expect(tools).not.toContain("find");
        expect(tools).not.toContain("ls");
      });
    });
  });

  // Audit A2: the unknown-type fallback in getConfig used to inherit
  // general-purpose's full permissions — BUILTIN_TOOL_NAMES plus
  // extensions: true and skills: true. That granted unrestricted tool
  // access to any caller that triggered the fallback with a malicious
  // or unknown type name. The fix replaces that path with a hard-coded
  // safe-minimal allowlist (read-only tools, no extensions, no skills).
  describe("audit A2: safe-minimal fallback for unknown types", () => {
    it("does NOT grant all builtin tools for unknown types", () => {
      const config = getConfig("definitely-not-registered");
      // The fallback must not return the full BUILTIN_TOOL_NAMES — that
      // would be a regression to the pre-fix behavior.
      expect(config.builtinToolNames).not.toEqual(BUILTIN_TOOL_NAMES);
      // No file-modification tools (write/edit) on the fallback path.
      expect(config.builtinToolNames).not.toContain("write");
      expect(config.builtinToolNames).not.toContain("edit");
    });

    it("does NOT grant extensions or skills for unknown types", () => {
      const config = getConfig("malicious-type-name");
      // Pre-fix this returned `true` (inherited from general-purpose);
      // post-fix it must be `false` so the caller cannot invoke
      // arbitrary extensions or skills via the fallback.
      expect(config.extensions).toBe(false);
      expect(config.skills).toBe(false);
    });

    it("fallback allowlist is a strict subset of BUILTIN_TOOL_NAMES", () => {
      // The fallback cannot grant more tools than the global builtin
      // set — otherwise it would silently introduce tools that don't
      // exist in the host platform.
      const config = getConfig("unknown");
      const builtinSet = new Set(BUILTIN_TOOL_NAMES);
      for (const tool of config.builtinToolNames) {
        expect(builtinSet.has(tool), `fallback grants non-builtin tool: ${tool}`).toBe(true);
      }
    });

    it("fallback still respects parent restrictions (defense in depth)", () => {
      // The safe-minimal fallback must still flow through
      // applyParentRestrictions, so a parent that has fewer tools
      // further narrows the fallback allowlist.
      const parentConfig: EffectiveConfig = {
        builtinToolNames: ["read"],
        extensions: true,
        skills: true,
      };
      const config = getConfig("unknown", parentConfig);
      // Intersection of safe-minimal ["read", "bash", "grep"] with
      // parent ["read"] = ["read"].
      expect(config.builtinToolNames).toEqual(["read"]);
    });

    it("absolute fallback (general-purpose disabled) is also safe-minimal", () => {
      // Even when general-purpose is disabled in the registry, the
      // unknown-type path must not regress to a permissive default.
      const agents = new Map([["general-purpose", makeAgentConfig({
        name: "general-purpose",
        enabled: false,
      })]]);
      registerAgents(agents);

      const config = getConfig("general-purpose");
      expect(config.builtinToolNames).not.toEqual(BUILTIN_TOOL_NAMES);
      expect(config.builtinToolNames).not.toContain("write");
      expect(config.builtinToolNames).not.toContain("edit");
      expect(config.extensions).toBe(false);
      expect(config.skills).toBe(false);
    });
  });

  // Audit B8: BUILTIN_TOOL_NAMES previously listed `find` and `ls`, which
  // are not real pi tools (they are Claude Code carry-over and would
  // never be invoked successfully by this extension). These tests pin
  // the post-fix BUILTIN_TOOL_NAMES list explicitly.
  describe("audit B8: BUILTIN_TOOL_NAMES is the correct pi subset", () => {
    it("BUILTIN_TOOL_NAMES excludes find and ls", () => {
      expect(BUILTIN_TOOL_NAMES).not.toContain("find");
      expect(BUILTIN_TOOL_NAMES).not.toContain("ls");
    });

    it("BUILTIN_TOOL_NAMES contains exactly the official pi builtin tools", () => {
      // The full expected list. A future regression that drops a tool
      // or adds a non-pi tool will fail this test.
      expect([...BUILTIN_TOOL_NAMES].sort()).toEqual(
        ["bash", "edit", "grep", "read", "write"].sort(),
      );
    });

    it("default read-only agents (Explore, Plan, Analysis) do not list find/ls", () => {
      // The Explore / Plan / Analysis defaults inherit from
      // READ_ONLY_TOOLS in default-agents.ts, which after B8 must not
      // include find/ls.
      for (const name of ["Explore", "Plan", "Analysis"]) {
        const config = getConfig(name);
        expect(config.builtinToolNames, `${name}`).not.toContain("find");
        expect(config.builtinToolNames, `${name}`).not.toContain("ls");
      }
    });

    it("normalizeBuiltinToolNames wildcard expansion no longer carries find/ls", () => {
      // The wildcard `*` expands to a copy of BUILTIN_TOOL_NAMES. If
      // BUILTIN_TOOL_NAMES were to regress and re-include find/ls,
      // wildcard expansion would propagate the regression.
      const result = normalizeBuiltinToolNames(["*"]);
      expect(result).not.toContain("find");
      expect(result).not.toContain("ls");
      expect(result).toEqual(BUILTIN_TOOL_NAMES);
    });
  });
});
