import { Type } from "@sinclair/typebox";
import { embed } from "./embeddings.js";
import {
  deleteMemory,
  getMemoryById,
  searchMemories,
  createMemoryBlock,
  updateMemoryBlock,
  getMemoryBlock,
  searchBlocks,
  supersedeBlock,
  listMemoryBlocks,
  getBlockHistory,
  getMaxBlockChars,
} from "./memory-storage.js";
import { searchChatMessages, getChatMessageRange, getChatTitle, getArchive, searchArchives } from "./chat-storage.js";
import { dedupAndSave } from "./memory-extraction.js";
import type { Tool, ToolCall } from "@mariozechner/pi-ai";
import type { MemoryCategory } from "../types.js";
import { StringEnum } from "@mariozechner/pi-ai";

export const MEMORY_TOOLS: Tool[] = [
  {
    name: "save_memory",
    description:
      "Save an important fact. Use whenever you want to remember something.",
    parameters: Type.Object({
      text: Type.String({ description: "The fact to remember" }),
      category: StringEnum(
        ["preference", "fact", "behavior", "instruction", "context", "decision", "note", "reflection"] as const,
        { description: "Category of the memory" }
      ),
      importance: Type.Number({
        description: "Importance from 1-10",
        minimum: 1,
        maximum: 10,
      }),
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
      "Retrieve the full content of an archived context block by its ID. Use this when you see an archive reference (e.g. archive:xxxx:001) in a compaction summary and need the exact details — tool outputs, code, reasoning traces.",
    parameters: Type.Object({
      archive_id: Type.String({ description: "Archive block ID (e.g. archive:abc12345:001)" }),
    }),
  },
  {
    name: "create_memory_block",
    description:
      "Create a structured memory block — a named, editable document for organizing knowledge about a topic, project, or domain. Use this to consolidate related facts into a coherent document. Blocks are indexed and searchable across all chats.",
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
      "Update an existing memory block's content or description. Use this to refine, expand, or correct knowledge in a block. If the block would exceed the configured character limit, consider splitting into a new block.",
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
      "List available memory blocks by scope or search. Use this to discover what knowledge blocks exist before reading or creating new ones. Defaults to showing the 15 most recently updated non-archived blocks. Use scope='archived' to see archived-only blocks.",
    parameters: Type.Object({
      scope: Type.Optional(StringEnum(["global", "project", "archived"], { description: "Filter by scope. Default excludes 'archived' blocks — use scope='archived' to see archived-only, or scope='global'/'project' to restrict." })),
      project_id: Type.Optional(Type.String({ description: "Project ID for project-scoped blocks" })),
      query: Type.Optional(Type.String({ description: "Optional search query to filter blocks by name/description" })),
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
      "Use this instead of save_memory when writing prose — save_memory is for atomic facts, notebook entries are for narrative.",
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

export async function executeMemoryTool(
  toolCall: ToolCall,
  chatId: string
): Promise<ToolResult> {
  switch (toolCall.name) {
    case "save_memory": {
      const { text, category, importance } = toolCall.arguments;
      if (!text) return { content: "Missing text", isError: true };

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
      };

      await dedupAndSave([fact], [embedding], chatId, undefined, 'explicit');
      return { content: `Saved memory: "${text}"`, isError: false };
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
            return `- [${r.memory.id}] ${r.memory.text} (${r.memory.category}, importance: ${r.memory.importance}/10, created: ${created}, score: ${r.score.toFixed(3)}${source}${supersedes})${superseded}`;
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

      // Resolve chat_id from memory if provided
      let targetChatId: string | undefined = chat_id;
      let memoryContext = "";

      if (memory_id && !targetChatId) {
        const memory = await getMemoryById(memory_id);
        if (!memory) {
          return { content: `Memory not found: ${memory_id}`, isError: true };
        }
        if (memory.sourceChatId) {
          targetChatId = memory.sourceChatId;
          memoryContext = `Searching conversation that produced memory: "${memory.text}"\n\n`;
        } else {
          return {
            content: `Memory "${memory_id}" has no linked source conversation.`,
            isError: false,
          };
        }
      }

      const resultLimit = Math.min(50, Math.max(1, maxResults || 5));
      const CONTEXT_RADIUS = 2; // messages before/after each match
      const MAX_CONTENT_CHARS = 6000;
      const matches = searchChatMessages(query, {
        chatId: targetChatId,
        limit: resultLimit,
      });

      // Also search archived context blocks (cross-chat)
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

      // Group matches by chat, preserving BM25 relevance ordering.
      // Sort by rank first (BM25: lower = more relevant), then by message index.
      const sortedMatches = [...matches].sort((a, b) => {
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

      // Compute each chat's best rank for relevance-based ordering
      const bestRank = (ranks: number[]) => Math.min(...ranks);

      const sections: string[] = [];
      if (memoryContext) sections.push(memoryContext.trim());

      let isFirstSection = true;
      for (const [cid, data] of byChatId) {
        const title = getChatTitle(cid);
        const chatLabel = targetChatId
          ? ""
          : `\n--- ${title || "Untitled"} (${cid}) [rank: ${Math.abs(bestRank(data.ranks)).toFixed(1)}] ---\n`;

        // Merge overlapping context windows
        const sortedIndices = [...new Set(data.indices)].sort((a, b) => a - b);
        const ranges: Array<[number, number]> = [];
        for (const idx of sortedIndices) {
          const start = Math.max(0, idx - CONTEXT_RADIUS);
          const end = idx + CONTEXT_RADIUS;
          if (ranges.length > 0 && start <= ranges[ranges.length - 1][1] + 1) {
            ranges[ranges.length - 1][1] = Math.max(ranges[ranges.length - 1][1], end);
          } else {
            ranges.push([start, end]);
          }
        }

        const messageGroups: string[] = [];
        for (const [start, end] of ranges) {
          const contextMsgs = getChatMessageRange(cid, start, end);
          const formatted = contextMsgs
            .map((m) => {
              const marker = sortedIndices.includes(m.messageIndex) ? " <<<" : "";
              const text = truncateAroundMatch(m.content, query, 800);
              return `  [${m.messageIndex}] ${m.role}: ${text}${marker}`;
            })
            .join("\n");
          messageGroups.push(formatted);
        }

        const section = chatLabel + messageGroups.join("\n  ...\n");

        // Always include first section; enforce budget for additional ones
        if (!isFirstSection && sections.join("\n").length + section.length > MAX_CONTENT_CHARS) {
          break;
        }
        isFirstSection = false;

        sections.push(section);
      }

      // Append archive matches if any
      if (archiveMatches.length > 0) {
        sections.push("\n--- Archived Context ---");
        for (const am of archiveMatches) {
          const chatLabel = targetChatId ? "" : ` (${getChatTitle(am.chatId) || am.chatId})`;
          sections.push(`  [${am.id}]${chatLabel}: ${am.indexEntry}`);
        }
        sections.push("  Use read_archived_context(archive_id) to retrieve full content.");
      }

      const content = sections.join("\n");
      const totalMatches = matches.length + archiveMatches.length;
      const truncated = content.length > MAX_CONTENT_CHARS;
      return {
        content: `Found ${totalMatches} match(es) (${matches.length} messages, ${archiveMatches.length} archived)${truncated ? " (truncated)" : ""}:\n\n${content}`,
        isError: false,
      };
    }

    case "read_archived_context": {
      const { archive_id } = toolCall.arguments;
      if (!archive_id) return { content: "Missing archive_id", isError: true };

      const archive = getArchive(archive_id) ?? (
        archive_id.startsWith("archive:") ? null : getArchive(`archive:${archive_id}`)
      );
      if (!archive) {
        return { content: `Archive block not found: ${archive_id}`, isError: false };
      }

      // Format the archived messages as readable conversation text
      const lines: string[] = [];
      lines.push(`Archive: ${archive.id} (${archive.messageCount} messages, ~${archive.estimatedTokens} tokens)`);
      lines.push(`From chat: ${getChatTitle(archive.chatId) || archive.chatId}`);
      lines.push(`Archived: ${archive.createdAt.slice(0, 10)}`);
      lines.push("---");

      for (const m of archive.messages) {
        if (m.role === "user") {
          lines.push(`user: ${m.content}`);
        } else if (m.role === "assistant") {
          if (m.thinking) lines.push(`thinking: ${m.thinking}`);
          if (m.content) lines.push(`agent: ${m.content}`);
          if (m.toolCalls?.length) {
            for (const tc of m.toolCalls) {
              lines.push(`tool_call: ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 500)})`);
            }
          }
          if (m.toolResults?.length) {
            for (const tr of m.toolResults) {
              lines.push(`tool_result [${tr.toolName}]: ${tr.content}`);
            }
          }
        }
      }

      return { content: lines.join("\n"), isError: false };
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
      const { v4: uuid } = await import("uuid");
      // Route blocks created during the notebook cycle through the notebook
      // prefix so they inherit the same system-block exclusion as blocks
      // created via createNotebookBlock (kept out of the stable prefix and
      // the "Available Memory Blocks" index).
      const { NOTEBOOK_CYCLE_CHAT_ID, generateNotebookBlockId } = await import("./notebook-storage.js");
      const id = chatId === NOTEBOOK_CYCLE_CHAT_ID
        ? generateNotebookBlockId("notebook")
        : `blk-${uuid()}`;
      const now = new Date().toISOString();
      
      // Auto-assign projectId for project-scoped blocks when created in a project chat
      // The agent may not have the project UUID, so we infer it from the chat context
      let finalProjectId = project_id || "";
      if (scope === "project" && !project_id && chatId) {
        const { getChat } = await import("./chat-storage.js");
        const chat = await getChat(chatId);
        if (chat?.projectId) {
          finalProjectId = chat.projectId;
        }
      }
      
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
        supersededBy: undefined,
        supersedes: undefined,
      });
      return { content: `Created memory block: [${block.id}] "${block.name}" (${block.scope}, ${block.tokenEstimate} tokens)`, isError: false };
    }

    case "update_memory_block": {
      const { block_id, content: newContent, description: newDesc, scope: newScope, project_id } = toolCall.arguments;
      if (!block_id) return { content: "Missing block_id", isError: true };

      const existing = getMemoryBlock(block_id);
      if (!existing) return { content: `Block not found: ${block_id}`, isError: false };

      const scopeChanged = newScope !== undefined && newScope !== existing.scope;
      const projectIdVal = project_id !== undefined ? (project_id === "" ? null : project_id) : undefined;
      const finalContent = newContent ?? existing.content;
      const maxChars = await getMaxBlockChars();
      if (finalContent.length > maxChars) {
        // Content too large — create a superseding block instead.
        // Preserve notebook/synthesis prefix so the replacement inherits the
        // same system-block exclusion as the original.
        const { v4: uuid } = await import("uuid");
        const { generateNotebookBlockId } = await import("./notebook-storage.js");
        const newId = existing.id.startsWith("blk-notebook-")
          ? generateNotebookBlockId("notebook")
          : existing.id.startsWith("blk-synth-")
          ? generateNotebookBlockId("synthesis")
          : `blk-${uuid()}`;
        const now = new Date().toISOString();
        const newBlock = supersedeBlock(existing.id, {
          id: newId,
          name: existing.name,
          description: newDesc ?? existing.description,
          content: finalContent.slice(0, maxChars),
          scope: newScope ?? existing.scope,
          projectId: projectIdVal !== undefined ? projectIdVal : (existing.projectId || ""),
          createdAt: now,
          updatedAt: now,
          updatedBy: "agent",
          supersededBy: undefined,
          supersedes: existing.id,
        });
        return {
          content: `Block exceeded ${maxChars} char limit — created new version [${newBlock.id}] superseding [${existing.id}]. Content was truncated to fit.`,
          isError: false,
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
      return { content: `Updated block [${block_id}] "${existing.name}"${scopeNote}${projectNote}`, isError: false };
    }

    case "read_memory_block": {
      const { block_id } = toolCall.arguments;
      if (!block_id) return { content: "Missing block_id", isError: true };

      const block = getMemoryBlock(block_id);
      if (!block) return { content: `Block not found: ${block_id}`, isError: false };

      const lines = [
        `Memory Block: ${block.name} [${block.id}]`,
        `Scope: ${block.scope}${block.projectId ? ` (project: ${block.projectId})` : ""}`,
        `Updated: ${block.updatedAt.slice(0, 10)} by ${block.updatedBy}`,
        `---`,
        block.content,
      ];
      return { content: lines.join("\n"), isError: false };
    }

    case "list_memory_blocks": {
      const { scope, project_id, query, recent_days, limit: maxResults } = toolCall.arguments;
      
      // Default: exclude archived (handled by backend), cap at 15
      const effectiveLimit = maxResults ?? 15;
      
      // Fetch all matching blocks (no limit at DB level — we cap in output)
      const blocks = listMemoryBlocks({ scope, projectId: project_id, query, includeInternal: true });
      
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
        `- [${b.id}] ${b.name} (${b.scope}) — ${b.description} [${b.tokenEstimate} tokens, updated ${b.updatedAt.slice(0,10)}]`
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
