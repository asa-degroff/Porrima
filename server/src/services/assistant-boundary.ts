import type { ChatMessage, ChatToolCall, ChatToolResult } from "../types.js";
import { carryRowIdentity } from "./chat-storage.js";
import { orderToolResultsByToolCalls } from "./tool-result-ordering.js";

/**
 * Placement rules for assistant rows committed mid-turn. Extracted from the
 * HTTP route's `upsertAssistantMessage` so the rules are unit-testable and
 * shared; the route remains the only caller in Phase 1 of this extraction.
 *
 * Invariants (docs/chat-message-architecture.md; issue #10):
 *
 * 1. An `_inProgress` row is the scratch slot for the loop's current assistant
 *    message — an update replaces it in place, carrying durable identity.
 *
 * 2. A committed tool-loop FRAGMENT may be re-committed later by the same
 *    tool-call set when a mid-loop steering/follow-up drain resets the
 *    accumulator (new `_toolLoopId`, call wiped, orphaned result). Appending
 *    that re-commit lands AFTER any injected rows persisted between the two
 *    versions, so the replayed message order can no longer match the order the
 *    provider actually put on the wire (recorded wire bodies show the call and
 *    its results adjacent, with `[System context …]` injections after them).
 *    Replacing the fragment in place — at its original position, unioning the
 *    tool results — restores wire-faithful ordering at the source and stops
 *    the per-turn KV prefix from busting at the first mid-loop injection.
 *
 *    The replacement fires only on an EXACT toolCall-id set match between the
 *    re-commit and a committed `_toolLoopFragment` row. Partial overlap keeps
 *    the append path (the replay-side call-id dedup in agent.js remains the
 *    safety net for those).
 *
 * 3. Anything else appends: a new iteration boundary.
 */
export function upsertAssistantRow(messages: ChatMessage[], row: ChatMessage): ChatMessage {
  // Pass 1: refresh the in-flight row (pre-existing behavior).
  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = messages[i];
    if (
      candidate.role === "assistant" &&
      candidate._inProgress &&
      (!row._toolLoopId || !candidate._toolLoopId || candidate._toolLoopId === row._toolLoopId)
    ) {
      const carried = carryRowIdentity(row, candidate);
      messages[i] = carried;
      return carried;
    }
  }

  // Pass 2: exact-set call-id re-commit replaces the committed fragment.
  const fragmentIndex = findRecommitFragmentIndex(messages, row);
  if (fragmentIndex !== null) {
    const candidate = messages[fragmentIndex];
    const merged = mergeCallPair(candidate, row);
    const carried = carryRowIdentity(merged, candidate);
    messages[fragmentIndex] = carried;
    return carried;
  }

  messages.push(row);
  return row;
}

function findRecommitFragmentIndex(messages: ChatMessage[], row: ChatMessage): number | null {
  const rowCallIds = (row.toolCalls ?? []).map((tc: ChatToolCall) => tc.id);
  if (rowCallIds.length === 0) return null;
  if (row._toolLoopFragment !== true) return null; // only loop fragments re-commit
  const rowSet = new Set(rowCallIds);
  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = messages[i];
    if (candidate.role !== "assistant" || candidate._inProgress) continue;
    if (candidate._toolLoopFragment !== true) continue;
    const candidateIds = (candidate.toolCalls ?? []).map((tc: ChatToolCall) => tc.id);
    if (candidateIds.length !== rowSet.size) continue;
    if (candidateIds.every((id: string) => rowSet.has(id))) return i;
  }
  return null;
}

/**
 * Union of the two versions of a call pair, preferring the re-commit for every
 * field but never dropping results the earlier fragment had captured (the
 * re-commit can legitimately lack them when the drain split accumulator state).
 */
function mergeCallPair(previous: ChatMessage, next: ChatMessage): ChatMessage {
  const calls = next.toolCalls ?? previous.toolCalls ?? [];
  const byCallId = new Map<string, ChatToolResult>();
  for (const tr of previous.toolResults ?? []) byCallId.set(tr.toolCallId, tr);
  for (const tr of next.toolResults ?? []) byCallId.set(tr.toolCallId, tr);
  const ordered = orderToolResultsByToolCalls(calls, [...byCallId.values()]);

  return {
    ...next,
    content: (next.content ?? "").trim() ? next.content : previous.content,
    thinking: next.thinking ?? previous.thinking,
    usage: next.usage ?? previous.usage,
    toolCalls: calls.length > 0 ? calls : next.toolCalls,
    toolResults: ordered.length > 0 ? ordered : undefined,
    artifacts: next.artifacts ?? previous.artifacts,
    visuals: next.visuals ?? previous.visuals,
    segments: next.segments ?? previous.segments,
  };
}
