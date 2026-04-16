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
  MAX_BLOCK_CHARS,
} from "./memory-storage.js";
import { searchChatMessages, getChatMessageRange, getChatTitle, getArchive, searchArchives } from "./chat-storage.js";
import { dedupAndSave } from "./memory-extraction.js";
import type { Tool, ToolCall } from "@mariozechner/pi-ai";
import type { MemoryCategory } from "../types.js";
import { StringEnum } from "@mariozechner/pi-ai";
import { savePersona, loadPersona } from "./persona-store.js";

export const MEMORY_TOOLS: Tool[] = [
  {
    name: "save_memory",
    description:
      "Save an important fact. Use whenever you want to remember something.",
    parameters: Type.Object({
      text: Type.String({ description: "The fact to remember" }),
      category: StringEnum(
        ["preference", "fact", "behavior", "instruction", "context", "decision", "note"] as const,
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
    name: "forget_memory",
    description:
      "Delete a memory. Use when the user asks you to forget something. Search first to find the memory ID.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Memory ID to delete" })),
      query: Type.Optional(
        Type.String({ description: "Search query to find memory to delete" })
      ),
    }),
  },
  {
    name: "update_persona",
    description:
      "Update the agent's persona document. Use sparingly—only for significant, recurring patterns that should become part of your core identity. Called automatically during synthesis when patterns emerge.",
    parameters: Type.Object({
      section: Type.String({
        description:
          "The persona section to update (e.g., 'Communication Style', 'Values & Principles')",
      }),
      content: Type.String({
        description: "The new content for this section",
      }),
      reason: Type.String({
        description:
          "Why this change is being made (e.g., 'User has repeatedly emphasized X across multiple sessions')",
      }),
    }),
  },
  {
    name: "search_conversation",
    description:
      "Search past conversations for specific details. Use when a memory lacks the detail you need — this lets you find the original exchange. Can search a specific conversation (by memory_id or chat_id) or across all conversations.",
    parameters: Type.Object({
      query: Type.String({ description: "Search terms to find in past conversation messages" }),
      memory_id: Type.Optional(
        Type.String({ description: "Memory ID — automatically looks up the source conversation" })
      ),
      chat_id: Type.Optional(
        Type.String({ description: "Chat ID to search within a specific conversation" })
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
      content: Type.String({ description: "Full block content — structured text, up to ~4000 characters" }),
      scope: Type.Optional(StringEnum(["global", "project"], { description: "Scope: 'global' (all chats) or 'project' (project-scoped). Default: global" })),
      project_id: Type.Optional(Type.String({ description: "Project ID for project-scoped blocks" })),
    }),
  },
  {
    name: "update_memory_block",
    description:
      "Update an existing memory block's content or description. Use this to refine, expand, or correct knowledge in a block. If the block would exceed ~4000 characters, consider splitting into a new block.",
    parameters: Type.Object({
      block_id: Type.String({ description: "Block ID (e.g. blk-...)" }),
      content: Type.Optional(Type.String({ description: "New content to replace the block's content" })),
      description: Type.Optional(Type.String({ description: "Updated one-line description" })),
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
      "List available memory blocks by scope or search. Use this to discover what knowledge blocks exist before reading or creating new ones.",
    parameters: Type.Object({
      scope: Type.Optional(StringEnum(["global", "project"], { description: "Filter by scope" })),
      project_id: Type.Optional(Type.String({ description: "Project ID for project-scoped blocks" })),
      query: Type.Optional(Type.String({ description: "Optional search query to filter blocks by name/description" })),
    }),
  },
  {
    name: "get_block_history",
    description:
      "Get the revision history of a memory block by following the supersession chain. Shows how the block evolved over time.",
    parameters: Type.Object({
      block_id: Type.String({ description: "Block ID to get history for" }),
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

      await dedupAndSave([fact], [embedding], chatId);
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
          .map((r) => `- [${r.block.id}] ${r.block.name}: ...${r.excerpt.slice(0, 200)}... (use read_memory_block to see full content)`)
          .join("\n");
        blockSection = `\n\nMemory blocks:\n${blockFormatted}`;
      }

      return { content: `Found memories:\n${formatted}${blockSection}`, isError: false };
    }

    case "forget_memory": {
      const { id, query } = toolCall.arguments;
      if (!id) {
        if (query) {
          let queryEmbedding: number[];
          try {
            queryEmbedding = await embed(query);
          } catch (e: any) {
            return { content: `Embedding failed: ${e.message}`, isError: true };
          }
          const results = await searchMemories(queryEmbedding, 1, new Date(), query);
          // RRF scores are small — ~0.005 indicates a strong match in at least one ranking
          if (results.length > 0 && results[0].score > 0.005) {
            const deleted = await deleteMemory(results[0].memory.id);
            if (deleted) {
              return {
                content: `Deleted memory: "${results[0].memory.text}"`,
                isError: false,
              };
            }
          }
          return {
            content: "No matching memory found to delete.",
            isError: true,
          };
        }
        return { content: "Missing id or query", isError: true };
      }

      const deleted = await deleteMemory(id);
      if (!deleted) return { content: "Memory not found", isError: true };
      return { content: "Memory deleted.", isError: false };
    }

    case "update_persona": {
      const { section, content, reason } = toolCall.arguments;
      if (!section || !content || !reason) {
        return {
          content: "Missing required fields: section, content, and reason",
          isError: true,
        };
      }

      try {
        const persona = await loadPersona();
        const updatedContent = updatePersonaSection(
          persona.content,
          section,
          content
        );
        await savePersona(updatedContent, reason);
        return {
          content: `Persona updated: "${section}" - ${reason}`,
          isError: false,
        };
      } catch (e: any) {
        return {
          content: `Persona update failed: ${e.message}`,
          isError: true,
        };
      }
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

      // Group matches by chat and fetch surrounding context
      const byChatId = new Map<string, number[]>();
      for (const m of matches) {
        const list = byChatId.get(m.chatId) || [];
        list.push(m.messageIndex);
        byChatId.set(m.chatId, list);
      }

      const sections: string[] = [];
      if (memoryContext) sections.push(memoryContext.trim());

      for (const [cid, indices] of byChatId) {
        // Show chat title for global searches; skip for single-chat scoped searches
        const title = getChatTitle(cid);
        const chatLabel = targetChatId ? "" : `\n--- ${title || "Untitled"} (${cid}) ---\n`;
        const messageGroups: string[] = [];

        // Merge overlapping context windows
        const sorted = [...new Set(indices)].sort((a, b) => a - b);
        const ranges: Array<[number, number]> = [];
        for (const idx of sorted) {
          const start = Math.max(0, idx - CONTEXT_RADIUS);
          const end = idx + CONTEXT_RADIUS;
          if (ranges.length > 0 && start <= ranges[ranges.length - 1][1] + 1) {
            ranges[ranges.length - 1][1] = Math.max(ranges[ranges.length - 1][1], end);
          } else {
            ranges.push([start, end]);
          }
        }

        for (const [start, end] of ranges) {
          const contextMsgs = getChatMessageRange(cid, start, end);
          const formatted = contextMsgs
            .map((m) => {
              const marker = sorted.includes(m.messageIndex) ? " <<<" : "";
              const text = truncateAroundMatch(m.content, query, 800);
              return `  [${m.messageIndex}] ${m.role}: ${text}${marker}`;
            })
            .join("\n");
          messageGroups.push(formatted);
        }

        sections.push(chatLabel + messageGroups.join("\n  ...\n"));
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

      const totalMatches = matches.length + archiveMatches.length;
      return {
        content: `Found ${totalMatches} match(es) (${matches.length} messages, ${archiveMatches.length} archived):\n\n${sections.join("\n")}`,
        isError: false,
      };
    }

    case "read_archived_context": {
      const { archive_id } = toolCall.arguments;
      if (!archive_id) return { content: "Missing archive_id", isError: true };

      const archive = getArchive(archive_id);
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
          if (m.content) lines.push(`assistant: ${m.content}`);
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
      if (content.length > MAX_BLOCK_CHARS) {
        return { content: `Content exceeds ${MAX_BLOCK_CHARS} character limit (${content.length} chars). Please shorten or split into multiple blocks.`, isError: true };
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
      const { block_id, content: newContent, description: newDesc } = toolCall.arguments;
      if (!block_id) return { content: "Missing block_id", isError: true };

      const existing = getMemoryBlock(block_id);
      if (!existing) return { content: `Block not found: ${block_id}`, isError: false };

      const finalContent = newContent ?? existing.content;
      if (finalContent.length > MAX_BLOCK_CHARS) {
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
          content: finalContent.slice(0, MAX_BLOCK_CHARS),
          scope: existing.scope,
          projectId: existing.projectId || "",
          createdAt: now,
          updatedAt: now,
          updatedBy: "agent",
          supersededBy: undefined,
          supersedes: existing.id,
        });
        return {
          content: `Block exceeded ${MAX_BLOCK_CHARS} char limit — created new version [${newBlock.id}] superseding [${existing.id}]. Content was truncated to fit.`,
          isError: false,
        };
      }

      updateMemoryBlock(block_id, {
        content: newContent,
        description: newDesc,
        updatedBy: "agent",
      });
      return { content: `Updated block [${block_id}] "${existing.name}"`, isError: false };
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
      const { scope, project_id, query } = toolCall.arguments;
      const blocks = listMemoryBlocks({ scope, projectId: project_id, query });
      
      if (blocks.length === 0) {
        return { content: "No memory blocks found matching criteria.", isError: false };
      }
      
      const lines = blocks.map((b) => 
        `- [${b.id}] ${b.name} (${b.scope}) — ${b.description} [${b.tokenEstimate} tokens, updated ${b.updatedAt.slice(0,10)}]`
      );
      return { content: `Found ${blocks.length} memory block(s):\n${lines.join("\n")}`, isError: false };
    }

    case "get_block_history": {
      const { block_id } = toolCall.arguments;
      if (!block_id) return { content: "Missing block_id", isError: true };

      const currentBlock = getMemoryBlock(block_id);
      if (!currentBlock) return { content: `Block not found: ${block_id}`, isError: false };

      const history = getBlockHistory(block_id);
      if (history.length === 0) {
        return { content: "No history found for this block.", isError: false };
      }

      const lines = [
        `Revision history for "${currentBlock.name}":`,
        `Total revisions: ${history.length}`,
        "---",
      ];

      for (let i = 0; i < history.length; i++) {
        const b = history[i];
        const version = i + 1;
        const isCurrent = b.id === block_id;
        lines.push(`\n[${version}] ${b.id} (${b.updatedAt.slice(0, 10)}) by ${b.updatedBy}${isCurrent ? " (current)" : ""}`);
        lines.push(`Content: ${b.content.slice(0, 200)}${b.content.length > 200 ? "..." : ""}`);
      }

      return { content: lines.join("\n"), isError: false };
    }

    default:
      return { content: `Unknown tool: ${toolCall.name}`, isError: true };
  }
}

/**
 * Update a specific section in the persona markdown.
 * If the section exists, replace its content. If not, append it.
 */
function updatePersonaSection(
  currentPersona: string,
  section: string,
  newContent: string
): string {
  const sectionHeader = `## ${section}`;
  const lines = currentPersona.split("\n");
  const sectionIndex = lines.findIndex((line) =>
    line.startsWith(sectionHeader)
  );

  if (sectionIndex === -1) {
    // Section doesn't exist, append it
    return (
      currentPersona.trimEnd() +
      `\n\n${sectionHeader}\n${newContent}\n`
    );
  }

  // Find the next section (## or #) or end of file
  let nextSectionIndex = lines.length;
  for (let i = sectionIndex + 1; i < lines.length; i++) {
    if (lines[i].startsWith("##") || lines[i].startsWith("#")) {
      nextSectionIndex = i;
      break;
    }
  }

  // Replace the section content
  const before = lines.slice(0, sectionIndex + 1).join("\n");
  const after = lines.slice(nextSectionIndex).join("\n");
  return `${before}\n${newContent}\n${after}`;
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
