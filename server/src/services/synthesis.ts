import { streamChat } from "./agent.js";
import { cosineSimilarity, embed } from "./embeddings.js";
import {
  loadMemoryStore,
  saveMemoryStore,
  saveDailyLog,
  withWriteLock,
  getMemoryCount,
  getLastSynthesis,
} from "./memory-storage.js";
import { discoverOllamaModels } from "./models.js";
import { loadPersona, savePersona } from "./persona-store.js";
import { getSettings, listChats, getChat } from "./storage.js";

const SYNTHESIS_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MERGE_THRESHOLD = 0.90;
const PERSONA_PROMOTION_THRESHOLD = 0.85; // Similarity threshold for pattern detection
const MIN_PATTERN_FREQUENCY = 3; // Minimum times a pattern must appear to consider for persona

export async function shouldRunSynthesis(): Promise<boolean> {
  const count = await getMemoryCount();
  if (count === 0) return false;
  const lastSynthesis = await getLastSynthesis();
  if (!lastSynthesis) return true;
  const elapsed = Date.now() - new Date(lastSynthesis).getTime();
  return elapsed >= SYNTHESIS_INTERVAL_MS;
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

    // Step 3: Load today's chats — skip synthesis entirely if no activity
    const chatDigest = await buildTodaysChatDigest();
    if (!chatDigest) {
      console.log("[synthesis] No agent chats today — skipping summary generation");
      store.lastSynthesis = new Date().toISOString();
      await saveMemoryStore(store);
      return;
    }

    // Step 4: Generate daily summary via LLM
    const resolvedModelId = modelId || (await getSynthesisModelId());
    if (resolvedModelId) {
      try {
        const memoriesText = store.memories
          .map(
            (m) =>
              `- [${m.category}] ${m.text} (importance: ${m.importance}/10, accessed: ${m.accessCount} times)`
          )
          .join("\n");

        let summaryText = "";
        let thinkingText = "";
        await streamChat(
          resolvedModelId,
          [
            {
              role: "user",
              content: `## Today's Conversations\n\n${chatDigest}\n\n---\n\n## Stored Memories (${store.memories.length} total)\n\n${memoriesText}\n\nBased on today's conversations and the stored memories, write a daily synthesis. Include:\n1. What was worked on today — key topics, tasks, and outcomes\n2. Broader themes and patterns across the user's projects\n3. Any contradictions or outdated info in the stored memories that should be cleaned up`,
              timestamp: Date.now(),
            },
          ],
          "You are a memory synthesis system. Write a daily synthesis document that captures what happened today and how it fits into the broader picture of the user's work. Write in English. Be concrete and specific — reference actual projects, decisions, and topics rather than vague generalizations. 3-5 paragraphs.",
          (event) => {
            if (event.type === "text_delta") {
              summaryText += event.delta;
            } else if (event.type === "thinking_delta") {
              thinkingText += event.delta;
            }
          }
        );

        // Use thinking content as fallback if text output is empty
        // (qwen3 reasoning mode can put all content into thinking tokens)
        const finalSummary = summaryText.trim() || thinkingText.trim();

        const today = new Date().toISOString().split("T")[0];
        if (finalSummary) {
          await saveDailyLog(
            today,
            `# Daily Synthesis - ${today}\n\n**Memories: ${store.memories.length}** | Merged: ${merged.size}\n\n${finalSummary}`
          );
          console.log(`[synthesis] Daily log saved for ${today} (${finalSummary.length} chars)`);
        } else {
          console.warn(
            `[synthesis] LLM returned empty summary for ${today} (model: ${resolvedModelId}). Skipping daily log write.`
          );
        }
      } catch (e) {
        console.error("[synthesis] Summary generation failed:", e);
      }

      // Step 5: Analyze memories for persona promotion candidates
      try {
        await analyzeAndPromotePersonaPatterns(store.memories, resolvedModelId);
      } catch (e) {
        console.error("[synthesis] Persona pattern analysis failed:", e);
      }
    } else {
      console.warn("[synthesis] No model available — skipping summary generation and persona analysis");
    }

    store.lastSynthesis = new Date().toISOString();
    await saveMemoryStore(store);
    console.log("[synthesis] Complete");
  });
}

/**
 * Analyze memories for recurring patterns that should be promoted to persona.
 * Looks for clusters of similar high-importance memories that appear frequently.
 */
async function analyzeAndPromotePersonaPatterns(
  memories: Array<{
    id: string;
    text: string;
    category: string;
    importance: number;
    embedding: number[];
    accessCount: number;
  }>,
  modelId: string
): Promise<void> {
  console.log("[synthesis] Analyzing memories for persona patterns...");

  // Filter to high-importance memories (importance >= 7) that have been accessed multiple times
  const candidateMemories = memories.filter(
    (m) => m.importance >= 7 && m.accessCount >= 2
  );

  if (candidateMemories.length < MIN_PATTERN_FREQUENCY) {
    console.log(
      `[synthesis] Not enough candidate memories for persona analysis (${candidateMemories.length} < ${MIN_PATTERN_FREQUENCY})`
    );
    return;
  }

  // Group memories by similarity to find clusters
  const clusters: Array<{
    centroid: number[];
    members: typeof candidateMemories;
    avgImportance: number;
    totalAccesses: number;
  }> = [];

  for (const memory of candidateMemories) {
    let assigned = false;
    for (const cluster of clusters) {
      const sim = cosineSimilarity(memory.embedding, cluster.centroid);
      if (sim > PERSONA_PROMOTION_THRESHOLD) {
        cluster.members.push(memory);
        cluster.avgImportance =
          (cluster.avgImportance * (cluster.members.length - 1) +
            memory.importance) /
          cluster.members.length;
        cluster.totalAccesses += memory.accessCount;
        // Update centroid (simple average)
        cluster.centroid = cluster.centroid.map(
          (val, i) =>
            (val * (cluster.members.length - 1) + memory.embedding[i]) /
            cluster.members.length
        );
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      clusters.push({
        centroid: [...memory.embedding],
        members: [memory],
        avgImportance: memory.importance,
        totalAccesses: memory.accessCount,
      });
    }
  }

  // Find clusters with enough members to warrant persona promotion
  const significantClusters = clusters.filter(
    (c) => c.members.length >= MIN_PATTERN_FREQUENCY
  );

  if (significantClusters.length === 0) {
    console.log(
      "[synthesis] No significant persona patterns found"
    );
    return;
  }

  console.log(
    `[synthesis] Found ${significantClusters.length} significant persona pattern(s)`
  );

  // For each significant cluster, generate a persona update suggestion
  for (const cluster of significantClusters) {
    try {
      const memberTexts = cluster.members
        .map((m) => `- ${m.text} (importance: ${m.importance}, accesses: ${m.accessCount})`)
        .join("\n");

      let suggestedUpdate = "";
      let suggestedThinking = "";
      await streamChat(
        modelId,
        [
          {
            role: "user",
            content: `The following memory pattern has been detected across ${cluster.members.length} related memories:\n\n${memberTexts}\n\nBased on this pattern, suggest a concise addition or update to the agent's persona document. Which section should this inform (Communication Style, Values & Principles, Behavioral Traits, Interaction Patterns, etc.)? Provide:\n1. The section name\n2. The suggested content (1-3 sentences)\n3. The reasoning for why this pattern warrants a persona change`,
            timestamp: Date.now(),
          },
        ],
        "You are analyzing user interaction patterns to improve the agent's core persona. Be conservative—only suggest changes for genuinely significant, recurring patterns. Write in English.",
        (event) => {
          if (event.type === "text_delta") {
            suggestedUpdate += event.delta;
          } else if (event.type === "thinking_delta") {
            suggestedThinking += event.delta;
          }
        }
      );

      const finalSuggestion = suggestedUpdate.trim() || suggestedThinking.trim();
      if (finalSuggestion) {
        console.log(
          `[synthesis] Persona pattern suggestion:\n${finalSuggestion}`
        );
      } else {
        console.warn("[synthesis] Persona pattern analysis returned empty suggestion");
      }

      // Log to daily summary (automatic implementation would parse and apply)
      // For now, this serves as an audit trail for manual review or future auto-implementation
    } catch (e) {
      console.error(
        "[synthesis] Failed to generate persona suggestion for cluster:",
        e
      );
    }
  }

  console.log("[synthesis] Persona pattern analysis complete");
}

const MAX_DIGEST_CHARS = 12000; // Cap total digest size to stay within context limits

/**
 * Load today's agent chats and build a condensed digest of conversations.
 * Returns a formatted string summarizing what was discussed, or empty string if no chats.
 */
async function buildTodaysChatDigest(): Promise<string> {
  const allChats = await listChats();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  // Find agent chats modified today
  const todaysAgentChats = allChats.filter(
    (c) => c.type === "agent" && new Date(c.lastModified).getTime() >= todayMs
  );

  if (todaysAgentChats.length === 0) return "";

  console.log(`[synthesis] Found ${todaysAgentChats.length} agent chat(s) from today`);

  const chatDigests: string[] = [];
  let totalChars = 0;

  for (const chatItem of todaysAgentChats) {
    const chat = await getChat(chatItem.id);
    if (!chat || chat.messages.length === 0) continue;

    // Filter to today's messages only
    const todaysMessages = chat.messages.filter((m) => m.timestamp >= todayMs);
    if (todaysMessages.length === 0) continue;

    // Build a condensed version: skip tool call details, truncate long messages
    const condensed = todaysMessages
      .map((m) => {
        const prefix = m.role === "user" ? "User" : "Agent";
        let text = m.content;
        // Truncate very long messages
        if (text.length > 500) {
          text = text.slice(0, 500) + "...";
        }
        // Note tool usage without full details
        const toolNote =
          m.toolCalls && m.toolCalls.length > 0
            ? ` [used tools: ${m.toolCalls.map((t) => t.name).join(", ")}]`
            : "";
        return `${prefix}: ${text}${toolNote}`;
      })
      .join("\n");

    const digest = `### ${chat.title || "Untitled Chat"}\n${condensed}`;

    // Respect the cap
    if (totalChars + digest.length > MAX_DIGEST_CHARS) {
      chatDigests.push(`### ${chat.title || "Untitled Chat"}\n(truncated — ${todaysMessages.length} messages)`);
      break;
    }

    chatDigests.push(digest);
    totalChars += digest.length;
  }

  return chatDigests.join("\n\n---\n\n");
}

async function getSynthesisModelId(): Promise<string | null> {
  // Prefer user's configured default model
  try {
    const settings = await getSettings();
    if (settings.defaultModelId) {
      // Verify the configured model is actually available in Ollama
      const models = await discoverOllamaModels();
      const found = models.find((m) => m.id === settings.defaultModelId);
      if (found) return found.id;
      console.warn(
        `[synthesis] Configured model "${settings.defaultModelId}" not available in Ollama, falling back`
      );
    }
  } catch {
    console.warn("[synthesis] Could not load settings, falling back to model discovery");
  }

  // Fallback: pick the first available non-embedding model
  try {
    const models = await discoverOllamaModels();
    if (models.length === 0) {
      console.error("[synthesis] No Ollama models available for synthesis");
      return null;
    }
    console.log(`[synthesis] Using fallback model: ${models[0].id}`);
    return models[0].id;
  } catch (e) {
    console.error("[synthesis] Ollama unreachable:", e);
    return null;
  }
}
