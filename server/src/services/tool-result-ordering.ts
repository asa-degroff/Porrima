import type { ChatToolCall, ChatToolResult } from "../types.js";

/**
 * Tool execution can complete in a different order than the assistant emitted
 * tool calls. Persist source order so future prompt replay matches the live
 * model continuation that created the cache.
 */
export function orderToolResultsByToolCalls(
  toolCalls: Pick<ChatToolCall, "id">[],
  toolResults: ChatToolResult[],
): ChatToolResult[] {
  if (toolCalls.length === 0 || toolResults.length <= 1) return toolResults;

  const resultsByCallId = new Map<string, ChatToolResult[]>();
  for (const result of toolResults) {
    const existing = resultsByCallId.get(result.toolCallId);
    if (existing) existing.push(result);
    else resultsByCallId.set(result.toolCallId, [result]);
  }

  const ordered: ChatToolResult[] = [];
  const orderedResultIds = new Set<ChatToolResult>();
  for (const call of toolCalls) {
    const matches = resultsByCallId.get(call.id);
    if (!matches) continue;
    for (const result of matches) {
      ordered.push(result);
      orderedResultIds.add(result);
    }
  }

  for (const result of toolResults) {
    if (!orderedResultIds.has(result)) ordered.push(result);
  }

  return ordered;
}
