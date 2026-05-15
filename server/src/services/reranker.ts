/**
 * Qwen3-Reranker client for memory retrieval.
 * Uses a dedicated llama.cpp instance with the /v1/rerank endpoint.
 * Configuration is read from user settings (rerankerEnabled, rerankerUrl).
 */

import { getSettings } from "./chat-storage.js";

const DEFAULT_RERANKER_URL = "http://localhost:8082";
const DEFAULT_RERANKER_MODEL = "qwen3-reranker";
const RERANKER_TIMEOUT_MS = 25_000;

/**
 * Chat-type-specific reranking instructions.
 * These guide the cross-encoder to focus on relevance to the
 * conversation topic rather than incidental term matches.
 */
export const RERANK_INSTRUCTIONS: Record<string, string> = {
  agent:
    "Given a conversation between the user and the AI, judge whether this memory is relevant to the current task, question, or topic of discussion.",
  bluesky:
    "Given a social media conversation, judge whether this memory is relevant to the TOPIC being discussed. Ignore notification metadata, reply counts, handle mentions, and tool usage instructions — focus only on the substantive conversational content.",
  quick:
    "Given a conversation between the user and the AI, judge whether this memory contains information useful for responding.",
  system:
    "Given an autonomous system or automation chat, judge whether this memory is relevant to the current synthesis, wake, maintenance, or automation task.",
  "passive-memory":
    "Given the agent's current reasoning trajectory during a tool loop — including its thinking, output, and tool activity — judge whether this memory is relevant to where the agent is heading, what it is investigating, or the task it is working on.",
};

interface RerankResult {
  index: number;
  relevance_score: number;
}

interface RerankUsage {
  prompt_tokens: number;
  total_tokens: number;
}

interface RerankResponse {
  results: RerankResult[];
  usage?: RerankUsage;
  model?: string;
}

/**
 * Rerank documents against a query using the Qwen3-Reranker model.
 *
 * @param query - The user's query text
 * @param documents - Array of document texts (memory contents)
 * @param instruction - Optional instruction to guide relevance judgment
 * @param topN - Maximum number of results to return (default: all)
 * @returns Sorted array of { index, score } where index maps to the input documents array.
 *          Falls back to original order if the reranker is unavailable or disabled.
 */
export interface RerankOutput {
  results: Array<{ index: number; score: number }>;
  usedModel: boolean;
  latencyMs: number;
  totalTokens: number;
  scoreMin: number;
  scoreMax: number;
  scoreMedian: number;
  documentCount: number;
}

const EMPTY_OUTPUT: RerankOutput = {
  results: [],
  usedModel: false,
  latencyMs: 0,
  totalTokens: 0,
  scoreMin: 0,
  scoreMax: 0,
  scoreMedian: 0,
  documentCount: 0,
};

function fallbackOutput(documentCount: number, latencyMs: number): RerankOutput {
  return {
    results: fallbackOrder(documentCount),
    usedModel: false,
    latencyMs,
    totalTokens: 0,
    scoreMin: 0,
    scoreMax: 0,
    scoreMedian: 0,
    documentCount,
  };
}

export async function rerank(
  query: string,
  documents: string[],
  instruction?: string,
  topN?: number
): Promise<RerankOutput> {
  if (documents.length === 0) return EMPTY_OUTPUT;

  const start = Date.now();

  // Read settings for reranker configuration
  const settings = await getSettings();
  if (settings.rerankerEnabled === false) {
    return fallbackOutput(documents.length, Date.now() - start);
  }

  const rerankerUrl = settings.rerankerUrl || DEFAULT_RERANKER_URL;
  const rerankerModel = settings.rerankerModelId || DEFAULT_RERANKER_MODEL;

  // Build the instruction-aware query in Qwen3-Reranker format
  const formattedQuery = instruction
    ? `Instruct: ${instruction}\nQuery: ${query}`
    : query;

  try {
    const res = await fetch(`${rerankerUrl}/v1/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: rerankerModel,
        query: formattedQuery,
        documents,
        top_n: topN ?? documents.length,
      }),
      signal: AbortSignal.timeout(RERANKER_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.warn(`[reranker] /v1/rerank returned ${res.status}`);
      return fallbackOutput(documents.length, Date.now() - start);
    }

    const data = (await res.json()) as RerankResponse;
    const scores = data.results.map((r) => r.relevance_score).sort((a, b) => a - b);
    const totalTokens = data.usage?.total_tokens ?? 0;
    const scoreMin = scores.length > 0 ? scores[0] : 0;
    const scoreMax = scores.length > 0 ? scores[scores.length - 1] : 0;
    const scoreMedian = scores.length > 0 ? scores[Math.floor(scores.length / 2)] : 0;

    return {
      results: data.results.map((r) => ({ index: r.index, score: r.relevance_score })),
      usedModel: true,
      latencyMs: Date.now() - start,
      totalTokens,
      scoreMin,
      scoreMax,
      scoreMedian,
      documentCount: documents.length,
    };
  } catch (err) {
    console.warn(
      `[reranker] unavailable, using fallback:`,
      err instanceof Error ? err.message : err
    );
    return fallbackOutput(documents.length, Date.now() - start);
  }
}

/** Fallback: return indices in original order with decaying scores. */
function fallbackOrder(count: number): Array<{ index: number; score: number }> {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    score: 1 / (i + 1),
  }));
}

/**
 * Check if the reranker service is available.
 */
export async function isRerankerAvailable(): Promise<boolean> {
  try {
    const settings = await getSettings();
    if (settings.rerankerEnabled === false) return false;
    const rerankerUrl = settings.rerankerUrl || DEFAULT_RERANKER_URL;
    const res = await fetch(`${rerankerUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
