/**
 * Qwen3-Reranker client for memory retrieval.
 * Uses a dedicated llama.cpp instance with the /v1/rerank endpoint.
 */

const RERANKER_URL = "http://localhost:8082";
const RERANKER_TIMEOUT_MS = 15_000;

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
};

interface RerankResult {
  index: number;
  relevance_score: number;
}

interface RerankResponse {
  results: RerankResult[];
}

/**
 * Rerank documents against a query using the Qwen3-Reranker model.
 *
 * @param query - The user's query text
 * @param documents - Array of document texts (memory contents)
 * @param instruction - Optional instruction to guide relevance judgment
 * @param topN - Maximum number of results to return (default: all)
 * @returns Sorted array of { index, score } where index maps to the input documents array.
 *          Falls back to original order if the reranker is unavailable.
 */
export async function rerank(
  query: string,
  documents: string[],
  instruction?: string,
  topN?: number
): Promise<Array<{ index: number; score: number }>> {
  if (documents.length === 0) return [];

  // Build the instruction-aware query in Qwen3-Reranker format
  const formattedQuery = instruction
    ? `Instruct: ${instruction}\nQuery: ${query}`
    : query;

  try {
    const res = await fetch(`${RERANKER_URL}/v1/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3-reranker",
        query: formattedQuery,
        documents,
        top_n: topN ?? documents.length,
      }),
      signal: AbortSignal.timeout(RERANKER_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.warn(`[reranker] /v1/rerank returned ${res.status}`);
      return fallbackOrder(documents.length, topN);
    }

    const data = (await res.json()) as RerankResponse;
    return data.results.map((r) => ({
      index: r.index,
      score: r.relevance_score,
    }));
  } catch (err) {
    console.warn(
      `[reranker] unavailable, using fallback:`,
      err instanceof Error ? err.message : err
    );
    return fallbackOrder(documents.length, topN);
  }
}

/** Fallback: return indices in original order with uniform scores. */
function fallbackOrder(
  count: number,
  topN?: number
): Array<{ index: number; score: number }> {
  const result = Array.from({ length: count }, (_, i) => ({
    index: i,
    score: 1 / (i + 1), // Decaying score to preserve original ranking
  }));
  return topN ? result.slice(0, topN) : result;
}

/**
 * Check if the reranker service is available.
 */
export async function isRerankerAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${RERANKER_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
