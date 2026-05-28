import type { ChatMessage } from "../types.js";
import { getDb, getSettings, type ContextArchive, getNextArchiveSequence, saveArchives } from "./chat-storage.js";
import { normalizeExtractionRequestSettings } from "./extraction-settings.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PreSynthesisArchiveResult {
  /** Number of chats archived */
  archivedCount: number;
  /** Chat IDs that were archived */
  chatIds: string[];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Pre-synthesis archiving: archive recent agent chats that don't yet have archives.
 *
 * This ensures the synthesis agent has full-fidelity transcript access via
 * `read_archived_context` tool, rather than relying on lossy summaries.
 *
 * Only archives chats that are at least 5 minutes old (avoid racing with
 * active conversations) and have more than 4 messages.
 *
 * @param maxChats - Maximum number of chats to archive per run (default: 10)
 * @returns number of chats archived
 */
export async function preSynthesisArchive(maxChats: number = 10): Promise<PreSynthesisArchiveResult> {
  const unarchivedChats = await findUnarchivedChats(maxChats);

  let archivedCount = 0;
  const archivedIds: string[] = [];

  for (const chatId of unarchivedChats) {
    const result = await archiveChatForSynthesis(chatId);
    if (result) {
      archivedCount++;
      archivedIds.push(chatId);
    }
  }

  return { archivedCount, chatIds: archivedIds };
}

// ---------------------------------------------------------------------------
// Query: find unarchived agent chats
// ---------------------------------------------------------------------------

/**
 * Find agent chats that need archiving for synthesis.
 *
 * Criteria:
 * - chatType === 'agent'
 * - updatedAt > 5 minutes ago (not currently active)
 * - message count > 4 (skip trivial chats)
 * - No archives exist yet
 *
 * Ordered by most recently modified first.
 */
async function findUnarchivedChats(maxChats: number): Promise<string[]> {
  const db = getDb();
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  // Subquery: chats that already have archives
  const archivedChatIds = db
    .prepare("SELECT DISTINCT chatId FROM context_archives")
    .all() as { chatId: string }[];
  const archivedSet = new Set(archivedChatIds.map((r) => r.chatId));

  // Get candidate agent chats (excluding the system chat itself)
  const rows = db
    .prepare(`
      SELECT id, messages, lastModified
      FROM chats
      WHERE type = 'agent'
        AND id != 'system'
        AND lastModified < ?
      ORDER BY lastModified DESC
      LIMIT ?
    `)
    .all(fiveMinAgo, maxChats * 2) as Array<{
      id: string;
      messages: string;
      lastModified: string;
    }>;

  const chatIds: string[] = [];
  for (const row of rows) {
    // Skip already-archived chats
    if (archivedSet.has(row.id)) continue;

    // Parse messages and check count
    const messages = JSON.parse(row.messages) as ChatMessage[];
    const messageCount = messages.filter((m) => !m._outOfContext).length;
    if (messageCount <= 4) continue;

    chatIds.push(row.id);
    if (chatIds.length >= maxChats) break;
  }

  return chatIds;
}

// ---------------------------------------------------------------------------
// Archive a single chat for synthesis access
// ---------------------------------------------------------------------------

/**
 * Archive all substantive messages in a chat for synthesis context access.
 *
 * Creates `context_archives` entries with LLM-generated index descriptions.
 * Does NOT modify the original chat (unlike compaction which marks messages
 * as out-of-context and inserts summaries).
 *
 * Returns true if any archives were created.
 */
async function archiveChatForSynthesis(chatId: string): Promise<boolean> {
  const db = getDb();
  const row = db.prepare(
    "SELECT id, modelId, messages FROM chats WHERE id = ?"
  ).get(chatId) as
    | {
        id: string;
        modelId: string;
        messages: string;
      }
    | undefined;

  if (!row) return false;

  const messages = JSON.parse(row.messages) as ChatMessage[];

  // Filter: only substantive conversation messages, exclude metadata rows.
  // Persisted system rows are passive-recall / memory-delta injections; they
  // duplicate memory-store content and produce empty "Conversation context"
  // archive blocks because index formatting intentionally ignores system text.
  const substantiveMessages = messages.filter(
    (m) => !m._outOfContext && !m._isCompactionSummary && m.role !== "system"
  );

  if (substantiveMessages.length <= 4) return false;

  // Group into logical blocks
  const blocks = groupIntoBlocks(substantiveMessages);
  if (blocks.length === 0) return false;

  // Assign archive IDs
  const startSeq = getNextArchiveSequence(chatId);
  const shortChatId = chatId.slice(0, 8);
  const archives: ContextArchive[] = [];
  const blockDescriptions: Array<{ id: string; text: string }> = [];

  for (let i = 0; i < blocks.length; i++) {
    const seqNum = startSeq + i;
    const id = `archive:${shortChatId}:${String(seqNum).padStart(3, "0")}`;
    const block = blocks[i];
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
      sequenceNum: seqNum,
      messages: block,
      indexEntry: "", // filled by LLM
      messageCount: block.length,
      estimatedTokens: tokens,
      createdAt: new Date().toISOString(),
    });
    blockDescriptions.push({ id, text });
  }

  // Generate index descriptions via extraction model
  await generateIndexEntries(archives, blockDescriptions, row.modelId);

  // Persist archives
  saveArchives(archives);
  console.log(
    `[pre-synthesis] Archived ${archives.length} blocks for chat ${chatId} (${substantiveMessages.length} messages)`
  );

  return true;
}

// ---------------------------------------------------------------------------
// Message grouping (reuses compaction.ts logic)
// ---------------------------------------------------------------------------

/**
 * Group messages into logical archive blocks:
 * - User + visible assistant turn (including all _toolLoopId fragments) → one block
 * - Standalone visible assistant turn (all _toolLoopId fragments) → one block
 * - Legacy collapsed assistant-with-tools row → one block
 * - Standalone messages → one block
 */
function groupIntoBlocks(messages: ChatMessage[]): ChatMessage[][] {
  const blocks: ChatMessage[][] = [];
  let i = 0;

  const collectLoopFragments = (start: number, loopId: string, into: ChatMessage[]): number => {
    let j = start;
    while (
      j < messages.length &&
      messages[j].role === "assistant" &&
      messages[j]._toolLoopId === loopId
    ) {
      into.push(messages[j]);
      j++;
    }
    return j;
  };

  while (i < messages.length) {
    const m = messages[i];

    // User + following visible assistant turn. Canonical multi-fragment
    // turns share a _toolLoopId across N rows; archive them together so a
    // single visible exchange becomes a single archive block.
    if (m.role === "user") {
      const block: ChatMessage[] = [m];
      const next = i + 1 < messages.length ? messages[i + 1] : null;
      if (next?.role === "assistant") {
        if (next._toolLoopId) {
          i = collectLoopFragments(i + 1, next._toolLoopId, block);
        } else {
          block.push(next);
          i += 2;
        }
      } else {
        i++;
      }
      blocks.push(block);
      continue;
    }

    // Canonical tool-loop fragments not preceded by a user message.
    if (m.role === "assistant" && m._toolLoopId) {
      const block: ChatMessage[] = [];
      i = collectLoopFragments(i, m._toolLoopId, block);
      blocks.push(block);
      continue;
    }

    // Legacy collapsed assistant message with tool calls.
    if (m.role === "assistant" && m.toolCalls?.length) {
      blocks.push([m]);
      i++;
      continue;
    }

    // Anything else: standalone block.
    blocks.push([m]);
    i++;
  }
  return blocks;
}

/**
 * Format a block of messages into readable text for the index description.
 */
function blockToText(block: ChatMessage[], maxPerMessage = 600): string {
  const parts: string[] = [];
  for (const m of block) {
    if (m.role === "user") {
      parts.push(`user: ${truncateMiddle(m.content, maxPerMessage)}`);
    } else if (m.role === "assistant") {
      // Thinking is the primary signal — it contains the agent's reasoning,
      // analysis, and decisions. The final output is often terse ("Clean, here's
      // what I changed") while the thinking has the substance.
      if (m.thinking) {
        parts.push(`thinking: ${truncateMiddle(m.thinking, maxPerMessage)}`);
      }
      if (m.content) {
        parts.push(`assistant: ${truncateMiddle(m.content, maxPerMessage)}`);
      }
      if (m.toolCalls?.length) {
        const callSummary = m.toolCalls
          .map((tc) => `${tc.name}(${summarizeArgs(tc.arguments, 80)})`)
          .join(", ");
        parts.push(`tools: ${callSummary}`);
      }
      if (m.toolResults?.length) {
        for (const tr of m.toolResults) {
          parts.push(`result [${tr.toolName}]: ${truncateMiddle(tr.content, 300)}`);
        }
      }
    }
  }
  return parts.join("\n");
}

/**
 * Truncate a string showing both the beginning and end.
 */
function truncateMiddle(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const headLen = Math.ceil(maxLen * 0.6);
  const tailLen = Math.floor(maxLen * 0.4) - 5;
  return `${text.slice(0, headLen)} ... ${text.slice(-tailLen)}`;
}

/**
 * Summarize tool call arguments for the index.
 */
function summarizeArgs(args: Record<string, unknown>, maxLen: number): string {
  try {
    const entries = Object.entries(args);
    if (entries.length === 0) return "";
    if (entries.length === 1 && typeof entries[0][1] === "string") {
      const val = String(entries[0][1]);
      return val.length > maxLen ? val.slice(0, maxLen) + "..." : val;
    }
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

/**
 * Generate a readable fallback description when the LLM fails.
 */
function generateFallbackDescription(block: ChatMessage[]): string {
  let assistantThinking = "";
  let assistantAnalysis = "";
  let userQuestion = "";
  const toolNames: string[] = [];
  let resultPreview = "";

  for (const m of block) {
    if (m.role === "user" && !userQuestion) {
      userQuestion = m.content.slice(0, 150).replace(/\n/g, " ");
    }
    if (m.role === "assistant") {
      // Thinking is the primary signal for fallback too.
      if (m.thinking && !assistantThinking) {
        const thinking = m.thinking.replace(/\n/g, " ").trim();
        if (thinking.length > 150) {
          assistantThinking = thinking.slice(0, 100) + " ... " + thinking.slice(-50);
        } else {
          assistantThinking = thinking;
        }
      }
      if (m.content && m.content.length > 100 && !assistantAnalysis) {
        const head = m.content.slice(0, 80).replace(/\n/g, " ");
        const tail =
          m.content.length > 200
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
        const firstResult = m.toolResults[0];
        resultPreview = firstResult.content.slice(0, 100).replace(/\n/g, " ");
      }
    }
  }

  if (assistantThinking) return assistantThinking;
  if (assistantAnalysis) return assistantAnalysis;
  if (resultPreview) return resultPreview;
  if (userQuestion) return `Question: ${userQuestion}`;
  if (toolNames.length > 0) {
    const unique = [...new Set(toolNames)];
    return `Tool calls: ${unique.join(", ")} (${toolNames.length} total)`;
  }
  return "Conversation context";
}

// ---------------------------------------------------------------------------
// Token estimation (reuses compaction.ts logic)
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// LLM index generation (reuses compaction.ts pattern)
// ---------------------------------------------------------------------------

/**
 * Generate index descriptions for archive blocks using the extraction model.
 * Falls back to the main chat model if extraction model is unavailable.
 */
async function generateIndexEntries(
  archives: ContextArchive[],
  blockDescriptions: Array<{ id: string; text: string }>,
  modelId: string,
): Promise<void> {
  const { getSettings } = await import("./chat-storage.js");
  const settings = await getSettings();
  const extractionUrl = settings.extractionModelUrl;

  // Budget per block — more chars for fewer blocks.
  // Increased to 12000 total (from 6000) to accommodate thinking content
  // and give the index model enough context to produce meaningful descriptions.
  const perBlockBudget = Math.min(2000, Math.max(700, Math.floor(12000 / blockDescriptions.length)));
  const inputParts = blockDescriptions
    .map((b) => `[${b.id}]\n${b.text.slice(0, perBlockBudget)}`)
    .join("\n\n---\n\n");

  const systemPrompt = `You are generating a structured index of conversation content being archived for future retrieval.
For each block below (identified by its archive ID), write a one-line description.

Format your response as exactly one line per block:
${blockDescriptions.map((b) => `- ${b.id} — <description>`).join("\n")}

Descriptions should capture the SIGNIFICANCE of each block — what was learned, decided, or accomplished — not just what actions were taken. A good description answers "why would I need this later?"

Good descriptions:
- archive:abc:001 — Identified P0 bug in memory reset during compaction; /compact path skipped resetMemoryContext
- archive:abc:002 — Reviewed indexed summary architecture; concluded lossless archival beats narrative summarization
- archive:abc:003 — Read compaction.ts to understand truncation thresholds (75% pre-send, 50% post-response, 85% mid-turn)

Bad descriptions (too vague or action-focused):
- archive:abc:001 — File reads and grep searches
- archive:abc:002 — Tool calls: read_file, edit_file

Prioritize: conclusions > findings > decisions > questions asked > tools used.

Output ONLY the formatted lines, nothing else.`;

  let outputText = "";

  if (extractionUrl) {
    const extractionSettings = normalizeExtractionRequestSettings(settings);
    outputText = await callExtractionModel(
      extractionUrl,
      modelId,
      systemPrompt,
      inputParts,
      settings.extractionModelId || "index-gen",
      extractionSettings.maxTokens,
      extractionSettings.timeoutMs,
    );
  }

  if (!outputText) {
    // Fallback: use main chat model
    const { streamChat } = await import("./agent.js");
    const result = await streamChat(
      modelId,
      [{ role: "user", content: inputParts, timestamp: Date.now() }],
      systemPrompt,
      () => {},
    );
    outputText = result.content.trim() || result.thinking?.trim() || "";
  }

  console.log(`[pre-synthesis] Index LLM output (${outputText.length}ch): ${outputText.slice(0, 300)}`);

  // Parse LLM output into per-archive descriptions
  const lines = outputText.split("\n");
  for (const line of lines) {
    const match = line.match(/^[-*]?\s*(archive:\S+)\s*[—–\-:]\s*(.+)$/);
    if (match) {
      const archive = archives.find((a) => a.id === match[1]);
      if (archive) archive.indexEntry = match[2].trim();
    }
  }

  // Fill missing entries with fallback
  let filled = 0;
  for (const a of archives) {
    if (!a.indexEntry) {
      a.indexEntry = generateFallbackDescription(a.messages);
      filled++;
    }
  }
  if (filled > 0) {
    console.log(`[pre-synthesis] ${filled}/${archives.length} index entries used fallback descriptions`);
  }
}

/**
 * Call the extraction model to generate index descriptions.
 */
async function callExtractionModel(
  extractionUrl: string,
  modelId: string,
  systemPrompt: string,
  userContent: string,
  extractionModelId: string,
  maxTokens: number,
  timeoutMs: number,
): Promise<string> {
  const res = await fetch(`${extractionUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: extractionModelId,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      max_tokens: maxTokens,
      temperature: 0.3,
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.ok) {
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || "";
  }
  return "";
}
