import { embed } from "./embeddings.js";
import { searchMemories, updateMemory, mmrRerank, getMemoryBlocksByScope, getAllMemoryBlocks, type MemoryBlock } from "./memory-storage.js";
import { rerank, RERANK_INSTRUCTIONS, type RerankOutput } from "./reranker.js";
import { loadPersona } from "./persona-store.js";
import { loadUserDocument } from "./user-store.js";
import { readAgentsMd } from "./project-storage.js";
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

// Cache the stable prefix (base prompt + persona + user doc + blocks + project context) per chat.
// This avoids re-fetching and re-assembling the stable parts every turn.
// The prefix only changes when the base system prompt changes (rare).
const stablePrefixCache = new Map<string, { basePrompt: string; prefix: string; blocksSection: string }>();

// Cache retrieved memories per chat. Only invalidated when new memories are
// extracted or modified, so the system prompt stays byte-identical between
// consecutive turns — maximizing KV cache prefix reuse.
const memoriesCache = new Map<string, { memoriesSection: string }>();

/**
 * Invalidate the cached memories for a chat, forcing re-retrieval on the next turn.
 * Call this after memory extraction, block updates, or any memory modification.
 */
export function invalidateMemoriesCache(chatId: string): void {
  memoriesCache.delete(chatId);
}

/**
 * Invalidate all memories caches (e.g., after global memory changes like synthesis).
 */
export function invalidateAllMemoriesCaches(): void {
  memoriesCache.clear();
}

/**
 * Invalidate the stable prefix cache for a chat (e.g., after block modifications).
 * This forces re-assembly of persona + user doc + blocks on the next turn.
 */
export function invalidateStablePrefixCache(chatId: string): void {
  stablePrefixCache.delete(chatId);
}

/**
 * Invalidate all caches for a chat (memories + stable prefix).
 * Use after operations that affect both memories and blocks.
 */
export function invalidateAllCaches(chatId: string): void {
  memoriesCache.delete(chatId);
  stablePrefixCache.delete(chatId);
}

/**
 * Invalidate all stable prefix caches globally.
 * Use after block modifications via the API (no specific chatId available).
 */
export function invalidateAllStablePrefixCaches(): void {
  stablePrefixCache.clear();
}

export interface AugmentedPromptResult {
  systemPrompt: string;        // Full system prompt including memories
  memoriesMessage: string;     // Empty string — memories are now in system prompt
  combined: string;            // Same as systemPrompt for backward compat
}

export async function buildMemoryAugmentedPrompt(
  baseSystemPrompt: string,
  recentMessages: ChatMessage[],
  chatId?: string,
  projectId?: string,
  chatType?: string,
  projectPath?: string
): Promise<string> {
  try {
    // Build or reuse the stable prefix (base prompt + persona + user doc + blocks).
    // This prefix rarely changes within a conversation, so caching it avoids
    // re-fetching persona/user doc/blocks every turn AND keeps the system prompt
    // prefix stable for llama.cpp's KV cache prefix matching.
    const cacheKey = chatId || "_default";
    let cached = stablePrefixCache.get(cacheKey);
    let stablePrefix: string;
    let blocksSection: string;

    if (cached && cached.basePrompt === baseSystemPrompt) {
      // Cache hit — reuse stable prefix
      stablePrefix = cached.prefix;
      blocksSection = cached.blocksSection;
    } else {
      // Cache miss or base prompt changed — rebuild
      let personaSection = "";
      try {
        const persona = await loadPersona();
        personaSection = `\n${persona.content}\n\nRemember: This is your core identity.`;
      } catch (e) {
        console.error("[memory] Failed to load persona, continuing without:", e);
      }

      let userSection = "";
      try {
        const userDoc = await loadUserDocument();
        if (userDoc && userDoc.content.trim()) {
          userSection = `\n\n## About the User\n${userDoc.content}\n\nThis concludes the user information.`;
        }
      } catch (e) {
        // User document is optional
      }

       // Load project context (AGENTS.md) after stable user context.
      // This is more stable than memory blocks (which are loaded/unloaded dynamically)
      // but less stable than persona/user docs.
      let projectSection = "";
      if (projectId && projectPath) {
        try {
          const agentsMd = await readAgentsMd(projectPath);
          if (agentsMd) {
            projectSection = `\n\n## Project Context\nYou are working on the project with the following context from AGENTS.md:\n${agentsMd}`;
          }
        } catch (e) {
          console.error("[memory] Failed to load AGENTS.md:", e);
        }
      }

      // Load memory blocks by scope:
      // - Global blocks: always loaded (full content)
      // - Project blocks: auto-loaded for matching project chats (full content)
      // - Other blocks: shown as one-line index for discovery via read_memory_block
      // Memory blocks come after AGENTS.md because they're more volatile -
      // they're loaded/unloaded dynamically and edited by the agent.
      blocksSection = "";
      try {
        const loadedBlocks: MemoryBlock[] = [];
        const globalBlocks = getMemoryBlocksByScope("global");
        loadedBlocks.push(...globalBlocks);
        if (projectId) {
          const projectBlocks = getMemoryBlocksByScope("project", projectId);
          loadedBlocks.push(...projectBlocks);
        }

        const allBlocks = getAllMemoryBlocks();
        const loadedIds = new Set(loadedBlocks.map((b) => b.id));
        const indexedBlocks = allBlocks.filter((b) => !loadedIds.has(b.id));

        // Load full content for global + project blocks (up to 5000 tokens for project chats)
        const tokenBudget = projectId ? 5000 : 3000;
        let loadedTokens = 0;
        const loadedParts: string[] = [];
        for (const block of loadedBlocks) {
          if (loadedTokens + block.tokenEstimate > tokenBudget) break;
          loadedParts.push(`### ${block.name}\n${block.content}`);
          loadedTokens += block.tokenEstimate;
        }

        // Build index for non-loaded blocks (other projects, overflow)
        const indexParts = indexedBlocks.map(
          (b) => `- [${b.id}] ${b.name}${b.scope === "project" ? ` (project)` : ""} — ${b.description}`
        );

        if (loadedParts.length > 0 || indexParts.length > 0) {
          const parts: string[] = [];
          if (loadedParts.length > 0) {
            parts.push(`## Memory Blocks\n${loadedParts.join("\n\n")}`);
          }
          if (indexParts.length > 0) {
            parts.push(`## Available Memory Blocks\n${indexParts.join("\n")}\nTo get the full content of any block, use read_memory_block(id) when relevant.`);
          }
          blocksSection = "\n\n" + parts.join("\n\n");
        }
      } catch (e) {
        console.error("[memory] Failed to load memory blocks:", e);
      }

      stablePrefix = `${baseSystemPrompt}${personaSection}${userSection}${projectSection}${blocksSection}`;
      stablePrefixCache.set(cacheKey, { basePrompt: baseSystemPrompt, prefix: stablePrefix, blocksSection });
    }

    // Check if we have cached memories for this chat
    const cachedMemories = chatId ? memoriesCache.get(chatId) : undefined;
    if (cachedMemories) {
      console.log(`[memory-retrieval] using cached memories for chat ${chatId}`);
      return `${stablePrefix}${cachedMemories.memoriesSection}`;
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
      const rerankOutput: RerankOutput = await rerank(
        userMessages,
        results.map((r) => r.memory.text),
        instruction,
        25 // Return top 25 from 30 candidates
      );

      // Replace RRF scores with reranker scores (0-1 calibrated relevance)
      const rerankedResults = rerankOutput.results.map(({ index, score }) => ({
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

      // --- Retrieval pipeline logging ---
      const allScores = rerankOutput.results.map((r) => r.score);
      const queryPreview = userMessages.length > 120 ? userMessages.slice(0, 120) + "..." : userMessages;
      console.log(`[memory-retrieval] query="${queryPreview}" type=${chatType || "agent"} reranker=${rerankOutput.usedModel ? "model" : "fallback"} latency=${rerankOutput.latencyMs}ms`);
      console.log(`[memory-retrieval] candidates=${results.length} reranked=${rerankOutput.results.length} scores: min=${Math.min(...allScores).toFixed(4)} max=${Math.max(...allScores).toFixed(4)} median=${allScores.sort((a, b) => a - b)[Math.floor(allScores.length / 2)]?.toFixed(4) ?? "?"}`);
      console.log(`[memory-retrieval] current: ${currentMemories.length} total, ${topCurrent.length} above threshold (0.05), ${currentMemories.length - topCurrent.length} filtered`);
      console.log(`[memory-retrieval] superseded: ${supersededMemories.length} total, ${topSuperseded.length} above threshold (0.02)`);
      console.log(`[memory-retrieval] selected: ${selected.length} current + ${topSuperseded.length} superseded = ${finalMemories.length} injected`);
      if (finalMemories.length > 0) {
        console.log(`[memory-retrieval] top memories: ${finalMemories.slice(0, 5).map((r) => `[${r.score.toFixed(3)}] ${r.memory.text.slice(0, 60)}...`).join(" | ")}`);
      }

      if (finalMemories.length > 0) {
        const memoriesBlock = finalMemories
          .map(
            (r) => {
              const created = r.memory.createdAt.slice(0, 10);
              const supersededNote = r.memory.supersededBy
                ? "SUPERSEDED — a newer version of this memory exists"
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

        // Check if there are non-loaded blocks that might have relevant context
        const hasIndexedBlocks = cached?.blocksSection?.includes("Available Memory Blocks");
        const blockHint = hasIndexedBlocks
          ? "\n\nAdditional context may be available in memory blocks listed above — use read_memory_block(id) to read your full memories from that block."
          : "";

        memoriesSection = `\n\n## Relevant memories to this chat:\n${memoriesBlock}\n\nUse these memories as needed — there's no need to list them unless asked.${blockHint}`;
      }
    }

    // Cache the memories for this chat so subsequent turns reuse the same text,
    // keeping the system prompt byte-identical for KV cache prefix matching.
    if (chatId) {
      memoriesCache.set(chatId, { memoriesSection });
    }

    // Assemble final prompt: stable prefix (cached) + memories (cached after first retrieval)
    return `${stablePrefix}${memoriesSection}`;
  } catch (e) {
    console.error("[memory] Context augmentation failed, using base prompt:", e);
    return baseSystemPrompt;
  }
}

/**
 * Build the augmented prompt — memories are now included in the system prompt
 * (not split out). The memoriesMessage field is always empty for backward compat.
 *
 * With memories cached per-chat and only re-retrieved when invalidated (after
 * extraction), the system prompt stays byte-identical between consecutive turns.
 * This means only the new messages at the end of context need KV cache processing,
 * reducing prompt eval from ~10k tokens to ~200-500 tokens per turn.
 */
export async function buildSplitAugmentedPrompt(
  baseSystemPrompt: string,
  recentMessages: ChatMessage[],
  chatId?: string,
  projectId?: string,
  chatType?: string,
  projectPath?: string
): Promise<AugmentedPromptResult> {
  const combined = await buildMemoryAugmentedPrompt(
    baseSystemPrompt, recentMessages, chatId, projectId, chatType, projectPath
  );

  return {
    systemPrompt: combined,
    memoriesMessage: "",  // No longer split — memories are in system prompt
    combined,
  };
}
