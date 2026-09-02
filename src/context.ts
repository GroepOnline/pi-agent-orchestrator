/**
 * context.ts — Extract parent conversation context for subagent inheritance.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Extract plain text from a message content block array.
 *
 * Filters for objects with `type: "text"` and joins their `text` fields.
 * Non-text blocks (images, tool calls, etc.) are silently skipped.
 *
 * Single-pass loop instead of `.filter().map().join("\n")` — avoids
 * 3 intermediate array allocations per call. Called once per assistant
 * message in `buildParentContext`, so for a 200-message conversation
 * that's 200 × 3 = 600 fewer intermediate arrays.
 *
 * @param content - Array of message content blocks (typically from assistant messages)
 * @returns Concatenated text of all text blocks, joined by newlines
 */
export function extractText(content: unknown[]): string {
  if (!content || content.length === 0) return "";
  const parts: string[] = [];
  for (const c of content as any[]) {
    if (c && c.type === "text") {
      parts.push(c.text ?? "");
    }
  }
  return parts.join("\n");
}

/** Maximum inherited parent-context size before the current task is appended. */
export const DEFAULT_PARENT_CONTEXT_MAX_CHARS = 64 * 1024;

const PARENT_CONTEXT_PREFIX = `# Parent Conversation Context
The following is the conversation history from the parent session that spawned you.
Use this context to understand what has been discussed and decided so far.

`;
const PARENT_CONTEXT_SUFFIX = `

---
# Your Task (below)
`;
const PARENT_CONTEXT_TRUNCATION_NOTICE =
  "[Earlier parent context omitted to fit the inheritance budget; complete entry boundaries preserved.]";

function formatParentEntry(entry: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>[number]): string | null {
  if (entry.type === "message") {
    const msg = entry.message;
    if (msg.role === "user") {
      const text = (typeof msg.content === "string"
        ? msg.content
        : extractText(msg.content)
      ).trim();
      return text ? `[User]: ${text}` : null;
    }
    if (msg.role === "assistant") {
      const text = extractText(msg.content).trim();
      return text ? `[Assistant]: ${text}` : null;
    }
    return null; // Skip toolResult messages — too verbose for inherited context.
  }
  if (entry.type === "compaction" && entry.summary) {
    return `[Summary]: ${entry.summary}`;
  }
  return null;
}

/**
 * Build a bounded text representation of the parent conversation context.
 *
 * The newest complete entries win. We never cut an entry with String.slice(),
 * so JSON, code fences, and function bodies cannot be handed to a child in a
 * syntactically half-truncated form. If the next complete entry does not fit,
 * all older context is replaced by one explicit truncation marker.
 */
export function buildParentContext(
  ctx: ExtensionContext,
  maxChars = DEFAULT_PARENT_CONTEXT_MAX_CHARS,
): string {
  const entries = ctx.sessionManager.getBranch();
  if (!entries || entries.length === 0) return "";
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";

  const fixedChars = PARENT_CONTEXT_PREFIX.length + PARENT_CONTEXT_SUFFIX.length;
  const bodyBudget = Math.floor(maxChars) - fixedChars;
  if (bodyBudget <= 0) return "";

  // Walk newest -> oldest so we can stop before allocating/serializing the
  // entire parent branch when only a bounded recent tail is useful.
  const selectedNewestFirst: string[] = [];
  let selectedChars = 0;
  let truncated = false;

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const part = formatParentEntry(entries[i]);
    if (!part) continue;
    const separatorChars = selectedNewestFirst.length > 0 ? 2 : 0;
    if (selectedChars + separatorChars + part.length > bodyBudget) {
      truncated = true;
      break;
    }
    selectedNewestFirst.push(part);
    selectedChars += separatorChars + part.length;
  }

  if (selectedNewestFirst.length === 0 && !truncated) return "";

  if (truncated) {
    const markerCost = PARENT_CONTEXT_TRUNCATION_NOTICE.length +
      (selectedNewestFirst.length > 0 ? 2 : 0);
    while (selectedNewestFirst.length > 0 && selectedChars + markerCost > bodyBudget) {
      const removed = selectedNewestFirst.pop()!;
      selectedChars -= removed.length;
      if (selectedNewestFirst.length > 0) selectedChars -= 2;
    }
    const finalMarkerCost = PARENT_CONTEXT_TRUNCATION_NOTICE.length +
      (selectedNewestFirst.length > 0 ? 2 : 0);
    if (finalMarkerCost > bodyBudget) return "";
  }

  const selected = selectedNewestFirst.reverse();
  const body = truncated
    ? [PARENT_CONTEXT_TRUNCATION_NOTICE, ...selected].join("\n\n")
    : selected.join("\n\n");

  return `${PARENT_CONTEXT_PREFIX}${body}${PARENT_CONTEXT_SUFFIX}`;
}
