import { embed } from "./embeddings.js";
import { searchMemories, updateMemory } from "./memory-storage.js";
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
    // Build a query from the last 3 user messages
    const userMessages = recentMessages
      .filter((m) => m.role === "user")
      .slice(-3)
      .map((m) => m.content)
      .join("\n");

    let memoriesSection = "";

    if (userMessages) {
      const queryEmbedding = await embed(userMessages);
      const results = await searchMemories(queryEmbedding, 5);
      const relevant = results.filter((r) => r.score > 0.01);

      if (relevant.length > 0) {
        const memoriesBlock = relevant
          .map(
            (r) =>
              `- ${r.memory.text} [${r.memory.category}, importance: ${r.memory.importance}/10]`
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

        memoriesSection = `\n\n## What you remember about this user\n${memoriesBlock}\n\nUse these memories naturally in conversation — don't list them unless asked. If memories seem outdated or contradictory, trust the user's latest statements.`;
      }
    }

    return `${baseSystemPrompt}${memoriesSection}`;
  } catch (e) {
    console.error("[memory] Context augmentation failed, using base prompt:", e);
    return baseSystemPrompt;
  }
}
