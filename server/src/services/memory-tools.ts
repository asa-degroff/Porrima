import { v4 as uuid } from "uuid";
import { embed, cosineSimilarity } from "./embeddings.js";
import {
  loadMemoryStore,
  addMemory,
  deleteMemory,
  searchMemories,
} from "./memory-storage.js";
import type { Memory, MemoryCategory } from "../types.js";

export const MEMORY_TOOLS_PROMPT = `
## Memory Tools

You have tools to manage your memory about the user. Use them when appropriate:

### save_memory
Save an important fact about the user. Use when they share personal info, preferences, or ask you to remember something.
\`\`\`tool
{"name": "save_memory", "args": {"text": "fact about the user", "category": "preference|fact|behavior|instruction", "importance": 5}}
\`\`\`

### search_memory
Search your memories for relevant information. Use when you need to recall something specific.
\`\`\`tool
{"name": "search_memory", "args": {"query": "what to search for"}}
\`\`\`

### forget_memory
Delete a memory. Use when the user asks you to forget something. Search first to find the memory ID.
\`\`\`tool
{"name": "forget_memory", "args": {"id": "memory-id"}}
\`\`\`

When using tools, place the tool block in your response. You'll receive the result and can continue your response.
Only use tools when genuinely useful — don't use them for every message.`;

export interface ToolCall {
  name: string;
  args: Record<string, any>;
}

export interface ToolResult {
  name: string;
  success: boolean;
  result: string;
}

export function parseToolCalls(text: string): ToolCall[] {
  const toolCalls: ToolCall[] = [];
  const regex = /```tool\s*\n([\s\S]*?)```/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.name && parsed.args) {
        toolCalls.push({ name: parsed.name, args: parsed.args });
      }
    } catch {
      // Skip malformed tool calls
    }
  }

  return toolCalls;
}

export async function executeMemoryTool(
  tool: ToolCall,
  chatId: string
): Promise<ToolResult> {
  switch (tool.name) {
    case "save_memory": {
      const { text, category, importance } = tool.args;
      if (!text) return { name: tool.name, success: false, result: "Missing text" };

      let embedding: number[];
      try {
        embedding = await embed(text);
      } catch (e: any) {
        return { name: tool.name, success: false, result: `Embedding failed: ${e.message}` };
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
      return { name: tool.name, success: true, result: `Saved memory: "${text}"` };
    }

    case "search_memory": {
      const { query } = tool.args;
      if (!query) return { name: tool.name, success: false, result: "Missing query" };

      let queryEmbedding: number[];
      try {
        queryEmbedding = await embed(query);
      } catch (e: any) {
        return { name: tool.name, success: false, result: `Embedding failed: ${e.message}` };
      }

      const results = await searchMemories(queryEmbedding, 5);
      if (results.length === 0) {
        return { name: tool.name, success: true, result: "No relevant memories found." };
      }

      const formatted = results
        .map(
          (r) =>
            `- [${r.memory.id}] ${r.memory.text} (${r.memory.category}, importance: ${r.memory.importance}/10, score: ${r.score.toFixed(3)})`
        )
        .join("\n");

      return { name: tool.name, success: true, result: `Found memories:\n${formatted}` };
    }

    case "forget_memory": {
      const { id } = tool.args;
      if (!id) {
        // If no ID but a query is given, try to find and delete by text match
        const { query } = tool.args;
        if (query) {
          let queryEmbedding: number[];
          try {
            queryEmbedding = await embed(query);
          } catch (e: any) {
            return { name: tool.name, success: false, result: `Embedding failed: ${e.message}` };
          }
          const results = await searchMemories(queryEmbedding, 1);
          if (results.length > 0 && results[0].score > 0.5) {
            const deleted = await deleteMemory(results[0].memory.id);
            if (deleted) {
              return { name: tool.name, success: true, result: `Deleted memory: "${results[0].memory.text}"` };
            }
          }
          return { name: tool.name, success: false, result: "No matching memory found to delete." };
        }
        return { name: tool.name, success: false, result: "Missing id or query" };
      }

      const deleted = await deleteMemory(id);
      if (!deleted) return { name: tool.name, success: false, result: "Memory not found" };
      return { name: tool.name, success: true, result: "Memory deleted." };
    }

    default:
      return { name: tool.name, success: false, result: `Unknown tool: ${tool.name}` };
  }
}

export function stripToolBlocks(text: string): string {
  return text.replace(/```tool\s*\n[\s\S]*?```/g, "").trim();
}
