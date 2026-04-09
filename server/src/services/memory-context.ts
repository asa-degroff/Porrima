import { embed } from "./embeddings.js";
import { searchMemories, updateMemory, mmrRerank, getMemoryBlocksByScope, getAllMemoryBlocks, type MemoryBlock } from "./memory-storage.js";
import { rerank, RERANK_INSTRUCTIONS, type RerankOutput } from "./reranker.js";
import { loadPersona } from "./persona-store.js";
import { loadUserDocument } from "./user-store.js";
import { readAgentsMd } from "./project-storage.js";
import { log } from "./logger.js";
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
const stablePrefixCache = new Map<string, { basePrompt: string; prefix: string; blocksSection: string }>();

// ---------------------------------------------------------------------------
// Delta-based memory context: frozen memories in system prompt + deltas at end
// ---------------------------------------------------------------------------
//
// The system prompt contains a "frozen" set of memories retrieved on the first
// turn (or after compaction). Between turns the system prompt is byte-identical
// so llama.cpp reuses 100% of the KV cache prefix.
//
// When new memories are extracted, we re-retrieve but only inject memories that
// aren't already in context (frozen set + previous deltas) as a small delta
// message appended at the END of conversation history. This keeps invalidation
// to just the delta + new user message (~200-500 tokens) instead of reprocessing
// the entire context.
//
// On compaction the frozen set is rebuilt from scratch (full reset).

interface MemoryContextState {
  /** Memory IDs baked into the system prompt */
  frozenIds: Set<string>;
  /** Memory IDs injected via delta messages in previous turns */
  deltaIds: Set<string>;
  /** The memories section text frozen in the system prompt */
  frozenMemoriesSection: string;
  /** Whether re-retrieval is needed (set by invalidateMemoriesCache) */
  dirty: boolean;
}

const contextState = new Map<string, MemoryContextState>();

/**
 * Mark memories as dirty for a chat — triggers delta retrieval on next turn.
 * The frozen system prompt stays intact; only new memories are appended.
 */
export function invalidateMemoriesCache(chatId: string): void {
  const state = contextState.get(chatId);
  if (state) {
    state.dirty = true;
  }
  // If no state exists yet, nothing to invalidate — first retrieval will be full.
}

/**
 * Invalidate all memories caches (e.g., after global memory changes like synthesis).
 */
export function invalidateAllMemoriesCaches(): void {
  for (const state of contextState.values()) {
    state.dirty = true;
  }
}

/**
 * Full reset of memory context for a chat — used after compaction.
 * Forces a complete re-retrieval with all memories going into the system prompt.
 */
export function resetMemoryContext(chatId: string): void {
  contextState.delete(chatId);
}

/**
 * Invalidate the stable prefix cache for a chat (e.g., after block modifications).
 */
export function invalidateStablePrefixCache(chatId: string): void {
  stablePrefixCache.delete(chatId);
}

/**
 * Invalidate all caches for a chat (memories + stable prefix).
 */
export function invalidateAllCaches(chatId: string): void {
  contextState.delete(chatId);
  stablePrefixCache.delete(chatId);
}

/**
 * Invalidate all stable prefix caches globally.
 */
export function invalidateAllStablePrefixCaches(): void {
  stablePrefixCache.clear();
}

export interface AugmentedPromptResult {
  systemPrompt: string;        // Stable system prompt (with frozen memories)
  memoriesMessage: string;     // Delta: only NEW memories not already in context
  combined: string;            // Legacy: full combined prompt for prompt viewer
}

// ---- Shared retrieval pipeline ----

interface RetrievalResult {
  memory: { id: string; text: string; category: string; importance: number; createdAt: string; supersededBy?: string; accessCount: number; projectId?: string; embedding: number[] };
  score: number;
}

async function retrieveMemories(
  recentMessages: ChatMessage[],
  chatType?: string,
  projectId?: string,
): Promise<RetrievalResult[]> {
  const userMessages = recentMessages
    .filter((m) => m.role === "user")
    .slice(-3)
    .map((m) => m.content)
    .join("\n");

  if (!userMessages) return [];

  const queryEmbedding = await embed(userMessages);
  const results = await searchMemories(queryEmbedding, 30, new Date(), userMessages);

  const instruction = RERANK_INSTRUCTIONS[chatType || "agent"];
  const rerankOutput: RerankOutput = await rerank(
    userMessages,
    results.map((r) => r.memory.text),
    instruction,
    25
  );

  const rerankedResults = rerankOutput.results.map(({ index, score }) => ({
    ...results[index],
    score,
  }));

  const currentMemories = rerankedResults.filter((r) => !r.memory.supersededBy);
  const supersededMemories = rerankedResults.filter((r) => r.memory.supersededBy);

  const topCurrent = currentMemories.filter((r) => r.score > 0.05);
  const diverseMemories = mmrRerank(topCurrent, queryEmbedding, 15, 0.7);

  if (projectId) {
    diverseMemories.sort((a, b) => {
      const aMatch = a.memory.projectId === projectId ? 1 : 0;
      const bMatch = b.memory.projectId === projectId ? 1 : 0;
      if (aMatch !== bMatch) return bMatch - aMatch;
      return b.score - a.score;
    });
  }

  const selected = diverseMemories.slice(0, 15);
  const topSuperseded = supersededMemories
    .filter((r) => r.score > 0.02)
    .slice(0, 5);

  const finalMemories = [...selected, ...topSuperseded.slice(0, 5)];

  // --- Retrieval pipeline logging ---
  const allScores = rerankOutput.results.map((r) => r.score);
  const queryPreview = userMessages.length > 120 ? userMessages.slice(0, 120) + "..." : userMessages;
  log(`[memory-retrieval] query="${queryPreview}" type=${chatType || "agent"} reranker=${rerankOutput.usedModel ? "model" : "fallback"} latency=${rerankOutput.latencyMs}ms`);
  log(`[memory-retrieval] candidates=${results.length} reranked=${rerankOutput.results.length} scores: min=${Math.min(...allScores).toFixed(4)} max=${Math.max(...allScores).toFixed(4)} median=${allScores.sort((a, b) => a - b)[Math.floor(allScores.length / 2)]?.toFixed(4) ?? "?"}`);
  log(`[memory-retrieval] current: ${currentMemories.length} total, ${topCurrent.length} above threshold (0.05), ${currentMemories.length - topCurrent.length} filtered`);
  log(`[memory-retrieval] superseded: ${supersededMemories.length} total, ${topSuperseded.length} above threshold (0.02)`);
  log(`[memory-retrieval] selected: ${selected.length} current + ${topSuperseded.length} superseded = ${finalMemories.length} total`);
  if (finalMemories.length > 0) {
    log(`[memory-retrieval] top memories: ${finalMemories.slice(0, 5).map((r) => `[${r.score.toFixed(3)}] ${r.memory.text.slice(0, 60)}...`).join(" | ")}`);
  }

  return finalMemories;
}

function formatMemory(r: RetrievalResult, projectId?: string): string {
  const created = r.memory.createdAt.slice(0, 10);
  const supersededNote = r.memory.supersededBy
    ? "SUPERSEDED — a newer version of this memory exists"
    : "";
  const projectNote = r.memory.projectId && projectId && r.memory.projectId !== projectId
    ? ` [project: ${r.memory.projectId}]`
    : "";
  return `- ${r.memory.text} [${r.memory.category}, importance: ${r.memory.importance}/10, saved: ${created}]${supersededNote}${projectNote}`;
}

function updateAccessMetadata(memories: RetrievalResult[]): void {
  const now = new Date().toISOString();
  for (const r of memories) {
    updateMemory(r.memory.id, {
      lastAccessed: now,
      accessCount: r.memory.accessCount + 1,
    }).catch(() => {});
  }
}

function buildMemoriesSection(memories: RetrievalResult[], projectId?: string, blockHint?: string): string {
  if (memories.length === 0) return "";
  const memoriesBlock = memories.map((r) => formatMemory(r, projectId)).join("\n");
  return `\n\n## My relevant memories to this chat:\n${memoriesBlock}\n\nUse these memories as needed — there's no need to list them unless asked.${blockHint || ""}`;
}

// ---- Stable prefix builder ----

async function buildStablePrefix(
  baseSystemPrompt: string,
  chatId: string,
  projectId?: string,
  projectPath?: string,
): Promise<{ stablePrefix: string; blocksSection: string }> {
  const cacheKey = chatId;
  const cached = stablePrefixCache.get(cacheKey);

  if (cached && cached.basePrompt === baseSystemPrompt) {
    return { stablePrefix: cached.prefix, blocksSection: cached.blocksSection };
  }

  let personaSection = "";
  try {
    const persona = await loadPersona();
    personaSection = `\n${persona.content}\n\nThis is my core identity.`;
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

  let blocksSection = "";
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

    const tokenBudget = projectId ? 5000 : 3000;
    let loadedTokens = 0;
    const loadedParts: string[] = [];
    for (const block of loadedBlocks) {
      if (loadedTokens + block.tokenEstimate > tokenBudget) break;
      loadedParts.push(`### ${block.name}\n${block.content}`);
      loadedTokens += block.tokenEstimate;
    }

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

  const stablePrefix = `${baseSystemPrompt}${personaSection}${userSection}${projectSection}${blocksSection}`;
  stablePrefixCache.set(cacheKey, { basePrompt: baseSystemPrompt, prefix: stablePrefix, blocksSection });

  return { stablePrefix, blocksSection };
}

// ---- Public API ----

/**
 * Legacy single-string prompt builder. Used by pre-send compaction rebuild.
 * Always does a full retrieval (no delta logic).
 */
export async function buildMemoryAugmentedPrompt(
  baseSystemPrompt: string,
  recentMessages: ChatMessage[],
  chatId?: string,
  projectId?: string,
  chatType?: string,
  projectPath?: string
): Promise<string> {
  try {
    const { stablePrefix, blocksSection } = await buildStablePrefix(
      baseSystemPrompt, chatId || "_default", projectId, projectPath
    );

    const memories = await retrieveMemories(recentMessages, chatType, projectId);
    updateAccessMetadata(memories);

    const cached = stablePrefixCache.get(chatId || "_default");
    const hasIndexedBlocks = cached?.blocksSection?.includes("Available Memory Blocks");
    const blockHint = hasIndexedBlocks
      ? "\n\nAdditional context may be available in memory blocks listed above — use read_memory_block(id) to read your full memories from that block."
      : "";

    const memoriesSection = buildMemoriesSection(memories, projectId, blockHint);
    return `${stablePrefix}${memoriesSection}`;
  } catch (e) {
    console.error("[memory] Context augmentation failed, using base prompt:", e);
    return baseSystemPrompt;
  }
}

/**
 * Delta-aware prompt builder for the main chat path.
 *
 * Returns:
 * - systemPrompt: frozen system prompt (byte-identical between turns)
 * - memoriesMessage: delta of NEW memories not already in context (may be empty)
 *
 * Flow:
 * 1. No state yet (first turn / post-compaction) → full retrieval, all memories
 *    go into systemPrompt, memoriesMessage is empty.
 * 2. State exists, not dirty → return frozen systemPrompt, empty delta.
 * 3. State exists, dirty (extraction added memories) → re-retrieve, diff against
 *    frozenIds ∪ deltaIds, return only new memories as memoriesMessage.
 */
export async function buildSplitAugmentedPrompt(
  baseSystemPrompt: string,
  recentMessages: ChatMessage[],
  chatId?: string,
  projectId?: string,
  chatType?: string,
  projectPath?: string
): Promise<AugmentedPromptResult> {
  try {
    const cacheKey = chatId || "_default";
    const { stablePrefix, blocksSection } = await buildStablePrefix(
      baseSystemPrompt, cacheKey, projectId, projectPath
    );

    const prefixCached = stablePrefixCache.get(cacheKey);
    const hasIndexedBlocks = prefixCached?.blocksSection?.includes("Available Memory Blocks");
    const blockHint = hasIndexedBlocks
      ? "\n\nAdditional context may be available in memory blocks listed above — use read_memory_block(id) to read your full memories from that block."
      : "";

    const state = chatId ? contextState.get(chatId) : undefined;

    // Case 1: No state — first turn or post-reset. Full retrieval into system prompt.
    if (!state) {
      const memories = await retrieveMemories(recentMessages, chatType, projectId);
      updateAccessMetadata(memories);

      const memoriesSection = buildMemoriesSection(memories, projectId, blockHint);
      const systemPrompt = `${stablePrefix}${memoriesSection}`;

      if (chatId) {
        contextState.set(chatId, {
          frozenIds: new Set(memories.map((r) => r.memory.id)),
          deltaIds: new Set(),
          frozenMemoriesSection: memoriesSection,
          dirty: false,
        });
      }

      log(`[memory-context] chat=${chatId} full retrieval: ${memories.length} memories frozen in system prompt`);

      return { systemPrompt, memoriesMessage: "", combined: systemPrompt };
    }

    // Case 2: State exists, not dirty — reuse frozen system prompt, no delta.
    if (!state.dirty) {
      const systemPrompt = `${stablePrefix}${state.frozenMemoriesSection}`;
      log(`[memory-context] chat=${chatId} cache hit: system prompt stable, no delta needed`);
      return { systemPrompt, memoriesMessage: "", combined: systemPrompt };
    }

    // Case 3: State exists, dirty — re-retrieve and compute delta.
    const memories = await retrieveMemories(recentMessages, chatType, projectId);
    updateAccessMetadata(memories);

    const inContextIds = new Set([...state.frozenIds, ...state.deltaIds]);
    const newMemories = memories.filter((r) => !inContextIds.has(r.memory.id));

    // Mark as clean
    state.dirty = false;

    // Track new delta IDs
    for (const r of newMemories) {
      state.deltaIds.add(r.memory.id);
    }

    // Build delta message (only new memories)
    let memoriesMessage = "";
    if (newMemories.length > 0) {
      const deltaBlock = newMemories.map((r) => formatMemory(r, projectId)).join("\n");
      memoriesMessage = `## Updated context — my newly recalled memories:\n${deltaBlock}`;
    }

    const systemPrompt = `${stablePrefix}${state.frozenMemoriesSection}`;

    log(`[memory-context] chat=${chatId} delta: ${memories.length} retrieved, ${newMemories.length} new (${state.frozenIds.size} frozen + ${state.deltaIds.size} delta in context)`);

    // If deltas have accumulated too many (>20), schedule a full reset on next compaction.
    // Don't reset now — that would change the system prompt and invalidate the KV cache.
    if (state.deltaIds.size > 20) {
      log(`[memory-context] chat=${chatId} delta accumulation high (${state.deltaIds.size}), will reset on next compaction`);
    }

    return { systemPrompt, memoriesMessage, combined: memoriesMessage ? `${systemPrompt}\n\n${memoriesMessage}` : systemPrompt };
  } catch (e) {
    console.error("[memory] Context augmentation failed, using base prompt:", e);
    // If we have existing frozen state, preserve the system prompt rather than falling
    // back to bare base prompt — the frozen memories are still valid.
    const state = chatId ? contextState.get(chatId) : undefined;
    if (state) {
      const cached = stablePrefixCache.get(chatId || "_default");
      if (cached) {
        const systemPrompt = `${cached.prefix}${state.frozenMemoriesSection}`;
        console.warn(`[memory-context] chat=${chatId} delta retrieval failed, using frozen state (skipping delta)`);
        state.dirty = false; // Don't retry immediately — wait for next invalidation
        return { systemPrompt, memoriesMessage: "", combined: systemPrompt };
      }
    }
    return { systemPrompt: baseSystemPrompt, memoriesMessage: "", combined: baseSystemPrompt };
  }
}
