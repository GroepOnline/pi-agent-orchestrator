/**
 * Local shapes mirroring the host's terminal-UI contracts.
 *
 * This extension does not import the upstream terminal-UI library directly;
 * it declares structurally compatible local declarations for the subset of
 * the framework that its UI components consume: `Component` (interface),
 * `TUI` (interface), `Text` (class), and the text helpers `visibleWidth`,
 * `truncateToWidth`, `wrapTextWithAnsi`, plus `matchesKey` (implemented in
 * `./keys.ts` against raw terminal bytes — the host does not pre-normalise).
 *
 * The host continues to supply a runtime that uses the upstream package
 * internally. We deliberately do not reach into it — we only declare the
 * shapes our renderers (`AgentDashboard`, `ConversationViewer`, etc.) need,
 * and rely on TypeScript's structural compatibility so that the host's
 * factory callbacks accept our returned `Component` objects. Any extra
 * surface the host's runtime exposes (parent class features, overlay
 * hooks, etc.) is invisible from this module, which is the desired
 * narrow contract.
 *
 * Why this exists at all:
 *   - Keeps the extension free of any runtime dependency on a third-party
 *     git-hosted package whose version drift has historically broken CI.
 *   - Sidesteps recurring type breakage when transitive copies of the
 *     upstream package sit at different versions across the host's
 *     dependency tree.
 *   - Aligns with AGENTS.md rule #4: no direct imports of `@earendil-works/pi-*`
 *     packages — only this local contract.
 *
 * If the host ever introduces a related symbol we need to consume, add it
 * here as a new local declaration, not as an import.
 */

import { matchesKey } from "./keys.js";

export {
  decodePrintableKey,
  matchesKey,
  parseKey,
  setKittyProtocolActive,
} from "./keys.js";

// ────────────────────────────────────────────────────────────────────────────
// Layout constants — visible-cell width semantics (ANSI-agnostic).
// ────────────────────────────────────────────────────────────────────────────

/** Match one ANSI escape sequence. SGR only (CSI ... m). Conservative — covers what the UI emits. */
const _ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;



// ────────────────────────────────────────────────────────────────────────────
// TUI — minimal interface for the host's TUI runtime object.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The host passes an object of this shape (and possibly more) as the
 * `tui` argument to our factory callbacks (e.g. `ctx.ui.custom(factory)`).
 *
 * We never construct one ourselves — we just declare what we read.
 */
export interface TUI {
  /** Trigger a re-render of the current frame. The host always provides this. */
  requestRender(): void;
  /** Terminal size, in cells. */
  terminal: {
    rows: number;
    columns: number;
  };
  // Other fields (overlay pass-through, event loop hooks, etc.) may exist on
  // the host's real object — we just don't see them via this interface, which
  // is fine.
}

// ────────────────────────────────────────────────────────────────────────────
// Component — minimal interface implemented by our renderers.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Any object we return from a `ctx.ui.custom(factory)` callback conforms to
 * this. The host's runtime calls `render(width)` synchronously to draw the
 * current frame, may call `handleInput(data)` for key events, and may call
 * `invalidate()` when the theme changes or a fresh render is needed (cached
 * renderers should drop their cache here).
 *
 * Mirrors the host's `Component` exactly, no more — TypeScript's structural
 * typing needs every REQUIRED member present on implementers in order for
 * `new Text(...)` / our agent-dashboard classes to be assignable to the
 * host's `Component` type at the boundary (e.g. `defineTool({ renderCall })`,
 * `registerMessageRenderer`). If you add an optional member here, you must
 * also have a no-op default on every class implementing this contract.
 */
export interface Component {
  /** Render the current frame as an array of pre-wrapped lines. One line per array element. */
  render(width: number): string[];
  /** Optional key-event handler. */
  handleInput?(data: string): void;
  /** Optional: tell the framework whether this component owns key-release events (Kitty protocol). */
  wantsKeyRelease?: boolean;
  /** Required: invalidate any cached rendering state. Called when theme changes or the framework needs a fresh render. */
  invalidate(): void;
}

// ────────────────────────────────────────────────────────────────────────────
// Text — tiny line buffer the framework treats as a Component-ish value.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Local `Text` shape — the contract the host expects for tools'
 * `renderCall` / `renderResult` returns, where the object is rendered as a
 * single multi-line block.
 *
 * Constructor accepts 1 or 3 args: `new Text(content)` or
 * `new Text(content, x, y)`. The x/y coordinates are accepted so existing
 * call sites compile unchanged but are otherwise unused.
 */
export class Text implements Component {
  readonly content: string;
  readonly x: number;
  readonly y: number;

  constructor(content: string, x: number = 0, y: number = 0) {
    this.content = content;
    this.x = x;
    this.y = y;
  }

  /** Render: split content on `\n` (collapsed with `fastTruncate` so we never
   *  emit lines wider than `width`). */
  render(width: number): string[] {
    if (width <= 0) return [];
    const lines = this.content.split("\n");
    const out: string[] = [];
    for (const line of lines) {
      out.push(visibleWidth(line) > width ? truncateToWidth(line, width) : line);
    }
    return out;
  }

  /** Invalidate: `Text` doesn't cache, so this is a no-op. */
  invalidate(): void {
    // no-op: render() walks content fresh each time
  }
}

// ────────────────────────────────────────────────────────────────────────────
// visibleWidth — string width in terminal cells, ignoring ANSI codes.
//
// Light implementation: strips SGR escapes, then returns the resulting
// character count. We don't model wide (CJK / emoji) characters — the
// codebase doesn't render them anywhere, and over-counting here is benign
// (we end up with MORE whitespace, never less).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Helper to compute length of an ANSI CSI escape sequence at index i.
 * Valid sequences end with a letter (0x40-0x5A or 0x61-0x7A).
 * Returns the length of the sequence if valid, 0 otherwise.
 */
export function getAnsiSequenceLength(str: string, i: number): number {
  if (str.charCodeAt(i) === 0x1b && str.charCodeAt(i + 1) === 0x5b) {
    let j = i + 2;
    while (j < str.length) {
      const code = str.charCodeAt(j);
      // Valid intermediate chars: 0-9, ;
      if ((code >= 0x30 && code <= 0x39) || code === 0x3b) {
        j++;
      } else if ((code >= 0x40 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
        return j - i + 1; // Found valid terminator
      } else {
        return 0; // Malformed sequence
      }
    }
  }
  return 0;
}

export function visibleWidth(str: string): number {
  let len = 0;
  let i = 0;
  while (i < str.length) {
    const ansiLen = getAnsiSequenceLength(str, i);
    if (ansiLen > 0) {
      i += ansiLen;
      continue;
    }
    len++;
    i++;
  }
  return len;
}

// ────────────────────────────────────────────────────────────────────────────
// truncateToWidth — cut a string to <= maxWidth visible cells.
//
// Preserves ANSI codes on the truncated slice by keeping them intact up to
// the cut point. Adds `…` (or custom ellipsis) when truncation actually
// happened, unless `pad` is requested.
// ────────────────────────────────────────────────────────────────────────────

const DEFAULT_ELLIPSIS = "…";

/**
 * Extract the longest prefix of `text` whose visible width is exactly
 * `maxWidth` (or shorter if `text` doesn't fill that width), preserving
 * ANSI escapes verbatim. No ellipsis, no ANSI reset appended —
 * `takeVisible` is meant to be paired with `truncateToWidth` for slicing
 * arithmetic (consume-the-prefix loops), not for display.
 */
function takeVisible(text: string, maxWidth: number): string {
  if (maxWidth <= 0 || text.length === 0) return "";
  let out = "";
  let visLen = 0;
  let i = 0;
  while (i < text.length && visLen < maxWidth) {
    const ansiLen = getAnsiSequenceLength(text, i);
    if (ansiLen > 0) {
      out += text.slice(i, i + ansiLen);
      i += ansiLen;
      continue;
    }
    out += text[i];
    visLen++;
    i++;
  }
  return out;
}

export function truncateToWidth(
  text: string,
  maxWidth: number,
  ellipsis: string = DEFAULT_ELLIPSIS,
  pad: boolean = false,
): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) {
    return pad ? text + " ".repeat(maxWidth - visibleWidth(text)) : text;
  }

  // Slice character-by-character while tallying visible width, skipping
  // ANSI escape sequences (they have visible width 0). Ellipsis-width is
  // reserved up-front unless we're padding with spaces.
  const budget = pad ? maxWidth : Math.max(0, maxWidth - visibleWidth(ellipsis));
  const prefix = takeVisible(text, budget);
  let out = prefix;

  // Append ellipsis (unless padding) and ALWAYS close any ANSI state we left
  // open — otherwise the next terminal line inherits the truncated color and
  // the wrapped output looks wrong.
  if (!pad) out += ellipsis;
  out += "\u001b[0m";

  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// wrapTextWithAnsi — wrap text to fit `width`, preserving ANSI codes.
//
// Word-wrap when possible; fall back to hard-wrapping at character boundaries
// when a single token exceeds `width`. We don't try to model wide chars —
// same caveat as `visibleWidth`.
// ────────────────────────────────────────────────────────────────────────────

export function wrapTextWithAnsi(text: string, width: number): string[] {
  if (width <= 0) return [];
  const inputLines = text.split("\n");
  const wrapped: string[] = [];

  for (const line of inputLines) {
    if (visibleWidth(line) <= width) {
      wrapped.push(line);
      continue;
    }

    // Split on whitespace, keep spaces attached to preceding token.
    const tokens: string[] = [];
    let buf = "";
    for (const ch of line) {
      if (ch === " ") {
        buf += ch;
        tokens.push(buf);
        buf = "";
      } else {
        buf += ch;
      }
    }
    if (buf) tokens.push(buf);

    let current = "";
    for (const tok of tokens) {
      const projected = visibleWidth(current + tok);
      if (projected <= width) {
        current += tok;
        continue;
      }
      // Flush whatever we accumulated so far.
      if (current.length > 0) {
        wrapped.push(current.trimEnd());
        current = "";
      }
      if (visibleWidth(tok) > width) {
        // Token alone doesn't fit — hard-wrap by repeatedly truncating
        // the longest prefix that fits. Use `takeVisible` for the slice
        // arithmetic (it returns the prefix without ellipsis/ANSI reset,
        // so the resulting `length` correctly indexes the original `rest`),
        // and `truncateToWidth` for the displayed line.
        let rest = tok;
        while (visibleWidth(rest) > width) {
          const prefix = takeVisible(rest, width);
          wrapped.push(truncateToWidth(rest, width));
          rest = rest.slice(prefix.length);
        }
        // Whatever's left at the end (still > width would loop again, but
        // takeVisible already returned a string of visible width <= width
        // so the remainder might be empty). Drop dangling whitespace.
        const trimmed = rest.replace(/^\s+/, "");
        if (trimmed.length > 0) current = trimmed;
      } else {
        current = tok;
      }
    }
    if (current) wrapped.push(current.trimEnd());
  }

  return wrapped;
}

// ────────────────────────────────────────────────────────────────────────────
// matchesKey — re-exported from ./keys.ts (see import block at top).
//
// IMPORTANT: the host does NOT normalise key events before calling
// `handleInput(data)`. Arrow keys arrive as ANSI (`\x1b[A`), Space as `" "`,
// Enter as `"\r"`, and Kitty terminals may send CSI-u for printable keys.
// The matcher in `./keys.ts` mirrors host `@earendil-works/pi-tui` so these
// raw sequences match keyIds like "up", "space", and "enter".
// ────────────────────────────────────────────────────────────────────────────

/** True when `data` matches any key id in `keyIds`. */
export function matchesAnyKey(data: string, keyIds: readonly string[]): boolean {
  for (let i = 0; i < keyIds.length; i++) {
    if (matchesKey(data, keyIds[i])) return true;
  }
  return false;
}
