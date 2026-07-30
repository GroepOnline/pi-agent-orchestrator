import type { AgentRecord } from "../../types.js";
import { getDisplayName } from "../agent-format.js";
import { getAgentSpinnerFrame } from "../animation.js";
import type { BoxChars, DashboardTheme } from "../theme.js";
import { fastTruncate, padAndTruncate } from "../theme.js";
import { visibleWidth } from "../tui-shim.js";
import { activityText, agentStats, statusColor, statusIcon } from "./helpers.js";
import { renderSectionTitle } from "./section-title.js";
import type { DashboardRenderState } from "./types.js";

export function renderSwarmSection(
  innerWidth: number,
  theme: DashboardTheme,
  box: BoxChars,
  state: DashboardRenderState,
  focus: Map<string, number>,
  baseLine = 0,
): string[] {
  let total = 0;
  const grouped = new Map<string, AgentRecord[]>();
  for (const record of state.agents) {
    if (!record.swarmId) continue;
    const members = grouped.get(record.swarmId) ?? [];
    members.push(record);
    grouped.set(record.swarmId, members);
    total++;
  }
  if (grouped.size === 0) return [];

  const firstSwarmId = grouped.keys().next().value ?? "swarm";
  const sectionGlyph = getAgentSpinnerFrame(firstSwarmId, state.frame, "swarm");
  const lines = [
    "",
    renderSectionTitle(
      `${sectionGlyph || "⌬"} SWARMS`,
      `${grouped.size} swarms · ${total} agents`,
      innerWidth,
      theme,
      box,
    ),
  ];
  const cardWidth = Math.max(28, innerWidth - 2);
  const contentWidth = Math.max(1, cardWidth - 4);

  for (const [swarmId, members] of grouped) {
    const mode = members[0]?.joinMode ?? "group";
    let running = 0;
    for (const member of members) {
      if (member.status === "running") running++;
    }
    const swarmGlyph = getAgentSpinnerFrame(swarmId, state.frame, "swarm");
    const header = ` ${swarmGlyph || "⌬"} ${swarmId} · ${mode} · ${running}/${members.length} live `;
    const dash = box.h.repeat(Math.max(2, cardWidth - visibleWidth(header) - 2));
    lines.push(` ${theme.border}${box.tl}${box.h}${theme.reset}${theme.highlight}${header}${theme.reset}${theme.border}${dash}${box.tr}${theme.reset}`);

    for (const member of members) {
      focus.set(member.id, baseLine + lines.length);
      const activity = state.agentActivity.get(member.id);
      const selected = state.agents[state.selectedIndex]?.id === member.id;
      const prefix = selected ? `${theme.highlight}▶${theme.reset}` : " ";
      const checked = state.selectedIds.has(member.id) ? `${theme.success}✓${theme.reset}` : " ";
      const icon = `${statusColor(member, theme)}${statusIcon(member, state.frame)}${theme.reset}`;
      const name = fastTruncate(getDisplayName(member.type), 16);
      const activityLabel = fastTruncate(activityText(member, activity), Math.max(8, contentWidth - 38));
      const stats = agentStats(member, activity);
      const row = `${prefix}${checked} ${icon} ${theme.title}${name}${theme.reset}  ${theme.muted}${activityLabel}${theme.reset} ${theme.dim}${stats}${theme.reset}`;
      lines.push(` ${theme.border}${box.l}${theme.reset} ${padAndTruncate(row, contentWidth)} ${theme.border}${box.r}${theme.reset}`);
    }
    lines.push(` ${theme.border}${box.bl}${box.h.repeat(Math.max(0, cardWidth - 2))}${box.br}${theme.reset}`);
  }
  return lines;
}
