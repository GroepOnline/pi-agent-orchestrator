import { matchesKey } from "./tui-shim.js";

/** Dashboard and top-view actions that can be rebound in `.pi/subagents.json`. */
export type DashboardAction =
  | "escapeKey"
  | "quitKey"
  | "moveUp"
  | "moveDown"
  | "pageUp"
  | "pageDown"
  | "home"
  | "end"
  | "pageLeft"
  | "pageRight"
  | "toggleSelect"
  | "openConversation"
  | "kill"
  | "steer"
  | "permissions"
  | "refresh"
  | "help"
  | "topView"
  | "schedules"
  | "tree"
  | "swarm"
  | "commandMode"
  | "commandSubmit"
  | "commandCancel"
  | "commandBackspace"
  | "closePerf"
  | "sortTokens"
  | "sortTurns"
  | "sortDuration"
  | "sortTools"
  | "sortName"
  | "sortLastSeen";

export type DashboardKeybindings = Record<DashboardAction, readonly string[]>;

export const DASHBOARD_ACTIONS: readonly DashboardAction[] = [
  "escapeKey",
  "quitKey",
  "moveUp",
  "moveDown",
  "pageUp",
  "pageDown",
  "home",
  "end",
  "pageLeft",
  "pageRight",
  "toggleSelect",
  "openConversation",
  "kill",
  "steer",
  "permissions",
  "refresh",
  "help",
  "topView",
  "schedules",
  "tree",
  "swarm",
  "commandMode",
  "commandSubmit",
  "commandCancel",
  "commandBackspace",
  "closePerf",
  "sortTokens",
  "sortTurns",
  "sortDuration",
  "sortTools",
  "sortName",
  "sortLastSeen",
];

/** Vim-style defaults; override per action via `dashboardKeybindings` in settings. */
export const DEFAULT_DASHBOARD_KEYBINDINGS: DashboardKeybindings = {
  escapeKey: ["escape", "esc"],
  quitKey: ["q"],
  moveUp: ["up", "k"],
  moveDown: ["down", "j"],
  pageUp: ["pageUp", "shift+up"],
  pageDown: ["pageDown", "shift+down"],
  home: ["home", "g"],
  end: ["end", "shift+g"],
  pageLeft: ["left", "shift+left"],
  pageRight: ["right", "shift+right"],
  toggleSelect: ["space"],
  // "enter" and "return" are aliases in matchesKey; both listed so help/overrides stay clear.
  openConversation: ["enter", "return"],
  kill: ["shift+k", "K"],
  steer: ["s", "shift+s"],
  permissions: ["p", "shift+p"],
  refresh: ["r", "shift+r"],
  help: ["?"],
  topView: ["t"],
  schedules: ["z", "shift+z"],
  tree: ["y"],
  swarm: ["w", "shift+w"],
  commandMode: ["/"],
  commandSubmit: ["enter", "return"],
  commandCancel: ["escape", "esc"],
  commandBackspace: ["backspace"],
  closePerf: ["q", "escape", "esc"],
  sortTokens: ["t"],
  sortTurns: ["r"],
  sortDuration: ["d"],
  sortTools: ["u"],
  sortName: ["n"],
  sortLastSeen: ["l"],
};

export type DashboardKeybindingsOverride = Partial<Record<DashboardAction, readonly string[]>>;

export function sanitizeDashboardKeybindings(raw: unknown): DashboardKeybindingsOverride | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const override: DashboardKeybindingsOverride = {};
  for (const action of DASHBOARD_ACTIONS) {
    const value = source[action];
    if (!Array.isArray(value)) continue;
    const keys = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
    if (keys.length > 0) override[action] = keys;
  }
  return Object.keys(override).length > 0 ? override : undefined;
}

export function resolveDashboardKeybindings(
  override?: DashboardKeybindingsOverride,
): DashboardKeybindings {
  const resolved = { ...DEFAULT_DASHBOARD_KEYBINDINGS };
  if (!override) return resolved;
  for (const action of DASHBOARD_ACTIONS) {
    const keys = override[action];
    if (keys && keys.length > 0) {
      resolved[action] = [...keys];
    }
  }
  return resolved;
}

export function matchDashboardKey(
  data: string,
  action: DashboardAction,
  bindings: DashboardKeybindings = DEFAULT_DASHBOARD_KEYBINDINGS,
): boolean {
  const keys = bindings[action];
  for (let i = 0; i < keys.length; i++) {
    if (matchesKey(data, keys[i])) return true;
  }
  return false;
}

export function isDashboardNavigationKey(
  data: string,
  bindings: DashboardKeybindings = DEFAULT_DASHBOARD_KEYBINDINGS,
): boolean {
  return (
    matchDashboardKey(data, "moveUp", bindings) ||
    matchDashboardKey(data, "moveDown", bindings) ||
    matchDashboardKey(data, "pageUp", bindings) ||
    matchDashboardKey(data, "pageDown", bindings) ||
    matchDashboardKey(data, "pageLeft", bindings) ||
    matchDashboardKey(data, "pageRight", bindings) ||
    matchDashboardKey(data, "home", bindings) ||
    matchDashboardKey(data, "end", bindings)
  );
}

/** First configured key for help text (e.g. footer hints). */
export function primaryDashboardKey(
  action: DashboardAction,
  bindings: DashboardKeybindings = DEFAULT_DASHBOARD_KEYBINDINGS,
): string {
  return bindings[action][0] ?? "";
}
