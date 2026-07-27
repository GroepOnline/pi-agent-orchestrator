/**
 * agent-dashboard.ts — Rich interactive TUI dashboard for subagent management.
 *
 * Performance architecture (v2):
 * - Adaptive refresh: 200ms when agents are running, 750ms when idle.
 * - Spinner animation: advanced on every timer tick, not just user input.
 * - Dirty flag: tracks structural changes (agent IDs, statuses) to skip
 *   expensive state recomputation when only the spinner ticked.
 * - Memoized theme/box chars: cached until UI style changes.
 * - Coalesced debounce: multiple rapid spawn requests batched with 16ms cap.
 * - Agent snapshot: lightweight structural hash for change detection.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager.js";
import { getDashboardKeybindings, getDashboardRefreshInterval, getUiStyle } from "../agent-registry.js";
import type { SubagentScheduler } from "../schedule.js";
import type { AgentRecord } from "../types.js";
import {
  buildDashboardBodyLines,
  type DashboardRenderState,
  renderDashboardDetailPanel,
  renderDashboardEmpty,
  renderDashboardFooter,
  renderDashboardHeader,
  renderDashboardHelp,
  renderDashboardPerf,
} from "./agent-dashboard-renderer.js";
import { getAgentTopEntries, renderTopTable, type SortKey, sortEntries } from "./agent-top-renderer.js";
import { renderTreeFooter, renderTreeView } from "./agent-tree-renderer.js";
import type { AgentActivity } from "./agent-ui-types.js";
import { renderSchedulesSection } from "./dashboard/schedules-section.js";
import {
  type DashboardAction,
  isDashboardNavigationKey,
  matchDashboardKey,
} from "./dashboard-keybindings.js";
import { getWidgetMetrics } from "./global-registry.js";
import { RenderMetrics, type RenderMetricsSnapshot } from "./render-metrics.js";
import { buildSnapshotHash } from "./snapshot-hash.js";
import {
  type BoxChars,
  borderLine,
  type DashboardTheme,
  framedRow,
  getBoxChars,
  getThemeColors,
} from "./theme.js";
import {
  type Component,
  decodePrintableKey,
  type TUI,
} from "./tui-shim.js";

const MIN_VIEWPORT = 8;
export const DASHBOARD_HEIGHT_PCT = 100;

/** Fast refresh when agents are running (5 fps). */
const ACTIVE_REFRESH_MS = 200;

/** Fastest possible refresh (10 fps) for very large agent lists. */
const TURBO_REFRESH_MS = 100;

/** Aggressive refresh (6.7 fps) for large agent lists (50+ agents). */
const HIGH_LOAD_REFRESH_MS = 150;

/** Minimum time between render calls, even under pressure (60 fps cap). */
const MIN_RENDER_GAP_MS = 16;

export interface AgentDashboardOptions {
  manager: AgentManager;
  agentActivity: Map<string, AgentActivity>;
  scheduler?: SubagentScheduler;
  onViewConversation?: (record: AgentRecord) => Promise<void>;
  onAbort?: (id: string) => boolean;
  onSteer?: (id: string) => Promise<void>;
  onShowPermissions?: (record: AgentRecord) => Promise<void>;
  onSwarmAction?: (action: string, agentIds: string[]) => Promise<void>;
}

export class AgentDashboard implements Component {
  private scrollOffset = 0;
  private selectedIndex = 0;
  private closed = false;
  private agents: AgentRecord[] = [];
  private spinnerFrame = 0;
  private bodyLineCount = 0;
  private bodyFocusLineByAgentId = new Map<string, number>();

  /** Multi-select support */
  private selectedIds = new Set<string>();
  private showHelp = false;
  private showPerf = false;
  /** Which metrics view to show: dashboard or widget. */
  private perfView: "dashboard" | "widget" = "dashboard";
  private inCommandMode = false;
  private commandBuffer = "";
  private topViewMode = false;
  private topSortKey: SortKey = "tokens";
  private topSortAsc = false;
  private topPage = 0;
  private topPageSize = 12;
  private showSchedules = false;
  private showTree = false;
  /** Scroll offset for scrollable overlays (help, tree, schedules, perf). */
  private subViewScrollOffset = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Performance: debounce & rate limiting ──

  /** Debounce state: true while a microtask render is pending. */
  private renderPending = false;

  /** Timestamp of the last actual render for rate limiting. */
  private lastRenderTime = 0;

  /** Debounce timer handle for coalescing multiple rapid state changes. */
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Performance: memoized theme ──

  /** Cached theme colors — recomputed only when UI style changes. */
  private cachedTheme: DashboardTheme | null = null;

  /** Cached box chars — recomputed only when UI style changes. */
  private cachedBoxChars: BoxChars | null = null;

  /** Last known UI style for cache invalidation. */
  private lastUiStyle: string | null = null;

  // ── Performance: dirty detection ──

  /**
   * Lightweight structural snapshot: numeric hash of agent IDs + statuses.
   * Uses FNV-1a inspired hashing for O(1) comparison instead of O(N) string equality.
   */
  private agentSnapshotHash = 0;

  // ── Performance: body line cache ──

  /**
   * Cached body lines — only rebuilt when dirty flag is set.
   * Prevents expensive rebuildDashboardBodyLines() on spinner-only ticks.
   */
  private cachedBodyLines: string[] = [];
  private cachedBodyFocusMap = new Map<string, number>();
  private cachedBodyLineCount = 0;
  private cachedSpinnerFrame = -1;
  private cachedInnerW = 0;

  /**
   * True when the snapshot changed during the last refreshAgents() call.
   * Reset after each render. Used to decide whether full recompute is needed.
   */
  private dirty = true;

  // ── Performance: render timing metrics ──

  /** Render timing tracker for monitoring dashboard render() performance. */
  private renderMetrics = new RenderMetrics("dashboard-render", 50);

  /** Timestamp of first spawned agent (for time-to-first-visible). */
  private firstSpawnedAt = 0;

  constructor(
    private readonly tui: TUI,
    private readonly options: AgentDashboardOptions,
    private readonly done: (result: undefined) => void,
  ) {
    this.refreshAgents();
    this.startRefreshTimer();
  }

  // ════════════════════════════════════════════════════════════════
  // Adaptive Refresh Timer
  // ════════════════════════════════════════════════════════════════

  /**
   * Compute the optimal refresh interval based on current agent state.
   * - 100+ agents: TURBO_REFRESH_MS (100ms) — high throughput, rapid state changes
   * - 50-99 agents: HIGH_LOAD_REFRESH_MS (150ms) — balanced for medium-large lists
   * - Running/queued agents: ACTIVE_REFRESH_MS (200ms) — captures state transitions
   * - Idle with < 50 agents: getDashboardRefreshInterval() (750ms) — low overhead
   */
  private computeRefreshInterval(): number {
    const count = this.agents.length;
    if (count >= 100) return TURBO_REFRESH_MS;
    if (count >= 50) return HIGH_LOAD_REFRESH_MS;
    if (this.hasRunningAgents()) return ACTIVE_REFRESH_MS;
    return getDashboardRefreshInterval();
  }

  /**
   * Start (or restart) the refresh timer with an adaptive interval.
   * Interval adapts to agent count and activity level.
   */
  private startRefreshTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    const interval = this.computeRefreshInterval();

    // Use setTimeout (self-rescheduling) instead of setInterval.
    // Prevents render pileup when a render takes longer than the interval.
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (this.closed) return;

      // Always advance spinner for smooth animation even without user input.
      this.spinnerFrame++;
      this.refreshAgents();

      // Only re-render if something actually changed or we're in active/turbo mode.
      if (this.dirty || this.spinnerFrame % 3 === 0) {
        this.requestRender();
      }

      // Self-reschedule with adaptive interval.
      this.startRefreshTimer();
    }, interval);
  }

  private hasRunningAgents(): boolean {
    return this.agents.some((a) => a.status === "running" || a.status === "queued");
  }

  // ════════════════════════════════════════════════════════════════
  // Debounced & Rate-Limited Render Requests
  // ════════════════════════════════════════════════════════════════

  /**
   * Coalesced render request with rate limiting.
   *
   * - First call in a burst: schedules via queueMicrotask (fires after current
   *   synchronous work completes, batching all concurrent spawns).
   * - Subsequent calls within 16ms of the last render: coalesced via setTimeout
   *   so we never render more than ~60 fps.
   * - Duplicate calls while pending: ignored (renderPending guard).
   */
  private requestRender(): void {
    if (this.closed) return;

    // Track request count for debounce effectiveness (called before debounce filtering).
    this.renderMetrics.recordRequested();

    const now = Date.now();
    const elapsed = now - this.lastRenderTime;

    // Rate limit: don't render more often than every 16ms.
    if (this.lastRenderTime > 0 && elapsed < MIN_RENDER_GAP_MS) {
      // Coalesce: schedule one render after the rate limit window expires.
      if (!this.coalesceTimer && !this.renderPending) {
        this.coalesceTimer = setTimeout(() => {
          this.coalesceTimer = null;
          this.lastRenderTime = 0; // force allow
          this.requestRender();
        }, MIN_RENDER_GAP_MS - elapsed);
      }
      return;
    }

    // Already pending — skip.
    if (this.renderPending) return;

    this.renderPending = true;

    queueMicrotask(() => {
      this.renderPending = false;
      if (this.closed) return;
      this.lastRenderTime = Date.now();
      this.tui.requestRender?.();
    });
  }

  // ════════════════════════════════════════════════════════════════
  // Lifecycle
  // ════════════════════════════════════════════════════════════════

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
    if (this.statusMessageTimer) {
      clearTimeout(this.statusMessageTimer);
      this.statusMessageTimer = null;
    }
    this.done(undefined);
  }

  // ════════════════════════════════════════════════════════════════
  // State Management
  // ════════════════════════════════════════════════════════════════

  /**
   * Refresh agent list and detect structural changes.
   * Sets `this.dirty` when agent IDs or statuses changed.
   */
  private refreshAgents(): void {
    this.agents = this.options.manager.listAgents();

    // Build lightweight numeric structural snapshot.
    const snapshotHash = buildSnapshotHash(this.agents);

    if (snapshotHash !== this.agentSnapshotHash) {
      this.agentSnapshotHash = snapshotHash;
      this.dirty = true;

      // Clamp selection when agents were removed.
      if (this.selectedIndex >= this.agents.length) {
        this.selectedIndex = Math.max(0, this.agents.length - 1);
      }

      // Purge selected IDs that no longer exist.
      // Build Set via for loop (avoids intermediate .map() array allocation).
      const currentIds = new Set<string>();
      for (let i = 0; i < this.agents.length; i++) {
        currentIds.add(this.agents[i].id);
      }
      for (const id of this.selectedIds) {
        if (!currentIds.has(id)) this.selectedIds.delete(id);
      }
    }
  }

  // ════════════════════════════════════════════════════════════════
  // Memoized Theme
  // ════════════════════════════════════════════════════════════════

  /** Get theme colors, recomputing only when UI style changes. */
  private getTheme(): DashboardTheme {
    const currentStyle = getUiStyle();
    if (this.cachedTheme && this.lastUiStyle === currentStyle) {
      return this.cachedTheme;
    }
    this.cachedTheme = getThemeColors();
    this.lastUiStyle = currentStyle;
    return this.cachedTheme;
  }

  /** Get box characters, recomputing only when UI style changes. */
  private getBox(): BoxChars {
    const currentStyle = getUiStyle();
    if (this.cachedBoxChars && this.lastUiStyle === currentStyle) {
      return this.cachedBoxChars;
    }
    this.cachedBoxChars = getBoxChars();
    return this.cachedBoxChars;
  }

  // ════════════════════════════════════════════════════════════════
  // Command Mode
  // ════════════════════════════════════════════════════════════════

  private getWidgetMetrics(): RenderMetricsSnapshot | undefined {
    const wm = getWidgetMetrics();
    if (wm?.getSnapshot) {
      try { return wm.getSnapshot(); } catch { /* ignore */ }
    }
    return undefined;
  }

  private executeCommand(buffer: string): void {
    const cmd = buffer.toLowerCase().trim();
    if (cmd === "/perf") {
      this.showPerf = !this.showPerf;
      if (this.showPerf) {
        this.perfView = "dashboard";
        this.showHelp = false;
        this.subViewScrollOffset = 0;
      }
    } else if (cmd === "/perf widget") {
      this.showPerf = true;
      this.perfView = "widget";
      this.showHelp = false;
      this.subViewScrollOffset = 0;
    } else if (cmd === "/perf dashboard") {
      this.showPerf = true;
      this.perfView = "dashboard";
      this.showHelp = false;
      this.subViewScrollOffset = 0;
    } else if (cmd === "/perf reset") {
      if (this.perfView === "widget") {
        // Widget metrics are owned by the AgentWidget instance; this
        // dashboard cannot reach into it. Show the perf panel so the
        // keystroke isn't silently swallowed — the user sees the panel
        // appear and can take action in the editor.
        this.showPerf = true;
      } else {
        this.renderMetrics.reset();
        // Clear the first-spawn baseline so the next session can re-arm
        // timeToFirstVisibleMs from the actual first agent arrival.
        this.firstSpawnedAt = 0;
      }
    }
  }

  // ════════════════════════════════════════════════════════════════
  // Input Handling
  // ════════════════════════════════════════════════════════════════

  // ── Status message (temporary, shown in footer, auto-clears) ──
  private statusMessage = "";
  private statusMessageTimer: ReturnType<typeof setTimeout> | null = null;

  /** Show a temporary status message in the dashboard footer. */
  private showStatus(msg: string): void {
    this.statusMessage = msg;
    this.dirty = true;
    this.requestRender();
    if (this.statusMessageTimer) clearTimeout(this.statusMessageTimer);
    this.statusMessageTimer = setTimeout(() => {
      this.statusMessage = "";
      this.statusMessageTimer = null;
      this.dirty = true;
      this.requestRender();
    }, 3000);
  }

  handleInput(data: string): void {
    const rec = this.agents[this.selectedIndex];
    const viewportHeight = this.getViewportHeight();
    const maxScroll = Math.max(0, this.bodyLineCount - viewportHeight);
    const keys = getDashboardKeybindings();
    const key = (action: DashboardAction): boolean => matchDashboardKey(data, action, keys);

    // ── Command mode ───────────────────────────────────────────────
    if (this.inCommandMode) {
      if (key("commandCancel")) {
        this.inCommandMode = false;
        this.commandBuffer = "";
        this.dirty = true;
        this.requestRender();
        return;
      }
      if (key("commandSubmit")) {
        this.executeCommand(this.commandBuffer);
        this.inCommandMode = false;
        this.commandBuffer = "";
        this.dirty = true;
        this.requestRender();
        return;
      }
      if (key("commandBackspace")) {
        this.commandBuffer = this.commandBuffer.slice(0, -1);
        this.dirty = true;
        this.requestRender();
        return;
      }
      // Shift+letter → map to uppercase (canonical form used in some tests)
      if (data.startsWith("shift+") && data.length === 7) {
        this.commandBuffer += data.charAt(6).toUpperCase();
        this.dirty = true;
        this.requestRender();
        return;
      }
      // Single character → append to buffer (legacy terminals)
      if (data.length === 1 && !data.includes("+")) {
        this.commandBuffer += data;
        this.dirty = true;
        this.requestRender();
        return;
      }
      // Kitty CSI-u / modifyOtherKeys printable (host sends raw sequences)
      const printable = decodePrintableKey(data);
      if (printable !== undefined && printable.length > 0) {
        this.commandBuffer += printable;
        this.dirty = true;
        this.requestRender();
        return;
      }
      // Unknown key while in command mode → cancel and fall through
      this.inCommandMode = false;
      this.commandBuffer = "";
    }

    // ── Toggle perf view if it's showing (q/esc close perf, not dashboard) ──
    if (this.showPerf) {
      if (key("closePerf")) {
        this.showPerf = false;
        this.dirty = true;
        this.requestRender();
        return;
      }
      // Allow / to enter command mode even when perf is showing
      if (key("commandMode") && !this.inCommandMode) {
        this.inCommandMode = true;
        this.commandBuffer = "/";
        this.dirty = true;
        this.requestRender();
        return;
      }
      if (!isDashboardNavigationKey(data, keys)) {
        this.dirty = true;
        this.requestRender();
        return;
      }
      // Safe navigation keys fall through to the normal handler below.
    }

    // ── Enter command mode from normal mode ──
    if (key("commandMode") && !this.inCommandMode) {
      this.inCommandMode = true;
      this.commandBuffer = "/";
      this.dirty = true;
      this.requestRender();
      return;
    }

    if (key("escapeKey")) {
      if (this.showHelp || this.showTree || this.showSchedules) {
        this.showHelp = false;
        this.showTree = false;
        this.showSchedules = false;
        this.subViewScrollOffset = 0;
        this.dirty = true;
        this.requestRender();
        return;
      }
      this.close();
      return;
    }

    if (key("quitKey")) {
      if (this.showHelp || this.showTree || this.showSchedules) {
        this.showHelp = false;
        this.showTree = false;
        this.showSchedules = false;
        this.subViewScrollOffset = 0;
        this.dirty = true;
        this.requestRender();
        return;
      }
      if (this.topViewMode) {
        this.topViewMode = false;
        this.dirty = true;
        this.requestRender();
        return;
      }
      this.close();
      return;
    }

    // ── Overlay scroll navigation ─────────────────────────────────
    // When an overlay (help/tree/schedules) is active, navigation keys scroll
    // the overlay instead of moving the underlying agent selection.
    const isSubViewActive = this.showHelp || this.showTree || this.showSchedules;
    if (isSubViewActive) {
      const vh = this.getViewportHeight();
      if (key("moveUp")) {
        this.subViewScrollOffset = Math.max(0, this.subViewScrollOffset - 1);
        this.dirty = true;
        this.requestRender();
        return;
      }
      if (key("moveDown")) {
        this.subViewScrollOffset += 1;
        this.dirty = true;
        this.requestRender();
        return;
      }
      if (key("pageUp")) {
        this.subViewScrollOffset = Math.max(0, this.subViewScrollOffset - vh);
        this.dirty = true;
        this.requestRender();
        return;
      }
      if (key("pageDown")) {
        this.subViewScrollOffset += vh;
        this.dirty = true;
        this.requestRender();
        return;
      }
      if (key("home")) {
        this.subViewScrollOffset = 0;
        this.dirty = true;
        this.requestRender();
        return;
      }
      if (key("end")) {
        this.subViewScrollOffset = 9999;
        this.dirty = true;
        this.requestRender();
        return;
      }
    }

    // Navigation — vim + arrows
    if (key("moveUp")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.dirty = true;
    } else if (key("moveDown")) {
      if (this.agents.length === 0) return;
      this.selectedIndex = Math.min(this.agents.length - 1, this.selectedIndex + 1);
      this.dirty = true;
    } else if (key("pageUp")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - this.getViewportHeight());
      this.scrollOffset = Math.max(0, this.scrollOffset - this.getViewportHeight());
      this.dirty = true;
    } else if (key("pageDown")) {
      if (this.agents.length === 0) return;
      this.selectedIndex = Math.min(this.agents.length - 1, this.selectedIndex + viewportHeight);
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.dirty = true;
    } else if (key("home")) {
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      this.dirty = true;
    } else if (key("end")) {
      if (this.agents.length === 0) return;
      this.selectedIndex = this.agents.length - 1;
      this.scrollOffset = maxScroll;
      this.dirty = true;
    }

    // ── Top view mode sort/page keys ──────────────────────────────
    if (this.topViewMode) {
      if (key("sortDuration")) {
        if (this.topSortKey === "duration") this.topSortAsc = !this.topSortAsc;
        else { this.topSortKey = "duration"; this.topSortAsc = false; }
        this.topPage = 0;
        this.dirty = true;
        this.spinnerFrame++;
        this.requestRender();
        return;
      }
      if (key("sortTools")) {
        if (this.topSortKey === "toolUses") this.topSortAsc = !this.topSortAsc;
        else { this.topSortKey = "toolUses"; this.topSortAsc = false; }
        this.topPage = 0;
        this.dirty = true;
        this.spinnerFrame++;
        this.requestRender();
        return;
      }
      if (key("sortLastSeen")) {
        if (this.topSortKey === "lastSeen") this.topSortAsc = !this.topSortAsc;
        else { this.topSortKey = "lastSeen"; this.topSortAsc = false; }
        this.topPage = 0;
        this.dirty = true;
        this.spinnerFrame++;
        this.requestRender();
        return;
      }
      if (key("sortName")) {
        if (this.topSortKey === "name") this.topSortAsc = !this.topSortAsc;
        else { this.topSortKey = "name"; this.topSortAsc = false; }
        this.topPage = 0;
        this.dirty = true;
        this.spinnerFrame++;
        this.requestRender();
        return;
      }
      if (key("pageLeft")) {
        this.topPage = Math.max(0, this.topPage - 1);
        this.dirty = true;
        this.spinnerFrame++;
        this.requestRender();
        return;
      }
      if (key("pageRight")) {
        const entries = sortEntries(getAgentTopEntries(this.agents, this.options.agentActivity), this.topSortKey, this.topSortAsc);
        const totalPages = Math.max(1, Math.ceil(entries.length / this.getViewportHeight()));
        this.topPage = Math.min(totalPages - 1, this.topPage + 1);
        this.dirty = true;
        this.spinnerFrame++;
        this.requestRender();
        return;
      }
      // t, r, and other keys fall through to the action handlers below
      // which check this.topViewMode inline.
    }

    // Actions
    if (key("openConversation")) {
      if (isSubViewActive) { this.dirty = true; this.requestRender(); return; }
      if (rec && this.options.onViewConversation) {
        this.close();
        void this.options.onViewConversation(rec);
        return;
      }
    } else if (key("toggleSelect")) {
      if (isSubViewActive) { this.dirty = true; this.requestRender(); return; }
      if (rec) {
        if (this.selectedIds.has(rec.id)) {
          this.selectedIds.delete(rec.id);
        } else {
          this.selectedIds.add(rec.id);
        }
        this.dirty = true;
        this.requestRender();
      }
    } else if (key("kill")) {
      if (isSubViewActive) { this.dirty = true; this.requestRender(); return; }
      const idsToKill = this.selectedIds.size > 0
        ? Array.from(this.selectedIds)
        : rec ? [rec.id] : [];

      let anyAborted = false;
      for (const id of idsToKill) {
        const aborted = this.options.onAbort
          ? this.options.onAbort(id)
          : this.options.manager.abort(id);
        if (aborted) anyAborted = true;
      }
      if (anyAborted) {
        this.selectedIds.clear();
        this.refreshAgents();
        this.requestRender();
      }
    } else if (key("steer")) {
      if (isSubViewActive) { this.dirty = true; this.requestRender(); return; }
      if (rec) {
        if (this.options.onSteer) {
          this.close();
          void this.options.onSteer(rec.id);
          return;
        }
        this.showStatus("Steer is not available in this context.");
      }
    } else if (key("permissions")) {
      if (isSubViewActive) { this.dirty = true; this.requestRender(); return; }
      if (rec) {
        if (this.options.onShowPermissions) {
          this.close();
          void this.options.onShowPermissions(rec);
          return;
        }
        this.showStatus("Permissions view is not available in this context.");
      }
    } else if (key("refresh")) {
      if (this.topViewMode) {
        // In top view: sort by turns
        if (this.topSortKey === "turns") this.topSortAsc = !this.topSortAsc;
        else { this.topSortKey = "turns"; this.topSortAsc = false; }
        this.topPage = 0;
      } else {
        this.refreshAgents();
      }
      this.dirty = true;
      this.requestRender();
    } else if (key("help")) {
      this.showHelp = !this.showHelp;
      if (this.showHelp) this.subViewScrollOffset = 0;
      this.dirty = true;
      this.requestRender();
    } else if (key("topView")) {
      if (this.topViewMode) {
        // In top view: sort by tokens (pressing t again toggles direction)
        if (this.topSortKey === "tokens") this.topSortAsc = !this.topSortAsc;
        else { this.topSortKey = "tokens"; this.topSortAsc = false; }
        this.topPage = 0;
      } else {
        this.topViewMode = !this.topViewMode;
        if (this.topViewMode) { this.topPage = 0; this.showSchedules = false; this.showTree = false; }
      }
      this.dirty = true;
      this.requestRender();
    } else if (key("schedules")) {
      if (this.options.scheduler?.isActive()) {
        this.showSchedules = !this.showSchedules;
        if (this.showSchedules) { this.topViewMode = false; this.showHelp = false; this.showPerf = false; this.showTree = false; this.subViewScrollOffset = 0; }
        this.dirty = true;
        this.requestRender();
      }
    } else if (key("tree")) {
      this.showTree = !this.showTree;
      if (this.showTree) { this.topViewMode = false; this.showSchedules = false; this.showHelp = false; this.showPerf = false; this.subViewScrollOffset = 0; }
      this.dirty = true;
      this.requestRender();
    } else if (key("swarm")) {
      if (isSubViewActive) { this.dirty = true; this.requestRender(); return; }
      const targets = this.selectedIds.size > 0
        ? (() => {
            const arr = [];
            for (let i = 0; i < this.agents.length; i++) {
              if (this.selectedIds.has(this.agents[i].id)) arr.push(this.agents[i]);
            }
            return arr;
          })()
        : rec ? [rec] : [];

      if (targets.length > 0) {
        if (this.options.onSwarmAction) {
          this.close();
          void this.options.onSwarmAction("create", targets.map((t) => t.id));
          return;
        }
        this.showStatus("Swarm actions are not available in this context.");
      }
    }

    // Spinner: advance on user input for responsive feel.
    this.spinnerFrame++;
    this.keepSelectedBodyLineVisible();
  }

  // ════════════════════════════════════════════════════════════════
  // Layout Helpers
  // ════════════════════════════════════════════════════════════════

  private getViewportHeight(): number {
    const rows = this.tui.terminal.rows;
    const maxRows = Math.floor((rows * DASHBOARD_HEIGHT_PCT) / 100);
    return Math.max(MIN_VIEWPORT, maxRows - this.chromeLines());
  }

  /**
   * Dynamically compute chrome lines based on terminal height.
   * Small terminals get proportionally less chrome; large terminals get more.
   * - Very small (< 30 rows): 10 lines (minimal chrome)
   * - Small (30-50 rows): 13 lines
   * - Normal (50-80 rows): 16 lines
   * - Large (> 80 rows): 19 lines
   */
  private chromeLines(): number {
    const rows = this.tui.terminal.rows;
    if (rows < 30) return 10;
    if (rows < 50) return 13;
    if (rows < 80) return 16;
    return 19;
  }

  private keepSelectedBodyLineVisible(): void {
    const selected = this.agents[this.selectedIndex];
    if (!selected) { this.scrollOffset = 0; return; }
    const line = this.bodyFocusLineByAgentId.get(selected.id);
    if (line === undefined) return;

    const vh = this.getViewportHeight();
    const maxScroll = Math.max(0, this.bodyLineCount - vh);
    if (line < this.scrollOffset) {
      this.scrollOffset = line;
    } else if (line >= this.scrollOffset + vh) {
      this.scrollOffset = line - vh + 1;
    }
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
  }

  // ════════════════════════════════════════════════════════════════
  // Render
  // ════════════════════════════════════════════════════════════════

  private renderState(): DashboardRenderState {
    return {
      agents: this.agents,
      selectedIndex: this.selectedIndex,
      selectedIds: this.selectedIds,
      frame: this.spinnerFrame,
      agentActivity: this.options.agentActivity,
    };
  }

  render(width: number): string[] {
    const renderStart = performance.now();

    // Track first spawn timestamp for time-to-first-visible.
    const hasSpawned = this.agents.length > 0;
    if (hasSpawned && this.firstSpawnedAt === 0) {
      this.firstSpawnedAt = Date.now();
      this.renderMetrics.setFirstSpawnTimestamp(this.firstSpawnedAt);
    }

    // Use memoized theme/box chars (only recomputed on UI style change).
    const th = this.getTheme();
    const box = this.getBox();

    // Robust width handling
    const terminalCols =
      this.tui?.terminal?.columns ??
      process.stdout?.columns ??
      120;

    const requestedWidth = width || terminalCols;
    const safeWidth = Math.max(60, Math.min(requestedWidth, terminalCols - 2));
    const innerW = Math.max(1, safeWidth - 4);

    const state = this.renderState();
    const lines = renderDashboardHeader(safeWidth, th, box, state, this.options.manager);

    if (this.showTree) {
      const overlayLines = [
        ...renderTreeView(innerW, th, box, this.agents),
        ...renderTreeFooter(innerW, th, box),
      ];
      const vh = this.getViewportHeight();
      const maxScroll = Math.max(0, overlayLines.length - vh);
      this.subViewScrollOffset = Math.min(this.subViewScrollOffset, maxScroll);
      const visible = overlayLines.slice(this.subViewScrollOffset, this.subViewScrollOffset + vh);
      for (const line of visible) lines.push(line);
      for (let i = visible.length; i < vh; i++) lines.push(framedRow("", innerW, th, box));
    } else if (this.showSchedules && this.options.scheduler?.isActive()) {
      const overlayLines = renderSchedulesSection(innerW, th, box, this.options.scheduler);
      const vh = this.getViewportHeight();
      const maxScroll = Math.max(0, overlayLines.length - vh);
      this.subViewScrollOffset = Math.min(this.subViewScrollOffset, maxScroll);
      const visible = overlayLines.slice(this.subViewScrollOffset, this.subViewScrollOffset + vh);
      for (const line of visible) lines.push(line);
      for (let i = visible.length; i < vh; i++) lines.push(framedRow("", innerW, th, box));
    } else if (this.showHelp) {
      const overlayLines = renderDashboardHelp(innerW, th, box);
      const vh = this.getViewportHeight();
      const maxScroll = Math.max(0, overlayLines.length - vh);
      this.subViewScrollOffset = Math.min(this.subViewScrollOffset, maxScroll);
      const visible = overlayLines.slice(this.subViewScrollOffset, this.subViewScrollOffset + vh);
      for (const line of visible) lines.push(line);
      for (let i = visible.length; i < vh; i++) lines.push(framedRow("", innerW, th, box));
    } else if (this.showPerf) {
      let overlayLines: string[];
      if (this.perfView === "widget") {
        const widgetMetrics = this.getWidgetMetrics();
        if (widgetMetrics) {
          overlayLines = renderDashboardPerf(innerW, th, box, widgetMetrics, "widget");
        } else {
          overlayLines = renderDashboardPerf(innerW, th, box, this.renderMetrics.snapshot(), "widget");
        }
      } else {
        overlayLines = renderDashboardPerf(innerW, th, box, this.renderMetrics.snapshot(), "dashboard");
      }
      const vh = this.getViewportHeight();
      const maxScroll = Math.max(0, overlayLines.length - vh);
      this.subViewScrollOffset = Math.min(this.subViewScrollOffset, maxScroll);
      const visible = overlayLines.slice(this.subViewScrollOffset, this.subViewScrollOffset + vh);
      for (const line of visible) lines.push(line);
      for (let i = visible.length; i < vh; i++) lines.push(framedRow("", innerW, th, box));
    } else if (this.agents.length === 0) {
      lines.push(...renderDashboardEmpty(innerW, th, box));
    } else if (this.topViewMode) {
      // Top view: render the agent stats table instead of the list
      const vh = this.getViewportHeight();
      this.topPageSize = Math.max(5, vh);
      const entries = sortEntries(getAgentTopEntries(this.agents, this.options.agentActivity), this.topSortKey, this.topSortAsc);
      lines.push(...renderTopTable(entries, this.topSortKey, this.topSortAsc, this.topPage, this.topPageSize, th, safeWidth, "t: back to list"));
    } else {
      // Body cache: rebuild when dirty OR when spinner changed (running agents need animation).
      const needsSpinnerRebuild = this.hasRunningAgents() && this.cachedSpinnerFrame !== this.spinnerFrame;
      const needsResizeRebuild = this.cachedInnerW !== innerW;
      if (this.dirty || this.cachedBodyLines.length === 0 || needsSpinnerRebuild || needsResizeRebuild) {
        const body = buildDashboardBodyLines(innerW, th, box, state);
        this.cachedBodyLines = body.lines;
        this.cachedBodyFocusMap = body.focusLineByAgentId;
        this.cachedBodyLineCount = body.lines.length;
        this.cachedSpinnerFrame = this.spinnerFrame;
        this.cachedInnerW = innerW;
      }
      this.bodyFocusLineByAgentId = this.cachedBodyFocusMap;
      this.bodyLineCount = this.cachedBodyLineCount;
      this.keepSelectedBodyLineVisible();

      const vh = this.getViewportHeight();
      const maxScroll = Math.max(0, this.cachedBodyLineCount - vh);
      this.scrollOffset = Math.min(this.scrollOffset, maxScroll);

      const start = Math.min(this.scrollOffset, maxScroll);
      const visible = this.cachedBodyLines.slice(start, start + vh);

      for (const line of visible) lines.push(framedRow(line, innerW, th, box));
      for (let i = visible.length; i < vh; i++) lines.push(framedRow("", innerW, th, box));
    }

    // Show command input line when in command mode.
    if (this.inCommandMode) {
      const cursor = " ".repeat(Math.max(0, innerW - 2 - this.commandBuffer.length - 2));
      const cmdLine = `${th.accent}${this.commandBuffer}${cursor}${th.dim}▌${th.reset}`;
      lines.push(...renderDashboardDetailPanel(safeWidth, th, box, state, this.options.manager));
      lines.push(borderLine(safeWidth, th, box, "mid"));
      lines.push(framedRow(`${th.title}cmd${th.reset}  ${cmdLine}`, innerW, th, box));
      lines.push(framedRow(`${th.dim}Enter to run · Esc to cancel${th.reset}`, innerW, th, box));
      lines.push(...renderDashboardFooter(safeWidth, th, box, this.options.agentActivity));
    } else {
      lines.push(...renderDashboardDetailPanel(safeWidth, th, box, state, this.options.manager));
      // Show temporary status message in the footer.
      if (this.statusMessage) {
        lines.push(framedRow(`${th.highlight}⚠ ${this.statusMessage}${th.reset}`, innerW, th, box));
      }
      lines.push(...renderDashboardFooter(safeWidth, th, box, this.options.agentActivity));
    }

    // Reset dirty flag after a full render.
    this.dirty = false;

    // Record render timing with active agent context.
    let activeAgents = 0;
    for (let i = 0; i < this.agents.length; i++) {
      if (this.agents[i].status === "running" || this.agents[i].status === "queued") activeAgents++;
    }
    this.renderMetrics.record(performance.now() - renderStart, activeAgents);

    return lines;
  }

  /** Get render performance metrics snapshot. */
  getRenderMetrics() {
    return this.renderMetrics.snapshot();
  }

  invalidate(): void {
    // Invalidate theme cache when the framework calls this (e.g. style change).
    this.cachedTheme = null;
    this.cachedBoxChars = null;
    this.lastUiStyle = null;
    this.dirty = true;
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
    if (this.statusMessageTimer) {
      clearTimeout(this.statusMessageTimer);
      this.statusMessageTimer = null;
    }
    this.closed = true;
  }
}

/**
 * Launch the interactive agent dashboard as an overlay.
 */
export async function showAgentDashboard(
  ctx: ExtensionCommandContext,
  manager: AgentManager,
  agentActivity: Map<string, AgentActivity>,
  scheduler?: SubagentScheduler,
  onViewConversation?: (record: AgentRecord) => Promise<void>,
  onAbort?: (id: string) => boolean,
  onSteer?: (id: string) => Promise<void>,
  onShowPermissions?: (record: AgentRecord) => Promise<void>,
  onSwarmAction?: (action: string, agentIds: string[]) => Promise<void>,
): Promise<void> {
  await ctx.ui.custom<undefined>(
    (tui, _theme, _keybindings, done) => {
      return new AgentDashboard(
        tui as import("./tui-shim.js").TUI,
        { manager, agentActivity, scheduler, onViewConversation, onAbort, onSteer, onShowPermissions, onSwarmAction },
        done,
      );
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "top-left",
        width: "100%",
        maxHeight: "100%",
      },
    },
  );
}
