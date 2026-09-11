import type { ChatMessage } from "../types";

/** An assistant row with nothing to display yet — a streaming placeholder. */
export function isEmptyAssistantPlaceholder(message: ChatMessage | undefined): boolean {
  return (
    message?.role === "assistant" &&
    !message._isCompactionSummary &&
    !message.content &&
    !message.thinking &&
    !message.toolCalls?.length &&
    !message.segments?.length &&
    !message.artifacts?.length &&
    !message.generatedImages?.length &&
    !message.visuals?.length
  );
}

/**
 * Message-list transition for the server's `follow_up_start` event.
 *
 * `send()` while streaming optimistically appends the queued user message
 * plus an empty `_steeringPending` assistant placeholder — the bubble the
 * drained response streams into. That placeholder is normally last, but when
 * the enqueue races the previous turn boundary the tool loop's
 * `message_complete` (continues: true) appends a continuation placeholder
 * after it. The drained response belongs in the live tail slot either way;
 * appending yet another placeholder strands the earlier empty rows as
 * permanent empty bubbles, so drop the superseded steering row and reuse the
 * tail slot, adding one only when the tail is a finalized row.
 */
export function applyFollowUpStart(messages: ChatMessage[]): ChatMessage[] {
  let steeringIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "assistant" && message._steeringPending) {
      steeringIdx = i;
      break;
    }
  }

  const lastIdx = messages.length - 1;
  if (steeringIdx >= 0 && steeringIdx === lastIdx) {
    // Normal steering path: clear the pending flag in place so deltas flow
    // into the optimistic bubble.
    const { _steeringPending, ...cleared } = messages[lastIdx];
    void _steeringPending;
    return [...messages.slice(0, lastIdx), cleared];
  }

  const tailHasSlot = isEmptyAssistantPlaceholder(messages[lastIdx]);
  if (steeringIdx < 0 && !tailHasSlot) {
    // Pure follow-up (e.g. queued while offline): add the response slot.
    return [...messages, { role: "assistant", content: "", timestamp: Date.now() }];
  }

  // A live tail slot already exists (continuation placeholder) and/or a
  // superseded steering placeholder sits above it. Drop the stale steering
  // row; keep the tail slot, or append one when the tail is finalized.
  const next = steeringIdx >= 0
    ? [...messages.slice(0, steeringIdx), ...messages.slice(steeringIdx + 1)]
    : [...messages];
  if (!tailHasSlot) {
    next.push({ role: "assistant", content: "", timestamp: Date.now() });
  }
  return next;
}
