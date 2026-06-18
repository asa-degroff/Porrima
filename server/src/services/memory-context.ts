import { embed, cosineSimilarity } from "./embeddings.js";
import { searchMemories, updateMemory, mmrRerank, getMemoryBlocksByScope, isSystemManagedMemoryBlock, type MemoryBlock } from "./memory-storage.js";
import { rerank, RERANK_INSTRUCTIONS, type RerankOutput } from "./reranker.js";
import { recordRerankerStats } from "./reranker-stats.js";
import { loadPersona } from "./persona-store.js";
import { loadUserDocument } from "./user-store.js";
import { readAgentsMd } from "./project-storage.js";
import { getProject, getSettings } from "./chat-storage.js";
import { getWorkspaceForProject } from "./workspace.js";
import { log } from "./logger.js";
import { getRetrievalBudget } from "./retrieval-settings.js";
import {
  clearLlamaCacheResidencyTarget,
  NEW_AGENT_CHAT_BASELINE_CACHE_ID,
} from "./llama-cache-residency.js";
import {
  applyCrossProjectScoreMultiplier,
  applyGlobalProjectScoreMultiplier,
  CROSS_PROJECT_SCORE_MULTIPLIER_DEFAULT,
  GLOBAL_PROJECT_SCORE_MULTIPLIER_DEFAULT,
  normalizeCrossProjectScoreMultiplier,
  normalizeGlobalProjectScoreMultiplier,
  sortByAdjustedScore,
} from "./memory-retrieval-scope.js";
import type { ChatMessage, Memory } from "../types.js";

// Cache the last-built augmented prompt per chat so the prompt viewer
// can return it instantly without a cold embedding call.
const promptCache = new Map<string, string>();

export function getCachedAugmentedPrompt(chatId: string): string | undefined {
  return promptCache.get(chatId);
}

export function setCachedAugmentedPrompt(chatId: string, prompt: string): void {
  promptCache.set(chatId, prompt);
}

// Cache the stable prefix per chat. The globally shareable portion is kept
// before project-only context so new-chat baseline warms can match project chats
// through global blocks and zeitgeist.
const stablePrefixCache = new Map<string, {
  basePrompt: string;
  prefix: string;
  blocksSection: string;
  hasIndexedBlocks: boolean;
}>();

async function loadProjectContext(projectId?: string, projectPath?: string): Promise<{ label: string; agentsMd: string | null } | null> {
  if (!projectId) return null;
  const project = await getProject(projectId);
  if (project) {
    const workspace = await getWorkspaceForProject(project);
    const agentsMd = await workspace.readAgentsMd();
    return { label: workspace.label, agentsMd };
  }
  if (projectPath) {
    const agentsMd = await readAgentsMd(projectPath);
    return { label: projectPath, agentsMd };
  }
  return null;
}

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
 * Return memory IDs already present in this chat's active memory context.
 * Used by passive mid-turn recall to avoid re-injecting frozen or delta
 * memories through a second hidden system row.
 */
export function getMemoryContextIds(chatId: string): Set<string> {
  const state = contextState.get(chatId);
  if (!state) return new Set();
  return new Set([...state.frozenIds, ...state.deltaIds]);
}

/**
 * Mark memory IDs as injected through an appended delta row.
 */
export function markMemoryDeltaInjected(chatId: string, memoryIds: string[]): void {
  const state = contextState.get(chatId);
  if (!state) return;
  for (const id of memoryIds) {
    state.deltaIds.add(id);
  }
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
  promptCache.delete(chatId);
}

/**
 * Invalidate all stable prefix caches globally.
 */
export function invalidateAllStablePrefixCaches(): void {
  stablePrefixCache.clear();
  clearLlamaCacheResidencyTarget(NEW_AGENT_CHAT_BASELINE_CACHE_ID, "new-agent-chat");
}

export function resetAllMemoryContextCaches(): void {
  contextState.clear();
  stablePrefixCache.clear();
  clearLlamaCacheResidencyTarget(NEW_AGENT_CHAT_BASELINE_CACHE_ID, "new-agent-chat");
}

export interface AugmentedPromptResult {
  systemPrompt: string;        // Stable system prompt (with frozen memories)
  memoriesMessage: string;     // Delta: only NEW memories not already in context
  combined: string;            // Legacy: full combined prompt for prompt viewer
}

// ---- Shared retrieval pipeline ----

export interface RetrievalResult {
  memory: Memory;
  score: number;
}

const SAME_CHAT_VISIBLE_SOURCE_COVERAGE_THRESHOLD = 0.8;
const MEMORY_RERANK_QUERY_CHARS = 900;
const MEMORY_RERANK_MESSAGE_CHARS = 450;

function messageTimestamp(message: ChatMessage): number | null {
  return typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
    ? message.timestamp
    : null;
}

function clampText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}\n[truncated]`;
}

function isSyntheticUserContext(message: ChatMessage): boolean {
  if (message.role !== "user") return false;
  if (message._isAutomationMessage) return true;
  const content = message.content.trim();
  return (
    content.startsWith("[System:") ||
    content.startsWith("Key context from this conversation") ||
    content.includes("\nKey context from this conversation")
  );
}

function recentRealUserMessages(recentMessages: ChatMessage[], limit: number): ChatMessage[] {
  return recentMessages
    .filter((m) => m.role === "user" && !m._outOfContext && !m._isCompactionSummary && !isSyntheticUserContext(m))
    .slice(-limit);
}

export function buildMemoryRerankQuery(recentMessages: ChatMessage[], maxChars = MEMORY_RERANK_QUERY_CHARS): string {
  const messages = recentRealUserMessages(recentMessages, 3);
  const parts: string[] = [];
  let used = 0;

  for (const message of [...messages].reverse()) {
    const text = clampText(message.content, MEMORY_RERANK_MESSAGE_CHARS).replace(/\s+/g, " ");
    if (!text) continue;
    const separator = parts.length > 0 ? 2 : 0;
    if (used + separator + text.length > maxChars && parts.length > 0) break;
    parts.unshift(text);
    used += separator + text.length;
  }

  const query = parts.join("\n\n").trim();
  if (query.length <= maxChars) return query;
  return query.slice(query.length - maxChars).trimStart();
}

function isSourceMessage(message: ChatMessage): boolean {
  return message.role !== "system";
}

function shouldSuppressSameChatMemory(memory: RetrievalResult["memory"], recentMessages: ChatMessage[]): boolean {
  const indexStart = memory.sourceMessageStartIndex;
  const indexEnd = memory.sourceMessageEndIndex;
  if (indexStart !== undefined && indexEnd !== undefined) {
    let total = 0;
    let visible = 0;
    for (let i = Math.max(0, indexStart); i <= indexEnd && i < recentMessages.length; i++) {
      const message = recentMessages[i];
      if (!message || !isSourceMessage(message)) continue;
      total++;
      if (!message._outOfContext) visible++;
    }
    if (total > 0) {
      return visible / total >= SAME_CHAT_VISIBLE_SOURCE_COVERAGE_THRESHOLD;
    }
  }

  const start = memory.sourceMessageStartTimestamp;
  const end = memory.sourceMessageEndTimestamp;
  if (start === undefined || end === undefined) {
    return !recentMessages.some((message) => message._isCompactionSummary && !message._outOfContext);
  }

  let total = 0;
  let visible = 0;
  for (const message of recentMessages) {
    if (!isSourceMessage(message)) continue;
    const ts = messageTimestamp(message);
    if (ts === null) continue;
    if (ts >= start && ts <= end) {
      total++;
      if (!message._outOfContext) visible++;
    }
  }
  if (total === 0) return false;
  return visible / total >= SAME_CHAT_VISIBLE_SOURCE_COVERAGE_THRESHOLD;
}

export function filterMemoriesAlreadyInCurrentContext<T extends RetrievalResult>(
  memories: T[],
  chatId: string | undefined,
  recentMessages: ChatMessage[],
  _source: string,
): T[] {
  if (!chatId) return memories;
  return memories.filter((result) => {
    if (!result.memory.sourceChatId || result.memory.sourceChatId !== chatId) return true;
    return !shouldSuppressSameChatMemory(result.memory, recentMessages);
  });
}

async function getConfiguredCrossProjectScoreMultiplier(): Promise<number> {
  try {
    const settings = await getSettings();
    return normalizeCrossProjectScoreMultiplier(settings.crossProjectScoreMultiplier);
  } catch {
    return CROSS_PROJECT_SCORE_MULTIPLIER_DEFAULT;
  }
}

async function getConfiguredGlobalProjectScoreMultiplier(): Promise<number> {
  try {
    const settings = await getSettings();
    return normalizeGlobalProjectScoreMultiplier(settings.globalProjectScoreMultiplier);
  } catch {
    return GLOBAL_PROJECT_SCORE_MULTIPLIER_DEFAULT;
  }
}

async function retrieveMemories(
  recentMessages: ChatMessage[],
  chatId?: string,
  chatType?: string,
  projectId?: string,
): Promise<RetrievalResult[]> {
  const userMessages = recentRealUserMessages(recentMessages, 3)
    .map((m) => m.content)
    .join("\n")
    .trim();

  if (!userMessages) return [];

  const budget = await getRetrievalBudget();
  const searchQuery = clampText(userMessages, budget.memoryContext.searchQueryChars);
  const rerankQuery = buildMemoryRerankQuery(recentMessages, budget.memoryContext.rerankQueryChars);
  if (!rerankQuery) return [];

  const queryEmbedding = await embed(searchQuery);
  const crossProjectMultiplier = await getConfiguredCrossProjectScoreMultiplier();
  const globalProjectMultiplier = await getConfiguredGlobalProjectScoreMultiplier();
  const searchResults = await searchMemories(
    queryEmbedding,
    budget.memoryContext.searchLimit,
    new Date(),
    searchQuery,
    undefined,
    projectId
      ? { projectId, crossProjectScoreMultiplier: crossProjectMultiplier }
      : { globalProjectScoreMultiplier: globalProjectMultiplier },
  );
  const results = filterMemoriesAlreadyInCurrentContext(
    searchResults as RetrievalResult[],
    chatId,
    recentMessages,
    "memory-retrieval",
  );
  if (results.length === 0) return [];

  const instruction = RERANK_INSTRUCTIONS[chatType || "agent"];
  const rerankCandidates = mmrRerank(
    sortByAdjustedScore(results).slice(0, budget.memoryContext.candidatePool),
    queryEmbedding,
    budget.memoryContext.rerankDocumentLimit,
    0.65,
  );
  const rerankOutput: RerankOutput = await rerank(
    rerankQuery,
    rerankCandidates.map((r) => r.memory.text),
    instruction,
    Math.min(budget.memoryContext.rerankTopN, rerankCandidates.length)
  );

  const rerankedResults = rerankOutput.results.map(({ index, score }) => ({
    ...rerankCandidates[index],
    score,
  }));

  // --- Topic-aware memory culling ---
  // After compaction cycles, the memory store accumulates memories from every
  // topic the conversation has touched. Compaction summaries capture what the
  // conversation is about NOW. Use the most recent one as a topic anchor to
  // favor memories relevant to the active topic and suppress stale ones from
  // earlier phases of the conversation.
  //
  // This only activates after at least one compaction cycle (when summaries
  // exist). Before compaction, retrieval is purely query-driven — which is
  // correct since there's no topic drift yet.
  const inContextSummaries = recentMessages
    .filter(m => m._isCompactionSummary && !m._outOfContext)
    .map(m => m.content);

  if (inContextSummaries.length > 0 && rerankedResults.length > 0) {
    const topicText = inContextSummaries[inContextSummaries.length - 1];
    try {
      const topicEmbedding = await embed(topicText);
      // Multiplicative topic adjustment: on-topic memories retain most of
      // their score, off-topic memories are dampened. TOPIC_BOOST_MIN is
      // the floor multiplier for completely off-topic memories — they can
      // still be retrieved if their relevance score is high enough, but
      // they're significantly disadvantaged.
      const TOPIC_BOOST_MIN = 0.3;

      let minTopicSim = 1, maxTopicSim = 0;
      for (const r of rerankedResults) {
        const topicSim = cosineSimilarity(r.memory.embedding, topicEmbedding);
        minTopicSim = Math.min(minTopicSim, topicSim);
        maxTopicSim = Math.max(maxTopicSim, topicSim);
        r.score *= (TOPIC_BOOST_MIN + (1 - TOPIC_BOOST_MIN) * topicSim);
      }

      log(`[memory-retrieval] topic-aware: ${inContextSummaries.length} compaction summaries, topic sim range: ${minTopicSim.toFixed(3)}–${maxTopicSim.toFixed(3)}`);
    } catch (e) {
      console.error("[memory-retrieval] topic embedding failed, skipping adjustment:", e);
    }
  }

  // --- Cross-project score dampening ---
  // When operating within a project context, memories from other projects get
  // dampened so they don't dominate retrieval results. They're not filtered out
  // entirely — genuinely relevant cross-project content can still surface if its
  // score is high enough to clear the threshold after dampening.
  if (projectId) {
    const crossProjectCount = applyCrossProjectScoreMultiplier(rerankedResults, projectId, crossProjectMultiplier);
    if (crossProjectCount > 0) {
      log(`[memory-retrieval] cross-project: dampened ${crossProjectCount} out-of-scope memories (×${crossProjectMultiplier})`);
    }
  } else {
    const projectScopedCount = applyGlobalProjectScoreMultiplier(rerankedResults, globalProjectMultiplier);
    if (projectScopedCount > 0 && globalProjectMultiplier !== GLOBAL_PROJECT_SCORE_MULTIPLIER_DEFAULT) {
      log(`[memory-retrieval] global-project: adjusted ${projectScopedCount} project-scoped memories (×${globalProjectMultiplier})`);
    }
  }

  const adjustedResults = sortByAdjustedScore(rerankedResults);
  const currentMemories = adjustedResults.filter((r) => !r.memory.supersededBy);
  const supersededMemories = adjustedResults.filter((r) => r.memory.supersededBy);

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

  // Record reranker stats for the UI — after final selection so we know
  // which memories were actually injected.
  try {
    recordRerankerStats({
      usedModel: rerankOutput.usedModel,
      latencyMs: rerankOutput.latencyMs,
      documentCount: rerankOutput.documentCount,
      topN: rerankOutput.results.length,
      totalTokens: rerankOutput.totalTokens,
      scoreMin: rerankOutput.scoreMin,
      scoreMax: rerankOutput.scoreMax,
      scoreMedian: rerankOutput.scoreMedian,
      chatType: chatType || "agent",
      source: "memory-context",
      query: `Instruct: ${instruction}\nQuery: ${rerankQuery}`,
      documents: rerankCandidates.map((r) => r.memory.text),
      selectedResults: finalMemories.map((r) => ({
        text: r.memory.text,
        score: r.score,
      })),
      timestamp: Date.now(),
    });
  } catch (e) {
    console.warn("[memory-retrieval] Failed to record reranker stats:", e);
  }

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

export function formatRetrievedMemoryForContext(r: RetrievalResult, projectId?: string): string {
  const created = r.memory.createdAt.slice(0, 10);
  const supersededNote = r.memory.supersededBy
    ? "SUPERSEDED — a newer version of this memory exists"
    : "";
  const projectNote = r.memory.projectId && (!projectId || r.memory.projectId !== projectId)
    ? ` [project: ${r.memory.projectId}]`
    : "";
  return `- ${r.memory.text} [${r.memory.category}, importance: ${r.memory.importance}/10, saved: ${created}]${supersededNote}${projectNote}`;
}

function updateAccessMetadata(memories: RetrievalResult[], skipIds?: Set<string>): void {
  const now = new Date().toISOString();
  for (const r of memories) {
    // Skip memories already in context (frozen or delta) — bumping their
    // accessCount/lastAccessed creates a positive feedback loop where
    // frequently-retrieved memories become harder to displace, even
    // when they're no longer relevant to the current topic.
    if (skipIds?.has(r.memory.id)) continue;
    updateMemory(r.memory.id, {
      lastAccessed: now,
      accessCount: r.memory.accessCount + 1,
    }).catch(() => {});
  }
}

function buildMemoriesSection(memories: RetrievalResult[], projectId?: string, blockHint?: string, zeitgeistHint?: string): string {
  if (memories.length === 0) return "";
  const memoriesBlock = memories.map((r) => formatRetrievedMemoryForContext(r, projectId)).join("\n");
  const hints = [blockHint, zeitgeistHint].filter(Boolean).join("\n\n");
  const hintsSection = hints ? `\n\n${hints}` : "";
  return `\n\n## My relevant memories to this chat:\n${memoriesBlock}\n\nUse these memories as needed — there's no need to list them unless asked.${hintsSection}`;
}

// ---- Stable prefix builder ----

const GLOBAL_MEMORY_BLOCK_TOKEN_BUDGET = 3000;
const PROJECT_CHAT_MEMORY_BLOCK_TOKEN_BUDGET = 5000;

interface SplitMemoryBlockParts {
  loadedParts: string[];
  indexParts: string[];
  loadedTokens: number;
}

interface StableMemoryBlockSections {
  globalSection: string;
  projectSection: string;
  combinedBlocksSection: string;
  hasIndexedBlocks: boolean;
}

function formatMemoryBlockIndexLine(block: MemoryBlock, options?: { project?: boolean }): string {
  return `- [${block.id}] ${block.name}${options?.project ? " (project)" : ""} — ${block.description}`;
}

function splitMemoryBlocksForPrefix(
  blocks: MemoryBlock[],
  tokenBudget: number,
  options?: { project?: boolean },
): SplitMemoryBlockParts {
  const loadedParts: string[] = [];
  const indexParts: string[] = [];
  let loadedTokens = 0;
  let budgetExhausted = tokenBudget <= 0;

  for (const block of blocks) {
    if (!budgetExhausted && loadedTokens + block.tokenEstimate <= tokenBudget) {
      loadedParts.push(`### ${block.name}\n${block.content}`);
      loadedTokens += block.tokenEstimate;
      continue;
    }
    budgetExhausted = true;
    indexParts.push(formatMemoryBlockIndexLine(block, options));
  }

  return { loadedParts, indexParts, loadedTokens };
}

function buildMemoryBlockSection(
  loadedHeading: string,
  loadedParts: string[],
  indexHeading: string,
  indexParts: string[],
): string {
  const parts: string[] = [];
  if (loadedParts.length > 0) {
    parts.push(`${loadedHeading}\n${loadedParts.join("\n\n")}`);
  }
  if (indexParts.length > 0) {
    parts.push(`${indexHeading}\n${indexParts.join("\n")}\nTo get the full content of any block, use read_memory_block(id) when relevant.`);
  }
  return parts.length > 0 ? `\n\n${parts.join("\n\n")}` : "";
}

function buildStableMemoryBlockSections(projectId?: string): StableMemoryBlockSections {
  const globalBlocks = getMemoryBlocksByScope("global")
    .filter((b) => !isSystemManagedMemoryBlock(b));
  const globalParts = splitMemoryBlocksForPrefix(
    globalBlocks,
    GLOBAL_MEMORY_BLOCK_TOKEN_BUDGET,
  );
  const globalSection = buildMemoryBlockSection(
    "## Memory Blocks",
    globalParts.loadedParts,
    "## Available Memory Blocks",
    globalParts.indexParts,
  );

  let projectSection = "";
  let hasProjectIndex = false;
  if (projectId) {
    const projectBlocks = getMemoryBlocksByScope("project", projectId)
      .filter((b) => !isSystemManagedMemoryBlock(b));
    const projectBudget = Math.max(0, PROJECT_CHAT_MEMORY_BLOCK_TOKEN_BUDGET - globalParts.loadedTokens);
    const projectParts = splitMemoryBlocksForPrefix(
      projectBlocks,
      projectBudget,
      { project: true },
    );
    projectSection = buildMemoryBlockSection(
      "## Project Memory Blocks",
      projectParts.loadedParts,
      "## Available Project Memory Blocks",
      projectParts.indexParts,
    );
    hasProjectIndex = projectParts.indexParts.length > 0;
  }

  return {
    globalSection,
    projectSection,
    combinedBlocksSection: `${globalSection}${projectSection}`,
    hasIndexedBlocks: globalParts.indexParts.length > 0 || hasProjectIndex,
  };
}

export async function buildStablePrefix(
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
  if (projectId) {
    try {
      const projectContext = await loadProjectContext(projectId, projectPath);
      if (projectContext) {
        const agentsSection = projectContext.agentsMd
          ? `\n\nProject instructions from AGENTS.md:\n${projectContext.agentsMd}`
          : "";
        projectSection = `\n\n## Project Context\nCurrent working directory: ${projectContext.label}${agentsSection}`;
      }
    } catch (e) {
      console.error("[memory] Failed to load AGENTS.md:", e);
    }
  }

  let globalBlocksSection = "";
  let projectBlocksSection = "";
  let combinedBlocksSection = "";
  let hasIndexedBlocks = false;
  try {
    const sections = buildStableMemoryBlockSections(projectId);
    globalBlocksSection = sections.globalSection;
    projectBlocksSection = sections.projectSection;
    combinedBlocksSection = sections.combinedBlocksSection;
    hasIndexedBlocks = sections.hasIndexedBlocks;
  } catch (e) {
    console.error("[memory] Failed to load memory blocks:", e);
  }

  // Load zeitgeist continuity block (global scope)
  let zeitgeistSection = "";
  try {
    const { getZeitgeistContent, getZeitgeistArchiveInstruction } = await import("./zeitgeist.js");
    const zeitgeistContent = getZeitgeistContent();
    if (zeitgeistContent) {
      zeitgeistSection = `\n\n## Continuity Context (Zeitgeist)\n\n${zeitgeistContent}`;
    }
  } catch (e) {
    // Zeitgeist not available yet — this is fine on first run
  }

  const stablePrefix = `${baseSystemPrompt}${personaSection}${userSection}${globalBlocksSection}${zeitgeistSection}${projectSection}${projectBlocksSection}`;
  stablePrefixCache.set(cacheKey, {
    basePrompt: baseSystemPrompt,
    prefix: stablePrefix,
    blocksSection: combinedBlocksSection,
    hasIndexedBlocks,
  });

  return { stablePrefix, blocksSection: combinedBlocksSection };
}

// ---- Public API ----

/**
 * Legacy single-string prompt builder. Used by pre-send compaction rebuild.
 * Always does a full retrieval (no delta logic).
 */
export interface MemoryAugmentationOptions {
  /** When true, skip memory retrieval entirely — the stable prefix (persona,
   * user doc, global memory blocks, zeitgeist, project context, and project
   * memory blocks) is still built, but
   * no memories are searched or injected. Use this for automation starts where
   * the trigger message has no meaningful conversational context to search
   * against; passive recall during the agent run will supply memories as
   * needed based on the agent's own output. */
  skipMemoryRetrieval?: boolean;
}

export async function buildMemoryAugmentedPrompt(
  baseSystemPrompt: string,
  recentMessages: ChatMessage[],
  chatId?: string,
  projectId?: string,
  chatType?: string,
  projectPath?: string,
  options?: MemoryAugmentationOptions
): Promise<string> {
  let stablePrefix: string;
  try {
    ({ stablePrefix } = await buildStablePrefix(
      baseSystemPrompt, chatId || "_default", projectId, projectPath
    ));
  } catch (e) {
    console.error("[memory] buildStablePrefix failed, falling back to base prompt:", e);
    return baseSystemPrompt;
  }

  // When skipMemoryRetrieval is set (automation starts), there's no meaningful
  // user query to search against — the trigger message is synthetic and any
  // prior user messages in the chat are from a different conversational context.
  // Passive recall during the agent run will supply relevant memories based
  // on the agent's own output trajectory.
  if (options?.skipMemoryRetrieval) {
    log(`[memory-context] chat=${chatId} skipping retrieval (automation start)`);
    return stablePrefix;
  }

  // Retrieval failures (e.g. embedding 500s on long inputs) must not discard
  // the stablePrefix — persona/user-doc/blocks/zeitgeist live there and are
  // independent of memory retrieval.
  try {
    const memories = await retrieveMemories(recentMessages, chatId, chatType, projectId);
    updateAccessMetadata(memories);

    const cached = stablePrefixCache.get(chatId || "_default");
    const blockHint = cached?.hasIndexedBlocks
      ? "\n\nAdditional context may be available in memory blocks listed above — use read_memory_block(id) to read your full memories from that block."
      : "";

    let zeitgeistHint = "";
    try {
      const { getZeitgeistArchiveInstruction } = await import("./zeitgeist.js");
      zeitgeistHint = getZeitgeistArchiveInstruction();
    } catch { /* zeitgeist not available */ }

    const memoriesSection = buildMemoriesSection(memories, projectId, blockHint, zeitgeistHint);
    return `${stablePrefix}${memoriesSection}`;
  } catch (e) {
    console.error("[memory] Memory retrieval failed, returning stablePrefix without memories:", e);
    return stablePrefix;
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
  projectPath?: string,
  options?: MemoryAugmentationOptions
): Promise<AugmentedPromptResult> {
  const cacheKey = chatId || "_default";

  // Build stablePrefix outside the retrieval try/catch — persona/user-doc/
  // blocks/zeitgeist must not be lost when memory retrieval fails (e.g.
  // embedding server 500s on long user inputs). Skills are appended by the
  // caller after this function returns, so they're also unaffected.
  let stablePrefix: string;
  try {
    ({ stablePrefix } = await buildStablePrefix(
      baseSystemPrompt, cacheKey, projectId, projectPath
    ));
  } catch (e) {
    console.error("[memory] buildStablePrefix failed, falling back to base prompt:", e);
    return { systemPrompt: baseSystemPrompt, memoriesMessage: "", combined: baseSystemPrompt };
  }

  const prefixCached = stablePrefixCache.get(cacheKey);
  const blockHint = prefixCached?.hasIndexedBlocks
    ? "\n\nAdditional context may be available in memory blocks listed above — use read_memory_block(id) to read your full memories from that block."
    : "";

  let zeitgeistHint = "";
  try {
    const { getZeitgeistArchiveInstruction } = await import("./zeitgeist.js");
    zeitgeistHint = getZeitgeistArchiveInstruction();
  } catch { /* zeitgeist not available */ }

  // When skipMemoryRetrieval is set (automation starts), there's no meaningful
  // user query to search against — the trigger message is synthetic and any
  // prior user messages in the chat are from a different conversational context.
  // Passive recall during the agent run will supply relevant memories based
  // on the agent's own output trajectory.
  if (options?.skipMemoryRetrieval) {
    log(`[memory-context] chat=${chatId} skipping retrieval (automation start)`);
    // Don't establish any state — the next real user turn should do a full
    // retrieval with an actual conversational query.
    return { systemPrompt: stablePrefix, memoriesMessage: "", combined: stablePrefix };
  }

  const state = chatId ? contextState.get(chatId) : undefined;

  // Case 1: No state — first turn or post-reset. Full retrieval into system prompt.
  if (!state) {
    try {
      const memories = await retrieveMemories(recentMessages, chatId, chatType, projectId);
      updateAccessMetadata(memories);

      const memoriesSection = buildMemoriesSection(memories, projectId, blockHint, zeitgeistHint);
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
    } catch (e) {
      // Retrieval failed on first turn — keep stablePrefix (with persona/blocks),
      // skip memories. Don't establish state so the next turn retries retrieval
      // with whatever the new query is.
      console.error(`[memory] chat=${chatId} initial retrieval failed, returning stablePrefix without memories:`, e);
      return { systemPrompt: stablePrefix, memoriesMessage: "", combined: stablePrefix };
    }
  }

  // Case 2: State exists, not dirty — reuse frozen system prompt, no delta.
  if (!state.dirty) {
    const systemPrompt = `${stablePrefix}${state.frozenMemoriesSection}`;
    log(`[memory-context] chat=${chatId} cache hit: system prompt stable, no delta needed`);
    return { systemPrompt, memoriesMessage: "", combined: systemPrompt };
  }

  // Case 3: State exists, dirty — re-retrieve and compute delta.
  try {
    const memories = await retrieveMemories(recentMessages, chatId, chatType, projectId);
    const inContextIds = new Set([...state.frozenIds, ...state.deltaIds]);
    // Only bump access for memories NOT already in context — frozen memories
    // get retrieved every turn and shouldn't have their recency signal inflated.
    updateAccessMetadata(memories, inContextIds);

    const newMemories = memories.filter((r) => !inContextIds.has(r.memory.id));

    state.dirty = false;
    for (const r of newMemories) {
      state.deltaIds.add(r.memory.id);
    }

    let memoriesMessage = "";
    if (newMemories.length > 0) {
      const deltaBlock = newMemories.map((r) => formatRetrievedMemoryForContext(r, projectId)).join("\n");
      memoriesMessage = `## Updated context — my newly recalled memories:\n${deltaBlock}`;
    }

    const systemPrompt = `${stablePrefix}${state.frozenMemoriesSection}`;

    log(`[memory-context] chat=${chatId} delta: ${memories.length} retrieved, ${newMemories.length} new (${state.frozenIds.size} frozen + ${state.deltaIds.size} delta in context)`);

    if (state.deltaIds.size > 20) {
      log(`[memory-context] chat=${chatId} delta accumulation high (${state.deltaIds.size}), will reset on next compaction`);
    }

    return { systemPrompt, memoriesMessage, combined: memoriesMessage ? `${systemPrompt}\n\n${memoriesMessage}` : systemPrompt };
  } catch (e) {
    // Delta retrieval failed — frozen memories in the system prompt are still
    // valid, so preserve them and skip the delta. Leave state.dirty=true so
    // the next turn retries with a different query string (transient
    // failures like a brief embed server hiccup recover automatically).
    console.warn(`[memory-context] chat=${chatId} delta retrieval failed, using frozen state (skipping delta):`, e);
    const systemPrompt = `${stablePrefix}${state.frozenMemoriesSection}`;
    return { systemPrompt, memoriesMessage: "", combined: systemPrompt };
  }
}
