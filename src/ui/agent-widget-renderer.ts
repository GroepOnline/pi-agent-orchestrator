import {
  getUiStyle,
  isShowActivityStream,
  isShowTokenUsage,
  isShowTurnProgress,
} from "../agent-registry.js";
import type { AgentRecord } from "../types.js";
import { getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import {
  describeActivity,
  formatMs,
  formatSessionTokens,
  formatTurns,
  getDisplayName,
  getPromptModeLabel,
} from "./agent-format.js";
import type { AgentActivity } from "./agent-ui-types.js";
import { getAgentSpinnerFrame } from "./animation.js";
import { activeTheme, fastTruncate, type Theme } from "./theme.js";

const MAX_WIDGET_LINES = 12;
const BATCH_COMPACT_THRESHOLD = 3;

export const ERROR_STATUSES = new Set(["error", "aborted", "steered", "stopped"]);

type WidgetTuiLike = {
  terminal: { columns: number };
};

type RenderAgentWidgetOptions = {
  agents: AgentRecord[];
  agentActivity: Map<string, AgentActivity>;
  frame: number;
  shouldShowFinished(agentId: string, status: string): boolean;
  theme: Theme;
  tui: WidgetTuiLike;
  pageIndex?: number;
  pageCount?: number;
};

function formatBurnRate(tokens: number, elapsedMs: number, theme: Theme): string {
  const seconds = elapsedMs / 1000;
  if (seconds < 1) return "";
  const rate = tokens / seconds;
  if (rate >= 1_000_000) return theme.fg("error", `${(rate / 1_000_000).toFixed(1)}M/s`);
  if (rate >= 1_000) return theme.fg("warning", `${(rate / 1_000).toFixed(1)}K/s`);
  return theme.fg("dim", `${rate.toFixed(0)}/s`);
}

function formatLastSeen(lastSeenMs: number | undefined, theme: Theme): string {
  if (lastSeenMs === undefined) return "";
  const seconds = Math.floor((Date.now() - lastSeenMs) / 1000);
  if (seconds < 5) return theme.fg("success", "now");
  if (seconds < 60) return theme.fg("muted", `${seconds}s`);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return theme.fg("muted", `${minutes}m`);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return theme.fg("dim", `${hours}h`);
  return theme.fg("dim", `${Math.floor(hours / 24)}d`);
}

function renderActivityHeatmap(
  agentActivity: Map<string, AgentActivity>,
  theme: Theme,
  availableWidth: number,
): string | undefined {
  if (agentActivity.size === 0) return undefined;

  const now = Date.now();
  const windowMs = 5 * 60_000;
  const segmentMs = 30_000;
  const segmentCount = 10;
  const buckets = new Array<number>(segmentCount).fill(0);
  let activeCount = 0;

  for (const activity of agentActivity.values()) {
    if (!activity.lastSeenMs) continue;
    const age = now - activity.lastSeenMs;
    if (age > windowMs) continue;
    activeCount++;
    const index = Math.min(segmentCount - 1, Math.floor((windowMs - age) / segmentMs));
    buckets[index]++;
  }
  if (activeCount === 0) return undefined;

  const maxBucket = Math.max(1, ...buckets);
  const blocks = ["░", "▒", "▓", "█"];
  const heatBar = buckets.map((count) => {
    if (count === 0) return blocks[0];
    if (count < maxBucket * 0.33) return blocks[1];
    if (count < maxBucket * 0.66) return blocks[2];
    return blocks[3];
  }).join("");

  const liveGlyph = getAgentSpinnerFrame("widget-heat", Math.floor(now / 120), "header");
  return fastTruncate(
    `${theme.fg("dim", "heat:")} ${heatBar}  ${theme.fg("accent", `${liveGlyph} ${activeCount} active`)}`,
    availableWidth,
  );
}

function renderFinishedLine(agent: AgentRecord, activity: AgentActivity | undefined, theme: Theme): string {
  const name = getDisplayName(agent.type);
  const modeLabel = getPromptModeLabel(agent.type);
  const duration = formatMs((agent.completedAt ?? Date.now()) - (agent.startedAt ?? 0));
  const uiStyle = getUiStyle();

  let icon: string;
  let statusText: string;
  if (agent.status === "completed") {
    icon = theme.fg("success", "✓");
    statusText = "";
  } else if (agent.status === "steered") {
    icon = theme.fg("warning", "✓");
    statusText = theme.fg("warning", " (turn limit)");
  } else if (agent.status === "stopped") {
    icon = theme.fg("dim", "■");
    statusText = theme.fg("dim", " stopped");
  } else if (agent.status === "error") {
    icon = theme.fg("error", "✗");
    statusText = theme.fg("error", ` error${agent.error ? `: ${agent.error.slice(0, 60)}` : ""}`);
  } else {
    icon = theme.fg("error", "✗");
    statusText = theme.fg("warning", " aborted");
  }

  const stats: string[] = [];
  if (activity && isShowTurnProgress()) stats.push(formatTurns(activity.turnCount, activity.maxTurns));
  if (agent.toolUses > 0) stats.push(`${agent.toolUses} tool use${agent.toolUses === 1 ? "" : "s"}`);
  stats.push(duration);

  const modeTag = modeLabel ? ` ${theme.fg("dim", `(${modeLabel})`)}` : "";
  const validationIcon = agent.validationResults
    ? agent.validated
      ? ` ${theme.fg("success", uiStyle === "plain" ? "✓" : "✅")}`
      : ` ${theme.fg("error", uiStyle === "plain" ? "✗" : "❌")}`
    : "";

  return `${icon} ${theme.fg("dim", name)}${validationIcon}${modeTag}  ${theme.fg("dim", agent.description)} ${theme.fg("dim", "·")} ${theme.fg("dim", stats.join(" · "))}${statusText}`;
}

export function renderAgentWidget(options: RenderAgentWidgetOptions): string[] {
  const running: AgentRecord[] = [];
  const queued: AgentRecord[] = [];
  const finished: AgentRecord[] = [];
  for (const agent of options.agents) {
    if (agent.status === "running") running.push(agent);
    else if (agent.status === "queued") queued.push(agent);
    else if (agent.completedAt && options.shouldShowFinished(agent.id, agent.status)) finished.push(agent);
  }

  const hasActive = running.length > 0 || queued.length > 0;
  if (!hasActive && finished.length === 0) return [];

  const uiStyle = getUiStyle();
  const theme = activeTheme(options.theme);
  let tree = "├──";
  let angle = "╰──";
  let bar = "│  ";
  let indent = "  ⎿  ";
  if (uiStyle === "retro") {
    tree = "|--";
    angle = "`--";
    bar = "|  ";
    indent = "  `--";
  } else if (uiStyle === "plain") {
    tree = "- ";
    angle = "- ";
    bar = "  ";
    indent = "  - ";
  }

  const width = Math.max(20, options.tui.terminal.columns);
  const truncate = (line: string): string => fastTruncate(line, width);

  const queuedByType = new Map<string, { name: string; count: number; firstId: string }>();
  for (const agent of queued) {
    const group = queuedByType.get(agent.type);
    if (group) group.count++;
    else queuedByType.set(agent.type, { name: getDisplayName(agent.type), count: 1, firstId: agent.id });
  }

  const queuedLines: string[] = [];
  for (const [type, group] of queuedByType) {
    if (group.count < BATCH_COMPACT_THRESHOLD) continue;
    const glyph = getAgentSpinnerFrame(`queue:${type}`, options.frame, "queue");
    queuedLines.push(truncate(
      `${theme.fg("dim", tree)} ${theme.fg("muted", glyph || "·")} ${theme.fg("accent", `${group.count}× ${group.name}`)} ${theme.fg("dim", "queued")}`,
    ));
  }
  for (const agent of queued) {
    const group = queuedByType.get(agent.type);
    if (!group || group.count >= BATCH_COMPACT_THRESHOLD) continue;
    const glyph = getAgentSpinnerFrame(agent.id, options.frame, "queue");
    queuedLines.push(truncate(
      `${theme.fg("dim", tree)} ${theme.fg("muted", glyph || "·")} ${theme.fg("dim", group.name)}  ${theme.fg("muted", agent.description)}`,
    ));
  }
  if (queuedLines.length > 50) queuedLines.length = 50;

  const runningLines: string[][] = [];
  for (const agent of running) {
    if (runningLines.length >= 50) break;
    const name = getDisplayName(agent.type);
    const modeLabel = getPromptModeLabel(agent.type);
    const modeTag = modeLabel ? ` ${theme.fg("dim", `(${modeLabel})`)}` : "";
    const elapsedMs = Date.now() - (agent.startedAt ?? 0);
    const elapsed = formatMs(elapsedMs);
    const activity = options.agentActivity.get(agent.id);
    const toolUses = activity?.toolUses ?? agent.toolUses;
    const tokens = getLifetimeTotal(activity?.lifetimeUsage);
    const contextPercent = getSessionContextPercent(activity?.session);

    const stats: string[] = [];
    if (activity && isShowTurnProgress()) stats.push(formatTurns(activity.turnCount, activity.maxTurns));
    if (toolUses > 0) stats.push(`${toolUses} tool`);
    if (isShowTokenUsage() && tokens > 0) {
      stats.push(formatSessionTokens(tokens, contextPercent, theme, agent.compactionCount));
      const burnRate = formatBurnRate(tokens, elapsedMs, theme);
      if (burnRate) stats.push(burnRate);
    }
    const lastSeen = formatLastSeen(activity?.lastSeenMs, theme);
    if (lastSeen) stats.push(lastSeen);
    stats.push(elapsed);

    const thinkingLabel = agent.invocation?.thinking
      ? ` ${theme.fg("dim", `🧠${agent.invocation.thinking}`)}`
      : "";
    const agentGlyph = getAgentSpinnerFrame(agent.id, options.frame, "agent", agent.type);
    const toolGlyph = getAgentSpinnerFrame(agent.id, options.frame, "tool");
    const activityText = activity ? describeActivity(activity.activeTools, activity.responseText) : "thinking…";

    const pair = [
      truncate(`${theme.fg("dim", tree)} ${theme.fg("accent", agentGlyph)} ${theme.bold(name)}${modeTag}${thinkingLabel}  ${theme.fg("muted", agent.description)} ${theme.fg("dim", "·")} ${theme.fg("dim", stats.join(" · "))}`),
    ];
    if (isShowActivityStream()) {
      pair.push(truncate(`${theme.fg("dim", bar)}${theme.fg("dim", `${indent}${toolGlyph ? `${toolGlyph} ` : ""}${activityText}`)}`));
    }
    runningLines.push(pair);
  }

  // Cap finished lines to the viewport budget remaining after the *rendered*
  // active and queued lines. Each running agent emits one line, or a two-line
  // pair when the activity stream is enabled, so counting only `running.length`
  // under-reserved the viewport: six running agents reserved six lines but
  // rendered twelve, pushing active rows into "+N more" while finished rows
  // stayed fully visible. Allow zero finished lines when active content
  // consumes the viewport; body render order is unchanged.
  const activeLineCount = runningLines.reduce((sum, pair) => sum + pair.length, 0);
  const maxFinishedVisible = Math.max(0, MAX_WIDGET_LINES - 1 - activeLineCount - queuedLines.length);
  const finishedLines: string[] = [];
  for (const agent of finished) {
    if (finishedLines.length >= maxFinishedVisible) break;
    finishedLines.push(
      truncate(`${theme.fg("dim", tree)} ${renderFinishedLine(agent, options.agentActivity.get(agent.id), theme)}`),
    );
  }

  const pageIndex = options.pageIndex ?? 0;
  const pageCount = options.pageCount ?? 1;
  const heatLine = hasActive ? renderActivityHeatmap(options.agentActivity, theme, width) : undefined;
  const headingGlyph = hasActive
    ? getAgentSpinnerFrame("widget-header", options.frame, "header")
    : uiStyle === "plain" ? "*" : "○";
  const headingColor = hasActive ? "accent" : "dim";

  const lines: string[] = [];
  if (heatLine) lines.push(heatLine);
  else lines.push(truncate(
    `${theme.fg(headingColor, headingGlyph)} ${theme.fg(headingColor, "Agents")}${pageCount > 1 ? `  ${theme.fg("dim", `[${pageIndex + 1}/${pageCount}]`)}` : ""}`,
  ));

  const maxBody = MAX_WIDGET_LINES - 1;
  const body: string[] = [];
  for (const line of finishedLines) body.push(line);
  for (const pair of runningLines) body.push(...pair);
  body.push(...queuedLines);

  if (body.length <= maxBody) {
    lines.push(...body);
  } else {
    lines.push(...body.slice(0, Math.max(0, maxBody - 1)));
    lines.push(truncate(`${theme.fg("dim", angle)} ${theme.fg("dim", `+${body.length - (maxBody - 1)} more`)}`));
  }

  if (lines.length > 1) {
    const last = lines.length - 1;
    const index = lines[last].indexOf(tree);
    if (index >= 0) lines[last] = `${lines[last].slice(0, index)}${angle}${lines[last].slice(index + tree.length)}`;
  }

  if (pageCount > 1 && lines.length < MAX_WIDGET_LINES) {
    const hint = pageIndex > 0 && pageIndex < pageCount - 1
      ? "↑↓ scroll for more"
      : pageIndex > 0
        ? "↑ scroll up"
        : "↓ scroll down";
    lines.push(truncate(`${theme.fg("dim", angle)} ${theme.fg("dim", hint)}`));
  }

  return lines;
}
