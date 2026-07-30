import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentTopEntry,
  buildColumns,
  formatCellRuntime,
  formatCellTokens,
  renderTopTable,
} from "../src/ui/agent-top-renderer.js";
import type { DashboardTheme } from "../src/ui/theme.js";
import { visibleWidth } from "../src/ui/tui-shim.js";

const FIXED_NOW = 1_700_000_000_000;

const plainTheme: DashboardTheme = {
  border: "",
  title: "",
  dim: "",
  muted: "",
  highlight: "",
  accent: "",
  success: "",
  error: "",
  reset: "",
  bgCard: "",
  bgSelected: "",
  bgHeader: "",
};

const entries: AgentTopEntry[] = [
  {
    id: "a",
    name: "Explore",
    status: "running",
    tokens: 30_400,
    turns: 18,
    toolUses: 21,
    durationMs: 281_000,
    lastSeenMs: FIXED_NOW - 25_000,
  },
  {
    id: "b",
    name: "Plan",
    status: "running",
    tokens: 20_600,
    turns: 14,
    toolUses: 23,
    durationMs: 281_000,
    lastSeenMs: FIXED_NOW - 120_000,
  },
  {
    id: "c",
    name: "Analysis",
    status: "queued",
    tokens: 12_400,
    turns: 5,
    toolUses: 17,
    durationMs: 281_000,
    lastSeenMs: FIXED_NOW - 5_000,
  },
];

describe("formatCellTokens / formatCellRuntime", () => {
  it("formats compact token cells without a unit suffix", () => {
    expect(formatCellTokens(30400)).toBe("30.4k");
    expect(formatCellTokens(999)).toBe("999");
    expect(formatCellTokens(1_500_000)).toBe("1.5M");
  });

  it("formats runtime as compact human durations", () => {
    expect(formatCellRuntime(12_300)).toBe("12.3s");
    expect(formatCellRuntime(281_000)).toBe("4m41s");
    expect(formatCellRuntime(3_661_000)).toBe("1h01m");
  });
});

describe("buildColumns measurement", () => {
  it("assigns a name width that fills the content budget exactly", () => {
    for (const width of [60, 80, 100, 140] as const) {
      const columns = buildColumns(width);
      const sep = Math.max(0, columns.length - 1) * 3;
      const total = columns.reduce((sum, col) => sum + col.width, 0) + sep;
      expect(total).toBe(width - 1); // GUTTER = 1
    }
  });
});

describe("renderTopTable layout", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps every line within width for full and widget modes", () => {
    for (const width of [60, 80, 100, 140]) {
      for (const mode of ["full", "widget"] as const) {
        const lines = renderTopTable(entries, "tokens", false, 0, 5, plainTheme, width, { mode });
        for (const line of lines) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it("aligns data columns under headers (plain theme)", () => {
    const width = 100;
    const lines = renderTopTable(entries, "tokens", false, 0, 5, plainTheme, width);
    const header = lines[2];
    const row = lines[4];
    // Same visible width for header and first data row
    expect(visibleWidth(header)).toBe(visibleWidth(row));
    expect(header.indexOf("TOKENS")).toBeGreaterThan(0);
    expect(row).toContain("30.4k");
    expect(row).toContain("4m41s");
  });

  it("widget mode omits overlay help chrome", () => {
    const lines = renderTopTable(entries, "tokens", false, 0, 5, plainTheme, 100, { mode: "widget" });
    const joined = lines.join("\n");
    expect(joined).toContain("AGENT TOP");
    expect(joined).not.toContain("Esc/q");
    expect(joined).not.toContain("return to chat");
  });
});
