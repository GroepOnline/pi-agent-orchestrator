import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { isAbortError, waitForPromiseOrAbort } from "../abort-wait.js";
import { getAgentConversation } from "../agent-runner.js";
import { formatLifetimeTokens, textResult } from "../tool-result-helpers.js";
import type { AgentRecord } from "../types.js";
import { formatDuration, getDisplayName } from "../ui/agent-format.js";
import { getSessionContextPercent } from "../usage.js";
import type { ToolContext } from "./context.js";

interface ResultWaitState {
  activeWaiters: number;
  initialResultConsumed: boolean;
  /** At least one waiter observed the agent promise settle rather than being cancelled. */
  promiseSettled: boolean;
}

/**
 * Shared per-record state is required because multiple parent tool calls may wait
 * on the same background agent concurrently. A WeakMap avoids adding transient
 * synchronization fields to the persisted AgentRecord shape.
 */
const resultWaitStates = new WeakMap<AgentRecord, ResultWaitState>();

function isTerminal(record: AgentRecord): boolean {
  return record.status !== "running" && record.status !== "queued";
}

function canWaitForRecord(record: AgentRecord): boolean {
  return Boolean(record.promise) && (record.status === "running" || record.status === "queued");
}

async function waitForAgentResult(record: AgentRecord, signal: AbortSignal | undefined, ctx: ToolContext): Promise<void> {
  let state = resultWaitStates.get(record);
  if (!state) {
    state = {
      activeWaiters: 0,
      initialResultConsumed: record.resultConsumed === true,
      promiseSettled: false,
    };
    resultWaitStates.set(record, state);
  }

  state.activeWaiters++;

  // Completion runs in the manager promise chain before this await resumes. Keep
  // notifications suppressed while any waiter intends to consume the result.
  record.resultConsumed = true;
  ctx.cancelNudge(record.id);

  try {
    await waitForPromiseOrAbort(record.promise!, signal, "get_subagent_result wait aborted");
    state.promiseSettled = true;
  } catch (error) {
    const cancelledWait = signal?.aborted === true && isAbortError(error);
    if (!cancelledWait) {
      // A rejected agent promise was still observed by this waiter. Treat it as
      // consumed rather than generating a second completion/error notification.
      state.promiseSettled = true;
    }
    throw error;
  } finally {
    state.activeWaiters--;

    if (state.activeWaiters === 0) {
      resultWaitStates.delete(record);

      if (state.promiseSettled) {
        // One or more callers received the terminal promise outcome.
        record.resultConsumed = true;
      } else {
        // Every waiter was cancelled. Restore the state that existed before the
        // first waiter arrived so the eventual background result remains visible.
        record.resultConsumed = state.initialResultConsumed;

        // The record can become terminal while all waiters are cancelling. Its
        // onComplete callback then saw resultConsumed=true and skipped the nudge;
        // recover exactly once when the final waiter exits.
        if (!state.initialResultConsumed && isTerminal(record)) {
          ctx.sendIndividualNudge(record);
        }
      }
    }
  }
}

export function createGetResultTool(ctx: ToolContext) {
  return defineTool({
    name: "get_subagent_result",
    label: "Get Agent Result",
    description:
      "Check status and retrieve results from a background agent. Use the agent ID returned by Agent with run_in_background.",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to check.",
      }),
      wait: Type.Optional(
        Type.Boolean({
          description: "If true, wait for the agent to complete before returning. Press Esc to cancel only this wait. Default: false.",
        }),
      ),
      verbose: Type.Optional(
        Type.Boolean({
          description: "If true, include the agent's full conversation (messages + tool calls). Default: false.",
        }),
      ),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      const record = ctx.manager.getRecord(params.agent_id);
      if (!record) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }

      if (params.wait && canWaitForRecord(record)) {
        await waitForAgentResult(record, signal, ctx);
      }

      const displayName = getDisplayName(record.type);
      const duration = formatDuration(record.startedAt ?? 0, record.completedAt);
      const tokens = formatLifetimeTokens(record);
      const contextPercent = getSessionContextPercent(record.session);
      const statsParts = [`Tool uses: ${record.toolUses}`];
      if (tokens) statsParts.push(tokens);
      if (contextPercent !== null) statsParts.push(`Context: ${Math.round(contextPercent)}%`);
      if (record.compactionCount) statsParts.push(`Compactions: ${record.compactionCount}`);
      statsParts.push(`Duration: ${duration}`);

      let output =
        `Agent: ${record.id}\n` +
        `Type: ${displayName} | Status: ${record.status} | ${statsParts.join(" | ")}\n` +
        `Description: ${record.description}\n\n`;

      if (record.status === "running" || record.status === "queued") {
        output +=
          record.status === "queued"
            ? "Agent is queued. Use wait: true (Esc cancels only the wait) or check back later."
            : "Agent is still running. Use wait: true (Esc cancels only the wait) or check back later.";
      } else if (record.status === "error") {
        output += `Error: ${record.error}`;
      } else if (!output.trim()) {
        output += `No output.\n\nThis agent finished without producing text. If this was a route-discovery task, prefer direct shell/docs lookup.`;
      } else {
        output += record.result?.trim() || "No output.";
      }

      // Mark result as consumed — suppresses the completion notification.
      if (isTerminal(record)) {
        record.resultConsumed = true;
        ctx.cancelNudge(params.agent_id);
      }

      // Verbose: include full conversation.
      if (params.verbose && record.session) {
        const conversation = getAgentConversation(record.session);
        if (conversation) {
          output += `\n\n--- Agent Conversation ---\n${conversation}`;
        }
      }

      return textResult(output);
    },
  });
}
