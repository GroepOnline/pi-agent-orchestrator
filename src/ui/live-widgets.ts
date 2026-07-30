/**
 * live-widgets.ts — Fan-out for all above-editor agent surfaces.
 *
 * Call sites must update every live surface together. Scattering
 * `widget.X(); topWidget.X();` pairs across index/tools is how half-updated
 * UI and missed markFinished bugs appear — this type deletes that class of
 * mistake.
 */

import type { AgentTopWidget } from "./agent-top-widget.js";
import type { UICtx } from "./agent-ui-types.js";
import type { AgentWidget } from "./agent-widget.js";

export class LiveWidgets {
  constructor(
    /** Tree / activity strip (`setWidget("agents")`). */
    readonly tree: AgentWidget,
    /** Persistent AGENT TOP strip (`setWidget("agent-top")`). */
    readonly top: AgentTopWidget,
  ) {}

  setUICtx(ctx: UICtx): void {
    this.tree.setUICtx(ctx);
    this.top.setUICtx(ctx);
  }

  ensureTimer(): void {
    this.tree.ensureTimer();
    this.top.ensureTimer();
  }

  onTurnStart(): void {
    this.tree.onTurnStart();
    this.top.onTurnStart();
  }

  markFinished(agentId: string): void {
    this.tree.markFinished(agentId);
    this.top.markFinished(agentId);
  }

  update(): void {
    this.tree.update();
    this.top.update();
  }

  /**
   * Spawn-burst coalescing lives on the tree widget only (top strip is
   * tick-driven and does not need the 16ms debounce path).
   */
  debouncedUpdate(): void {
    this.tree.debouncedUpdate();
  }

  /** Bind UI context, start timers, and paint once. */
  bind(ctx: UICtx): void {
    this.setUICtx(ctx);
    this.ensureTimer();
    this.update();
  }

  dispose(): void {
    this.tree.dispose();
    this.top.dispose();
  }
}
