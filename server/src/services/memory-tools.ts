import { Type } from "@sinclair/typebox";
import { v4 as uuid } from "uuid";
import { embed } from "./embeddings.js";
import {
  addMemory,
  deleteMemory,
  searchMemories,
} from "./memory-storage.js";
import type { Tool, ToolCall } from "@mariozechner/pi-ai";
import type { Memory, MemoryCategory } from "../types.js";
import { StringEnum } from "@mariozechner/pi-ai";

export const MEMORY_TOOLS: Tool[] = [
  {
    name: "save_memory",
    description:
      "Save an important fact about the user. Use when they share personal info, preferences, or ask you to remember something.",
    parameters: Type.Object({
      text: Type.String({ description: "The fact to remember" }),
      category: StringEnum(
        ["preference", "fact", "behavior", "instruction"] as const,
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
      "Search your memories for relevant information. Use when you need to recall something specific about the user.",
    parameters: Type.Object({
      query: Type.String({ description: "What to search for" }),
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

      const now = new Date().toISOString();
      const memory: Memory = {
        id: uuid(),
        text,
        category: (category as MemoryCategory) || "fact",
        importance: Math.min(10, Math.max(1, importance || 5)),
        embedding,
        createdAt: now,
        lastAccessed: now,
        accessCount: 0,
        sourceChatId: chatId,
      };

      await addMemory(memory);
      return { content: `Saved memory: "${text}"`, isError: false };
    }

    case "search_memory": {
      const { query } = toolCall.arguments;
      if (!query) return { content: "Missing query", isError: true };

      let queryEmbedding: number[];
      try {
        queryEmbedding = await embed(query);
      } catch (e: any) {
        return { content: `Embedding failed: ${e.message}`, isError: true };
      }

      const results = await searchMemories(queryEmbedding, 5);
      if (results.length === 0) {
        return { content: "No relevant memories found.", isError: false };
      }

      const formatted = results
        .map(
          (r) =>
            `- [${r.memory.id}] ${r.memory.text} (${r.memory.category}, importance: ${r.memory.importance}/10, score: ${r.score.toFixed(3)})`
        )
        .join("\n");

      return { content: `Found memories:\n${formatted}`, isError: false };
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
          const results = await searchMemories(queryEmbedding, 1);
          if (results.length > 0 && results[0].score > 0.5) {
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

    default:
      return { content: `Unknown tool: ${toolCall.name}`, isError: true };
  }
}
