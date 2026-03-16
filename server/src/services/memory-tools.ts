import { Type } from "@sinclair/typebox";
import { embed } from "./embeddings.js";
import {
  deleteMemory,
  searchMemories,
} from "./memory-storage.js";
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
      "Search your memories for relevant information. Use when you need to recall something specific.",
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
      const { query } = toolCall.arguments;
      if (!query) return { content: "Missing query", isError: true };

      let queryEmbedding: number[];
      try {
        queryEmbedding = await embed(query);
      } catch (e: any) {
        return { content: `Embedding failed: ${e.message}`, isError: true };
      }

      const results = await searchMemories(queryEmbedding, 5, new Date(), query);
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
