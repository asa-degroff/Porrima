import { createHash } from "crypto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { embed } from "./embeddings.js";
import { searchMemories, mmrRerank, updateMemory, type ScoredMemory } from "./memory-storage.js";
import { rerank, RERANK_INSTRUCTIONS, type RerankOutput } from "./reranker.js";
import { recordRerankerStats } from "./reranker-stats.js";
import {
  formatRetrievedMemoryForContext,
  getMemoryContextIds,
  markMemoryDeltaInjected,
} from "./memory-context.js";
import { hiddenSystemContextToUserMessage } from "./agent.js";
import { getSettings } from "./chat-storage.js";
import { log } from "./logger.js";
import {
  applyCrossProjectScoreMultiplier,
  applyGlobalProjectScoreMultiplier,
  CROSS_PROJECT_SCORE_MULTIPLIER_DEFAULT,
  GLOBAL_PROJECT_SCORE_MULTIPLIER_DEFAULT,
  normalizeCrossProjectScoreMultiplier,
  normalizeGlobalProjectScoreMultiplier,
  sortByAdjustedScore,
} from "./memory-retrieval-scope.js";
import type { ChatMessage } from "../types.js";

const MIN_QUERY_CHARS = 80;
const MAX_QUERY_CHARS = 6000;
const MAX_RERANK_QUERY_CHARS = 900;
const RECENT_MESSAGE_COUNT = 12;
const SEARCH_EVERY_ITERATIONS = 2;
const MIN_CANDIDATES_BEFORE_RERANK = 3;
const FAST_SEARCH_LIMIT = 40;
const DIVERSE_CANDIDATE_LIMIT = 16;
const RERANK_DOCUMENT_LIMIT = 12;
const RERANK_TOP_N = 4;
const MAX_RERANK_DOCUMENT_CHARS = 1200;
const MIN_RERANK_SCORE = 0.12;
const MAX_MEMORIES_PER_INJECTION = 2;
const MAX_PASSIVE_MEMORIES_PER_TURN = 12;
const MIN_ITERATIONS_BETWEEN_INJECTIONS = 3;

export interface PassiveMemoryRecallInjection {
  content: string;
  memoryIds: string[];
  memories: string[];
  createdAt: number;
}

export interface PassiveMemoryRecallScheduleOptions {
  iteration: number;
  stopReason: string;
  chatMessages: ChatMessage[];
  chatType?: string;
  projectId?: string;
}

function clampText(text: string | undefined, maxChars: number): string {
  if (!text) return "";
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n[truncated]`;
}

function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

function pushUnique(items: string[], value: string | undefined, maxItems: number): void {
  const trimmed = value?.trim();
  if (!trimmed || items.includes(trimmed) || items.length >= maxItems) return;
  items.push(trimmed);
}

const OPERATIONAL_FILE_EXTENSIONS =
  "ts|tsx|js|jsx|mjs|cjs|md|json|service|db|sqlite|py|rs|go|css|html|yml|yaml|toml|sql|sh";

const TOOL_OR_COMMAND_NAMES = new RegExp(
  "\\b(?:" + [
    "read_file",
    "write_file",
    "edit_file",
    "list_files",
    "bash",
    "web_search",
    "web_fetch",
    "search_memory",
    "save_memory",
    "read_memory_block",
    "create_memory_block",
    "create_artifact",
  ].join("|") + ")\\b",
  "gi",
);

function anchorToTopicWords(anchor: string): string {
  const cleaned = anchor
    .replace(/^[`"'\s]+|[`"',\s]+$/g, "")
    .replace(/[{}[\]()]/g, " ")
    .trim();
  if (!cleaned) return "";

  const segments = cleaned.split(/[\\/]+/).filter(Boolean);
  let value = segments.length > 0 ? segments[segments.length - 1] : cleaned;
  if (/^\/?(?:api|v\d)\//i.test(cleaned) && segments.length > 0) {
    value = segments.slice(-2).join(" ");
  }

  return value
    .replace(new RegExp(`\\.(${OPERATIONAL_FILE_EXTENSIONS})\\b`, "gi"), " ")
    .replace(/[-_.:]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b(?:api|dist|src|server|client|routes|services|components|hooks|lib|utils|v\d)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function replaceOperationalAnchor(anchor: string): string {
  const topicWords = anchorToTopicWords(anchor);
  return topicWords.length >= 3 ? ` ${topicWords} ` : " ";
}

function scrubOperationalNoise(text: string | undefined): string {
  if (!text) return "";
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, " ")
    .replace(/`([^`\n]{2,160})`/g, (_match, inner: string) => {
      return /[\\/]|\.|_|-|^\/(?:api|v\d)\//i.test(inner)
        ? replaceOperationalAnchor(inner)
        : ` ${inner} `;
    })
    .replace(new RegExp(`\\b[\\w./-]+\\.(${OPERATIONAL_FILE_EXTENSIONS})\\b`, "gi"), replaceOperationalAnchor)
    .replace(/\/(?:api|v\d)\/[\w./:-]+/gi, replaceOperationalAnchor)
    .replace(/(?:^|\s)(?:\.{0,2}\/|~\/|\/)[\w./-]+/g, replaceOperationalAnchor)
    .replace(/\b(?:path|command|cmd|file|filename)=\S+/gi, " ")
    .replace(/"(?:path|command|cmd|file|filename)"\s*:\s*"[^"]*"/gi, " ")
    .replace(TOOL_OR_COMMAND_NAMES, " ")
    .replace(/[{}[\]"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatToolObservations(message: ChatMessage, maxItems = 4): string {
  const parts: string[] = [];
  if (message.toolResults?.length) {
    for (const result of message.toolResults.slice(-maxItems)) {
      const observation = scrubOperationalNoise(clampText(result.content, 700));
      if (observation) parts.push(`Observation: ${observation}`);
    }
  }
  return parts.join("\n");
}

export function buildPassiveRecallQuery(messages: ChatMessage[], maxChars = MAX_QUERY_CHARS): string {
  const recent = messages
    .filter((message) => !message._outOfContext && message.role !== "system")
    .slice(-RECENT_MESSAGE_COUNT);

  const parts: string[] = [];
  for (const message of recent) {
    if (message.role === "user") {
      const content = scrubOperationalNoise(clampText(message.content, 1200));
      if (content) parts.push(`User: ${content}`);
      continue;
    }

    // Include thinking output — the agent's reasoning trajectory during tool loops.
    // This is the direction the agent is heading, valuable for finding context in
    // territory the original user message didn't cover.
    const thinking = message.thinking
      ? scrubOperationalNoise(clampText(message.thinking, 800)).replace(/\s+/g, " ")
      : "";
    const text = scrubOperationalNoise(clampText(message.content, message._isCompactionSummary ? 1600 : 1000));
    const observations = formatToolObservations(message);
    const combined = [
      thinking ? `Thinking: ${thinking}` : "",
      text ? `Assistant: ${text}` : "",
      observations,
    ].filter(Boolean).join("\n");
    if (combined) parts.push(combined);
  }

  const query = parts.join("\n\n").trim();
  return query.length > maxChars ? query.slice(query.length - maxChars) : query;
}

export function buildPassiveRerankQuery(messages: ChatMessage[], maxChars = MAX_RERANK_QUERY_CHARS): string {
  const recent = messages
    .filter((message) => !message._outOfContext && message.role !== "system")
    .slice(-RECENT_MESSAGE_COUNT);

  // --- Agent trajectory (primary signal) ---
  // The thinking block captures where the agent is heading — its reasoning
  // trajectory during the tool loop. This is the strongest signal for finding
  // context in territory the agent has excavated but the original user message
  // didn't cover.
  const latestThinking = [...recent]
    .reverse()
    .find((message) => message.role === "assistant" && message.thinking?.trim())
    ?.thinking;
  const agentThinking = latestThinking
    ? scrubOperationalNoise(latestThinking).replace(/\s+/g, " ")
    : "";

  const assistantFocus = [...recent]
    .reverse()
    .filter((message) => message.role === "assistant" && message.content?.trim())
    .slice(0, 2)
    .map((message) => scrubOperationalNoise(clampText(message.content, 350)).replace(/\s+/g, " "))
    .filter(Boolean)
    .reverse();

  const observations: string[] = [];
  for (const message of recent) {
    const observation = formatToolObservations(message, 2).replace(/\s+/g, " ");
    if (observation) pushUnique(observations, observation, 3);
  }

  // --- User context (secondary, for grounding) ---
  // Demoted: memory-context already retrieved memories for this query at turn start.
  // Kept as a grounding signal when agent trajectory is sparse.
  const latestUser = scrubOperationalNoise([...recent].reverse().find((message) => message.role === "user")?.content);

  const parts: string[] = [];
  if (agentThinking?.trim()) parts.push(`Agent thinking: ${clampText(agentThinking, 300)}`);
  if (assistantFocus.length) parts.push(`Assistant output: ${assistantFocus.join(" / ")}`);
  if (observations.length) parts.push(`Observed facts: ${observations.join(" / ")}`);
  if (latestUser?.trim()) parts.push(`User request: ${clampText(latestUser, 120).replace(/\s+/g, " ")}`);

  const query = parts.join("\n").trim();
  if (!query) return "";
  return query.length > maxChars ? query.slice(0, maxChars).trimEnd() : query;
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

function recordStats(
  output: RerankOutput,
  chatType: string | undefined,
  formattedQuery: string,
  documents: string[],
  selectedResults?: Array<{ text: string; score: number }>,
): void {
  try {
    recordRerankerStats({
      usedModel: output.usedModel,
      latencyMs: output.latencyMs,
      documentCount: output.documentCount,
      topN: output.results.length,
      totalTokens: output.totalTokens,
      scoreMin: output.scoreMin,
      scoreMax: output.scoreMax,
      scoreMedian: output.scoreMedian,
      chatType: chatType || "agent",
      source: "passive-memory",
      query: formattedQuery,
      documents,
      selectedResults,
      timestamp: Date.now(),
    });
  } catch (e) {
    console.warn("[passive-memory] Failed to record reranker stats:", e);
  }
}

function formatInjection(memories: ScoredMemory[], projectId?: string): string {
  const lines = memories
    .map((memory) => formatRetrievedMemoryForContext(memory, projectId))
    .join("\n");
  return [
    "[System context - passively recalled memories]",
    "## Recalled context - memories that may be relevant now:",
    lines,
    "",
    "Use these memories only if they help the current task. Do not mention that they were recalled unless asked.",
  ].join("\n");
}

export interface PassiveMemoryRecallPersistOptions {
  /**
   * Called when a post-turn recall injection becomes ready.
   * The caller should push the injection row to chat.messages and persist.
   * This enables passive recall to work across turn boundaries for conversational
   * sessions without tool use.
   */
  onReady?: (content: string, memoryIds: string[]) => Promise<void> | void;
}

export class PassiveMemoryRecallController {
  private inFlight: Promise<void> | null = null;
  private candidates = new Map<string, ScoredMemory>();
  private readyQueue: PassiveMemoryRecallInjection[] = [];
  private injectedIds = new Set<string>();
  private queuedIds = new Set<string>();
  private lastQueryHash: string | null = null;
  private lastScheduledIteration = 0;
  private lastInjectionIteration = 0;
  private totalInjected = 0;

  constructor(
    private readonly chatId: string,
    private readonly persist?: PassiveMemoryRecallPersistOptions,
  ) {}

  schedule(options: PassiveMemoryRecallScheduleOptions): void {
    // Trigger on tool-use (mid-turn pause) or conversational stop (post-turn).
    // For conversational stops, require substantial content so we don't waste
    // searches on trivial responses. The thinking block is the key signal — it
    // captures where the agent's reasoning traveled, which is distinct from
    // the user message that memory-context already handled at turn start.
    const isToolUse = options.stopReason === "toolUse";
    const isStop = options.stopReason === "stop";
    if (!isToolUse && !isStop) return;

    // For conversational stops, check for substantial content.
    // We look at the last assistant message for thinking + text depth.
    if (isStop) {
      const lastAssistant = [...options.chatMessages]
        .reverse()
        .find((m) => m.role === "assistant" && !m._isPassiveMemoryRecall);
      const thinkingLen = lastAssistant?.thinking?.trim().length ?? 0;
      const contentLen = lastAssistant?.content?.trim().length ?? 0;
      // Require meaningful depth — either substantial thinking or substantial output.
      // This avoids triggering on trivial one-line responses.
      if (thinkingLen < 150 && contentLen < 300) return;
    }

    if (this.inFlight) return;
    if (this.totalInjected >= MAX_PASSIVE_MEMORIES_PER_TURN) return;
    // Spacing guard: avoid redundant searches during tool loops.
    // For post-turn schedules (conversational stops), skip the spacing guard —
    // the query hash dedup already prevents redundant searches, and the first
    // conversational turn (iteration=0) needs to be allowed through.
    if (isToolUse && options.iteration - this.lastScheduledIteration < SEARCH_EVERY_ITERATIONS) return;

    const query = buildPassiveRecallQuery(options.chatMessages);
    if (query.length < MIN_QUERY_CHARS) return;
    const rerankQuery = buildPassiveRerankQuery(options.chatMessages) || clampText(query, MAX_RERANK_QUERY_CHARS);

    const queryHash = hashText(query);
    if (queryHash === this.lastQueryHash) return;
    this.lastQueryHash = queryHash;
    this.lastScheduledIteration = options.iteration;

    this.inFlight = this.runRecall(query, rerankQuery, options)
      .catch((err) => {
        console.warn("[passive-memory] recall failed:", err instanceof Error ? err.message : err);
      })
      .finally(() => {
        this.inFlight = null;
      });
  }

  peekReady(iteration: number): PassiveMemoryRecallInjection | null {
    if (this.readyQueue.length === 0) return null;
    if (this.totalInjected >= MAX_PASSIVE_MEMORIES_PER_TURN) return null;
    if (
      this.lastInjectionIteration > 0 &&
      iteration - this.lastInjectionIteration < MIN_ITERATIONS_BETWEEN_INJECTIONS
    ) {
      return null;
    }
    return this.readyQueue[0];
  }

  markApplied(injection: PassiveMemoryRecallInjection, iteration: number): void {
    const idx = this.readyQueue.indexOf(injection);
    if (idx >= 0) this.readyQueue.splice(idx, 1);
    for (const id of injection.memoryIds) {
      this.queuedIds.delete(id);
      this.injectedIds.add(id);
    }
    this.totalInjected += injection.memoryIds.length;
    this.lastInjectionIteration = iteration;
    markMemoryDeltaInjected(this.chatId, injection.memoryIds);
  }

  toReplayUserMessage(injection: PassiveMemoryRecallInjection): AgentMessage | null {
    return hiddenSystemContextToUserMessage(
      injection.content,
      injection.createdAt,
    ) as unknown as AgentMessage | null;
  }

  private async runRecall(
    query: string,
    rerankQuery: string,
    options: PassiveMemoryRecallScheduleOptions,
  ): Promise<void> {
    const queryEmbedding = await embed(query);
    const crossProjectMultiplier = await getConfiguredCrossProjectScoreMultiplier();
    const globalProjectMultiplier = await getConfiguredGlobalProjectScoreMultiplier();
    const searchResults = await searchMemories(
      queryEmbedding,
      FAST_SEARCH_LIMIT,
      new Date(),
      query,
      undefined,
      options.projectId
        ? { projectId: options.projectId, crossProjectScoreMultiplier: crossProjectMultiplier }
        : { globalProjectScoreMultiplier: globalProjectMultiplier },
    );
    const inContextIds = getMemoryContextIds(this.chatId);
    const excludedIds = new Set([...inContextIds, ...this.injectedIds, ...this.queuedIds]);

    const freshResults = searchResults.filter(
      (result) => !result.memory.supersededBy && !excludedIds.has(result.memory.id),
    );
    if (freshResults.length === 0) return;

    const diverse = mmrRerank(
      sortByAdjustedScore(freshResults).slice(0, 24),
      queryEmbedding,
      DIVERSE_CANDIDATE_LIMIT,
      0.55,
    );
    for (const candidate of diverse) {
      const existing = this.candidates.get(candidate.memory.id);
      if (!existing || candidate.score > existing.score) {
        this.candidates.set(candidate.memory.id, candidate);
      }
    }

    if (this.candidates.size < MIN_CANDIDATES_BEFORE_RERANK) {
      log(`[passive-memory] chat=${this.chatId} accumulated ${this.candidates.size} candidate(s), waiting for more`);
      return;
    }

    const rerankCandidates = sortByAdjustedScore([...this.candidates.values()])
      .filter((candidate) => !excludedIds.has(candidate.memory.id))
      .slice(0, RERANK_DOCUMENT_LIMIT);
    if (rerankCandidates.length === 0) return;

    const instruction = RERANK_INSTRUCTIONS["passive-memory"];
    const rerankDocuments = rerankCandidates.map((candidate) => clampText(candidate.memory.text, MAX_RERANK_DOCUMENT_CHARS));
    const formattedQuery = `Instruct: ${instruction}\nQuery: ${rerankQuery}`;
    const output = await rerank(
      rerankQuery,
      rerankDocuments,
      instruction,
      Math.min(RERANK_TOP_N, rerankCandidates.length),
    );

    // Passive recall should be precision-heavy. If the reranker is disabled or
    // unavailable, keep normal explicit memory search as the fallback path.
    if (!output.usedModel) {
      this.candidates.clear();
      recordStats(output, options.chatType, formattedQuery, rerankDocuments);
      return;
    }

    // --- Cross-project score dampening ---
    // Dampen memories from other projects so they don't dominate passive recall.
    // Applied after mapping reranker results but before MIN_RERANK_SCORE filtering,
    // so dampened scores are compared against the threshold consistently.
    let candidates = output.results.map(({ index, score }) => ({ ...rerankCandidates[index], score }));

    if (options.projectId) {
      const crossProjectCount = applyCrossProjectScoreMultiplier(candidates, options.projectId, crossProjectMultiplier);
      if (crossProjectCount > 0) {
        log(`[passive-memory] cross-project: dampened ${crossProjectCount} out-of-scope memories (×${crossProjectMultiplier})`);
      }
    } else {
      const projectScopedCount = applyGlobalProjectScoreMultiplier(candidates, globalProjectMultiplier);
      if (projectScopedCount > 0 && globalProjectMultiplier !== GLOBAL_PROJECT_SCORE_MULTIPLIER_DEFAULT) {
        log(`[passive-memory] global-project: adjusted ${projectScopedCount} project-scoped memories (×${globalProjectMultiplier})`);
      }
    }

    const selected = sortByAdjustedScore(candidates)
      .filter((candidate) => candidate.score >= MIN_RERANK_SCORE)
      .filter((candidate) => !excludedIds.has(candidate.memory.id))
      .slice(0, Math.min(MAX_MEMORIES_PER_INJECTION, MAX_PASSIVE_MEMORIES_PER_TURN - this.totalInjected));

    // Record stats after selection so we know which memories were actually injected.
    recordStats(output, options.chatType, formattedQuery, rerankDocuments,
      selected.map((c) => ({ text: c.memory.text, score: c.score })),
    );

    this.candidates.clear();
    if (selected.length === 0) {
      log(
        `[passive-memory] chat=${this.chatId} reranked ${rerankCandidates.length} candidate(s), none above ${MIN_RERANK_SCORE}`,
      );
      return;
    }

    const memoryIds = selected.map((candidate) => candidate.memory.id);
    for (const id of memoryIds) this.queuedIds.add(id);
    const now = new Date().toISOString();
    for (const candidate of selected) {
      updateMemory(candidate.memory.id, {
        lastAccessed: now,
        accessCount: candidate.memory.accessCount + 1,
      }).catch(() => {});
    }

    const injectionContent = formatInjection(selected, options.projectId);

    // If a persist callback is provided for post-turn injection, bypass the
    // ready queue and persist directly. The caller handles pushing to
    // chat.messages and saving. For mid-turn injection (tool-use), the
    // ready queue + peekReady path handles iteration spacing.
    if (options.stopReason === "stop" && this.persist?.onReady) {
      try {
        await this.persist.onReady(injectionContent, memoryIds);
        // Mark as applied so the IDs are tracked.
        for (const id of memoryIds) {
          this.queuedIds.delete(id);
          this.injectedIds.add(id);
        }
        this.totalInjected += memoryIds.length;
        this.lastInjectionIteration = options.iteration;
        markMemoryDeltaInjected(this.chatId, memoryIds);
        log(
          `[passive-memory] chat=${this.chatId} post-turn injected ${selected.length} memor${
            selected.length === 1 ? "y" : "ies"
          }: ${memoryIds.join(",")}`,
        );
      } catch (e) {
        for (const id of memoryIds) this.queuedIds.delete(id);
        console.warn("[passive-memory] post-turn persist failed:", e);
      }
    } else {
      this.readyQueue.push({
        content: injectionContent,
        memoryIds,
        memories: selected.map((candidate) => candidate.memory.text),
        createdAt: Date.now(),
      });
      log(
        `[passive-memory] chat=${this.chatId} queued ${selected.length} recalled memor${
          selected.length === 1 ? "y" : "ies"
        }: ${memoryIds.join(",")}`,
      );
    }
  }
}
