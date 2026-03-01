import type { Chat } from "../types.js";

/**
 * Truncate chat history to fit within the context window.
 *
 * Strategy: keep the first user message (for title/context) and trim the oldest
 * middle messages until estimated token usage drops below 50% of the context
 * window. This leaves headroom for the next exchange after compaction.
 *
 * Token estimation uses the stored `usage.totalTokens` from the most recent
 * assistant message (which reflects the full context the LLM saw). We target
 * 50% after truncation so the conversation has room to grow before hitting
 * the limit again.
 *
 * Returns true if messages were actually truncated.
 */
export async function truncateChatHistory(
  chat: Chat,
  contextWindow: number
): Promise<boolean> {
  const messages = chat.messages;
  if (messages.length <= 2) return false;

  // Find the most recent assistant message with usage info
  let lastUsage = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].usage?.totalTokens) {
      lastUsage = messages[i].usage!.totalTokens;
      break;
    }
  }

  if (lastUsage === 0) return false;

  const targetTokens = contextWindow * 0.5;
  if (lastUsage <= targetTokens) return false;

  // Estimate tokens per message by dividing total across all messages.
  // This is rough but sufficient — we just need to get below the target.
  const tokensPerMessage = lastUsage / messages.length;
  const messagesToKeep = Math.max(2, Math.floor(targetTokens / tokensPerMessage));
  const messagesToRemove = messages.length - messagesToKeep;

  if (messagesToRemove <= 0) return false;

  // Keep the first message (preserves title context) and the most recent messages.
  // Remove from index 1 up to messagesToRemove.
  const firstMessage = messages[0];
  const recentMessages = messages.slice(1 + messagesToRemove);

  chat.messages = [firstMessage, ...recentMessages];

  console.log(
    `[compaction] Truncated chat ${chat.id}: removed ${messagesToRemove} messages ` +
    `(${messages.length} → ${chat.messages.length}), ` +
    `estimated ${lastUsage} → ~${Math.round(chat.messages.length * tokensPerMessage)} tokens`
  );

  return true;
}
