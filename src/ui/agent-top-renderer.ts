/**
 * agent-top-renderer.ts — Live top-like resource table for orchestrated agents.
 *
 * Layout contract:
 * - Every cell is padded/truncated with ANSI-aware helpers (`visibleWidth`,
 *   `padAndTruncate`) so colored spinners never shift columns.
 * - Column set is responsive at 60 / 80 / 100 / 140 terminal columns.
 * - Row visible width equals the content budget (gutter + columns + separators).
 * - `mode: "widget"` is a compact strip for the persistent above-editor widget;
 *   `"full"` is used by the interactive dashboard top view.
 */

import type { AgentRecord } from "../types.js";
import { getLifetimeTotal } from "../usage.js";
import { getDisplayName } from "./agent-format.js";
import type { AgentActivity } from "./agent-ui-types.js";
import { ANIMATION_INTERVAL, getAgentSpinnerFrame } from "./animation.js";
import { type DashboardTheme, fastTruncate, padAndTruncate } from "./theme.js";
import { visibleWidth } from "./tui-shim.js";

export type SortKey = "tokens" | "turns" | "duration" | "toolUses" | "name" | "lastSeen";

export interface AgentTopEntry {
  id: string;
  /** Agent type id when known (from live records); optional in synthetic test fixtures. */
  type?: string;
  name: string;
  status: string;
  tokens: number;
  turns: number;
  toolUses: number;
  durationMs: number;
  lastSeenMs: number | undefined;
}

export type TopRenderMode = "full" | "widget";

type TopTheme = ReturnType<typeof createTopThemeAdapter>;
type ColumnKey = "name" | "status" | "tokens" | "turns" | "toolUses" | "duration" | "lastSeen" | "load";
type TopColumn = { key: ColumnKey; label: string; width: number; align: "left" | "right" };

/** Visible cells for the column separator ` │ `. */
const SEP_WIDTH = 3;
/** Leading gutter so the table is not flush against the left edge. */
const GUTTER = 1;

export function getAgentTopEntries(
  agents: AgentRecord[],
  activity: Map<string, AgentActivity>,
): AgentTopEntry[] {
  const now = Date.now();
  return agents.map((record) => {
    const agentActivity = activity.get(record.id);
    const tokens = agentActivity
      ? getLifetimeTotal(agentActivity.lifetimeUsage)
      : (record.lifetimeUsage?.input ?? 0) + (record.lifetimeUsage?.output ?? 0);
    return {
      id: record.id,
      type: record.type,
      name: getDisplayName(record.type),
      status: record.status,
      tokens,
      turns: agentActivity?.turnCount ?? 0,
      toolUses: agentActivity?.toolUses ?? record.toolUses,
      durationMs: (record.completedAt ?? now) - (record.startedAt ?? now),
      lastSeenMs: agentActivity?.lastSeenMs,
    };
  });
}

export function sortEntries(entries: AgentTopEntry[], key: SortKey, asc: boolean): AgentTopEntry[] {
  return [...entries].sort((left, right) => {
    let comparison = 0;
    if (key === "name") comparison = left.name.localeCompare(right.name);
    else if (key === "tokens") comparison = left.tokens - right.tokens;
    else if (key === "turns") comparison = left.turns - right.turns;
    else if (key === "toolUses") comparison = left.toolUses - right.toolUses;
    else if (key === "duration") comparison = left.durationMs - right.durationMs;
    else comparison = (left.lastSeenMs ?? 0) - (right.lastSeenMs ?? 0);
    return asc ? comparison : -comparison;
  });
}

export function createTopThemeAdapter(th: DashboardTheme): {
  fg(color: string, text: string): string;
  bold(text: string): string;
} {
  return {
    fg(color: string, text: string): string {
      const code = color === "title" ? th.title
        : color === "dim" ? th.dim
        : color === "muted" ? th.muted
        : color === "highlight" ? th.highlight
        : color === "accent" ? th.accent
        : color === "success" ? th.success
        : color === "error" ? th.error
        : color === "warning" ? th.highlight
        : color === "border" ? th.border
        : th.dim;
      return `${code}${text}${th.reset}`;
    },
    bold(text: string): string {
      return `${th.title}${text}${th.reset}`;
    },
  };
}

/** Compact token count for table cells (no "token" suffix — column label carries the unit). */
export function formatCellTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

/** Human runtime: `12.3s` / `4m41s` / `1h05m`. */
export function formatCellRuntime(ms: number): string {
  const clamped = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const totalSec = Math.floor(clamped / 1000);
  if (totalSec < 60) return `${(clamped / 1000).toFixed(1)}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

function formatLastSeen(lastSeenMs: number | undefined): string {
  if (lastSeenMs === undefined) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - lastSeenMs) / 1000));
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function statusText(entry: AgentTopEntry, theme: TopTheme): string {
  const frame = Math.floor(Date.now() / ANIMATION_INTERVAL);
  const withGlyph = (glyph: string, label: string): string => (glyph ? `${glyph} ${label}` : label);
  if (entry.status === "running") {
    return theme.fg("accent", withGlyph(getAgentSpinnerFrame(entry.id, frame, "agent", entry.type), "RUN"));
  }
  if (entry.status === "queued") {
    return theme.fg("warning", withGlyph(getAgentSpinnerFrame(entry.id, frame, "queue", entry.type), "QUEUE"));
  }
  if (entry.status === "completed") return theme.fg("success", "✓ DONE");
  if (entry.status === "steered") return theme.fg("warning", "↳ STEER");
  if (entry.status === "aborted" || entry.status === "error") return theme.fg("error", "✕ FAIL");
  return theme.fg("dim", `■ ${entry.status.toUpperCase()}`);
}

/**
 * Build responsive columns. Drop order matches AGENTS.md / existing tests:
 * load <102, SEEN <92, TOOLS <78, TURNS <68.
 */
export function buildColumns(width: number): TopColumn[] {
  const columns: TopColumn[] = [
    { key: "name", label: "AGENT", width: 0, align: "left" },
    { key: "status", label: "STATE", width: 8, align: "left" },
    { key: "tokens", label: "TOKENS", width: 8, align: "right" },
    { key: "turns", label: "TURNS", width: 6, align: "right" },
    { key: "toolUses", label: "TOOLS", width: 6, align: "right" },
    { key: "duration", label: "RUNTIME", width: 8, align: "right" },
    { key: "lastSeen", label: "SEEN", width: 5, align: "right" },
    { key: "load", label: "LOAD", width: 8, align: "left" },
  ];

  if (width < 102) columns.splice(columns.findIndex((column) => column.key === "load"), 1);
  if (width < 92) columns.splice(columns.findIndex((column) => column.key === "lastSeen"), 1);
  if (width < 78) columns.splice(columns.findIndex((column) => column.key === "toolUses"), 1);
  if (width < 68) columns.splice(columns.findIndex((column) => column.key === "turns"), 1);

  // Widen numeric columns on very wide terminals.
  if (width >= 140) {
    for (const column of columns) {
      if (column.key === "tokens") column.width = 9;
      if (column.key === "duration") column.width = 9;
      if (column.key === "load") column.width = 10;
      if (column.key === "status") column.width = 9;
    }
  }

  const separators = Math.max(0, columns.length - 1) * SEP_WIDTH;
  const fixedWidth = columns.reduce((sum, column) => sum + (column.key === "name" ? 0 : column.width), 0);
  const nameColumn = columns.find((column) => column.key === "name");
  const contentBudget = Math.max(40, width - GUTTER);
  if (nameColumn) {
    nameColumn.width = Math.max(10, contentBudget - fixedWidth - separators);
  }
  return columns;
}

function columnSortKey(key: ColumnKey): SortKey | undefined {
  if (key === "toolUses") return "toolUses";
  if (key === "lastSeen") return "lastSeen";
  if (key === "duration") return "duration";
  if (key === "name" || key === "tokens" || key === "turns") return key;
  return undefined;
}

/** Pad/truncate a (possibly ANSI-colored) cell to an exact visible width. */
function renderCell(content: string, column: TopColumn): string {
  const truncated = fastTruncate(content, column.width);
  if (column.align === "right") {
    const pad = Math.max(0, column.width - visibleWidth(truncated));
    return `${" ".repeat(pad)}${truncated}`;
  }
  return padAndTruncate(truncated, column.width);
}

function separator(theme: TopTheme): string {
  return ` ${theme.fg("border", "│")} `;
}

function joinCells(cells: string[], theme: TopTheme): string {
  return cells.join(separator(theme));
}

function contentWidth(columns: TopColumn[]): number {
  return columns.reduce((sum, column) => sum + column.width, 0)
    + Math.max(0, columns.length - 1) * SEP_WIDTH;
}

function renderLoadBar(tokens: number, maximum: number, width: number, theme: TopTheme): string {
  const barWidth = Math.max(4, width);
  const filled = maximum <= 0 ? 0 : Math.max(0, Math.min(barWidth, Math.round((tokens / maximum) * barWidth)));
  return `${theme.fg("accent", "■".repeat(filled))}${theme.fg("dim", "·".repeat(barWidth - filled))}`;
}

function renderSummary(entries: AgentTopEntry[], theme: TopTheme, mode: TopRenderMode): string {
  let running = 0;
  let queued = 0;
  let totalTokens = 0;
  let totalTurns = 0;
  let totalTools = 0;
  for (const entry of entries) {
    if (entry.status === "running") running++;
    else if (entry.status === "queued") queued++;
    totalTokens += entry.tokens;
    totalTurns += entry.turns;
    totalTools += entry.toolUses;
  }
  const sep = theme.fg("dim", mode === "widget" ? " · " : " │ ");
  const parts = [
    theme.fg("accent", `${running} active`),
    theme.fg("warning", `${queued} queued`),
    theme.fg("muted", formatCellTokens(totalTokens)),
    theme.fg("muted", `${totalTurns} turns`),
    theme.fg("muted", `${totalTools} tools`),
  ];
  return parts.join(sep);
}

function renderTitleLine(
  theme: TopTheme,
  sortKey: SortKey,
  sortAsc: boolean,
  currentPage: number,
  totalPages: number,
  helpLine: string | undefined,
  mode: TopRenderMode,
  width: number,
): string {
  const direction = sortAsc ? "↑" : "↓";
  const glyph = getAgentSpinnerFrame("agent-top-header", Math.floor(Date.now() / ANIMATION_INTERVAL), "header");
  const title = theme.fg("title", theme.bold("AGENT TOP"));
  const meta = theme.fg("dim", `sort ${sortKey} ${direction} · ${currentPage + 1}/${totalPages}`);
  const help = helpLine ? theme.fg("dim", helpLine) : "";
  const core = mode === "widget"
    ? `${theme.fg("accent", glyph)} ${title}  ${meta}`
    : ` ${theme.fg("accent", glyph)} ${title}  ${meta}${help ? `  ${help}` : ""}`;
  return padAndTruncate(core, width);
}

export interface RenderTopTableOptions {
  mode?: TopRenderMode;
  helpLine?: string;
}

export function renderTopTable(
  entries: AgentTopEntry[],
  sortKey: SortKey,
  sortAsc: boolean,
  page: number,
  pageSize: number,
  th: DashboardTheme,
  width: number,
  helpLineOrOptions?: string | RenderTopTableOptions,
): string[] {
  const options: RenderTopTableOptions = typeof helpLineOrOptions === "string"
    ? { helpLine: helpLineOrOptions, mode: "full" }
    : (helpLineOrOptions ?? {});
  const mode = options.mode ?? "full";
  const helpLine = options.helpLine;

  const theme = createTopThemeAdapter(th);
  const safeWidth = Math.max(40, width);
  const columns = buildColumns(safeWidth);
  const tableWidth = contentWidth(columns);
  const safePageSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(entries.length / safePageSize));
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const start = currentPage * safePageSize;
  const slice = entries.slice(start, start + safePageSize);
  const maximumTokens = Math.max(0, ...entries.map((entry) => entry.tokens));
  const direction = sortAsc ? "↑" : "↓";
  const lines: string[] = [];
  const gutter = " ".repeat(GUTTER);

  lines.push(renderTitleLine(
    theme, sortKey, sortAsc, currentPage, totalPages, helpLine, mode, safeWidth,
  ));

  const summary = `${gutter}${renderSummary(entries, theme, mode)}`;
  lines.push(padAndTruncate(summary, safeWidth));

  const headerCells = columns.map((column) => {
    const mappedSortKey = columnSortKey(column.key);
    const marker = mappedSortKey === sortKey ? direction : " ";
    const label = `${marker}${column.label}`;
    const colored = theme.fg(mappedSortKey === sortKey ? "highlight" : "muted", label);
    return renderCell(colored, column);
  });
  lines.push(padAndTruncate(`${gutter}${joinCells(headerCells, theme)}`, safeWidth));

  const rule = theme.fg("border", "─".repeat(Math.min(safeWidth - GUTTER, tableWidth)));
  lines.push(padAndTruncate(`${gutter}${rule}`, safeWidth));

  if (entries.length === 0) {
    lines.push(padAndTruncate(
      `${gutter}${theme.fg("muted", "No agents in this session yet.")}`,
      safeWidth,
    ));
    return lines;
  }

  for (const entry of slice) {
    const cells = columns.map((column) => {
      if (column.key === "name") return renderCell(theme.fg("accent", entry.name), column);
      if (column.key === "status") return renderCell(statusText(entry, theme), column);
      if (column.key === "tokens") {
        return renderCell(theme.fg("muted", formatCellTokens(entry.tokens)), column);
      }
      if (column.key === "turns") {
        return renderCell(theme.fg("muted", String(entry.turns)), column);
      }
      if (column.key === "toolUses") {
        return renderCell(theme.fg("muted", String(entry.toolUses)), column);
      }
      if (column.key === "duration") {
        return renderCell(theme.fg("dim", formatCellRuntime(entry.durationMs)), column);
      }
      if (column.key === "lastSeen") {
        const lastSeen = formatLastSeen(entry.lastSeenMs);
        const color = lastSeen === "now" ? "success" : lastSeen === "—" ? "dim" : "muted";
        return renderCell(theme.fg(color, lastSeen), column);
      }
      return renderCell(renderLoadBar(entry.tokens, maximumTokens, column.width, theme), column);
    });
    lines.push(padAndTruncate(`${gutter}${joinCells(cells, theme)}`, safeWidth));
  }

  // Widget footer hint when truncated
  if (mode === "widget" && entries.length > safePageSize) {
    const remaining = entries.length - safePageSize;
    lines.push(padAndTruncate(
      `${gutter}${theme.fg("dim", `+${remaining} more · open dashboard (t) for full top`)}`,
      safeWidth,
    ));
  }

  return lines;
}
