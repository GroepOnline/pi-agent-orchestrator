import { describe, expect, it, vi } from "vitest";
import { DEFAULT_DASHBOARD_KEYBINDINGS } from "../src/ui/dashboard-keybindings.js";
import { DEFAULT_FOOTER_STATUS_CONFIG } from "../src/ui/footer-status-config.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  defineTool: vi.fn(),
}));

vi.mock("../src/agent-manager.js", () => ({}));
vi.mock("../src/agent-registry.js", () => ({
  getDefaultJoinMode: vi.fn().mockReturnValue("smart"),
  isSchedulingEnabled: vi.fn().mockReturnValue(true),
  setDefaultJoinMode: vi.fn(),
  setSchedulingEnabled: vi.fn(),
  getFooterStatusConfig: () => DEFAULT_FOOTER_STATUS_CONFIG,
  getDashboardKeybindings: () => DEFAULT_DASHBOARD_KEYBINDINGS,
}));
vi.mock("../src/agent-runner.js", () => ({
  getDefaultMaxTurns: vi.fn().mockReturnValue(undefined),
  getGraceTurns: vi.fn().mockReturnValue(5),
  getMaxEndHookRevisions: vi.fn().mockReturnValue(0),
  setDefaultMaxTurns: vi.fn(),
  setGraceTurns: vi.fn(),
  setMaxEndHookRevisions: vi.fn(),
}));
vi.mock("../src/output-handler.js", () => ({
  showAgentsMenu: vi.fn(),
}));

import { registerAgentsCommand } from "../src/commands/agents.js";

describe("registerAgentsCommand", () => {
  it("registers the /agents command with the pi host", () => {
    const pi = {
      registerCommand: vi.fn(),
      events: { on: vi.fn(), emit: vi.fn() },
    } as any;
    const manager = { listAgents: vi.fn().mockReturnValue([]) } as any;
    const scheduler = { isActive: vi.fn().mockReturnValue(true), listJobs: vi.fn().mockReturnValue([]) } as any;
    const agentActivity = new Map();

    registerAgentsCommand(pi, manager, scheduler, agentActivity);

    expect(pi.registerCommand).toHaveBeenCalledWith(
      "agents",
      expect.objectContaining({
        description: expect.any(String),
        handler: expect.any(Function),
      }),
    );
  });

  it("handler function calls showAgentsMenu with correct context", async () => {
    const { showAgentsMenu } = await import("../src/output-handler.js");
    const pi = {
      registerCommand: vi.fn(),
      events: { on: vi.fn(), emit: vi.fn() },
    } as any;
    const manager = { listAgents: vi.fn().mockReturnValue([]) } as any;
    const scheduler = { isActive: vi.fn().mockReturnValue(true), listJobs: vi.fn().mockReturnValue([]) } as any;
    const agentActivity = new Map();

    registerAgentsCommand(pi, manager, scheduler, agentActivity);

    // Extract the handler that was registered
    const handler = (pi.registerCommand as any).mock.calls[0][1].handler;
    expect(typeof handler).toBe("function");

    // Call the handler
    const ctx = { ui: {}, session: {} };
    await handler([], ctx);

    expect(showAgentsMenu).toHaveBeenCalledWith(ctx, expect.objectContaining({
      pi,
      manager,
      scheduler,
      agentActivity,
    }));
  });
});
