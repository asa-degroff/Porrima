import { streamChat } from "./agent.js";
import { cosineSimilarity, embed } from "./embeddings.js";
import {
  loadMemoryStore,
  saveMemoryStore,
  saveDailyLog,
  withWriteLock,
} from "./memory-storage.js";
import { discoverOllamaModels } from "./models.js";

const SYNTHESIS_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MERGE_THRESHOLD = 0.90;

export async function shouldRunSynthesis(): Promise<boolean> {
  const store = await loadMemoryStore();
  if (!store.lastSynthesis) return store.memories.length > 0;
  const elapsed = Date.now() - new Date(store.lastSynthesis).getTime();
  return elapsed >= SYNTHESIS_INTERVAL_MS && store.memories.length > 0;
}

export async function runDailySynthesis(modelId?: string): Promise<void> {
  console.log("[synthesis] Starting daily synthesis...");

  // Wrap entire synthesis in write lock to prevent concurrent memory mutations
  await withWriteLock(async () => {
    const store = await loadMemoryStore();

    if (store.memories.length === 0) {
      console.log("[synthesis] No memories to synthesize");
      store.lastSynthesis = new Date().toISOString();
      await saveMemoryStore(store);
      return;
    }

    // Step 1: Consolidate near-duplicate memories (cosine > 0.90)
    const merged = new Set<string>();
    for (let i = 0; i < store.memories.length; i++) {
      if (merged.has(store.memories[i].id)) continue;
      for (let j = i + 1; j < store.memories.length; j++) {
        if (merged.has(store.memories[j].id)) continue;
        const sim = cosineSimilarity(
          store.memories[i].embedding,
          store.memories[j].embedding
        );
        if (sim > MERGE_THRESHOLD) {
          console.log(
            `[synthesis] Merging: "${store.memories[j].text}" into "${store.memories[i].text}" (sim=${sim.toFixed(3)})`
          );
          store.memories[i].importance = Math.max(
            store.memories[i].importance,
            store.memories[j].importance
          );
          store.memories[i].accessCount +=
            store.memories[j].accessCount;
          merged.add(store.memories[j].id);
        }
      }
    }

    if (merged.size > 0) {
      store.memories = store.memories.filter((m) => !merged.has(m.id));
      console.log(`[synthesis] Consolidated ${merged.size} duplicate memories`);
    }

    // Step 2: Apply importance decay for old, unused memories + purge stale ones
    const now = Date.now();
    const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000;
    const staleIds = new Set<string>();
    for (const memory of store.memories) {
      const daysSinceAccess =
        (now - new Date(memory.lastAccessed).getTime()) / (24 * 60 * 60 * 1000);
      if (daysSinceAccess > 30 && memory.importance > 1) {
        memory.importance = Math.max(1, memory.importance - 1);
      }
      // Purge memories not accessed in 6+ months with low importance
      const msSinceAccess = now - new Date(memory.lastAccessed).getTime();
      if (msSinceAccess > SIX_MONTHS_MS && memory.importance <= 2) {
        staleIds.add(memory.id);
      }
    }

    if (staleIds.size > 0) {
      store.memories = store.memories.filter((m) => !staleIds.has(m.id));
      console.log(`[synthesis] Purged ${staleIds.size} stale memories (>6 months, importance ≤2)`);
    }

    // Step 3: Generate daily summary via LLM
    const resolvedModelId = modelId || (await getDefaultModelId());
    if (resolvedModelId) {
      try {
        const memoriesText = store.memories
          .map(
            (m) =>
              `- [${m.category}] ${m.text} (importance: ${m.importance}/10, accessed: ${m.accessCount} times)`
          )
          .join("\n");

        let summaryText = "";
        await streamChat(
          resolvedModelId,
          [
            {
              role: "user",
              content: `Here are all current memories about the user:\n\n${memoriesText}\n\nWrite a brief daily summary (2-4 paragraphs) of what you know about this user, organized by theme. Note any contradictions or outdated info.`,
              timestamp: Date.now(),
            },
          ],
          "You are a memory synthesis system. Summarize user memories concisely.",
          (event) => {
            if (event.type === "text_delta") {
              summaryText += event.delta;
            }
          }
        );

        const today = new Date().toISOString().split("T")[0];
        await saveDailyLog(
          today,
          `# Daily Synthesis - ${today}\n\n**Memories: ${store.memories.length}** | Merged: ${merged.size}\n\n${summaryText}`
        );
        console.log(`[synthesis] Daily log saved for ${today}`);
      } catch (e) {
        console.error("[synthesis] Summary generation failed:", e);
      }
    }

    store.lastSynthesis = new Date().toISOString();
    await saveMemoryStore(store);
    console.log("[synthesis] Complete");
  });
}

async function getDefaultModelId(): Promise<string | null> {
  try {
    const models = await discoverOllamaModels();
    return models.length > 0 ? models[0].id : null;
  } catch {
    return null;
  }
}
