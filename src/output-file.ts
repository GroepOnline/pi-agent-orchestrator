/**
 * output-file.ts — Streaming JSONL output file for agent transcripts.
 *
 * Creates a per-agent output file that streams conversation turns as JSONL,
 * matching Claude Code's task output file format.
 */

import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/**
 * Encode a cwd path as a filesystem-safe directory name. Handles:
 *   - POSIX:   "/home/user/project"        → "home-user-project"
 *   - Windows: "C:\Users\foo\project"      → "Users-foo-project"
 *   - UNC:     "\\\\server\\share\\project"  → "server-share-project"
 */
export function encodeCwd(cwd: string): string {
  return cwd
    .replace(/[/\\]/g, "-")        // both separators → dash
    .replace(/^[A-Za-z]:-/, "")    // strip Windows drive prefix ("C:-")
    .replace(/^-+/, "");           // strip leading dashes (POSIX root, UNC)
}

const MAX_OUTPUT_SEGMENT_LENGTH = 200;
/** Hex length of the collision-resistance suffix appended to lossy segments. */
const SEGMENT_HASH_LENGTH = 8;

/** Sanitize sessionId / agentId segments so they cannot escape the tasks directory.
 *
 * Sanitization is lossy: separator variants (`a/b` vs `a-b`), dropped characters,
 * and values differing only past the truncation boundary can all collapse to the
 * same string. Since these segments become session directories and agent
 * filenames, a collision would let distinct jobs write to the same location. When
 * the cleaned value no longer matches the raw input we therefore append a short
 * stable hash of the raw input, keeping distinct inputs on distinct paths while
 * leaving already-safe segments untouched and human-readable. */
export function sanitizeOutputPathSegment(name: string): string {
  if (!name) return "_";
  const cleaned = name
    .replace(/\0/g, "")
    .replace(/[\\/]/g, "-")
    .replace(/[:*?"<>|]/g, "-")
    // Drop bare "." / ".." path segments (including after separator neutralization).
    .split("-")
    .filter((part) => part !== "" && part !== "." && part !== "..")
    .join("-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Fast path: already a safe, non-truncated segment — keep it verbatim.
  if (cleaned === name && name.length <= MAX_OUTPUT_SEGMENT_LENGTH) return cleaned;
  const suffix = createHash("sha256").update(name).digest("hex").slice(0, SEGMENT_HASH_LENGTH);
  const room = MAX_OUTPUT_SEGMENT_LENGTH - SEGMENT_HASH_LENGTH - 1;
  const base = (cleaned || "_").slice(0, Math.max(1, room));
  return `${base}-${suffix}`;
}

/** Create the output file path, ensuring the directory exists.
 *  Mirrors Claude Code's layout: /tmp/{prefix}-{uid}/{encoded-cwd}/{sessionId}/tasks/{agentId}.output */
export function createOutputFilePath(cwd: string, agentId: string, sessionId: string): string {
  const encoded = encodeCwd(cwd);
  const safeSessionId = sanitizeOutputPathSegment(sessionId);
  const safeAgentId = sanitizeOutputPathSegment(agentId);
  const root = join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // chmod is a no-op on Windows and throws on some Windows filesystems.
  // On Unix we still want to enforce 0o700 past umask, so only swallow on Windows.
  try {
    chmodSync(root, 0o700);
  } catch (err) {
    if (process.platform !== "win32") throw err;
  }
  const dir = join(root, encoded, safeSessionId, "tasks");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${safeAgentId}.output`);
}

/** Write the initial user prompt entry. */
export function writeInitialEntry(path: string, agentId: string, prompt: string, cwd: string): void {
  const entry = {
    isSidechain: true,
    agentId,
    type: "user",
    message: { role: "user", content: prompt },
    timestamp: new Date().toISOString(),
    cwd,
  };
  writeFileSync(path, `${JSON.stringify(entry)}\n`, "utf-8");
}

/**
 * Subscribe to session events and flush new messages to the output file on each turn_end.
 * Returns a cleanup function that does a final flush and unsubscribes.
 */
export function streamToOutputFile(
  session: AgentSession,
  path: string,
  agentId: string,
  cwd: string,
): () => void {
  let writtenCount = 1; // initial user prompt already written

  const flush = () => {
    const messages = session.messages;
    while (writtenCount < messages.length) {
      const msg = messages[writtenCount];
      const entry = {
        isSidechain: true,
        agentId,
        type: msg.role === "assistant" ? "assistant" : msg.role === "user" ? "user" : "toolResult",
        message: msg,
        timestamp: new Date().toISOString(),
        cwd,
      };
      try {
        appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf-8");
      } catch { /* ignore write errors */ }
      writtenCount++;
    }
  };

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") flush();
  });

  return () => {
    flush();
    unsubscribe();
  };
}
