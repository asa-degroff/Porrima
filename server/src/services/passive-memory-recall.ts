import { createHash } from "crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { embed } from "./embeddings.js";
import { searchMemories, mmrRerank, updateMemory, type ScoredMemory } from "./memory-storage.js";
import { rerank, RERANK_INSTRUCTIONS, type RerankOutput } from "./reranker.js";
import { recordRerankerStats } from "./reranker-stats.js";
import {
  formatRetrievedMemoryForContext,
  filterMemoriesAlreadyInCurrentContext,
  getMemoryContextIds,
  markMemoryDeltaInjected,
} from "./memory-context.js";
import { hiddenSystemContextToUserMessage } from "./agent.js";
import { getSettings } from "./chat-storage.js";
import { log } from "./logger.js";
import { getRetrievalBudget } from "./retrieval-settings.js";
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
const RECENT_MESSAGE_COUNT = 12;
const SEARCH_EVERY_ITERATIONS = 2;
const MIN_CANDIDATES_BEFORE_RERANK = 3;
const MIN_RERANK_SCORE = 0.12;
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

function clampSignal(text: string | undefined, maxChars: number): string {
  if (!text) return "";
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars).trimEnd();
}

function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

const OPERATIONAL_FILE_EXTENSIONS =
  "ts|tsx|js|jsx|mjs|cjs|md|json|service|db|sqlite|py|rs|go|css|html|yml|yaml|toml|sql|sh";

const TOOL_OR_COMMAND_NAMES = new RegExp(
  "\\b(?:" + [
    "ask_user",
    "apply_patch",
    "exec_command",
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
    .replace(/[{}[\]"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract semantic signal from tool calls — the agent's intent, not its output.
 * A web_search with query "X" or read_file with path "Y" carries precise signal
 * about what territory the agent is exploring, without the noise of raw output.
 */
function extractToolCallSignal(toolCalls: ChatMessage["toolCalls"], maxChars = 300): string {
  if (!toolCalls?.length) return "";
  const parts: string[] = [];
  for (const call of toolCalls) {
    const args = call.arguments as Record<string, any>;
    // Extract key semantic arguments by common names.
    // Scrub file paths and URLs to avoid leaking operational noise,
    // but keep query/search text that carries topical signal.
    const rawSignal = [
      args.query, args.q, args.search, args.text,
      args.path, args.file, args.filename,
      args.url, args.term, args.blockId, args.block_id,
      args.name, args.category, args.importance,
    ].filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map((v) => v.replace(/\s+/g, " ").trim())
      .join(" ");
    if (rawSignal) {
      parts.push(`${call.name}: ${scrubOperationalNoise(rawSignal)}`);
    }
  }
  const joined = parts.join(" / ");
  return joined.length > maxChars ? joined.slice(0, maxChars).trimEnd() : joined;
}

function activeRecallWindow(messages: ChatMessage[]): ChatMessage[] {
  const latestUserIndex = messages.reduce(
    (latest, message, index) => message.role === "user" ? index : latest,
    -1,
  );
  return latestUserIndex >= 0 ? messages.slice(latestUserIndex) : messages;
}

function isAutomationUserPrompt(message: ChatMessage): boolean {
  return message.role === "user" && Boolean(message._isAutomationMessage);
}

export function buildPassiveRecallQuery(messages: ChatMessage[], maxChars = 6000): string {
  const recent = messages
    .filter((message) => !message._outOfContext && message.role !== "system")
    .slice(-RECENT_MESSAGE_COUNT);

  const parts: string[] = [];
  for (const message of recent) {
    if (message.role === "user") {
      if (isAutomationUserPrompt(message)) continue;
      const content = scrubOperationalNoise(clampText(message.content, 1200));
      if (content) parts.push(content);
      continue;
    }

    // Include thinking output — the agent's reasoning trajectory during tool loops.
    // This is the direction the agent is heading, valuable for finding context in
    // territory the original user message didn't cover.
    const thinking = message.thinking
      ? scrubOperationalNoise(clampText(message.thinking, 800)).replace(/\s+/g, " ")
      : "";
    const text = scrubOperationalNoise(clampText(message.content, message._isCompactionSummary ? 1600 : 1000));

    // Tool call signal — the agent's intent, not its output.
    // A web_search call's query or read_file's path carries precise semantic signal
    // about what territory the agent is exploring, without the noise of raw output.
    const toolSignal = message.role === "assistant"
      ? extractToolCallSignal(message.toolCalls)
      : "";

    const combined = [
      thinking,
      text,
      toolSignal,
    ].filter(Boolean).join("\n");
    if (combined) parts.push(combined);
  }

  const query = parts.join("\n\n").trim();
  return query.length > maxChars ? query.slice(query.length - maxChars) : query;
}

export function buildPassiveRerankQuery(messages: ChatMessage[], maxChars = 900): string {
  const recent = messages
    .filter((message) => !message._outOfContext && message.role !== "system")
    .slice(-RECENT_MESSAGE_COUNT);
  const active = activeRecallWindow(recent);
  const latestAssistant = [...active].reverse().find((message) => message.role === "assistant");

  // --- Agent trajectory (primary signal) ---
  // The thinking block captures where the agent is heading — its reasoning
  // trajectory during the tool loop. This is the strongest signal for finding
  // context in territory the agent has excavated but the original user message
  // didn't cover.
  const latestThinking = latestAssistant?.thinking;
  const agentThinking = latestThinking
    ? scrubOperationalNoise(latestThinking).replace(/\s+/g, " ")
    : "";

  // Agent's visible output — the actual text the agent produced.
  // This is valuable signal: the answer, analysis, or conclusion the agent
  // has arrived at. Previously under-budgeted at 350 chars.
  const latestAssistantContent = latestAssistant?.content?.trim()
    ? scrubOperationalNoise(clampSignal(latestAssistant.content, 500)).replace(/\s+/g, " ")
    : "";

  // Tool call signal — the agent's intent, extracted from call arguments.
  // A web_search with query "X" or read_file with path "Y" carries precise
  // semantic signal about what territory the agent is exploring.
  // Replaces tool observations (raw output), which were noisy.
  const toolCalls = latestAssistant
    ? extractToolCallSignal(latestAssistant.toolCalls)
    : "";

  // User request — included but with decay. After several tool-loop iterations,
  // the agent's trajectory (thinking + tool calls + output) is the primary signal.
  // The user's original request has already been searched for by the initial
  // retrieval and early passive recall turns. Deep into the run, trajectory matters more.
  const latestUser = scrubOperationalNoise(
    [...active].reverse().find((message) => message.role === "user" && !isAutomationUserPrompt(message))?.content,
  );

  const trajectoryLength = (agentThinking?.trim().length ?? 0) + (toolCalls?.length ?? 0) + (latestAssistantContent?.length ?? 0);
  const hasSubstantialTrajectory = trajectoryLength >= 200;

  // Budget allocation: trajectory-first, user-decaying
  const userBudget = hasSubstantialTrajectory
    ? Math.max(100, Math.floor(maxChars * 0.15))   // 135 chars at 900 — decayed
    : Math.max(260, Math.floor(maxChars * 0.45));   // 405 chars — full when no trajectory yet
  const thinkingBudget = Math.max(160, Math.floor(maxChars * 0.35)); // 315
  const toolCallBudget = Math.max(80, Math.floor(maxChars * 0.25));  // 225
  const contentBudget = Math.max(120, Math.floor(maxChars * 0.25));  // 225

  const parts: string[] = [];
  if (latestUser?.trim()) parts.push(clampSignal(latestUser, userBudget));
  if (agentThinking?.trim()) parts.push(clampSignal(agentThinking, thinkingBudget));
  if (toolCalls) parts.push(clampSignal(toolCalls, toolCallBudget));
  if (latestAssistantContent) parts.push(clampSignal(latestAssistantContent, contentBudget));

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
  private maxMemoriesPerTurn = 12;

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
    // Spacing guard: avoid redundant searches during tool loops.
    // For post-turn schedules (conversational stops), skip the spacing guard —
    // the query hash dedup already prevents redundant searches, and the first
    // conversational turn (iteration=0) needs to be allowed through.
    if (isToolUse && options.iteration - this.lastScheduledIteration < SEARCH_EVERY_ITERATIONS) return;

    this.inFlight = getRetrievalBudget()
      .then((budget) => {
        this.maxMemoriesPerTurn = budget.passiveRecall.memoriesPerTurn;
        if (this.totalInjected >= budget.passiveRecall.memoriesPerTurn) return;

        const query = buildPassiveRecallQuery(options.chatMessages, budget.passiveRecall.queryChars);
        if (query.length < MIN_QUERY_CHARS) return;
        const rerankQuery = buildPassiveRerankQuery(options.chatMessages, budget.passiveRecall.rerankQueryChars) ||
          clampText(query, budget.passiveRecall.rerankQueryChars);

        const queryHash = hashText(query);
        if (queryHash === this.lastQueryHash) return;
        this.lastQueryHash = queryHash;
        this.lastScheduledIteration = options.iteration;

        return this.runRecall(query, rerankQuery, options, budget);
      })
      .catch((err) => {
        console.warn("[passive-memory] recall failed:", err instanceof Error ? err.message : err);
      })
      .finally(() => {
        this.inFlight = null;
      });
  }

  peekReady(iteration: number): PassiveMemoryRecallInjection | null {
    if (this.readyQueue.length === 0) return null;
    if (this.totalInjected >= this.maxMemoriesPerTurn) return null;
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
    budget: Awaited<ReturnType<typeof getRetrievalBudget>>,
  ): Promise<void> {
    const queryEmbedding = await embed(query);
    const crossProjectMultiplier = await getConfiguredCrossProjectScoreMultiplier();
    const globalProjectMultiplier = await getConfiguredGlobalProjectScoreMultiplier();
    const searchResults = filterMemoriesAlreadyInCurrentContext(
      await searchMemories(
        queryEmbedding,
        budget.passiveRecall.searchLimit,
        new Date(),
        query,
        undefined,
        options.projectId
          ? { projectId: options.projectId, crossProjectScoreMultiplier: crossProjectMultiplier }
          : { globalProjectScoreMultiplier: globalProjectMultiplier },
      ),
      this.chatId,
      options.chatMessages,
      "passive-memory",
    );
    const inContextIds = getMemoryContextIds(this.chatId);
    const excludedIds = new Set([...inContextIds, ...this.injectedIds, ...this.queuedIds]);

    const freshResults = searchResults.filter(
      (result) => !result.memory.supersededBy && !excludedIds.has(result.memory.id),
    );
    if (freshResults.length === 0) return;

    const diverse = mmrRerank(
      sortByAdjustedScore(freshResults).slice(0, budget.passiveRecall.candidatePool),
      queryEmbedding,
      budget.passiveRecall.diverseCandidateLimit,
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
      .slice(0, budget.passiveRecall.rerankDocumentLimit);
    if (rerankCandidates.length === 0) return;

    const instruction = RERANK_INSTRUCTIONS["passive-memory"];
    const rerankDocuments = rerankCandidates.map((candidate) => clampText(candidate.memory.text, budget.passiveRecall.rerankDocumentChars));
    const formattedQuery = `Instruct: ${instruction}\nQuery: ${rerankQuery}`;
    const output = await rerank(
      rerankQuery,
      rerankDocuments,
      instruction,
      Math.min(budget.passiveRecall.rerankTopN, rerankCandidates.length),
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
      .slice(0, Math.min(
        budget.passiveRecall.memoriesPerInjection,
        budget.passiveRecall.memoriesPerTurn - this.totalInjected,
      ));

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
