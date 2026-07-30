import { describe, expect, it, vi } from "vitest";
import type { AgentTopWidget } from "../src/ui/agent-top-widget.js";
import type { AgentWidget } from "../src/ui/agent-widget.js";
import { LiveWidgets } from "../src/ui/live-widgets.js";

function mockTree(): AgentWidget {
  return {
    setUICtx: vi.fn(),
    ensureTimer: vi.fn(),
    onTurnStart: vi.fn(),
    markFinished: vi.fn(),
    update: vi.fn(),
    debouncedUpdate: vi.fn(),
    dispose: vi.fn(),
    getRenderMetrics: vi.fn(),
  } as unknown as AgentWidget;
}

function mockTop(): AgentTopWidget {
  return {
    setUICtx: vi.fn(),
    ensureTimer: vi.fn(),
    onTurnStart: vi.fn(),
    markFinished: vi.fn(),
    update: vi.fn(),
    forceRefresh: vi.fn(),
    dispose: vi.fn(),
  } as unknown as AgentTopWidget;
}

describe("LiveWidgets", () => {
  it("fans out markFinished + update to both surfaces", () => {
    const tree = mockTree();
    const top = mockTop();
    const live = new LiveWidgets(tree, top);

    live.markFinished("a1");
    live.update();

    expect(tree.markFinished).toHaveBeenCalledWith("a1");
    expect(top.markFinished).toHaveBeenCalledWith("a1");
    expect(tree.update).toHaveBeenCalledOnce();
    expect(top.update).toHaveBeenCalledOnce();
  });

  it("routes debouncedUpdate only to the tree widget", () => {
    const tree = mockTree();
    const top = mockTop();
    const live = new LiveWidgets(tree, top);

    live.debouncedUpdate();
    expect(tree.debouncedUpdate).toHaveBeenCalledOnce();
  });

  it("bind sets ctx, ensures timers, and paints once", () => {
    const tree = mockTree();
    const top = mockTop();
    const live = new LiveWidgets(tree, top);
    const ui = { setWidget: vi.fn(), setStatus: vi.fn() };

    live.bind(ui as never);

    expect(tree.setUICtx).toHaveBeenCalledWith(ui);
    expect(top.setUICtx).toHaveBeenCalledWith(ui);
    expect(tree.ensureTimer).toHaveBeenCalledOnce();
    expect(top.ensureTimer).toHaveBeenCalledOnce();
    expect(tree.update).toHaveBeenCalledOnce();
    expect(top.update).toHaveBeenCalledOnce();
  });
});
