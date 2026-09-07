import type { AnimationStyle } from "../agent-registry.js";
import { logger } from "../logger.js";

/** Default cadence for terminal animation frames. */
export const ANIMATION_INTERVAL = 80;

/**
 * Spinner catalogue. Dashboard-safe styles use single-cell glyphs so cards and
 * tables never jitter horizontally while frames advance.
 */
export const SPINNER_FRAMES = {
  braille: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  dots: ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"],
  dotsDouble: ["⢄", "⢂", "⢁", "⡁", "⡈", "⡐", "⢐", "⢠"],
  lines: ["-", "\\", "|", "/"],
  classic: ["*"],
  pulse: ["◦", "•", "●", "•"],
  wave: ["░", "▒", "▓", "█", "▓", "▒"],
  pipe: ["┤", "┘", "┴", "└", "├", "┌", "┬", "┐"],
  moon: ["○", "◑", "●", "◐"],
  clock: ["◴", "◷", "◶", "◵"],
  radar: ["▖", "▘", "▝", "▗"],
  glitch: ["▚", "▞", "█", "░", "▌", "▐"],
  matrix: ["⡀", "⡄", "⡆", "⡇", "⣇", "⣧", "⣷", "⣿"],
  fire: ["⡀", "⡄", "⡆", "⡇", "⢇", "⢎", "⠎", "⠘", "⠉", "⠁"],
  squareSpin: ["▖", "▘", "▝", "▗"],
  rhombus: ["◇", "◈", "◆", "◈"],
  bouncingBall: ["⎽", "⎼", "⎻", "⎺", "⎻", "⎼"],

  // Original orchestrator-focused motion language.
  orbit: ["◜", "◝", "◞", "◟"],
  aperture: ["◒", "◐", "◓", "◑"],
  signal: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█", "▇", "▆", "▅", "▄", "▃", "▂"],
  scanline: ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "█", "▉", "▊", "▋", "▌", "▍", "▎"],
  pipeline: ["┈", "┉", "┅", "━", "┅", "┉"],
  cascade: ["⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿", "⣾", "⣼", "⣸", "⣠"],
  weave: ["⠏", "⠛", "⠹", "⢸", "⣰", "⣤", "⣆", "⡇"],
  kernel: ["⊙", "⊚", "⊛", "⊚"],
  lattice: ["⌜", "⌝", "⌟", "⌞"],
  prism: ["△", "▷", "▽", "◁"],
  ripple: ["·", "∙", "•", "●", "•", "∙"],
  shuttle: ["▰", "▱", "▱", "▰", "▱", "▱"],

  // Motion system v2: compact identities for orchestration roles.
  reactor: ["⊙", "◉", "●", "◉"],
  forge: ["◇", "◈", "◆", "◈"],
  neural: ["⠁", "⠉", "⠋", "⠛", "⠟", "⠿", "⡿", "⣿", "⣾", "⣼", "⣸", "⣰", "⣠", "⣀"],
  vector: ["⇢", "⇡", "⇠", "⇣"],
  sentinel: ["◡", "⊙", "◠", "⊙"],
  comet: ["·", "∙", "•", "◉", "●", "◉", "•", "∙"],
  none: [""],
} as const;

export type SpinnerStyle = keyof typeof SPINNER_FRAMES;
export type SpinnerRole = "agent" | "header" | "queue" | "handoff" | "swarm" | "tool" | "scheduler";

/** Styles guaranteed to remain compact enough for dashboard rows and cards. */
export const DASHBOARD_SPINNER_STYLES = [
  "braille",
  "dotsDouble",
  "orbit",
  "aperture",
  "signal",
  "scanline",
  "pipeline",
  "cascade",
  "weave",
  "kernel",
  "lattice",
  "prism",
  "ripple",
  "reactor",
  "forge",
  "neural",
  "vector",
  "sentinel",
  "comet",
] as const satisfies readonly SpinnerStyle[];

export const SPINNER_PACKS = {
  orchestrator: DASHBOARD_SPINNER_STYLES,
  signals: ["signal", "scanline", "wave", "glitch", "matrix", "fire", "shuttle", "radar"] as const,
  minimal: ["dots", "pulse", "squareSpin", "rhombus", "bouncingBall", "moon"] as const,
} as const satisfies Record<"orchestrator" | "signals" | "minimal", readonly SpinnerStyle[]>;

const ROLE_STYLES = {
  orchestrator: {
    header: "reactor",
    queue: "pipeline",
    handoff: "weave",
    swarm: "aperture",
    tool: "neural",
    scheduler: "clock",
  },
  signals: {
    header: "signal",
    queue: "scanline",
    handoff: "pipeline",
    swarm: "cascade",
    tool: "matrix",
    scheduler: "radar",
  },
  minimal: {
    header: "dots",
    queue: "pulse",
    handoff: "pipe",
    swarm: "squareSpin",
    tool: "rhombus",
    scheduler: "clock",
  },
} as const satisfies Record<"orchestrator" | "signals" | "minimal", Record<Exclude<SpinnerRole, "agent">, SpinnerStyle>>;

/**
 * Known agent families receive stable visual identities in the default
 * orchestrator profile. Unknown custom agents still use deterministic hashing.
 */
const AGENT_TYPE_STYLE_RULES = [
  { keywords: ["security", "secure", "sentinel", "threat", "threats"], style: "sentinel" },
  {
    keywords: [
      "validate", "validator", "validators", "validation", "test", "tests", "testing", "tester",
      "testers", "qa", "verify", "verifier", "verification", "check", "checker", "checking",
    ],
    style: "prism",
  },
  {
    keywords: [
      "review", "reviewer", "reviewers", "reviewing", "critic", "critics", "critique", "inspect",
      "inspection", "inspector", "inspectors",
    ],
    style: "aperture",
  },
  {
    keywords: [
      "code", "coder", "coders", "coding", "implement", "implemented", "implementing", "implementer",
      "implementers", "implementation", "build", "builder", "builders",
      "building", "engineer", "engineers", "engineering",
    ],
    style: "forge",
  },
  {
    keywords: [
      "analysis", "analyst", "analysts", "analyze", "analyzing", "audit", "auditor", "auditors",
      "auditing", "diagnose", "diagnosis", "diagnostic", "diagnostics",
    ],
    style: "signal",
  },
  {
    keywords: [
      "plan", "planner", "planners", "planning", "architect", "architects", "architecture",
      "architectural", "design", "designer", "designers", "designing",
    ],
    style: "lattice",
  },
  {
    keywords: [
      "explore", "explorer", "explorers", "exploring", "research", "researcher", "researchers",
      "researching", "search", "searches", "searching", "scan", "scanner", "scanners", "scanning",
    ],
    style: "radar",
  },
  {
    keywords: [
      "compress", "compressor", "compressors", "compression", "summary", "summaries", "summarize",
      "summarizes", "summarized", "summarizing", "summarizer", "summarizers", "handoff", "handoffs",
    ],
    style: "weave",
  },
  {
    keywords: [
      "orchestrate", "orchestrating", "orchestration", "orchestrator", "orchestrators", "lead", "leader",
      "leaders", "leadership", "manager", "managers", "management", "coordinate", "coordinating",
      "coordination", "coordinator", "coordinators",
    ],
    style: "reactor",
  },
] as const satisfies readonly { keywords: readonly string[]; style: SpinnerStyle }[];

/** Map accepted alternate spellings onto canonical keyword tokens. */
function normalizeAgentTypeToken(token: string): string {
  // Keep the -or form matchable without embedding a codespell false positive in source.
  if (token === `implement${"or"}`) return "implementer";
  if (token === `implement${"ors"}`) return "implementers";
  return token;
}

function tokenizeAgentType(agentType: string): string[] {
  return agentType
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(normalizeAgentTypeToken);
}

export function getSpinnerStyleForAgentType(agentType: string): SpinnerStyle | undefined {
  const tokens = tokenizeAgentType(agentType);
  if (tokens.length === 0) return undefined;
  return AGENT_TYPE_STYLE_RULES.find((rule) =>
    rule.keywords.some((keyword) => tokens.includes(keyword))
  )?.style;
}

/** Mutable global frames retained for backwards compatibility. */
export const SPINNER: string[] = [...SPINNER_FRAMES.braille];

let activeAnimationProfile: AnimationStyle = "orchestrator";

function positiveModulo(value: number, divisor: number): number {
  if (divisor <= 0) return 0;
  return ((value % divisor) + divisor) % divisor;
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function copyFrames(style: SpinnerStyle): string[] {
  return [...SPINNER_FRAMES[style]];
}

function isPackProfile(profile: AnimationStyle): profile is keyof typeof SPINNER_PACKS {
  return profile === "orchestrator" || profile === "signals" || profile === "minimal";
}

function isDirectStyle(profile: string): profile is Extract<AnimationStyle, SpinnerStyle> {
  return profile === "braille" || profile === "dots" || profile === "lines" || profile === "classic" || profile === "none";
}

function packForProfile(profile: AnimationStyle): keyof typeof SPINNER_PACKS {
  if (isPackProfile(profile)) return profile;
  return "orchestrator";
}

function fallbackStyleForProfile(profile: AnimationStyle): SpinnerStyle {
  if (isDirectStyle(profile)) return profile;
  if (profile === "signals") return "signal";
  if (profile === "minimal") return "dots";
  return "orbit";
}

/** Apply a persisted motion profile while retaining the legacy function name. */
export function setSpinnerStyle(style: AnimationStyle | SpinnerStyle): void {
  const validProfiles: readonly string[] = [
    "orchestrator",
    "signals",
    "minimal",
    "reduced",
    "braille",
    "dots",
    "lines",
    "classic",
    "none",
  ];
  activeAnimationProfile = validProfiles.includes(style) ? (style as AnimationStyle) : "braille";
  const fallback = fallbackStyleForProfile(activeAnimationProfile);
  SPINNER.splice(0, SPINNER.length, ...copyFrames(fallback));
}

export function getAnimationProfile(): AnimationStyle {
  return activeAnimationProfile;
}

export function isReducedMotion(): boolean {
  return activeAnimationProfile === "reduced";
}

export function getSpinnerFrame(frame: number): string {
  if (SPINNER.length === 0) return "";
  const index = isReducedMotion() ? 0 : positiveModulo(frame, SPINNER.length);
  return SPINNER[index] ?? "";
}

export function getSpinnerFrameForStyle(style: SpinnerStyle, frame: number, phase = 0): string {
  const frames = SPINNER_FRAMES[style];
  return frames[positiveModulo(frame + phase, frames.length)] ?? "";
}

/**
 * Resolve a spinner style for an agent row or runtime channel.
 *
 * `agentType` only affects the default `orchestrator` pack, and only for
 * `agent` (running) and `queue` roles. Other roles always use the pack's
 * dedicated channel style so tool/swarm/header motion stays role-semantic.
 */
export function getSpinnerStyleForAgent(
  agentId: string,
  role: SpinnerRole = "agent",
  agentType?: string,
): SpinnerStyle {
  if (activeAnimationProfile === "none") return "none";

  const packName = packForProfile(activeAnimationProfile);
  const allowAgentType = role === "agent" || role === "queue";

  if (role !== "agent" && !(allowAgentType && agentType)) {
    return ROLE_STYLES[packName][role];
  }

  if (isDirectStyle(activeAnimationProfile)) {
    return role === "agent" ? activeAnimationProfile : ROLE_STYLES[packName][role];
  }

  if (allowAgentType && packName === "orchestrator" && agentType) {
    const semanticStyle = getSpinnerStyleForAgentType(agentType);
    if (semanticStyle) return semanticStyle;
  }

  if (role !== "agent") return ROLE_STYLES[packName][role];

  const pack = SPINNER_PACKS[packName];
  const index = stableHash(agentId) % pack.length;
  return pack[index] ?? "braille";
}

/** Stable style per agent plus a stable phase offset to avoid synchronized motion. */
export function getAgentSpinnerFrame(
  agentId: string,
  frame: number,
  role: SpinnerRole = "agent",
  agentType?: string,
): string {
  const style = getSpinnerStyleForAgent(agentId, role, agentType);
  if (style === "none") return "";
  const phase = stableHash(`${role}:${agentId}`) % SPINNER_FRAMES[style].length;
  const effectiveFrame = isReducedMotion() ? 0 : frame;
  return getSpinnerFrameForStyle(style, effectiveFrame, phase);
}

/** Time-driven semantic frame for renderers that do not own a frame counter. */
export function getTimeSpinnerFrameForRole(
  role: Exclude<SpinnerRole, "agent">,
  key: string,
  now = Date.now(),
  interval = ANIMATION_INTERVAL,
): string {
  const safeInterval = Math.max(1, interval);
  return getAgentSpinnerFrame(key, Math.floor(now / safeInterval), role);
}

export function getTimeSpinnerFrame(now = Date.now(), interval = ANIMATION_INTERVAL): string {
  const safeInterval = Math.max(1, interval);
  return getSpinnerFrame(Math.floor(now / safeInterval));
}

export interface SpinnerOptions {
  style?: SpinnerStyle;
  customFrames?: string[];
  interval?: number;
  prefix?: string | (() => string);
  suffix?: string | (() => string);
  colorizer?: (text: string) => string;
}

export class SpinnerEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentFrameIndex = 0;
  private isTerminated = false;

  public frames: string[];
  public interval: number;
  public prefix: string | (() => string);
  public suffix: string | (() => string);
  public colorizer?: (text: string) => string;

  constructor(options: SpinnerOptions = {}) {
    const selectedStyle = options.style ?? "braille";
    this.frames = options.customFrames?.length ? [...options.customFrames] : copyFrames(selectedStyle);
    this.interval = Math.max(1, options.interval ?? ANIMATION_INTERVAL);
    this.prefix = options.prefix ?? "";
    this.suffix = options.suffix ?? "";
    this.colorizer = options.colorizer;
  }

  public getFrame(): string {
    const rawFrame = this.frames[positiveModulo(this.currentFrameIndex, this.frames.length)] ?? "";
    return this.colorizer ? this.colorizer(rawFrame) : rawFrame;
  }

  public toString(): string {
    const prefix = typeof this.prefix === "function" ? this.prefix() : this.prefix;
    const suffix = typeof this.suffix === "function" ? this.suffix() : this.suffix;
    return `${prefix}${this.getFrame()}${suffix}`;
  }

  public start(
    terminalMode = typeof process !== "undefined" && process.stdout?.write !== undefined,
  ): this {
    if (this.timer) return this;
    this.isTerminated = false;

    if (terminalMode) process.stdout.write("\x1B[?25l");

    this.timer = setInterval(() => {
      this.currentFrameIndex++;
      if (terminalMode && !this.isTerminated) process.stdout.write(`\r${this.toString()}`);
    }, this.interval);

    return this;
  }

  public stop(
    finalMessage?: string,
    terminalMode = typeof process !== "undefined" && process.stdout?.write !== undefined,
  ): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isTerminated = true;

    if (!terminalMode) return;
    process.stdout.write("\x1B[?25h");
    process.stdout.write(finalMessage === undefined ? "\n" : `\r${finalMessage}\n`);
  }

  public update(options: SpinnerOptions): void {
    if (options.style) this.frames = copyFrames(options.style);
    if (options.customFrames?.length) this.frames = [...options.customFrames];
    if (options.interval !== undefined) this.interval = Math.max(1, options.interval);
    if (options.prefix !== undefined) this.prefix = options.prefix;
    if (options.suffix !== undefined) this.suffix = options.suffix;
    if (options.colorizer !== undefined) this.colorizer = options.colorizer;
    this.currentFrameIndex = positiveModulo(this.currentFrameIndex, this.frames.length);
  }
}

export function makeDualSpinner(style: SpinnerStyle, text: string): SpinnerOptions {
  return {
    style,
    prefix: "[ ",
    suffix: ` ] — ${text} — [ `,
    colorizer: (frame) => `${frame} ] [ ${frame}`,
  };
}

export function getAlternateFrame(
  styleA: SpinnerStyle,
  styleB: SpinnerStyle,
  durationMs = 2000,
): string {
  const now = Date.now();
  const style = Math.floor(now / Math.max(1, durationMs)) % 2 === 0 ? styleA : styleB;
  return getSpinnerFrameForStyle(style, Math.floor(now / ANIMATION_INTERVAL));
}

export function runShowcase(): void {
  logger.info("=== PI ORCHESTRATOR SPINNER SHOWCASE ===");
  const styles = Object.keys(SPINNER_FRAMES) as SpinnerStyle[];
  let styleIndex = 0;
  const engine = new SpinnerEngine({
    style: styles[styleIndex],
    prefix: "  ",
    suffix: () => `  [style: ${styles[styleIndex]}]  Ctrl+C to stop`,
  });

  engine.start();
  const rotation = setInterval(() => {
    styleIndex = (styleIndex + 1) % styles.length;
    engine.update({ style: styles[styleIndex] });
  }, 2500);

  process.once("SIGINT", () => {
    clearInterval(rotation);
    engine.stop("Spinner showcase stopped.", true);
  });
}
