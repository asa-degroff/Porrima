import { StringEnum, Type, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import { embed } from "./embeddings.js";
import {
  deleteMemory,
  getMemoryById,
  searchMemories,
  createMemoryBlock,
  updateMemoryBlock,
  getMemoryBlock,
  searchBlocks,
  listMemoryBlocks,
  getBlockHistory,
  getMaxBlockChars,
} from "./memory-storage.js";
import { searchChatMessages, getChatMessageRange, getChatTitle, getArchive, searchArchives } from "./chat-storage.js";
import { dedupAndSave } from "./memory-extraction.js";
import type { ChatMessage, MemoryCategory } from "../types.js";
import { VALID_MEMORY_CATEGORIES } from "../types.js";

export const MEMORY_TOOLS: Tool[] = [
  {
    name: "save_memory",
    description:
      "Save an important fact. Use whenever you want to remember something. " +
      "If the fact corrects or updates an existing memory, pass supersedeMemoryId — " +
      "the old memory is kept but marked superseded, preserving lineage instead of " +
      "leaving two conflicting facts in circulation.",
    parameters: Type.Object({
      text: Type.String({ description: "The fact to remember" }),
      category: StringEnum(
        VALID_MEMORY_CATEGORIES as unknown as readonly [string, ...string[]],
        { description: "Category of the memory" }
      ),
      importance: Type.Number({
        description: "Importance from 1-10",
        minimum: 1,
        maximum: 10,
      }),
      supersedeMemoryId: Type.Optional(
        Type.String({
          description:
            "ID of an existing memory that this new memory replaces (it is stale or wrong). " +
            "The old memory is kept but marked superseded, not deleted. " +
            "Find IDs via search_memory. Omit when the fact is genuinely new.",
        })
      ),
    }),
  },
  {
    name: "search_memory",
    description:
      "Search your memories for relevant information. Use when you need to recall something from your past conversations. Supports date filtering and sorting.",
    parameters: Type.Object({
      query: Type.String({ description: "What to search for" }),
      from: Type.Optional(Type.String({ description: "Only memories created after this date (ISO 8601, e.g. '2026-01-01')" })),
      to: Type.Optional(Type.String({ description: "Only memories created before this date (ISO 8601, e.g. '2026-03-30')" })),
      sort_by: Type.Optional(StringEnum(
        ["relevance", "newest", "oldest"] as const,
        { description: "Sort order: relevance (default), newest, or oldest" }
      )),
    }),
  },
  {
    name: "search_conversation",
    description:
      "Search past chats for specific details. Use when a memory lacks the detail you need — this lets you find the original exchange. Can search a specific chat (by memory_id or chat_id) or across all chats.",
    parameters: Type.Object({
      query: Type.String({ description: "Search terms to find in past chat messages" }),
      memory_id: Type.Optional(
        Type.String({ description: "Memory ID — automatically looks up the source chat" })
      ),
      chat_id: Type.Optional(
        Type.String({ description: "Chat ID to search within a specific chat" })
      ),
      limit: Type.Optional(
        Type.Number({ description: "Max matches to return (default 5)", minimum: 1, maximum: 50 })
      ),
    }),
  },
  {
    name: "read_archived_context",
    description:
      "Retrieve the content of an archived context block by its ID. Use this when you see an archive reference (e.g. archive:xxxx:001) in a compaction summary and need the exact details — conversation content, tool outputs, code. User/assistant conversation is rendered first; reasoning traces are omitted by default (pass include_thinking=true to include them), and tool activity is trimmed as needed to fit. Use offset/limit to page through large archives.",
    parameters: Type.Object({
      archive_id: Type.String({ description: "Archive block ID (e.g. archive:abc12345:001)" }),
      include_thinking: Type.Optional(
        Type.Boolean({ description: "Include reasoning traces (thinking blocks). Default false — thinking is verbose and rarely needed to recover facts or conclusions." }),
      ),
      offset: Type.Optional(
        Type.Number({ description: "0-based index of the first message to render. Use with limit to page through large archives.", minimum: 0 }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Maximum number of messages to render. Use with offset to page through large archives.", minimum: 1 }),
      ),
    }),
  },
  {
    name: "create_memory_block",
    description:
      "Create a structured memory block — a named, editable document for organizing knowledge about a topic, project, or domain. Use this to consolidate related facts into a coherent document. Blocks are indexed and searchable.",
    parameters: Type.Object({
      name: Type.String({ description: "Block name (e.g. 'Tech Stack', 'User Preferences', 'Architecture', 'Topic Details')" }),
      description: Type.String({ description: "One-line summary of what this block covers — used for retrieval and indexing" }),
      content: Type.String({ description: "Full block content — structured text, up to the configured limit" }),
      scope: Type.Optional(StringEnum(["global", "project", "archived"], { description: "Scope: 'global' (all chats), 'project' (project-scoped), or 'archived' (hidden from context, searchable). Default: global" })),
      project_id: Type.Optional(Type.String({ description: "Project ID for project-scoped blocks" })),
    }),
  },
  {
    name: "update_memory_block",
    description:
      "Update an existing memory block's content or description. Use this to refine, expand, or correct knowledge in a block. Updates exceeding the configured character limit are rejected with the exact overage — split into multiple blocks if the content is too large.",
    parameters: Type.Object({
      block_id: Type.String({ description: "Block ID (e.g. blk-...)" }),
      content: Type.Optional(Type.String({ description: "New content to replace the block's content" })),
      description: Type.Optional(Type.String({ description: "Updated one-line description" })),
      scope: Type.Optional(StringEnum(["global", "project", "archived"], { description: "Change scope (e.g. 'archived' to hide from context while keeping searchable)" })),
      project_id: Type.Optional(Type.String({ description: "Reassign to a different project (pass empty string to clear)" })),
    }),
  },
  {
    name: "read_memory_block",
    description:
      "Load the full content of a memory block. Use when you see a block reference in the Available Memory Blocks section and need the full details.",
    parameters: Type.Object({
      block_id: Type.String({ description: "Block ID (e.g. blk-...)" }),
    }),
  },
  {
    name: "list_memory_blocks",
    description:
      "List available memory blocks by scope. Use this to discover what knowledge blocks exist before reading or creating new ones. Defaults to showing the 15 most recently updated non-archived blocks. Use scope='archived' to see archived-only blocks. To find blocks by content, use search_memory.",
    parameters: Type.Object({
      scope: Type.Optional(StringEnum(["global", "project", "archived"], { description: "Filter by scope. Default excludes 'archived' blocks — use scope='archived' to see archived-only, or scope='global'/'project' to restrict." })),
      project_id: Type.Optional(Type.String({ description: "Project ID for project-scoped blocks" })),
      recent_days: Type.Optional(Type.Number({ description: "Only return blocks updated within the last N days. Omit for no recency filter." })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of blocks to return (default 15). Set higher to see more results." })),
    }),
  },
  {
    name: "create_notebook_entry",
    description:
      "Write a notebook entry — a narrative reflection, daily synthesis, or longer-form note in your own voice. " +
      "Notebook entries are preserved verbatim (no character cap), remain fully searchable via search_memory and " +
      "list_memory_blocks, and are excluded from active context so they don't crowd the system prompt. " +
      "Use this when writing prose — save_memory is for atomic facts, notebook entries are for narrative.",
    parameters: Type.Object({
      content: Type.String({
        description: "The full notebook entry content (markdown allowed, no length cap)",
      }),
      date: Type.Optional(Type.String({
        description: "Optional YYYY-MM-DD date. Defaults to today. Used in the block id and name.",
      })),
    }),
  },
];

export interface ToolResult {
  content: string;
  isError: boolean;
}

function suggestSimilarBlocks(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return "";
  const blocks = listMemoryBlocks({ query: trimmed, includeInternal: true }).slice(0, 5);
  return blocks
    .map((b) => `- [${b.id}] ${b.name} (${b.scope}${b.projectId ? `, project: ${b.projectId}` : ""}) — ${b.description} [updated ${b.updatedAt.slice(0, 10)}]`)
    .join("\n");
}

// --- Memory block context helpers ---

type BlockType = "note" | "notebook" | "synthesis";

/**
 * Resolve the block identity (id + blockType) for a freshly created block.
 * Blocks created during the notebook synthesis cycle are routed through the
 * notebook ID prefix and tagged `notebook` so they inherit the same system-block
 * exclusion as blocks created via createNotebookBlock. All other blocks get a
 * plain `blk-<uuid>` id and `note` type.
 */
async function resolveNewBlockIdentity(chatId: string): Promise<{ id: string; blockType: BlockType }> {
  const { v4: uuid } = await import("uuid");
  const { NOTEBOOK_CYCLE_CHAT_ID, generateNotebookBlockId } = await import("./notebook-storage.js");
  if (chatId === NOTEBOOK_CYCLE_CHAT_ID) {
    return { id: generateNotebookBlockId("notebook"), blockType: "notebook" };
  }
  return { id: `blk-${uuid()}`, blockType: "note" };
}

/**
 * Auto-assign a projectId for project-scoped blocks when the caller didn't
 * supply one. Infers it from the chat context (the agent may not have the UUID).
 * Pass `existingProjectId` when updating so it's preserved unless overridden.
 */
async function resolveProjectIdForScope(
  scope: string | undefined,
  projectId: string | undefined,
  chatId: string | undefined,
): Promise<string> {
  if (projectId) return projectId;
  if (scope === "project" && chatId && !projectId) {
    const { getChat } = await import("./chat-storage.js");
    const chat = await getChat(chatId);
    if (chat?.projectId) return chat.projectId;
  }
  return "";
}

// --- read_archived_context formatting helpers ---

/**
 * Per-field character caps applied when rendering an archive. Thinking is
 * capped separately via `thinkingCap` so it can be omitted entirely by
 * default (thinking routinely dominates an archive — up to ~95% of the
 * chars — and buries the conclusions the caller is actually after).
 */
interface ArchiveRenderCaps {
  user: number;
  agent: number;
  args: number;
  result: number;
  thinking: number;
  /** When false, tool calls/results collapse into a one-line count summary. */
  tools: boolean;
}

const ARCHIVE_CAPS_FULL: ArchiveRenderCaps = { user: 8000, agent: 12000, args: 500, result: 4000, thinking: 8000, tools: true };
const ARCHIVE_CAPS_REDUCED: ArchiveRenderCaps = { user: 4000, agent: 8000, args: 300, result: 1500, thinking: 0, tools: true };
const ARCHIVE_CAPS_MINIMAL: ArchiveRenderCaps = { user: 2000, agent: 4000, args: 200, result: 600, thinking: 0, tools: true };

/** Budget used when the caller doesn't supply one (e.g. headless runners). */
const DEFAULT_ARCHIVE_READ_BUDGET_CHARS = 24_000;

function truncateMiddleArchive(text: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (text.length <= maxLen) return text;
  if (maxLen < 16) return text.slice(0, maxLen);
  const headLen = Math.ceil(maxLen * 0.6);
  const tailLen = Math.floor(maxLen * 0.4) - 5;
  return `${text.slice(0, headLen)} ... ${text.slice(-tailLen)}`;
}

/**
 * Render archived messages as readable conversation text under the given caps.
 * Conversation (user/agent) is emitted first within each turn because that is
 * what retrieval almost always wants; reasoning and tool activity follow and
 * absorb any trimming.
 */
function renderArchiveMessages(messages: ChatMessage[], caps: ArchiveRenderCaps): string[] {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      lines.push(`user: ${truncateMiddleArchive(m.content || "", caps.user)}`);
    } else if (m.role === "assistant") {
      if (m.content) lines.push(`agent: ${truncateMiddleArchive(m.content, caps.agent)}`);
      if (m.thinking && caps.thinking > 0) {
        lines.push(`thinking: ${truncateMiddleArchive(m.thinking, caps.thinking)}`);
      }
      const callCount = m.toolCalls?.length ?? 0;
      const resultCount = m.toolResults?.length ?? 0;
      if (!caps.tools) {
        if (callCount || resultCount) {
          lines.push(`[tool activity: ${callCount} call(s), ${resultCount} result(s) — omitted to fit budget]`);
        }
        continue;
      }
      if (m.toolCalls?.length) {
        for (const tc of m.toolCalls) {
          lines.push(`tool_call: ${tc.name}(${truncateMiddleArchive(JSON.stringify(tc.arguments), caps.args)})`);
        }
      }
      if (m.toolResults?.length) {
        for (const tr of m.toolResults) {
          lines.push(`tool_result [${tr.toolName}]: ${truncateMiddleArchive(tr.content || "", caps.result)}`);
        }
      }
    }
  }
  return lines;
}

/**
 * Format an archive under a char budget, progressively tightening caps until
 * the output fits. Returns the rendered text plus metadata about what was
 * trimmed so the caller can tell the model where to look next.
 */
function formatArchiveWithinBudget(
  archive: { id: string; chatId: string; messageCount: number; estimatedTokens: number; createdAt: string; messages: ChatMessage[] },
  chatTitle: string,
  opts: { includeThinking: boolean; offset: number; limit?: number; budgetChars: number },
): string {
  const total = archive.messages.length;
  const offset = Math.min(Math.max(0, Math.floor(opts.offset)), total);
  const limit = opts.limit != null ? Math.max(1, Math.floor(opts.limit)) : total - offset;
  const window = archive.messages.slice(offset, offset + limit);

  const header: string[] = [
    `Archive: ${archive.id} (${archive.messageCount} messages, ~${archive.estimatedTokens} tokens)`,
    `From chat: ${chatTitle || archive.chatId}`,
    `Archived: ${archive.createdAt.slice(0, 10)}`,
  ];
  if (window.length < total) {
    header.push(`Showing messages ${offset + 1}-${offset + window.length} of ${total} (use offset/limit to page)`);
  }

  const totalThinkingChars = window.reduce((sum, m) => sum + ((m.role === "assistant" && m.thinking) ? m.thinking.length : 0), 0);
  if (totalThinkingChars > 0 && !opts.includeThinking) {
    header.push(`[reasoning traces omitted: ${totalThinkingChars.toLocaleString()} chars — call again with include_thinking=true if you need them]`);
  }
  header.push("---");
  const headerText = header.join("\n");
  // Reserve room for the header, separators, and the worst-case truncation
  // footer so the final string lands under the caller's tool-result budget
  // and the generic wrapper never has to hard-cut the tail.
  const budget = Math.max(2000, opts.budgetChars - headerText.length - 200);

  const tiers: ArchiveRenderCaps[] = opts.includeThinking
    ? [
        ARCHIVE_CAPS_FULL,
        { ...ARCHIVE_CAPS_REDUCED, thinking: 2000 },
        { ...ARCHIVE_CAPS_MINIMAL, thinking: 800 },
        { ...ARCHIVE_CAPS_MINIMAL, thinking: 400, tools: false },
      ]
    : [
        { ...ARCHIVE_CAPS_FULL, thinking: 0 },
        ARCHIVE_CAPS_REDUCED,
        ARCHIVE_CAPS_MINIMAL,
        { ...ARCHIVE_CAPS_MINIMAL, tools: false },
      ];

  let body = renderArchiveMessages(window, tiers[0]);
  for (let i = 1; i < tiers.length; i++) {
    if (body.join("\n").length <= budget) break;
    body = renderArchiveMessages(window, tiers[i]);
  }

  // Last resort: still over budget at the tightest tier. Scale the
  // highest-value fields (agent/user) down proportionally rather than letting
  // the generic tool-result wrapper hard-cut the tail, which is where
  // conclusions live. Iterates because the per-field floors keep a single
  // pass slightly over.
  let text = body.join("\n");
  const tight = tiers[tiers.length - 1];
  let scale = 1;
  for (let pass = 0; pass < 6 && text.length > budget; pass++) {
    scale = Math.max(0.05, scale * (budget / text.length));
    body = renderArchiveMessages(window, {
      ...tight,
      tools: false,
      user: Math.max(200, Math.floor(tight.user * scale)),
      agent: Math.max(400, Math.floor(tight.agent * scale)),
      thinking: Math.max(0, Math.floor(tight.thinking * scale)),
    });
    text = body.join("\n");
    if (scale <= 0.05) break;
  }

  let footer = "";
  if (text.length > budget) {
    text = text.slice(0, budget);
    footer = `\n[output truncated to fit context budget — use offset/limit to page through this archive]`;
  }

  return `${headerText}\n${text}${footer}`;
}

export async function executeMemoryTool(
  toolCall: ToolCall,
  chatId: string,
  opts: { maxResultChars?: number } = {},
): Promise<ToolResult> {
  switch (toolCall.name) {
    case "save_memory": {
      const { text, category, importance, supersedeMemoryId } = toolCall.arguments;
      if (!text) return { content: "Missing text", isError: true };

      // Validate the supersession target before spending an embedding call.
      let supersedeTargetId: string | undefined;
      if (supersedeMemoryId) {
        const target = await getMemoryById(supersedeMemoryId);
        if (!target) {
          return {
            content: `Cannot supersede: memory not found: ${supersedeMemoryId}. Use search_memory to find the correct ID.`,
            isError: true,
          };
        }
        if (target.supersededBy) {
          return {
            content: `Cannot supersede: ${supersedeMemoryId} is already superseded by ${target.supersededBy}. Supersede the current version instead.`,
            isError: true,
          };
        }
        supersedeTargetId = target.id;
      }

      let embedding: number[];
      try {
        embedding = await embed(text);
      } catch (e: any) {
        return { content: `Embedding failed: ${e.message}`, isError: true };
      }

      const fact = {
        text,
        category: (category as MemoryCategory) || "fact",
        importance: Math.min(10, Math.max(1, importance || 5)),
        subject: '',
      };

      const outcome = await dedupAndSave([fact], [embedding], chatId, { sourceType: 'explicit', supersedeMemoryId: supersedeTargetId });

      if (outcome.added === 0 && outcome.skippedDuplicates === 0) {
        return { content: "Memory was not saved — source chat no longer exists.", isError: true };
      }

      if (outcome.skippedAsDuplicates.length > 0) {
        const dup = outcome.skippedAsDuplicates[0];
        return {
          content: `Not saved — near-duplicate of existing memory [${dup.memoryId}]: "${dup.text}" (similarity ${dup.similarity.toFixed(3)}); importance bumped. If that memory is stale and this text is the correction, re-save with supersedeMemoryId: ${dup.memoryId}`,
          isError: false,
        };
      }

      if (supersedeTargetId) {
        const newId = outcome.savedIds[0];
        if (outcome.superseded > 0) {
          return { content: `Superseded [${supersedeTargetId}] with [${newId}]: "${text}"`, isError: false };
        }
        return {
          content: `Saved [${newId}]: "${text}", but the supersession link was rejected: ${outcome.supersedeLinkErrors[0] ?? "unknown reason"}. The old memory is unchanged.`,
          isError: true,
        };
      }

      return { content: `Saved memory [${outcome.savedIds[0]}]: "${text}"`, isError: false };
    }

    case "search_memory": {
      const { query, from, to, sort_by } = toolCall.arguments;
      if (!query) return { content: "Missing query", isError: true };

      let queryEmbedding: number[];
      try {
        queryEmbedding = await embed(query);
      } catch (e: any) {
        return { content: `Embedding failed: ${e.message}`, isError: true };
      }

      const dateRange = (from || to) ? { from, to } : undefined;
      const results = await searchMemories(queryEmbedding, 5, new Date(), query, dateRange);
      if (results.length === 0) {
        return { content: "No relevant memories found.", isError: false };
      }

      // Apply sort override if requested
      if (sort_by === "newest") {
        results.sort((a, b) => new Date(b.memory.createdAt).getTime() - new Date(a.memory.createdAt).getTime());
      } else if (sort_by === "oldest") {
        results.sort((a, b) => new Date(a.memory.createdAt).getTime() - new Date(b.memory.createdAt).getTime());
      }

      const formatted = results
        .map(
          (r) => {
            const created = r.memory.createdAt.slice(0, 10);
            const source = r.memory.sourceChatId ? `, source: ${r.memory.sourceChatId}` : "";
            const superseded = r.memory.supersededBy
              ? ` [SUPERSEDED by ${r.memory.supersededBy}]`
              : "";
            const supersedes = r.memory.supersedes
              ? `, supersedes: ${r.memory.supersedes}`
              : "";
            const subjectLine = r.memory.subject
              ? `(subject: ${r.memory.subject})\n`
              : "";
            return `${subjectLine}- [${r.memory.id}] ${r.memory.text} (${r.memory.category}, importance: ${r.memory.importance}/10, created: ${created}, score: ${r.score.toFixed(3)}${source}${supersedes})${superseded}`;
          }
        )
        .join("\n");

      // Also search memory blocks for matching content
      const blockResults = searchBlocks(query, { limit: 3 });
      let blockSection = "";
      if (blockResults.length > 0) {
        const blockFormatted = blockResults
          .map((r) => `- [${r.block.id}] ${r.block.name}: ...${r.excerpt.slice(0, 1000)}... (use read_memory_block to see full content)`)
          .join("\n");
        blockSection = `\n\nMemory blocks:\n${blockFormatted}`;
      }

      return { content: `Found memories:\n${formatted}${blockSection}`, isError: false };
    }

    case "search_conversation": {
      const { query, memory_id, chat_id, limit: maxResults } = toolCall.arguments;
      if (!query) return { content: "Missing query", isError: true };

      const target = await resolveTargetChat(memory_id, chat_id);
      if (!target.ok) {
        return { content: target.content, isError: target.isError };
      }
      const { targetChatId, memoryContext } = target;
      const scopeToSingleChat = !!targetChatId;

      const resultLimit = Math.min(50, Math.max(1, maxResults || 5));
      const matches = searchChatMessages(query, {
        chatId: targetChatId,
        limit: resultLimit,
      });
      const archiveMatches = searchArchives(query, {
        chatId: targetChatId,
        limit: Math.min(5, resultLimit),
      });

      if (matches.length === 0 && archiveMatches.length === 0) {
        const scope = targetChatId
          ? `conversation "${getChatTitle(targetChatId) || targetChatId}"`
          : "any conversation";
        return {
          content: `${memoryContext}No matching messages found in ${scope} for query: "${query}"`,
          isError: false,
        };
      }

      // Sort by BM25 rank, then message index, and group by chat.
      const sortedMatches = [...(matches as ChatMessageMatch[])].sort((a, b) => {
        const rankDiff = a.rank - b.rank;
        if (rankDiff !== 0) return rankDiff;
        return a.messageIndex - b.messageIndex;
      });

      const byChatId = new Map<string, { indices: number[]; ranks: number[] }>();
      for (const m of sortedMatches) {
        const entry = byChatId.get(m.chatId) || { indices: [] as number[], ranks: [] as number[] };
        entry.indices.push(m.messageIndex);
        entry.ranks.push(m.rank);
        byChatId.set(m.chatId, entry);
      }

      const sections: string[] = [];
      if (memoryContext) sections.push(memoryContext.trim());

      let isFirstSection = true;
      for (const [cid, data] of byChatId) {
        const section = formatMatchSection(cid, data, query, scopeToSingleChat);
        if (!isFirstSection && sections.join("\n").length + section.length > CONVERSATION_MAX_CONTENT_CHARS) {
          break;
        }
        isFirstSection = false;
        sections.push(section);
      }

      if (archiveMatches.length > 0) {
        sections.push(formatArchiveSection(archiveMatches as ArchiveMatch[], scopeToSingleChat));
      }

      const content = sections.join("\n");
      const totalMatches = matches.length + archiveMatches.length;
      const truncated = content.length > CONVERSATION_MAX_CONTENT_CHARS;
      return {
        content: `Found ${totalMatches} match(es) (${matches.length} messages, ${archiveMatches.length} archived)${truncated ? " (truncated)" : ""}:\n\n${content}`,
        isError: false,
      };
    }

    case "read_archived_context": {
      const { archive_id, include_thinking, offset, limit } = toolCall.arguments;
      if (!archive_id) return { content: "Missing archive_id", isError: true };

      const archive = getArchive(archive_id) ?? (
        archive_id.startsWith("archive:") ? null : getArchive(`archive:${archive_id}`)
      );
      if (!archive) {
        return { content: `Archive block not found: ${archive_id}`, isError: false };
      }

      const offsetNum = Number(offset);
      const limitNum = Number(limit);
      const content = formatArchiveWithinBudget(archive, getChatTitle(archive.chatId) || "", {
        includeThinking: Boolean(include_thinking),
        offset: Number.isFinite(offsetNum) ? offsetNum : 0,
        limit: limit !== undefined && Number.isFinite(limitNum) ? limitNum : undefined,
        budgetChars: opts.maxResultChars ?? DEFAULT_ARCHIVE_READ_BUDGET_CHARS,
      });
      return { content, isError: false };
    }

    case "create_memory_block": {
      const { name, description, content, scope, project_id } = toolCall.arguments;
      if (!name || !description || !content) {
        return { content: "Missing required fields: name, description, content", isError: true };
      }
      const maxChars = await getMaxBlockChars();
      if (content.length > maxChars) {
        return { content: `Content exceeds ${maxChars} character limit (${content.length} chars). Please shorten or split into multiple blocks.`, isError: true };
      }
      const { id, blockType } = await resolveNewBlockIdentity(chatId);
      const finalProjectId = await resolveProjectIdForScope(scope, project_id, chatId);
      const now = new Date().toISOString();

      const block = createMemoryBlock({
        id,
        name,
        description,
        content,
        scope: scope || "global",
        projectId: finalProjectId,
        createdAt: now,
        updatedAt: now,
        updatedBy: "agent",
        blockType,
        supersededBy: undefined,
        supersedes: undefined,
      });
      return { content: `Created memory block: [${block.id}] "${block.name}" (${content.length}/${maxChars} chars, ${block.tokenEstimate} tokens)`, isError: false };
    }

    case "update_memory_block": {
      const { block_id, content: newContent, description: newDesc, scope: newScope, project_id } = toolCall.arguments;
      if (!block_id) return { content: "Missing block_id", isError: true };

      const existing = getMemoryBlock(block_id);
      if (!existing) {
        const similar = suggestSimilarBlocks([newDesc, newContent].filter(Boolean).join(" "));
        const hint = similar.length
          ? `\n\nSimilar active blocks:\n${similar}`
          : "\n\nUse search_memory to find the current block ID, then retry the update.";
        return { content: `Block not found: ${block_id}${hint}`, isError: false };
      }

      const scopeChanged = newScope !== undefined && newScope !== existing.scope;
      const projectIdVal = project_id !== undefined ? (project_id === "" ? null : project_id) : undefined;
      const finalContent = newContent ?? existing.content;
      const maxChars = await getMaxBlockChars();
      if (finalContent.length > maxChars) {
        // Reject rather than truncate: silent truncation destroys the tail of
        // the document and orphans the old row. The agent sees the exact
        // overage and decides how to split or trim.
        return {
          content: `Content exceeds ${maxChars} character limit (${finalContent.length} chars, ${finalContent.length - maxChars} over). Shorten or split into multiple blocks.`,
          isError: true,
        };
      }

      updateMemoryBlock(block_id, {
        content: newContent,
        description: newDesc,
        scope: newScope,
        projectId: projectIdVal,
        updatedBy: "agent",
      });
      const scopeNote = scopeChanged ? ` scope: ${existing.scope} → ${newScope}` : "";
      const projectNote = projectIdVal !== undefined && projectIdVal !== existing.projectId
        ? ` projectId: ${existing.projectId || "(none)"} → ${projectIdVal || "(none)"}` : "";
      return { content: `Updated block [${block_id}] "${existing.name}" (${finalContent.length}/${maxChars} chars)${scopeNote}${projectNote}`, isError: false };
    }

    case "read_memory_block": {
      const { block_id } = toolCall.arguments;
      if (!block_id) return { content: "Missing block_id", isError: true };

      const block = getMemoryBlock(block_id);
      if (!block) {
        return {
          content: `Block not found: ${block_id}\n\nUse search_memory to find the current block ID, or list_memory_blocks to browse.`,
          isError: false,
        };
      }

      const maxChars = await getMaxBlockChars();
      const lines = [
        `Memory Block: ${block.name} [${block.id}]`,
        `Scope: ${block.scope}${block.projectId ? ` (project: ${block.projectId})` : ""}`,
        `Updated: ${block.updatedAt.slice(0, 10)} by ${block.updatedBy}`,
        `Length: ${block.content.length}/${maxChars} chars (${block.tokenEstimate} tokens)`,
        `---`,
        block.content,
      ];
      return { content: lines.join("\n"), isError: false };
    }

    case "list_memory_blocks": {
      const { scope, project_id, recent_days, limit: maxResults } = toolCall.arguments;
      
      // Default: exclude archived (handled by backend), cap at 15
      const effectiveLimit = maxResults ?? 15;
      
      // Fetch all matching blocks (no limit at DB level — we cap in output)
      const maxChars = await getMaxBlockChars();
      const blocks = listMemoryBlocks({ scope, projectId: project_id, includeInternal: true });
      
      // Apply recency filter if requested
      let filteredBlocks = blocks;
      if (recent_days !== undefined && recent_days !== null) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - recent_days);
        filteredBlocks = blocks.filter((b) => new Date(b.updatedAt) >= cutoff);
      }
      
      if (filteredBlocks.length === 0) {
        return { content: "No memory blocks found matching criteria.", isError: false };
      }
      
      const lines = filteredBlocks.map((b) => 
        `- [${b.id}] ${b.name} (${b.scope}) — ${b.description} [${b.content.length}/${maxChars} chars, ${b.tokenEstimate} tok, updated ${b.updatedAt.slice(0,10)}]`
      );
      
      const shown = Math.min(effectiveLimit, filteredBlocks.length);
      const truncated = filteredBlocks.length > effectiveLimit;
      const output = lines.slice(0, effectiveLimit).join("\n");
      const suffix = truncated ? `\n\n... and ${filteredBlocks.length - effectiveLimit} more block(s). Use limit=<N> or scope='archived' to see additional results.` : "";
      
      return { content: `Found ${filteredBlocks.length} memory block(s) (showing ${shown}):\n${output}${suffix}`, isError: false };
    }

    case "create_notebook_entry": {
      const { content, date } = toolCall.arguments;
      if (!content || typeof content !== "string" || content.trim().length === 0) {
        return { content: "Missing or empty content", isError: true };
      }
      const { createNotebookEntry, extractBlockDescription, findDuplicateAgentNotebookEntry } = await import("./notebook-storage.js");
      const existing = findDuplicateAgentNotebookEntry(content, { type: "notebook", date });
      if (existing) {
        const description = extractBlockDescription(content);
        return {
          content: `Notebook entry already exists [${existing.id}] "${description.slice(0, 60)}..." (${content.length} chars). Skipped duplicate.`,
          isError: false,
        };
      }
      const entry = await createNotebookEntry("agent", content, { type: "notebook", date });
      const description = extractBlockDescription(content);
      return {
        content: `Created notebook entry [${entry.id}] "${description.slice(0, 60)}..." (${content.length} chars)`,
        isError: false,
      };
    }

    default:
      return { content: `Unknown tool: ${toolCall.name}`, isError: true };
  }
}

/**
 * Truncate a long message to a window centered on the first occurrence of any
 * query term. If the message is short enough, return it as-is.
 */
function truncateAroundMatch(text: string, query: string, maxLen: number): string {
  if (text.length <= maxLen) return text;

  // Find the earliest position where any query term appears (case-insensitive)
  const lowerText = text.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);

  let matchPos = -1;
  for (const term of terms) {
    const idx = lowerText.indexOf(term);
    if (idx !== -1 && (matchPos === -1 || idx < matchPos)) {
      matchPos = idx;
    }
  }

  // No term found in this message (it's a context neighbor, not the match itself)
  if (matchPos === -1) {
    return text.slice(0, maxLen) + "... [truncated]";
  }

  // Center a window of maxLen around the match position
  const half = Math.floor(maxLen / 2);
  let start = Math.max(0, matchPos - half);
  let end = start + maxLen;

  // Clamp to text bounds
  if (end > text.length) {
    end = text.length;
    start = Math.max(0, end - maxLen);
  }

  const slice = text.slice(start, end);
  const prefix = start > 0 ? "... " : "";
  const suffix = end < text.length ? " ... [truncated]" : "";
  return prefix + slice + suffix;
}

// --- search_conversation helpers ---

type ChatMessageMatch = {
  chatId: string;
  messageIndex: number;
  role: string;
  content: string;
  rank: number;
};

type ArchiveMatch = { id: string; chatId: string; indexEntry: string; rank: number };

const CONVERSATION_CONTEXT_RADIUS = 2;
const CONVERSATION_MAX_CONTENT_CHARS = 6000;

/**
 * Resolve the target chat for a conversation search from either an explicit
 * `chat_id` or a `memory_id` (looking up the memory's source chat).
 * Returns `{ targetChatId, memoryContext }` on success, or an early-exit
 * result string when the memory is missing or has no linked conversation.
 */
async function resolveTargetChat(
  memoryId: string | undefined,
  chatId: string | undefined,
): Promise<
  | { ok: true; targetChatId: string | undefined; memoryContext: string }
  | { ok: false; content: string; isError: boolean }
> {
  if (!memoryId || chatId) {
    return { ok: true, targetChatId: chatId, memoryContext: "" };
  }
  const memory = await getMemoryById(memoryId);
  if (!memory) {
    return { ok: false, content: `Memory not found: ${memoryId}`, isError: true };
  }
  if (memory.sourceChatId) {
    return {
      ok: true,
      targetChatId: memory.sourceChatId,
      memoryContext: `Searching conversation that produced memory: "${memory.text}"\n\n`,
    };
  }
  return {
    ok: false,
    content: `Memory "${memoryId}" has no linked source conversation.`,
    isError: false,
  };
}

/**
 * Merge overlapping context-window indices into a minimal set of [start, end]
 * ranges. Each index expands to `[idx - radius, idx + radius]`; adjacent or
 * overlapping ranges are coalesced.
 */
function mergeContextRanges(indices: number[], radius: number): Array<[number, number]> {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (const idx of sorted) {
    const start = Math.max(0, idx - radius);
    const end = idx + radius;
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      ranges.push([start, end]);
    }
  }
  return ranges;
}

/**
 * Format one chat's matches into a single section string: a chat label (when
 * searching across chats), then each merged context range rendered with
 * match markers (`<<<`) and per-message truncation around the query terms.
 */
function formatMatchSection(
  chatId: string,
  data: { indices: number[]; ranks: number[] },
  query: string,
  scopeToSingleChat: boolean,
): string {
  const title = getChatTitle(chatId);
  const chatLabel = scopeToSingleChat
    ? ""
    : `\n--- ${title || "Untitled"} (${chatId}) [rank: ${Math.abs(Math.min(...data.ranks)).toFixed(1)}] ---\n`;

  const sortedIndices = [...new Set(data.indices)].sort((a, b) => a - b);
  const ranges = mergeContextRanges(sortedIndices, CONVERSATION_CONTEXT_RADIUS);

  const groups: string[] = [];
  for (const [start, end] of ranges) {
    const contextMsgs = getChatMessageRange(chatId, start, end);
    const formatted = contextMsgs
      .map((m) => {
        const marker = sortedIndices.includes(m.messageIndex) ? " <<<" : "";
        const text = truncateAroundMatch(m.content, query, 800);
        return `  [${m.messageIndex}] ${m.role}: ${text}${marker}`;
      })
      .join("\n");
    groups.push(formatted);
  }

  return chatLabel + groups.join("\n  ...\n");
}

/**
 * Format archive matches into a trailing section.
 */
function formatArchiveSection(archiveMatches: ArchiveMatch[], scopeToSingleChat: boolean): string {
  const lines: string[] = ["\n--- Archived Context ---"];
  for (const am of archiveMatches) {
    const chatLabel = scopeToSingleChat ? "" : ` (${getChatTitle(am.chatId) || am.chatId})`;
    lines.push(`  [${am.id}]${chatLabel}: ${am.indexEntry}`);
  }
  lines.push("  Use read_archived_context(archive_id) to retrieve full content.");
  return lines.join("\n");
}
