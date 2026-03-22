import { embed } from "./embeddings.js";
import { searchMemories, updateMemory } from "./memory-storage.js";
import { loadPersona } from "./persona-store.js";
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
  recentMessages: ChatMessage[]
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

    // Build a query from the last 3 user messages
    const userMessages = recentMessages
      .filter((m) => m.role === "user")
      .slice(-3)
      .map((m) => m.content)
      .join("\n");

    let memoriesSection = "";

    if (userMessages) {
      const queryEmbedding = await embed(userMessages);
      const results = await searchMemories(queryEmbedding, 5, new Date(), userMessages);
      // RRF scores are much smaller than raw cosine — max ~0.033 before decay/importance
      const relevant = results.filter((r) => r.score > 0.0003);

      if (relevant.length > 0) {
        const memoriesBlock = relevant
          .map(
            (r) => {
              const supersededNote = r.memory.supersededBy
                ? " ⚠️ SUPERSEDED — a newer version of this memory exists"
                : "";
              return `- ${r.memory.text} [${r.memory.category}, importance: ${r.memory.importance}/10]${supersededNote}`;
            }
          )
          .join("\n");

        // Update access metadata (fire-and-forget)
        const now = new Date().toISOString();
        for (const r of relevant) {
          updateMemory(r.memory.id, {
            lastAccessed: now,
            accessCount: r.memory.accessCount + 1,
          }).catch(() => {});
        }

        memoriesSection = `\n\n## My relevant memories to this chat:\n${memoriesBlock}\n\nUse these memories as needed — there's no need to list them unless asked.`;
      }
    }

    return `${baseSystemPrompt}${personaSection}${memoriesSection}`;
  } catch (e) {
    console.error("[memory] Context augmentation failed, using base prompt:", e);
    return baseSystemPrompt;
  }
}
