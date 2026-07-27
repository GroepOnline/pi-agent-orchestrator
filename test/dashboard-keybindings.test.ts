import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import type { AgentActivity } from "../src/ui/agent-ui-types.js";
import {
  DEFAULT_DASHBOARD_KEYBINDINGS,
  matchDashboardKey,
  resolveDashboardKeybindings,
  sanitizeDashboardKeybindings,
} from "../src/ui/dashboard-keybindings.js";
import {
  DEFAULT_FOOTER_STATUS_CONFIG,
  formatFooterStatusText,
  resolveFooterStatusConfig,
  sanitizeFooterStatusConfig,
} from "../src/ui/footer-status-config.js";
import { matchesKey } from "../src/ui/tui-shim.js";

describe("dashboard-keybindings", () => {
  it("matches vim defaults for navigation", () => {
    const bindings = DEFAULT_DASHBOARD_KEYBINDINGS;
    expect(matchDashboardKey("k", "moveUp", bindings)).toBe(true);
    expect(matchDashboardKey("j", "moveDown", bindings)).toBe(true);
    expect(matchDashboardKey("space", "toggleSelect", bindings)).toBe(true);
  });

  it("sanitizes unknown actions and empty key lists", () => {
    expect(sanitizeDashboardKeybindings(null)).toBeUndefined();
    expect(
      sanitizeDashboardKeybindings({
        moveUp: ["up"],
        bogus: ["x"],
        moveDown: [],
      }),
    ).toEqual({ moveUp: ["up"] });
  });

  it("merges overrides without dropping unspecified actions", () => {
    const merged = resolveDashboardKeybindings({ moveUp: ["w"] });
    expect(merged.moveUp).toEqual(["w"]);
    expect(merged.moveDown).toEqual(DEFAULT_DASHBOARD_KEYBINDINGS.moveDown);
  });
});

describe("tui-shim ctrl+letter", () => {
  it("matches ctrl+c as raw control character", () => {
    expect(matchesKey("\u0003", "ctrl+c")).toBe(true);
    expect(matchesKey("ctrl+c", "ctrl+c")).toBe(true);
  });
});

describe("footer-status-config", () => {
  it("formats default running/queued summary", () => {
    const text = formatFooterStatusText(DEFAULT_FOOTER_STATUS_CONFIG, 2, 1);
    expect(text).toBe("2 running, 1 queued agents");
  });

  it("honors custom template placeholders", () => {
    const text = formatFooterStatusText(
      resolveFooterStatusConfig({
        template: "{running}↑ {queued}⏳ ({total})",
      }),
      3,
      2,
    );
    expect(text).toBe("3↑ 2⏳ (5)");
  });

  it("sanitizes footer slot and drops invalid values", () => {
    expect(sanitizeFooterStatusConfig({ enabled: true, slot: "" })).toEqual({ enabled: true });
    expect(sanitizeFooterStatusConfig({ slot: "agents" })).toEqual({ slot: "agents" });
  });
});

describe("AgentDashboard swarm interaction", () => {
  let AgentDashboard: typeof import("../src/ui/agent-dashboard.js").AgentDashboard;
  let setDashboardKeybindings: typeof import("../src/agent-registry.js").setDashboardKeybindings;

  class SwarmMockManager {
    agents: AgentRecord[] = [];
    aborted: string[] = [];

    listAgents(): AgentRecord[] {
      return this.agents;
    }

    abort(id: string): boolean {
      this.aborted.push(id);
      const agent = this.agents.find((entry) => entry.id === id);
      if (agent) agent.status = "aborted";
      return true;
    }

    getSessionUsage() {
      return { spawnedAgents: this.agents.length, totalTurns: 12 };
    }

    getSessionMaxSpawns() {
      return 20;
    }

    getSessionMaxTurns() {
      return 200;
    }
  }

  function mockTui(rows = 30, columns = 100) {
    return {
      terminal: { rows, columns },
      requestRender: vi.fn(),
    };
  }

  function swarmAgents(count: number, swarmId = "swarm-alpha"): AgentRecord[] {
    const agents: AgentRecord[] = [];
    for (let i = 0; i < count; i++) {
      agents.push({
        id: `swarm-agent-${i + 1}`,
        type: "general-purpose",
        description: `swarm worker ${i + 1}`,
        status: "running",
        toolUses: i,
        startedAt: Date.now() - 10_000,
        spawnedAt: Date.now() - 10_000,
        swarmId,
        lifetimeUsage: { input: 1000 + i, output: 200, cacheWrite: 0 },
        compactionCount: 0,
        currentLevel: 0,
        totalSpawned: 0,
      } as AgentRecord);
    }
    return agents;
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
    const registry = await import("../src/agent-registry.js");
    setDashboardKeybindings = registry.setDashboardKeybindings;
    setDashboardKeybindings();
    const mod = await import("../src/ui/agent-dashboard.js");
    AgentDashboard = mod.AgentDashboard;
  });

  afterEach(() => {
    setDashboardKeybindings();
    vi.useRealTimers();
  });

  it("renders swarm members and navigates with vim keys", () => {
    const manager = new SwarmMockManager();
    manager.agents = swarmAgents(5);
    const activity = new Map<string, AgentActivity>();
    for (const agent of manager.agents) {
      activity.set(agent.id, {
        activeTools: new Map(),
        toolUses: 1,
        responseText: "working",
        turnCount: 2,
        maxTurns: 8,
        lifetimeUsage: agent.lifetimeUsage,
      });
    }

    let _closed = false;
    const dash = new AgentDashboard(
      mockTui() as never,
      { manager: manager as never, agentActivity: activity },
      () => { _closed = true; },
    );

    const initial = dash.render(100).join("\n");
    expect(initial).toContain("swarm-alpha");
    expect(initial).toContain("swarm worker");

    dash.handleInput("j");
    dash.handleInput("j");
    const afterNav = dash.render(100).join("\n");
    expect(afterNav.length).toBeGreaterThan(0);

    dash.handleInput("t");
    const topView = dash.render(100).join("\n");
    expect(topView).toContain("AGENT TOP");

    dash.handleInput("q");
    const backToList = dash.render(100).join("\n");
    expect(backToList).not.toContain("AGENT TOP");
  });

  it("multi-selects swarm agents and triggers swarm action", async () => {
    const manager = new SwarmMockManager();
    manager.agents = swarmAgents(4);
    const activity = new Map<string, AgentActivity>();
    const swarmCalls: Array<{ action: string; ids: string[] }> = [];

    let closed = false;
    const dash = new AgentDashboard(
      mockTui() as never,
      {
        manager: manager as never,
        agentActivity: activity,
        onSwarmAction: async (action, agentIds) => {
          swarmCalls.push({ action, ids: [...agentIds] });
        },
      },
      () => { closed = true; },
    );

    dash.handleInput("space");
    dash.handleInput("j");
    dash.handleInput("space");
    dash.handleInput("w");

    expect(closed).toBe(true);
    expect(swarmCalls).toHaveLength(1);
    expect(swarmCalls[0].action).toBe("create");
    expect(swarmCalls[0].ids.length).toBe(2);
  });

  it("handles raw host key bytes for arrows, space, enter, and steer", () => {
    const manager = new SwarmMockManager();
    manager.agents = swarmAgents(3);
    const activity = new Map<string, AgentActivity>();
    const steered: string[] = [];
    let viewed: string | undefined;
    let closed = false;

    const dash = new AgentDashboard(
      mockTui() as never,
      {
        manager: manager as never,
        agentActivity: activity,
        onSteer: async (id) => { steered.push(id); },
        onViewConversation: async (rec) => { viewed = rec.id; },
      },
      () => { closed = true; },
    );

    // Arrow-down (raw ANSI) then vim j — both move selection
    dash.handleInput("\x1b[B");
    dash.handleInput("j");
    // Literal space toggles multi-select on current row
    dash.handleInput(" ");
    // Steer with plain s (closes dashboard)
    dash.handleInput("s");
    expect(closed).toBe(true);
    expect(steered).toEqual(["swarm-agent-3"]);

    closed = false;
    const dash2 = new AgentDashboard(
      mockTui() as never,
      {
        manager: manager as never,
        agentActivity: activity,
        onViewConversation: async (rec) => { viewed = rec.id; },
      },
      () => { closed = true; },
    );
    dash2.handleInput("\r");
    expect(closed).toBe(true);
    expect(viewed).toBe("swarm-agent-1");
  });

  it("kills selected swarm agent with shift+k", () => {
    const manager = new SwarmMockManager();
    manager.agents = swarmAgents(3);
    const activity = new Map<string, AgentActivity>();

    const dash = new AgentDashboard(
      mockTui() as never,
      { manager: manager as never, agentActivity: activity },
      () => {},
    );

    dash.handleInput("shift+k");
    expect(manager.aborted).toEqual(["swarm-agent-1"]);
  });

  it("closes on escape and respects custom quit binding", () => {
    const manager = new SwarmMockManager();
    manager.agents = swarmAgents(2);
    const activity = new Map<string, AgentActivity>();

    let closed = false;
    const dash = new AgentDashboard(
      mockTui() as never,
      { manager: manager as never, agentActivity: activity },
      () => { closed = true; },
    );

    dash.handleInput("escape");
    expect(closed).toBe(true);

    closed = false;
    setDashboardKeybindings({ quitKey: ["ctrl+c"], escapeKey: ["escape"] });
    const dash2 = new AgentDashboard(
      mockTui() as never,
      { manager: manager as never, agentActivity: activity },
      () => { closed = true; },
    );
    dash2.handleInput("\u0003");
    expect(closed).toBe(true);
  });

  it("opens help overlay and dismisses with escape", () => {
    const manager = new SwarmMockManager();
    manager.agents = swarmAgents(2);
    const activity = new Map<string, AgentActivity>();

    const dash = new AgentDashboard(
      mockTui() as never,
      { manager: manager as never, agentActivity: activity },
      () => {},
    );

    dash.handleInput("?");
    const helpOpen = dash.render(100).join("\n");
    expect(helpOpen.toLowerCase()).toContain("move selection up");

    dash.handleInput("escape");
    const helpClosed = dash.render(100).join("\n");
    expect(helpClosed.toLowerCase()).not.toContain("top view sort keys");
  });
});
