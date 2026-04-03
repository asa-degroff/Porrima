import type { Chat, ChatMessage } from "../types.js";

export interface CompactionResult {
  truncated: boolean;
  removedCount: number;
  removedMessages?: ChatMessage[];
  /** Estimated token count of removed messages (chars/4 approximation) */
  estimatedTokenCount?: number;
}

/**
 * Estimate token count from character count.
 * English text averages ~4 chars/token. This is a rough proxy but fast.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate total context size including system prompt and all messages.
 * Exported as `estimateContextTokens` for use in chat route fallback compaction.
 */
export { estimateContextSize as estimateContextTokens };
function estimateContextSize(messages: Chat["messages"], systemPrompt: string): number {
  // If the most recent assistant message has actual LLM-reported usage,
  // use that as a baseline — it includes tool definitions, system prompt,
  // and framing overhead that character estimation misses.
  let lastKnownUsage = 0;
  let lastUsageIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && messages[i].usage?.totalTokens) {
      lastKnownUsage = messages[i].usage!.totalTokens;
      lastUsageIndex = i;
      break;
    }
  }

  // Character-based estimation for comparison / messages after last usage
  let charEstimate = estimateTokens(systemPrompt);
  for (const m of messages) {
    if (m.role === "user") {
      charEstimate += estimateTokens(m.content);
      if (m.images?.length) {
        // Rough estimate: ~256 tokens per image
        charEstimate += m.images.length * 256;
      }
    } else if (m.role === "assistant") {
      charEstimate += estimateTokens(m.content);
      if (m.thinking) charEstimate += estimateTokens(m.thinking);
      // Tool calls/results add overhead
      if (m.toolCalls) charEstimate += m.toolCalls.length * 50;
      if (m.toolResults) {
        for (const r of m.toolResults) {
          charEstimate += estimateTokens(r.content) + 20; // content + framing overhead
        }
      }
    }
  }

  if (lastKnownUsage > 0 && lastUsageIndex >= 0) {
    // Add character estimate for messages AFTER the last usage checkpoint
    let additionalTokens = 0;
    for (let i = lastUsageIndex + 1; i < messages.length; i++) {
      const m = messages[i];
      additionalTokens += estimateTokens(m.content);
      if (m.images?.length) additionalTokens += m.images.length * 256;
    }
    const usageBased = lastKnownUsage + additionalTokens;
    // Use the higher of the two estimates
    return Math.max(charEstimate, usageBased);
  }

  return charEstimate;
}

/**
 * Proactively truncate chat history BEFORE sending to the LLM if context
 * would exceed the safe threshold (~80% of context window).
 *
 * This prevents broken responses from hitting the context limit mid-generation.
 * Unlike post-response compaction (which targets 50%), pre-send truncation
 * targets 75% to leave room for the new exchange.
 *
 * Returns CompactionResult if truncation occurred, null if context is already safe.
 */
export async function truncateBeforeSend(
  chat: Chat,
  contextWindow: number,
  systemPrompt: string,
  onCompacting?: () => void,
  onKeepalive?: () => void
): Promise<CompactionResult | null> {
  const noOp = null;
  const messages = chat.messages;
  if (messages.length <= 2) return noOp;

  const estimatedTokens = estimateContextSize(messages, systemPrompt);
  const threshold = contextWindow * 0.75;

  if (estimatedTokens <= threshold) return noOp;

  onCompacting?.();

  console.log(
    `[compaction] Pre-send truncation triggered: ${estimatedTokens} tokens > ${threshold} threshold`
  );

  // Calculate how many messages to remove to get below threshold
  // Use character-based estimation for per-message sizing
  const messageTokenEstimates = messages.map((m, i) => {
    let tokens = 0;
    if (m.role === "user") {
      tokens = estimateTokens(m.content);
      if (m.images?.length) tokens += m.images.length * 256;
    } else {
      tokens = estimateTokens(m.content);
      if (m.thinking) tokens += estimateTokens(m.thinking);
      if (m.toolCalls) tokens += m.toolCalls.length * 50;
      if (m.toolResults) {
        for (const r of m.toolResults) {
          tokens += estimateTokens(r.content) + 20;
        }
      }
    }
    return tokens;
  });

  // Keep first message (title context) + most RECENT messages that fit in budget.
  // Iterate backwards from end to prioritize recent context.
  let runningTotal = estimateTokens(systemPrompt) + messageTokenEstimates[0];
  let keepFromIndex = 1; // start assuming we keep only the first message

  // Build a list of recent messages that fit within threshold
  const recentIndices: number[] = [];
  for (let i = messages.length - 1; i >= 1; i--) {
    if (runningTotal + messageTokenEstimates[i] <= threshold) {
      runningTotal += messageTokenEstimates[i];
      recentIndices.push(i);
    } else {
      // Stop adding messages, but don't break - we need to find the boundary
      break;
    }
  }

  // If no recent messages fit, we're in a dangerous state - keep at least the last 2 messages
  // even if it slightly exceeds threshold. Better to have context than lose it entirely.
  if (recentIndices.length === 0) {
    console.warn(`[compaction] No recent messages fit within threshold (${runningTotal} > ${threshold}), keeping last 2 messages`);
    keepFromIndex = Math.max(1, messages.length - 2);
  } else {
    // Sort indices ascending to get the boundary
    recentIndices.sort((a, b) => a - b);
    keepFromIndex = recentIndices[0];
  }

  const messagesToRemove = keepFromIndex - 1; // messages between first and keepFromIndex

  if (messagesToRemove <= 0) return noOp;

  // Generate summary of removed messages before truncation
  const removedMessages = messages.slice(1, keepFromIndex);
  const summary = await generateCompactionSummary(removedMessages, chat.modelId, onKeepalive);

  // Keep first message, insert summary, then recent messages
  const firstMessage = messages[0];
  const recentMessages = messages.slice(keepFromIndex);
  
  // Preserve usage from the last removed message if available
  const lastRemovedUsage = removedMessages.length > 0 
    ? removedMessages[removedMessages.length - 1].usage 
    : undefined;
  
  const summaryMessage: typeof firstMessage = {
    role: "assistant",
    content: summary, // Strip the prefix - UI will handle rendering
    thinking: undefined,
    // Note: Summary messages intentionally DON'T inherit usage from removed messages.
    // This prevents confusion in the TokenIndicator. The next real assistant response
    // will have accurate usage data from Ollama's prompt_eval_count.
    timestamp: Date.now(),
    _isCompactionSummary: true,
    _compactedMessageCount: messagesToRemove,
  };

  chat.messages = [firstMessage, summaryMessage, ...recentMessages];

  // Calculate estimated token count of removed messages for tracking
  const estimatedRemovedTokens = removedMessages.reduce((sum, m) => {
    let tokens = estimateTokens(m.content);
    if (m.role === "user" && m.images?.length) {
      tokens += m.images.length * 256;
    }
    if (m.role === "assistant") {
      if (m.thinking) tokens += estimateTokens(m.thinking);
      if (m.toolCalls) tokens += m.toolCalls.length * 50;
      if (m.toolResults) {
        for (const r of m.toolResults) {
          tokens += estimateTokens(r.content) + 20;
        }
      }
    }
    return sum + tokens;
  }, 0);

  console.log(
    `[compaction] Pre-send truncated chat ${chat.id}: removed ${messagesToRemove} messages ` +
    `(~${estimatedRemovedTokens} est. tokens) → ${chat.messages.length} messages`
  );

  return { truncated: true, removedCount: messagesToRemove, estimatedTokenCount: estimatedRemovedTokens };
}

/**
 * Generate a brief summary of messages being removed during compaction.
 * This preserves context continuity for the model.
 */
async function generateCompactionSummary(
  messages: Chat["messages"],
  modelId: string,
  onKeepalive?: () => void
): Promise<string> {
  if (messages.length === 0) return "";

  const { streamChat } = await import("./agent.js");

  // Build summary input with enough content for meaningful summarization.
  // Cap total input to ~8k chars (~2k tokens) to avoid overloading the summarizer.
  // Distribute budget evenly across all messages so later ones aren't excluded.
  const MAX_SUMMARY_INPUT = 8000;
  const perMessageBudget = Math.max(100, Math.floor(MAX_SUMMARY_INPUT / messages.length));

  const summaryParts: string[] = [];
  for (const m of messages) {
    const truncated = m.content.slice(0, perMessageBudget);
    summaryParts.push(
      `${m.role}: ${truncated}${m.content.length > perMessageBudget ? "..." : ""}`
    );
  }
  const summaryPrompt = summaryParts.join("\n").slice(0, MAX_SUMMARY_INPUT);

  const systemPrompt = `You are summarizing conversation messages that will be removed due to context limits.
Provide a concise summary of the key points, decisions, code discussed, and outcomes.
Focus on what the assistant needs to know to continue the conversation coherently.

Example: "The user asked for help debugging a TypeScript type error. The assistant identified a missing generic parameter and provided a fix using Record<string, unknown>. The user confirmed the fix worked."

Output ONLY the summary, no introduction or formatting.`;

  // Send keepalives every 10s so the client SSE inactivity timer doesn't fire
  // while the summary model is generating
  const keepaliveInterval = onKeepalive
    ? setInterval(onKeepalive, 10_000)
    : null;

  try {
    const result = await streamChat(
      modelId,
      [{ role: "user", content: summaryPrompt, timestamp: Date.now() }],
      systemPrompt,
      () => {}
    );
    return result.content.trim() || "Previous conversation context was truncated.";
  } catch (err) {
    console.error("[compaction] Summary generation failed:", err);
    return "Previous conversation context was truncated.";
  } finally {
    if (keepaliveInterval) clearInterval(keepaliveInterval);
  }
}

/**
 * Truncate chat history to fit within the context window (post-response).
 *
 * Strategy: keep the first user message (for title/context) and the most recent
 * messages. Uses character-based token estimation (consistent with truncateBeforeSend).
 * Targets 50% of context window to leave headroom for the next exchange.
 * Generates a summary of removed messages to preserve context continuity.
 *
 * @param forceCompact - When true (e.g. stopReason was "length"), skip usage
 *   checks and compact based on character estimation. This handles cases where
 *   the model hit the context limit but usage data is missing or inaccurate.
 */
export async function truncateChatHistory(
  chat: Chat,
  contextWindow: number,
  forceCompact: boolean = false,
  onCompacting?: () => void,
  onKeepalive?: () => void
): Promise<CompactionResult> {
  const noOp: CompactionResult = { truncated: false, removedCount: 0 };
  const messages = chat.messages;
  if (messages.length <= 2) return noOp;

  const targetTokens = contextWindow * 0.5;

  if (!forceCompact) {
    // Find the most recent assistant message with usage info
    let lastUsage = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].usage?.totalTokens) {
        lastUsage = messages[i].usage!.totalTokens;
        break;
      }
    }

    if (lastUsage === 0) return noOp;
    if (lastUsage <= targetTokens) return noOp;
  }

  // Use character-based per-message estimation (consistent with truncateBeforeSend)
  const messageTokenEstimates = messages.map((m) => {
    let tokens = estimateTokens(m.content);
    if (m.role === "user" && m.images?.length) {
      tokens += m.images.length * 256;
    }
    if (m.role === "assistant") {
      if (m.thinking) tokens += estimateTokens(m.thinking);
      if (m.toolCalls) tokens += m.toolCalls.length * 50;
      if (m.toolResults) {
        for (const r of m.toolResults) {
          tokens += estimateTokens(r.content) + 20;
        }
      }
    }
    return tokens;
  });

  // Iterate backwards to keep most recent messages that fit in target budget
  let runningTotal = messageTokenEstimates[0]; // always keep first
  let keepFromIndex = messages.length;

  for (let i = messages.length - 1; i >= 1; i--) {
    if (runningTotal + messageTokenEstimates[i] <= targetTokens) {
      runningTotal += messageTokenEstimates[i];
      keepFromIndex = i;
    } else {
      break;
    }
  }

  keepFromIndex = Math.min(keepFromIndex, messages.length - 1);
  const messagesToRemove = keepFromIndex - 1;

  if (messagesToRemove <= 0) return noOp;

  onCompacting?.();

  const firstMessage = messages[0];
  const removedMessages = messages.slice(1, keepFromIndex);
  const recentMessages = messages.slice(keepFromIndex);

  // Generate summary of removed messages to preserve continuity
  const summary = await generateCompactionSummary(removedMessages, chat.modelId, onKeepalive);

  // Preserve usage from the last removed message if available
  const lastRemovedUsage = removedMessages.length > 0
    ? removedMessages[removedMessages.length - 1].usage
    : undefined;

  const summaryMessage: ChatMessage = {
    role: "assistant",
    content: summary, // Strip the prefix - UI will handle rendering
    // Note: Summary messages intentionally DON'T inherit usage from removed messages.
    // This prevents confusion in the TokenIndicator. The next real assistant response
    // will have accurate usage data from Ollama's prompt_eval_count.
    timestamp: Date.now(),
    _isCompactionSummary: true,
    _compactedMessageCount: messagesToRemove,
  };

  chat.messages = [firstMessage, summaryMessage, ...recentMessages];

  // Calculate estimated token count of removed messages for tracking
  const estimatedRemovedTokens = removedMessages.reduce((sum, m) => {
    let tokens = estimateTokens(m.content);
    if (m.role === "user" && m.images?.length) {
      tokens += m.images.length * 256;
    }
    if (m.role === "assistant") {
      if (m.thinking) tokens += estimateTokens(m.thinking);
      if (m.toolCalls) tokens += m.toolCalls.length * 50;
      if (m.toolResults) {
        for (const r of m.toolResults) {
          tokens += estimateTokens(r.content) + 20;
        }
      }
    }
    return sum + tokens;
  }, 0);

  console.log(
    `[compaction] Truncated chat ${chat.id}: removed ${messagesToRemove} messages ` +
    `(~${estimatedRemovedTokens} est. tokens) → ${chat.messages.length} messages`
  );

  return { truncated: true, removedCount: messagesToRemove, removedMessages, estimatedTokenCount: estimatedRemovedTokens };
}
