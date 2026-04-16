import type { Chat, ChatMessage } from "../types.js";
import { getNextArchiveSequence, saveArchives, type ContextArchive, updateChatTitle } from "./chat-storage.js";
import { regenerateTitle } from "./title-generation.js";
import { withExtractionMutex } from "./memory-extraction.js";

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
    if (messages[i]._outOfContext) continue;
    if (messages[i].role === "assistant" && messages[i].usage?.totalTokens) {
      lastKnownUsage = messages[i].usage!.totalTokens;
      lastUsageIndex = i;
      break;
    }
  }

  // Character-based estimation for comparison / messages after last usage
  // Only count in-context messages (skip _outOfContext ones)
  let charEstimate = estimateTokens(systemPrompt);
  for (const m of messages) {
    if (m._outOfContext) continue;
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

  // Build index of in-context messages for budget calculation
  const icIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (!messages[i]._outOfContext) icIndices.push(i);
  }
  if (icIndices.length <= 2) return noOp;

  // Per-message token estimates for in-context messages
  const icEstimates = icIndices.map((idx) => {
    const m = messages[idx];
    let tokens = estimateTokens(m.content);
    if (m.role === "user" && m.images?.length) tokens += m.images.length * 256;
    if (m.role === "assistant") {
      if (m.thinking) tokens += estimateTokens(m.thinking);
      if (m.toolCalls) tokens += m.toolCalls.length * 50;
      if (m.toolResults) {
        for (const r of m.toolResults) tokens += estimateTokens(r.content) + 20;
      }
    }
    return tokens;
  });

  // Apply scaling factor for accurate estimates
  const messageContentTokens = icEstimates.reduce((s, t) => s + t, 0);
  const charEstimateTotal = estimateTokens(systemPrompt) + messageContentTokens;
  const scaleFactor = charEstimateTotal > 0 ? estimatedTokens / charEstimateTotal : 1;
  const scaledEstimates = icEstimates.map((t) => Math.ceil(t * scaleFactor));
  const overheadTokens = Math.ceil(estimateTokens(systemPrompt) * scaleFactor);

  // Iterate backwards over in-context messages to find budget boundary
  let runningTotal = overheadTokens + scaledEstimates[0]; // always keep first
  let keepFromIC = 1;
  const recentICIndices: number[] = [];
  for (let ic = icIndices.length - 1; ic >= 1; ic--) {
    if (runningTotal + scaledEstimates[ic] <= threshold) {
      runningTotal += scaledEstimates[ic];
      recentICIndices.push(ic);
    } else {
      break;
    }
  }

  if (recentICIndices.length === 0) {
    console.warn(`[compaction] No recent messages fit within threshold (${runningTotal} > ${threshold}), keeping last 2 in-context`);
    keepFromIC = Math.max(1, icIndices.length - 2);
  } else {
    recentICIndices.sort((a, b) => a - b);
    keepFromIC = recentICIndices[0];
  }

  const messagesToMarkCount = keepFromIC - 1;
  console.log(`[compaction] Pre-send budget: overhead=${overheadTokens} scale=${scaleFactor.toFixed(2)} keepFromIC=${keepFromIC} marking=${messagesToMarkCount}/${icIndices.length} in-context`);

  if (messagesToMarkCount <= 0) return noOp;

  // Collect removed messages for archiving
  const removedMessages: ChatMessage[] = [];
  const markedIndices: number[] = [];
  for (let ic = 1; ic < keepFromIC; ic++) {
    const origIdx = icIndices[ic];
    removedMessages.push(messages[origIdx]);
    markedIndices.push(origIdx);
  }

  // Archive and generate summary
  const indexedSummary = await archiveAndIndex(chat.id, removedMessages, chat.modelId, onKeepalive);

  // Mark messages as out-of-context, strip large content
  const ARCHIVED_CONTENT_CAP = 500;
  for (const origIdx of markedIndices) {
    const m = messages[origIdx];
    m._outOfContext = true;
    if (m.toolResults) {
      for (const r of m.toolResults) {
        if (r.content && r.content.length > ARCHIVED_CONTENT_CAP) {
          r.content = r.content.slice(0, ARCHIVED_CONTENT_CAP) + "\n[archived]";
        }
      }
    }
    if (m.thinking && m.thinking.length > ARCHIVED_CONTENT_CAP) {
      m.thinking = m.thinking.slice(0, ARCHIVED_CONTENT_CAP) + "\n[archived]";
    }
    if (m.images) {
      m.images = m.images.map(img => ({ ...img, data: "" }));
    }
  }

  // Insert summary before the first kept in-context message
  const insertionIdx = icIndices[keepFromIC];
  const summaryMessage: ChatMessage = {
    role: "assistant",
    content: indexedSummary,
    thinking: undefined,
    timestamp: Date.now(),
    _isCompactionSummary: true,
    _compactedMessageCount: messagesToMarkCount,
  };
  messages.splice(insertionIdx, 0, summaryMessage);
  chat.messages = messages;

  const estimatedRemovedTokens = removedMessages.reduce((sum, m) => {
    let tokens = estimateTokens(m.content);
    if (m.role === "user" && m.images?.length) tokens += m.images.length * 256;
    if (m.role === "assistant") {
      if (m.thinking) tokens += estimateTokens(m.thinking);
      if (m.toolCalls) tokens += m.toolCalls.length * 50;
      if (m.toolResults) {
        for (const r of m.toolResults) tokens += estimateTokens(r.content) + 20;
      }
    }
    return sum + tokens;
  }, 0);

  const inContextCount = chat.messages.filter(m => !m._outOfContext).length;
  console.log(
    `[compaction] Pre-send compacted chat ${chat.id}: marked ${messagesToMarkCount} messages out-of-context ` +
    `(~${estimatedRemovedTokens} est. tokens) → ${inContextCount} in-context, ${chat.messages.length} total`
  );

  // Regenerate title based on in-context messages to keep it current
  try {
    const inContextMsgs = chat.messages.filter(m => !m._outOfContext);
    const newTitle = await regenerateTitle(inContextMsgs);
    if (newTitle && newTitle !== chat.title) {
      await updateChatTitle(chat.id, newTitle);
      chat.title = newTitle;
      console.log(`[compaction] Title updated: "${chat.title}"`);
    }
  } catch (err) {
    console.warn("[compaction] Title regeneration failed:", err);
  }

  return { truncated: true, removedCount: messagesToMarkCount, removedMessages, estimatedTokenCount: estimatedRemovedTokens };
}

// ---------------------------------------------------------------------------
// Indexed archival — replaces narrative summaries with structured indexes
// ---------------------------------------------------------------------------

/**
 * Group removed messages into logical archive blocks:
 * - Tool call + result pairs → one block each
 * - User + assistant exchanges (no tools) → one block
 * - Standalone messages → one block
 */
function groupIntoBlocks(messages: ChatMessage[]): ChatMessage[][] {
  const blocks: ChatMessage[][] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    // Assistant message with tool calls: include it + all subsequent tool results
    if (m.role === "assistant" && m.toolCalls?.length) {
      blocks.push([m]);
      i++;
      continue;
    }
    // User message: pair with next assistant response if available
    if (m.role === "user") {
      const block = [m];
      if (i + 1 < messages.length && messages[i + 1].role === "assistant") {
        block.push(messages[i + 1]);
        i += 2;
      } else {
        i++;
      }
      blocks.push(block);
      continue;
    }
    // Anything else: standalone block
    blocks.push([m]);
    i++;
  }
  return blocks;
}

/**
 * Format a block of messages into readable text for the index description.
 * Prioritizes analytical content (findings, conclusions, decisions) over
 * mechanical actions (tool call names, file paths). For long messages,
 * includes both the beginning and end to capture introductions AND conclusions.
 */
function blockToText(block: ChatMessage[], maxPerMessage = 400): string {
  const parts: string[] = [];
  for (const m of block) {
    if (m.role === "user") {
      // User messages are usually questions or requests — keep the full context
      parts.push(`user: ${truncateMiddle(m.content, maxPerMessage)}`);
    } else if (m.role === "assistant") {
      // Assistant messages may contain analysis, conclusions, or findings
      // that are far more valuable than tool call names
      if (m.content) {
        const contentSnippet = truncateMiddle(m.content, maxPerMessage);
        parts.push(`assistant: ${contentSnippet}`);
      }
      // Tool calls: include names and brief args for identification,
      // but focus on results which contain the actual information
      if (m.toolCalls?.length) {
        const callSummary = m.toolCalls
          .map(tc => `${tc.name}(${summarizeArgs(tc.arguments, 80)})`)
          .join(", ");
        parts.push(`tools: ${callSummary}`);
      }
      if (m.toolResults?.length) {
        for (const tr of m.toolResults) {
          // Tool results often contain the key findings (file contents, search results, etc.)
          parts.push(`result [${tr.toolName}]: ${truncateMiddle(tr.content, 300)}`);
        }
      }
    }
  }
  return parts.join("\n");
}

/**
 * Truncate a string showing both the beginning and end, with a gap indicator.
 * This captures introductions AND conclusions for long messages.
 */
function truncateMiddle(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const headLen = Math.ceil(maxLen * 0.6);
  const tailLen = Math.floor(maxLen * 0.4) - 5; // -5 for " ... "
  return `${text.slice(0, headLen)} ... ${text.slice(-tailLen)}`;
}

/**
 * Summarize tool call arguments for the index — extracts key-value pairs
 * rather than dumping raw JSON.
 */
function summarizeArgs(args: Record<string, unknown>, maxLen: number): string {
  try {
    const entries = Object.entries(args);
    if (entries.length === 0) return "";
    // For single simple values, just show the value
    if (entries.length === 1 && typeof entries[0][1] === "string") {
      const val = String(entries[0][1]);
      return val.length > maxLen ? val.slice(0, maxLen) + "..." : val;
    }
    // For multiple args, show key=value pairs
    const summary = entries
      .map(([k, v]) => {
        const val = typeof v === "string" ? v : JSON.stringify(v);
        return `${k}=${val.length > 40 ? val.slice(0, 40) + "..." : val}`;
      })
      .join(", ");
    return summary.length > maxLen ? summary.slice(0, maxLen) + "..." : summary;
  } catch {
    return JSON.stringify(args).slice(0, maxLen);
  }
}

/** Generate a readable fallback description when the LLM index generation fails. */
function generateFallbackDescription(block: ChatMessage[]): string {
  // Try to find the most informative content in the block
  let assistantAnalysis = "";
  let userQuestion = "";
  const toolNames: string[] = [];
  let resultPreview = "";

  for (const m of block) {
    if (m.role === "user" && !userQuestion) {
      userQuestion = m.content.slice(0, 120).replace(/\n/g, " ");
    }
    if (m.role === "assistant") {
      // Prefer substantial analysis over short tool-call-only messages
      if (m.content && m.content.length > 100) {
        // For long responses, take the beginning and end to capture conclusions
        const head = m.content.slice(0, 80).replace(/\n/g, " ");
        const tail = m.content.length > 200
          ? " ... " + m.content.slice(-60).replace(/\n/g, " ")
          : "";
        assistantAnalysis = head + tail;
      } else if (m.content && !assistantAnalysis) {
        assistantAnalysis = m.content.slice(0, 80).replace(/\n/g, " ");
      }
      if (m.toolCalls?.length) {
        for (const tc of m.toolCalls) toolNames.push(tc.name);
      }
      if (m.toolResults?.length && !resultPreview) {
        // Extract a meaningful snippet from the first result
        const firstResult = m.toolResults[0];
        resultPreview = firstResult.content.slice(0, 100).replace(/\n/g, " ");
      }
    }
  }

  // Prioritize: analysis > result > question > tool names
  if (assistantAnalysis) return assistantAnalysis;
  if (resultPreview) return resultPreview;
  if (userQuestion) return `Question: ${userQuestion}`;
  if (toolNames.length > 0) {
    const unique = [...new Set(toolNames)];
    return `Tool calls: ${unique.join(", ")} (${toolNames.length} total)`;
  }
  return "Conversation context";
}

/**
 * Archive removed messages and generate an indexed summary.
 * Returns the summary text to insert into the chat in place of removed messages.
 */
async function archiveAndIndex(
  chatId: string,
  removedMessages: ChatMessage[],
  modelId: string,
  onKeepalive?: () => void,
): Promise<string> {
  if (removedMessages.length === 0) return "";

  // Filter out compaction summary messages — they contain archive indices and
  // system metadata, not actual conversation content worth archiving.
  const substantiveMessages = removedMessages.filter((m) => !m._isCompactionSummary);
  if (substantiveMessages.length === 0) return "";

  const blocks = groupIntoBlocks(substantiveMessages);
  if (blocks.length === 0) return "";

  // Assign archive IDs
  let seq = getNextArchiveSequence(chatId);
  const shortChatId = chatId.slice(0, 8);
  const archives: ContextArchive[] = [];
  const blockDescriptions: Array<{ id: string; text: string }> = [];

  for (const block of blocks) {
    const id = `archive:${shortChatId}:${String(seq).padStart(3, "0")}`;
    const text = blockToText(block);
    const tokens = block.reduce((sum, m) => {
      let t = estimateTokens(m.content);
      if (m.toolResults) for (const r of m.toolResults) t += estimateTokens(r.content);
      if (m.thinking) t += estimateTokens(m.thinking);
      return sum + t;
    }, 0);

    archives.push({
      id,
      chatId,
      sequenceNum: seq,
      messages: block,
      indexEntry: "", // filled by LLM below
      messageCount: block.length,
      estimatedTokens: tokens,
      createdAt: new Date().toISOString(),
    });
    blockDescriptions.push({ id, text });
    seq++;
  }

  // Generate index descriptions — prefer the dedicated extraction model (CPU, fast)
  // to avoid blocking the GPU chat model's KV cache.
  // Budget more chars per block when there are fewer blocks, so analytical content
  // gets enough context for meaningful descriptions.
  const { getSettings } = await import("./chat-storage.js");
  const settings = await getSettings();
  const extractionUrl = settings.extractionModelUrl;

  const perBlockBudget = Math.min(1200, Math.max(500, Math.floor(6000 / blockDescriptions.length)));
  const inputParts = blockDescriptions.map(
    (b) => `[${b.id}]\n${b.text.slice(0, perBlockBudget)}`
  ).join("\n\n---\n\n");

  const systemPrompt = `You are generating a structured index of conversation content being archived for future retrieval.
For each block below (identified by its archive ID), write a one-line description.

Format your response as exactly one line per block:
${blockDescriptions.map((b) => `- ${b.id} — <description>`).join("\n")}

Descriptions should capture the SIGNIFICANCE of each block — what was learned, decided, or accomplished — not just what actions were taken. A good description answers "why would I need this later?"

Good descriptions:
- archive:abc:001 — Identified P0 bug in memory reset during compaction; /compact path skipped resetMemoryContext
- archive:abc:002 — Reviewed indexed summary architecture; concluded lossless archival beats narrative summarization
- archive:abc:003 — Read compaction.ts to understand truncation thresholds (75% pre-send, 50% post-response, 85% mid-turn)
- archive:abc:004 — User prefers systems that preserve full-fidelity message storage with indexed access rather than lossy summarization

Bad descriptions (too vague or action-focused):
- archive:abc:001 — File reads and grep searches
- archive:abc:002 — Tool calls: read_file, edit_file
- archive:abc:004 — User asked about memory

Prioritize: conclusions > findings > decisions > questions asked > tools used.
If the agent analyzed something, describe the analysis result, not just the analysis process.

Output ONLY the formatted lines, nothing else.`;

  const keepaliveInterval = onKeepalive ? setInterval(onKeepalive, 10_000) : null;

  try {
    let outputText = "";

    if (extractionUrl) {
      // Use dedicated CPU extraction model — fast, no GPU contention.
      // Serialize through the extraction mutex to prevent memory pile-up
      // from concurrent queued requests on the --parallel 1 server.
      outputText = await withExtractionMutex(async () => {
        const res = await fetch(`${extractionUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: settings.extractionModelId || "index-gen",
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: inputParts },
            ],
            max_tokens: 1000,
            temperature: 0.3,
            stream: false,
          }),
          signal: AbortSignal.timeout(60_000),
        });
        if (res.ok) {
          const data = await res.json();
          return data.choices?.[0]?.message?.content?.trim() || "";
        }
        return "";
      });
    }

    if (!outputText) {
      // Fallback: use main chat model via streamChat
      const { streamChat } = await import("./agent.js");
      const result = await streamChat(
        modelId,
        [{ role: "user", content: inputParts, timestamp: Date.now() }],
        systemPrompt,
        () => {},
      );
      outputText = result.content.trim() || result.thinking?.trim() || "";
    }
    console.log(`[compaction] Index LLM output (${outputText.length}ch): ${outputText.slice(0, 300)}`);

    const lines = outputText.split("\n");
    for (const line of lines) {
      // Match: "- archive:xxx:001 — description" with various dash types
      const match = line.match(/^[-*]?\s*(archive:\S+)\s*[—–\-:]\s*(.+)$/);
      if (match) {
        const archive = archives.find((a) => a.id === match[1]);
        if (archive) archive.indexEntry = match[2].trim();
      }
    }

    // Fill any missing entries with a readable fallback description
    let filled = 0;
    for (const a of archives) {
      if (!a.indexEntry) {
        a.indexEntry = generateFallbackDescription(a.messages);
        filled++;
      }
    }
    if (filled > 0) {
      console.log(`[compaction] ${filled}/${archives.length} index entries used fallback descriptions`);
    }
  } catch (err) {
    console.error("[compaction] Index generation failed, using fallback descriptions:", err);
    for (const a of archives) {
      const preview = blockToText(a.messages).slice(0, 80);
      a.indexEntry = preview || "conversation context";
    }
  } finally {
    if (keepaliveInterval) clearInterval(keepaliveInterval);
  }

  // Persist archives
  saveArchives(archives);
  console.log(`[compaction] Archived ${archives.length} blocks for chat ${chatId}`);

  // Build the indexed summary text
  const indexLines = archives
    .map((a) => `- ${a.id} — ${a.indexEntry}`)
    .join("\n");

  return `[Compacted context — use read_archived_context to retrieve details]\nArchived blocks:\n${indexLines}`;
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
  onKeepalive?: () => void,
  /** Known token usage from the current turn (the message may not be in chat.messages yet). */
  knownUsage?: number
): Promise<CompactionResult> {
  const noOp: CompactionResult = { truncated: false, removedCount: 0 };
  const messages = chat.messages;
  if (messages.length <= 1) return noOp;  // Need at least 2 total messages

  const targetTokens = contextWindow * 0.5;

  if (!forceCompact) {
    // Use caller-provided usage if available, otherwise search messages
    let lastUsage = knownUsage ?? 0;
    if (!lastUsage) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]._outOfContext) continue;
        if (messages[i].usage?.totalTokens) {
          lastUsage = messages[i].usage!.totalTokens;
          break;
        }
      }
    }

    if (lastUsage === 0) return noOp;
    if (lastUsage <= targetTokens) return noOp;
  }

  // Truncate any oversized tool results in-place before estimation.
  // This prevents a single bloated error result (e.g., 1MB bash output)
  // from consuming the entire compaction budget and causing all intermediate
  // messages to be removed.
  const MAX_TOOL_RESULT_CHARS = 60_000;
  for (const m of messages) {
    if (m.role === "assistant" && m.toolResults) {
      for (const r of m.toolResults) {
        if (r.content && r.content.length > MAX_TOOL_RESULT_CHARS) {
          console.log(`[compaction] Truncating oversized tool result: ${r.toolName} ${(r.content.length / 1024).toFixed(0)}KB → ${(MAX_TOOL_RESULT_CHARS / 1024).toFixed(0)}KB`);
          r.content = r.content.slice(0, MAX_TOOL_RESULT_CHARS) + `\n[Truncated from ${(r.content.length / 1024).toFixed(0)}KB]`;
        }
      }
    }
  }

  // Build index of in-context messages (skip already out-of-context ones)
  const inContextIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (!messages[i]._outOfContext) inContextIndices.push(i);
  }

  // Need at least 2 in-context messages to compact (unless forcing with very few messages)
  if (inContextIndices.length <= 1) return noOp;
  if (!forceCompact && inContextIndices.length <= 2) return noOp;  // Auto-compaction needs 3+ in-context

  // Estimate tokens for each in-context message
  const inContextEstimates = inContextIndices.map((idx) => {
    const m = messages[idx];
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

  // Iterate backwards over in-context messages to find the keep boundary
  let runningTotal = inContextEstimates[0]; // always keep first in-context message
  let keepFromICIdx = inContextIndices.length; // index into inContextIndices

  for (let ic = inContextIndices.length - 1; ic >= 1; ic--) {
    if (runningTotal + inContextEstimates[ic] <= targetTokens) {
      runningTotal += inContextEstimates[ic];
      keepFromICIdx = ic;
    } else {
      break;
    }
  }

  keepFromICIdx = Math.min(keepFromICIdx, inContextIndices.length - 1);

  // For forced compaction (manual /compact), if the budget calculation would keep
  // everything, still compact at least half the in-context messages. The user
  // explicitly asked to compact — don't skip just because it all fits.
  if (forceCompact && keepFromICIdx <= 1 && inContextIndices.length > 3) {
    keepFromICIdx = Math.ceil(inContextIndices.length / 2);
    console.log(`[compaction] Force compact: budget keeps all, compacting first half (${keepFromICIdx - 1} of ${inContextIndices.length} in-context messages)`);
  }

  const messagesToMarkCount = keepFromICIdx - 1; // exclude the first in-context message

  if (messagesToMarkCount <= 0) return noOp;

  onCompacting?.();

  // Collect the messages being marked out (for archiving and estimation)
  const removedMessages: ChatMessage[] = [];
  const markedOriginalIndices: number[] = [];
  for (let ic = 1; ic < keepFromICIdx; ic++) {
    const origIdx = inContextIndices[ic];
    removedMessages.push(messages[origIdx]);
    markedOriginalIndices.push(origIdx);
  }

  // Archive removed messages and generate indexed summary
  const indexedSummary = await archiveAndIndex(chat.id, removedMessages, chat.modelId, onKeepalive);

  // Mark messages as out-of-context (preserve for UI, exclude from LLM)
  // Also strip large content to limit storage growth.
  const ARCHIVED_CONTENT_CAP = 500;
  for (const origIdx of markedOriginalIndices) {
    const m = messages[origIdx];
    m._outOfContext = true;
    // Strip tool results to save space (they're archived separately)
    if (m.toolResults) {
      for (const r of m.toolResults) {
        if (r.content && r.content.length > ARCHIVED_CONTENT_CAP) {
          r.content = r.content.slice(0, ARCHIVED_CONTENT_CAP) + "\n[archived]";
        }
      }
    }
    // Strip thinking content
    if (m.thinking && m.thinking.length > ARCHIVED_CONTENT_CAP) {
      m.thinking = m.thinking.slice(0, ARCHIVED_CONTENT_CAP) + "\n[archived]";
    }
    // Strip base64 images from user messages
    if (m.images) {
      m.images = m.images.map(img => ({ ...img, data: "" }));
    }
  }

  // Insert the compaction summary right before the first kept in-context message
  const insertionIndex = inContextIndices[keepFromICIdx];
  const summaryMessage: ChatMessage = {
    role: "assistant",
    content: indexedSummary,
    timestamp: Date.now(),
    _isCompactionSummary: true,
    _compactedMessageCount: messagesToMarkCount,
  };
  messages.splice(insertionIndex, 0, summaryMessage);
  chat.messages = messages;

  // Calculate estimated token count for logging
  const estimatedRemovedTokens = removedMessages.reduce((sum, m) => {
    let tokens = estimateTokens(m.content);
    if (m.role === "user" && m.images?.length) tokens += m.images.length * 256;
    if (m.role === "assistant") {
      if (m.thinking) tokens += estimateTokens(m.thinking);
      if (m.toolCalls) tokens += m.toolCalls.length * 50;
      if (m.toolResults) {
        for (const r of m.toolResults) tokens += estimateTokens(r.content) + 20;
      }
    }
    return sum + tokens;
  }, 0);

  const inContextCount = chat.messages.filter(m => !m._outOfContext).length;
  console.log(
    `[compaction] Compacted chat ${chat.id}: marked ${messagesToMarkCount} messages out-of-context ` +
    `(~${estimatedRemovedTokens} est. tokens) → ${inContextCount} in-context, ${chat.messages.length} total`
  );

  // Regenerate title based on in-context messages to keep it current
  try {
    const inContextMsgs = chat.messages.filter(m => !m._outOfContext);
    const newTitle = await regenerateTitle(inContextMsgs);
    if (newTitle && newTitle !== chat.title) {
      await updateChatTitle(chat.id, newTitle);
      chat.title = newTitle;
      console.log(`[compaction] Title updated: "${chat.title}"`);
    }
  } catch (err) {
    console.warn("[compaction] Title regeneration failed:", err);
  }

  return { truncated: true, removedCount: messagesToMarkCount, removedMessages, estimatedTokenCount: estimatedRemovedTokens };
}

/**
 * Trigger a manual compaction of the chat history.
 * This is used for /compact command - it forces compaction regardless of current token usage.
 * Returns the compaction result, or null if compaction was not needed.
 */
export async function triggerCompaction(
  chat: Chat,
  contextWindow: number
): Promise<CompactionResult | null> {
  console.log(`[compaction] Manual compaction triggered for chat ${chat.id}`);
  
  // Use truncateChatHistory with forceCompact=true
  const result = await truncateChatHistory(chat, contextWindow, true);
  
  if (result.truncated) {
    console.log(`[compaction] Manual compaction complete: removed ${result.removedCount} messages (~${result.estimatedTokenCount} est. tokens)`);
  } else {
    console.log(`[compaction] Manual compaction skipped: not enough messages to compact`);
  }
  
  return result;
}
