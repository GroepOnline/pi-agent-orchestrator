import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setShowAgentTopWidget } from "../src/agent-registry.js";
import type { AgentRecord } from "../src/types.js";
import { AgentTopWidget } from "../src/ui/agent-top-widget.js";
import type { AgentActivity } from "../src/ui/agent-ui-types.js";

class MockManager {
  agents: AgentRecord[] = [];
  listAgents(): AgentRecord[] {
    return this.agents;
  }
}

function runningAgent(id: string): AgentRecord {
  return {
    id,
    type: "general-purpose",
    description: `worker ${id}`,
    status: "running",
    toolUses: 2,
    startedAt: Date.now() - 5_000,
    spawnedAt: Date.now() - 5_000,
    lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0 },
    compactionCount: 0,
    currentLevel: 0,
    totalSpawned: 0,
  } as AgentRecord;
}

describe("AgentTopWidget", () => {
  beforeEach(() => {
    setShowAgentTopWidget(true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    setShowAgentTopWidget(true);
    vi.useRealTimers();
  });

  it("registers an aboveEditor widget only while agents are active", () => {
    const manager = new MockManager();
    const activity = new Map<string, AgentActivity>();
    const ui = { setWidget: vi.fn(), setStatus: vi.fn() };
    const top = new AgentTopWidget(manager as never, activity);
    top.setUICtx(ui as never);

    top.update();
    expect(ui.setWidget).not.toHaveBeenCalled();

    manager.agents = [runningAgent("a1")];
    top.update();
    expect(ui.setWidget).toHaveBeenCalledWith(
      "agent-top",
      expect.any(Function),
      { placement: "aboveEditor" },
    );

    const factory = ui.setWidget.mock.calls[0][1] as (tui: unknown, theme: unknown) => {
      render: () => string[];
      invalidate: () => void;
    };
    const component = factory({ terminal: { columns: 100 } }, {});
    const lines = component.render();
    expect(lines.join("\n")).toContain("AGENT TOP");
    expect(lines.join("\n")).toContain("1 active");
  });

  it("clears the widget when the setting is disabled", () => {
    const manager = new MockManager();
    manager.agents = [runningAgent("a1")];
    const activity = new Map<string, AgentActivity>();
    const ui = { setWidget: vi.fn(), setStatus: vi.fn() };
    const top = new AgentTopWidget(manager as never, activity);
    top.setUICtx(ui as never);
    top.update();
    expect(ui.setWidget).toHaveBeenCalled();

    setShowAgentTopWidget(false);
    ui.setWidget.mockClear();
    top.forceRefresh();
    expect(ui.setWidget).toHaveBeenCalledWith("agent-top", undefined);
  });

  it("keeps an idle tick alive so toggles apply without a registry handler", () => {
    const manager = new MockManager();
    manager.agents = [runningAgent("a1")];
    const activity = new Map<string, AgentActivity>();
    const ui = { setWidget: vi.fn(), setStatus: vi.fn() };
    const top = new AgentTopWidget(manager as never, activity);
    top.setUICtx(ui as never);
    top.update();
    expect(ui.setWidget).toHaveBeenCalled();

    setShowAgentTopWidget(false);
    ui.setWidget.mockClear();
    // Idle tick (1000ms) should clear the strip without forceRefresh.
    vi.advanceTimersByTime(1000);
    expect(ui.setWidget).toHaveBeenCalledWith("agent-top", undefined);

    setShowAgentTopWidget(true);
    ui.setWidget.mockClear();
    vi.advanceTimersByTime(1000);
    expect(ui.setWidget).toHaveBeenCalledWith(
      "agent-top",
      expect.any(Function),
      { placement: "aboveEditor" },
    );

    top.dispose();
  });
});
