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
import { log } from "./logger.js";
import type { ChatMessage } from "../types.js";

const MIN_QUERY_CHARS = 80;
const MAX_QUERY_CHARS = 6000;
const MAX_RERANK_QUERY_CHARS = 900;
const RECENT_MESSAGE_COUNT = 12;
const SEARCH_EVERY_ITERATIONS = 2;
const MIN_CANDIDATES_BEFORE_RERANK = 3;
const FAST_SEARCH_LIMIT = 40;
const DIVERSE_CANDIDATE_LIMIT = 8;
const RERANK_DOCUMENT_LIMIT = 6;
const RERANK_TOP_N = 4;
const MAX_RERANK_DOCUMENT_CHARS = 1200;
const MIN_RERANK_SCORE = 0.12;
const MAX_MEMORIES_PER_INJECTION = 2;
const MAX_PASSIVE_MEMORIES_PER_TURN = 6;
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

function compactToolCall(call: NonNullable<ChatMessage["toolCalls"]>[number]): string {
  const args = call.arguments ?? {};
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const argMap = args as Record<string, unknown>;
    const path = typeof argMap.path === "string" ? argMap.path : undefined;
    const command = typeof argMap.command === "string" ? argMap.command : undefined;
    const query = typeof argMap.query === "string" ? argMap.query : undefined;
    if (path) return `${call.name} path=${path}`;
    if (command) return `${call.name} command=${clampText(command, 120)}`;
    if (query) return `${call.name} query=${clampText(query, 120)}`;
  }
  return call.name;
}

function extractAnchors(text: string | undefined, maxAnchors: number): string[] {
  if (!text) return [];
  const anchors: string[] = [];
  const patterns = [
    /`([^`\n]{2,120})`/g,
    /\b[\w.-]+\.service\b/g,
    /\b[\w./-]+\.(?:ts|tsx|js|jsx|md|json|service|db|sqlite|py|rs|go)\b/g,
    /\/(?:api|v\d)\/[\w./:-]+/g,
    /\b[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)+\b/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      pushUnique(anchors, match[1] || match[0], maxAnchors);
      if (anchors.length >= maxAnchors) return anchors;
    }
  }

  for (const line of text.split(/\n+/)) {
    if (!/\b(error|failed|fallback|timeout|returned|rerank|batch|input)\b/i.test(line)) continue;
    pushUnique(anchors, clampText(line.replace(/\s+/g, " "), 160), maxAnchors);
    if (anchors.length >= maxAnchors) return anchors;
  }

  return anchors;
}

function toolSummary(message: ChatMessage): string {
  const parts: string[] = [];
  if (message.toolCalls?.length) {
    const calls = message.toolCalls.slice(-4).map((call) => {
      const args = clampText(JSON.stringify(call.arguments ?? {}), 300);
      return `${call.name}(${args})`;
    });
    parts.push(`tool calls: ${calls.join("; ")}`);
  }
  if (message.toolResults?.length) {
    for (const result of message.toolResults.slice(-4)) {
      parts.push(`tool result from ${result.toolName}: ${clampText(result.content, 900)}`);
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
      const content = clampText(message.content, 1200);
      if (content) parts.push(`User: ${content}`);
      continue;
    }

    const text = clampText(message.content, message._isCompactionSummary ? 1600 : 1000);
    const tools = toolSummary(message);
    const combined = [text ? `Assistant: ${text}` : "", tools].filter(Boolean).join("\n");
    if (combined) parts.push(combined);
  }

  const query = parts.join("\n\n").trim();
  return query.length > maxChars ? query.slice(query.length - maxChars) : query;
}

export function buildPassiveRerankQuery(messages: ChatMessage[], maxChars = MAX_RERANK_QUERY_CHARS): string {
  const recent = messages
    .filter((message) => !message._outOfContext && message.role !== "system")
    .slice(-RECENT_MESSAGE_COUNT);

  const latestUser = [...recent].reverse().find((message) => message.role === "user")?.content;
  const assistantFocus = [...recent]
    .reverse()
    .filter((message) => message.role === "assistant" && message.content?.trim())
    .slice(0, 2)
    .map((message) => clampText(message.content, 220).replace(/\s+/g, " "))
    .reverse();

  const toolCalls: string[] = [];
  const anchors: string[] = [];
  for (const message of recent) {
    for (const call of message.toolCalls?.slice(-4) ?? []) {
      pushUnique(toolCalls, compactToolCall(call), 8);
      const args = call.arguments as Record<string, unknown> | undefined;
      pushUnique(anchors, typeof args?.path === "string" ? args.path : undefined, 12);
    }
    for (const anchor of extractAnchors(message.content, 12)) pushUnique(anchors, anchor, 12);
    for (const result of message.toolResults?.slice(-4) ?? []) {
      pushUnique(anchors, result.toolName, 12);
      for (const anchor of extractAnchors(result.content, 12)) pushUnique(anchors, anchor, 12);
    }
  }

  const parts: string[] = [];
  if (latestUser?.trim()) parts.push(`Current user request: ${clampText(latestUser, 320).replace(/\s+/g, " ")}`);
  if (assistantFocus.length) parts.push(`Recent assistant focus: ${assistantFocus.join(" / ")}`);
  if (toolCalls.length) parts.push(`Current tool activity: ${toolCalls.join("; ")}`);
  if (anchors.length) parts.push(`Concrete anchors: ${anchors.join(", ")}`);

  const query = parts.join("\n").trim();
  if (!query) return "";
  return query.length > maxChars ? query.slice(0, maxChars).trimEnd() : query;
}

function sortCandidates(candidates: ScoredMemory[], projectId?: string): ScoredMemory[] {
  return [...candidates].sort((a, b) => {
    if (projectId) {
      const aProject = a.memory.projectId === projectId ? 1 : 0;
      const bProject = b.memory.projectId === projectId ? 1 : 0;
      if (aProject !== bProject) return bProject - aProject;
    }
    return b.score - a.score;
  });
}

function recordStats(output: RerankOutput, chatType: string | undefined): void {
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

  constructor(private readonly chatId: string) {}

  schedule(options: PassiveMemoryRecallScheduleOptions): void {
    if (options.stopReason !== "toolUse") return;
    if (this.inFlight) return;
    if (this.totalInjected >= MAX_PASSIVE_MEMORIES_PER_TURN) return;
    if (options.iteration - this.lastScheduledIteration < SEARCH_EVERY_ITERATIONS) return;

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

  toAgentMessage(injection: PassiveMemoryRecallInjection): AgentMessage {
    return {
      role: "system",
      content: injection.content,
      timestamp: injection.createdAt,
    } as unknown as AgentMessage;
  }

  private async runRecall(
    query: string,
    rerankQuery: string,
    options: PassiveMemoryRecallScheduleOptions,
  ): Promise<void> {
    const queryEmbedding = await embed(query);
    const searchResults = await searchMemories(queryEmbedding, FAST_SEARCH_LIMIT, new Date(), query);
    const inContextIds = getMemoryContextIds(this.chatId);
    const excludedIds = new Set([...inContextIds, ...this.injectedIds, ...this.queuedIds]);

    const freshResults = searchResults.filter(
      (result) => !result.memory.supersededBy && !excludedIds.has(result.memory.id),
    );
    if (freshResults.length === 0) return;

    const diverse = mmrRerank(
      sortCandidates(freshResults, options.projectId).slice(0, 24),
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

    const rerankCandidates = sortCandidates([...this.candidates.values()], options.projectId)
      .filter((candidate) => !excludedIds.has(candidate.memory.id))
      .slice(0, RERANK_DOCUMENT_LIMIT);
    if (rerankCandidates.length === 0) return;

    const instruction = RERANK_INSTRUCTIONS[options.chatType || "agent"];
    const output = await rerank(
      rerankQuery,
      rerankCandidates.map((candidate) => clampText(candidate.memory.text, MAX_RERANK_DOCUMENT_CHARS)),
      instruction,
      Math.min(RERANK_TOP_N, rerankCandidates.length),
    );
    recordStats(output, options.chatType);

    // Passive recall should be precision-heavy. If the reranker is disabled or
    // unavailable, keep normal explicit memory search as the fallback path.
    if (!output.usedModel) {
      this.candidates.clear();
      return;
    }

    const selected = output.results
      .map(({ index, score }) => ({ ...rerankCandidates[index], score }))
      .filter((candidate) => candidate.score >= MIN_RERANK_SCORE)
      .filter((candidate) => !excludedIds.has(candidate.memory.id))
      .slice(0, Math.min(MAX_MEMORIES_PER_INJECTION, MAX_PASSIVE_MEMORIES_PER_TURN - this.totalInjected));

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

    this.readyQueue.push({
      content: formatInjection(selected, options.projectId),
      memoryIds,
      memories: selected.map((candidate) => candidate.memory.text),
      createdAt: Date.now(),
    });
    log(
      `[passive-memory] chat=${this.chatId} queued ${selected.length} recalled memor${
        selected.length === 1 ? "y" : "ies"
      }: ${selected.map((candidate) => candidate.memory.id).join(",")}`,
    );
  }
}
