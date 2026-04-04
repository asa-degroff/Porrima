import { embed } from "./embeddings.js";
import { searchMemories, updateMemory, mmrRerank } from "./memory-storage.js";
import { rerank, RERANK_INSTRUCTIONS } from "./reranker.js";
import { loadPersona } from "./persona-store.js";
import { loadUserDocument } from "./user-store.js";
import type { ChatMessage } from "../types.js";

// Cache the last-built augmented prompt per chat so the prompt viewer
// can return it instantly without a cold Ollama embedding call.
const promptCache = new Map<string, string>();

export function getCachedAugmentedPrompt(chatId: string): string | undefined {
  return promptCache.get(chatId);
}

export function setCachedAugmentedPrompt(chatId: string, prompt: string): void {
  promptCache.set(chatId, prompt);
}

export async function buildMemoryAugmentedPrompt(
  baseSystemPrompt: string,
  recentMessages: ChatMessage[],
  chatId?: string,
  projectId?: string,
  chatType?: string
): Promise<string> {
  try {
    // Load persona and inject it first
    let personaSection = "";
    try {
      const persona = await loadPersona();
      personaSection = `\n\n## Your Persona\n${persona.content}\n\nRemember: This is your core identity.`;
    } catch (e) {
      console.error("[memory] Failed to load persona, continuing without:", e);
    }

    // Load user document (optional) and inject after persona
    let userSection = "";
    try {
      const userDoc = await loadUserDocument();
      if (userDoc && userDoc.content.trim()) {
        userSection = `\n\n## About the User\n${userDoc.content}`;
      }
    } catch (e) {
      // User document is optional - silently skip if not found
    }

    // Build a query from the last 3 user messages
    const userMessages = recentMessages
      .filter((m) => m.role === "user")
      .slice(-3)
      .map((m) => m.content)
      .join("\n");

    let memoriesSection = "";

    if (userMessages) {
      const queryEmbedding = await embed(userMessages);
      // Fetch a larger candidate pool for reranking (30 up from 15)
      const results = await searchMemories(queryEmbedding, 30, new Date(), userMessages);

      // Rerank candidates using the cross-encoder for query-specific relevance
      const instruction = RERANK_INSTRUCTIONS[chatType || "agent"];
      const rerankResults = await rerank(
        userMessages,
        results.map((r) => r.memory.text),
        instruction,
        25 // Return top 25 from 30 candidates
      );

      // Replace RRF scores with reranker scores (0-1 calibrated relevance)
      const rerankedResults = rerankResults.map(({ index, score }) => ({
        ...results[index],
        score,
      }));

      // Separate current and superseded memories
      const currentMemories = rerankedResults.filter((r) => !r.memory.supersededBy);
      const supersededMemories = rerankedResults.filter((r) => r.memory.supersededBy);

      // Filter by reranker relevance threshold (scores are 0-1)
      const topCurrent = currentMemories.filter((r) => r.score > 0.05);

      // Apply MMR re-ranking for diversity (reuse the query embedding)
      const diverseMemories = mmrRerank(topCurrent, queryEmbedding, 15, 0.7);

      // Apply project scoping: boost project-matching memories to the top
      if (projectId) {
        diverseMemories.sort((a, b) => {
          const aMatch = a.memory.projectId === projectId ? 1 : 0;
          const bMatch = b.memory.projectId === projectId ? 1 : 0;
          if (aMatch !== bMatch) return bMatch - aMatch;
          return b.score - a.score;
        });
      }

      const selected = diverseMemories.slice(0, 15);

      // Select relevant superseded memories as "historical context"
      const topSuperseded = supersededMemories
        .filter((r) => r.score > 0.02) // Lower threshold for historical context
        .slice(0, 5);

      // Combine current + superseded
      const finalMemories = [...selected];
      if (topSuperseded.length > 0) {
        finalMemories.push(...topSuperseded.slice(0, 5));
      }

      if (finalMemories.length > 0) {
        const memoriesBlock = finalMemories
          .map(
            (r) => {
              const created = r.memory.createdAt.slice(0, 10);
              const supersededNote = r.memory.supersededBy
                ? " ⚠️ SUPERSEDED — a newer version of this memory exists"
                : "";
              const projectNote = r.memory.projectId && projectId && r.memory.projectId !== projectId
                ? ` [project: ${r.memory.projectId}]`
                : "";
              return `- ${r.memory.text} [${r.memory.category}, importance: ${r.memory.importance}/10, saved: ${created}]${supersededNote}${projectNote}`;
            }
          )
          .join("\n");

        // Update access metadata (fire-and-forget)
        const now = new Date().toISOString();
        for (const r of finalMemories) {
          updateMemory(r.memory.id, {
            lastAccessed: now,
            accessCount: r.memory.accessCount + 1,
          }).catch(() => {});
        }

        memoriesSection = `\n\n## My relevant memories to this chat:\n${memoriesBlock}\n\nUse these memories as needed — there's no need to list them unless asked.`;
      }
    }

    return `${baseSystemPrompt}${personaSection}${userSection}${memoriesSection}`;
  } catch (e) {
    console.error("[memory] Context augmentation failed, using base prompt:", e);
    return baseSystemPrompt;
  }
}
