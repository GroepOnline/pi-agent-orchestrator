/**
 * agent-widget.ts — Persistent widget showing running/completed agents above the editor.
 *
 * Displays a tree of agents with animated spinners, live stats, and activity descriptions.
 * Uses the callback form of setWidget for themed rendering.
 *
 * Performance features:
 * - Dirty checking: skips TUI re-render when agent list structure hasn't changed.
 * - Adaptive refresh: responsive interval (160ms) while work is active,
 *   falling back to a low-cost 1000ms idle cadence.
 *
 * UI styles: premium (default), retro, plain
 */

import type { AgentManager } from "../agent-manager.js";
import { getFooterStatusConfig } from "../agent-registry.js";
import type { AgentRecord } from "../types.js";
import { AdaptiveTick } from "./adaptive-tick.js";
import type { AgentActivity, UICtx } from "./agent-ui-types.js";
import { ERROR_STATUSES, renderAgentWidget } from "./agent-widget-renderer.js";
import { formatFooterStatusText } from "./footer-status-config.js";
import { RenderMetrics } from "./render-metrics.js";
import type { Theme } from "./theme.js";
import type { TUI } from "./tui-shim.js";

// ---- Constants ----

/** Fast refresh interval when agents are actively running. */
const ACTIVE_REFRESH_MS = 160;

/** Idle refresh interval when all agents are finished — animates spinner cheaply. */
const IDLE_REFRESH_MS = 1000;

/**
 * Virtual scroll page size: max body lines per page.
 * Matches MAX_WIDGET_LINES in agent-widget-renderer minus heading.
 */
const PAGE_SIZE = 11;

/** Widget render considered slow if it exceeds 16ms (~60fps budget). */
const SLOW_WIDGET_UPDATE_MS = 16;

// ---- Widget manager ----

export class AgentWidget {
  private closed = false;
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private readonly tick: AdaptiveTick;
  /** Tracks how many turns each finished agent has survived. Key: agent ID, Value: turns since finished. */
  private finishedTurnAge = new Map<string, number>();
  /** How many extra turns errors/aborted agents linger (completed agents clear after 1 turn). */
  private static readonly ERROR_LINGER_TURNS = 2;

  /** Whether the widget callback is currently registered with the TUI. */
  private widgetRegistered = false;
  /** Cached TUI reference from widget factory callback, used for requestRender(). */
  private tui: TUI | undefined;
  /** Last status bar text, used to avoid redundant setStatus calls. */
  private lastStatusText: string | undefined;
  /** Last footer slot written — cleared when the configured slot changes. */
  private lastFooterSlot: string | undefined;

  // ── Performance: dirty detection ──

  /**
   * Lightweight structural snapshot: numeric hash of agent IDs + statuses.
   * When unchanged, we skip requestRender to avoid TUI-wide re-render.
   * Uses numeric comparison (O(1)) instead of string equality (O(N)).
   */
  private agentSnapshotHash = 0;

  /**
   * True if the snapshot changed during the last update.
   * Reset after each render cycle.
   */
  private dirty = false;

  // ── Performance: spawn batching ──

  /** Debounce timer for coalescing rapid update() calls during spawn bursts. */
  private updateTimer: ReturnType<typeof setTimeout> | undefined;

  // ── Virtual scrolling ──

  /** Current scroll page (0 = first). */
  private scrollPage = 0;

  /** Total pages available based on current agent count. */
  private maxPages = 1;

  // No totalAgentCount field — page count is derived from line estimates
  // in getVisibleWindow().

  // ── Performance metrics ──

  /** Render timing tracker for monitoring update() performance. */
  private renderMetrics = new RenderMetrics("widget-update", SLOW_WIDGET_UPDATE_MS);

  /** Timestamp of first spawned agent (for time-to-first-visible). */
  private firstSpawnedAt = 0;

  /** Minimum gap between consecutive update() calls (16ms ~ 60fps). */
  private static readonly SPAWN_BATCH_MS = 16;

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
  ) {
    this.tick = new AdaptiveTick(
      () => Boolean(this.uiCtx) && !this.closed,
      () => this.update(),
      ACTIVE_REFRESH_MS,
    );
  }

  /** Set the UI context (grabbed from first tool execution). */
  setUICtx(ctx: UICtx) {
    if (ctx !== this.uiCtx) {
      if (this.uiCtx) {
        this.uiCtx.setWidget("agents", undefined);
        const slot = getFooterStatusConfig().slot;
        this.uiCtx.setStatus(slot, undefined);
      }
      // UICtx changed — the widget registered on the old context is gone.
      // Force re-registration on next update().
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
      this.lastStatusText = undefined;
    }
  }

  /**
   * Called on each new turn (tool_execution_start).
   * Ages finished agents and clears those that have lingered long enough.
   */
  onTurnStart() {
    // Age all finished agents
    for (const [id, age] of this.finishedTurnAge) {
      this.finishedTurnAge.set(id, age + 1);
    }
    // Force update on turn boundaries — finished agents might expire
    this.dirty = true;
    this.update();
  }

  /** Ensure the widget update timer is running. */
  ensureTimer() {
    this.tick.ensure(ACTIVE_REFRESH_MS);
  }

  /** Current adaptive refresh interval (exposed for tests / metrics). */
  get currentIntervalMs(): number {
    return this.tick.currentIntervalMs;
  }

  /** Check if a finished agent should still be shown in the widget. */
  private shouldShowFinished(agentId: string, status: string): boolean {
    const age = this.finishedTurnAge.get(agentId) ?? 0;
    const maxAge = ERROR_STATUSES.has(status) ? AgentWidget.ERROR_LINGER_TURNS : 1;
    return age < maxAge;
  }

  /** Record an agent as finished (call when agent completes). */
  markFinished(agentId: string) {
    if (!this.finishedTurnAge.has(agentId)) {
      this.finishedTurnAge.set(agentId, 0);
    }
  }

  /** Get the agents for the current scroll page. */
  private getVisibleWindow(agents: AgentRecord[]): AgentRecord[] {
    // Zero-allocation single-pass counting loop to establish window bounds
    let runningCount = 0;
    let queuedCount = 0;
    let finishedCount = 0;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (a.status === "running") runningCount++;
      else if (a.status === "queued") queuedCount++;
      else finishedCount++;
    }

    // Compute total lines
    const totalLines = runningCount * 2 + queuedCount + finishedCount;

    this.maxPages = Math.max(1, Math.ceil(totalLines / PAGE_SIZE));

    // Clamp scroll page
    if (this.scrollPage >= this.maxPages) {
      this.scrollPage = Math.max(0, this.maxPages - 1);
    }

    // Compute visible window without intermediate array allocations
    const visible: AgentRecord[] = [];
    let remainingLines = PAGE_SIZE;
    let skipped = this.scrollPage * PAGE_SIZE;

    const processCategory = (targetStatus: string, linesPerAgent: number) => {
      for (let i = 0; i < agents.length; i++) {
        const a = agents[i];
        const match = targetStatus === "finished"
            ? (a.status !== "running" && a.status !== "queued")
            : a.status === targetStatus;

        if (match) {
          if (skipped > 0) {
            if (linesPerAgent <= skipped) {
              skipped -= linesPerAgent;
              continue;
            }
            // Agent starts mid-page after partial skip.
            const prevSkipped = skipped;
            skipped = 0;
            visible.push(a);
            remainingLines -= linesPerAgent - prevSkipped;
          } else if (remainingLines >= linesPerAgent) {
            visible.push(a);
            remainingLines -= linesPerAgent;
          } else {
            return; // No more room in this page
          }
        }
      }
    };

    processCategory("running", 2);
    processCategory("queued", 1);
    processCategory("finished", 1);

    return visible;
  }

  /** Scroll one page up (toward newest agents). */
  scrollUp(): void {
    if (this.scrollPage > 0) {
      this.scrollPage--;
      this.dirty = true;
      this.update();
    }
  }

  /** Scroll one page down (toward older/finished agents). */
  scrollDown(): void {
    if (this.scrollPage < this.maxPages - 1) {
      this.scrollPage++;
      this.dirty = true;
      this.update();
    }
  }

  /** Get current scroll page. */
  getScrollPage(): number {
    return this.scrollPage;
  }

  /** Get total pages. */
  getMaxPages(): number {
    return this.maxPages;
  }

  /** Get render performance metrics snapshot. */
  getRenderMetrics() {
    return this.renderMetrics.snapshot();
  }

private renderWidget(tui: TUI, theme: Theme): string[] {
    const renderStart = performance.now();
    const allAgents = this.manager.listAgents();
    try {
      const visibleAgents = this.getVisibleWindow(allAgents);
      return renderAgentWidget({
        agents: visibleAgents,
        agentActivity: this.agentActivity,
        frame: this.widgetFrame,
        shouldShowFinished: (agentId, status) => this.shouldShowFinished(agentId, status),
        theme,
        tui,
        // Pagination info for the heading indicator
        pageIndex: this.scrollPage,
        pageCount: this.maxPages,
      });
    } finally {
      let activeAgents = 0;
      for (let i = 0; i < allAgents.length; i++) {
        if (allAgents[i].status === "running" || allAgents[i].status === "queued") activeAgents++;
      }
      this.renderMetrics.record(performance.now() - renderStart, activeAgents);
    }
  }

  /**
   * Debounced update: coalesces rapid calls (e.g. bulk spawns) into a single
   * update after 16ms. Falls back to immediate update when the timer is not
   * already pending — ensures the widget still updates promptly for the
   * first spawn, while batching subsequent ones.
   *
   * Usage: call from spawn paths where multiple agents may be created in
   * quick succession (background spawns, swarm joins, group joins).
   */
  debouncedUpdate(): void {
    if (!this.uiCtx) return;
    if (this.updateTimer) {
      // Timer already pending — will fire after window expires
      return;
    }
    // First call: immediate update to show the first agent promptly.
    // Then schedule a coalesced update to catch any subsequent spawns.
    this.update();
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      this.update();
    }, AgentWidget.SPAWN_BATCH_MS);
  }

  /** Force an immediate widget update. */
  update() {
    if (!this.uiCtx || this.closed) return;
    // Clear any pending debounce timer — we're updating now.
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = undefined;
    }
    const allAgents = this.manager.listAgents();

    // Single-pass: build snapshot hash + count running/queued/hasFinished
    // in one iteration instead of 3 separate loops.
    let hash = 0x811c9dc5;
    let runningCount = 0;
    let queuedCount = 0;
    let hasFinished = false;
    for (let i = 0; i < allAgents.length; i++) {
      const a = allAgents[i];
      // Hash: agent ID + status
      const id = a.id;
      for (let j = 0; j < id.length; j++) {
        hash ^= id.charCodeAt(j);
        hash = Math.imul(hash, 0x01000193);
      }
      hash ^= 0x3a;
      hash = Math.imul(hash, 0x01000193);
      const status = a.status;
      for (let j = 0; j < status.length; j++) {
        hash ^= status.charCodeAt(j);
        hash = Math.imul(hash, 0x01000193);
      }
      hash ^= 0x2c;
      hash = Math.imul(hash, 0x01000193);
      // Categorize
      if (a.status === "running") runningCount++;
      else if (a.status === "queued") queuedCount++;
      else if (a.completedAt && this.shouldShowFinished(a.id, a.status)) hasFinished = true;
    }
    const snapshotHash = hash | 0;

    const snapshotChanged = snapshotHash !== this.agentSnapshotHash;
    if (snapshotChanged) {
      this.agentSnapshotHash = snapshotHash;
      this.dirty = true;
      // Adapt refresh interval based on agent activity level.
      const hasRunning = runningCount > 0 || queuedCount > 0;
      const targetInterval = hasRunning ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS;
      if (this.tick.currentIntervalMs !== targetInterval) {
        this.tick.reschedule(targetInterval);
      }
    }
    const hasActive = runningCount > 0 || queuedCount > 0;

    // Clean up stale finishedTurnAge entries for removed agents (runs every update, not just when idle).
    const agentIds = new Set<string>();
    for (let i = 0; i < allAgents.length; i++) agentIds.add(allAgents[i].id);
    for (const [id] of this.finishedTurnAge) {
      if (!agentIds.has(id)) this.finishedTurnAge.delete(id);
    }

    // Track active agents and first spawn timestamp
    const totalActive = runningCount + queuedCount;
    if (totalActive > 0 && this.firstSpawnedAt === 0) {
      this.firstSpawnedAt = Date.now();
      this.renderMetrics.setFirstSpawnTimestamp(this.firstSpawnedAt);
    }

    // Nothing to show — clear widget
    if (!hasActive && !hasFinished) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("agents", undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (this.lastStatusText !== undefined) {
        const slot = this.lastFooterSlot ?? getFooterStatusConfig().slot;
        this.uiCtx.setStatus(slot, undefined);
        this.lastStatusText = undefined;
        this.lastFooterSlot = undefined;
      }
      this.tick.stop();
      this.dirty = false;
      return;
    }

    // Status bar — only call setStatus when the text or slot actually changes
    const footerConfig = getFooterStatusConfig();
    if (this.lastFooterSlot !== undefined && this.lastFooterSlot !== footerConfig.slot) {
      this.uiCtx.setStatus(this.lastFooterSlot, undefined);
      this.lastStatusText = undefined;
    }
    const newStatusText = formatFooterStatusText(footerConfig, runningCount, queuedCount);
    if (newStatusText !== this.lastStatusText) {
      this.uiCtx.setStatus(footerConfig.slot, newStatusText);
      this.lastStatusText = newStatusText;
      this.lastFooterSlot = footerConfig.slot;
    }

    // Always advance spinner for smooth animation.
    this.widgetFrame++;

    // Render motion every second 160ms tick. This is visibly responsive while
    // avoiding a full widget redraw on every timer callback over SSH terminals.
    if (!this.dirty && hasActive && this.widgetFrame % 2 === 0) {
      this.dirty = true;
    }

    // Dirty check: skip TUI re-render when only the spinner frame advanced.
    // On turn boundaries and structural changes, we always re-render.
    if (!this.dirty && this.widgetRegistered) {
      this.renderMetrics.recordRequested(); // Track skipped renders
      return; // Nothing changed — don't trigger TUI re-render
    }

    // Register widget callback once; subsequent updates use requestRender()
    // which re-invokes render() without replacing the component (avoids layout thrashing).
    if (this.widgetRegistered) {
      // Widget already registered — just request a re-render of existing components.
      this.tui?.requestRender();
      this.dirty = false;
    } else {
      this.uiCtx.setWidget("agents", (tui, theme) => {
        this.tui = tui;
        return {
          render: () => this.renderWidget(tui, theme),
          invalidate: () => {
            // Theme changed — force re-registration so factory captures fresh theme.
            this.widgetRegistered = false;
            this.tui = undefined;
          },
        };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
      this.dirty = false;
    }
  }

  dispose() {
    this.closed = true;
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = undefined;
    }
    this.tick.stop();
    if (this.uiCtx) {
      this.uiCtx.setWidget("agents", undefined);
      const slot = getFooterStatusConfig().slot;
      this.uiCtx.setStatus(slot, undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
    this.lastStatusText = undefined;
  }
}
