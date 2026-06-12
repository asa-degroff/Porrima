import type { Settings } from "../types.js";
import { getSettings } from "./chat-storage.js";

export type RetrievalDepthProfile = "fast" | "balanced" | "thorough" | "custom";

export const DEFAULT_RETRIEVAL_DEPTH_PROFILE: RetrievalDepthProfile = "balanced";
export const DEFAULT_RERANKER_TIMEOUT_MS = 25_000;

export interface RetrievalBudget {
  profile: RetrievalDepthProfile;
  rerankerTimeoutMs: number;
  memoryContext: {
    searchQueryChars: number;
    rerankQueryChars: number;
    searchLimit: number;
    candidatePool: number;
    rerankDocumentLimit: number;
    rerankTopN: number;
  };
  passiveRecall: {
    queryChars: number;
    rerankQueryChars: number;
    searchLimit: number;
    candidatePool: number;
    diverseCandidateLimit: number;
    rerankDocumentLimit: number;
    rerankDocumentChars: number;
    rerankTopN: number;
    memoriesPerInjection: number;
    memoriesPerTurn: number;
  };
}

const PRESET_BUDGETS: Record<Exclude<RetrievalDepthProfile, "custom">, RetrievalBudget> = {
  fast: {
    profile: "fast",
    rerankerTimeoutMs: DEFAULT_RERANKER_TIMEOUT_MS,
    memoryContext: {
      searchQueryChars: 4000,
      rerankQueryChars: 1500,
      searchLimit: 24,
      candidatePool: 18,
      rerankDocumentLimit: 16,
      rerankTopN: 12,
    },
    passiveRecall: {
      queryChars: 4000,
      rerankQueryChars: 1500,
      searchLimit: 28,
      candidatePool: 18,
      diverseCandidateLimit: 12,
      rerankDocumentLimit: 10,
      rerankDocumentChars: 1200,
      rerankTopN: 3,
      memoriesPerInjection: 1,
      memoriesPerTurn: 12,
    },
  },
  balanced: {
    profile: "balanced",
    rerankerTimeoutMs: DEFAULT_RERANKER_TIMEOUT_MS,
    memoryContext: {
      searchQueryChars: 6000,
      rerankQueryChars: 2000,
      searchLimit: 30,
      candidatePool: 24,
      rerankDocumentLimit: 24,
      rerankTopN: 18,
    },
    passiveRecall: {
      queryChars: 6000,
      rerankQueryChars: 2000,
      searchLimit: 40,
      candidatePool: 24,
      diverseCandidateLimit: 16,
      rerankDocumentLimit: 14,
      rerankDocumentChars: 1600,
      rerankTopN: 4,
      memoriesPerInjection: 2,
      memoriesPerTurn: 18,
    },
  },
  thorough: {
    profile: "thorough",
    rerankerTimeoutMs: DEFAULT_RERANKER_TIMEOUT_MS,
    memoryContext: {
      searchQueryChars: 8000,
      rerankQueryChars: 2500,
      searchLimit: 48,
      candidatePool: 36,
      rerankDocumentLimit: 32,
      rerankTopN: 24,
    },
    passiveRecall: {
      queryChars: 8000,
      rerankQueryChars: 2500,
      searchLimit: 64,
      candidatePool: 36,
      diverseCandidateLimit: 24,
      rerankDocumentLimit: 20,
      rerankDocumentChars: 2000,
      rerankTopN: 6,
      memoriesPerInjection: 3,
      memoriesPerTurn: 24,
    },
  },
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function normalizeProfile(value: Settings["retrievalDepthProfile"]): RetrievalDepthProfile {
  return value === "fast" || value === "balanced" || value === "thorough" || value === "custom"
    ? value
    : DEFAULT_RETRIEVAL_DEPTH_PROFILE;
}

export function resolveRetrievalBudget(settings: Settings): RetrievalBudget {
  const profile = normalizeProfile(settings.retrievalDepthProfile);
  const base = PRESET_BUDGETS[profile === "custom" ? "balanced" : profile];
  const timeoutMs = clampInt(
    settings.rerankerTimeoutMs,
    base.rerankerTimeoutMs,
    5_000,
    60_000,
  );

  if (profile !== "custom") {
    return { ...base, profile, rerankerTimeoutMs: timeoutMs };
  }

  const memoryContextRerankDocumentLimit = clampInt(
    settings.memoryContextRerankDocumentLimit,
    base.memoryContext.rerankDocumentLimit,
    8,
    40,
  );
  const passiveRecallRerankDocumentLimit = clampInt(
    settings.passiveRecallRerankDocumentLimit,
    base.passiveRecall.rerankDocumentLimit,
    8,
    32,
  );

  return {
    profile,
    rerankerTimeoutMs: timeoutMs,
    memoryContext: {
      searchQueryChars: clampInt(settings.memoryContextSearchQueryChars, base.memoryContext.searchQueryChars, 2000, 12000),
      rerankQueryChars: clampInt(settings.memoryContextRerankQueryChars, base.memoryContext.rerankQueryChars, 400, 2000),
      searchLimit: clampInt(settings.memoryContextSearchLimit, base.memoryContext.searchLimit, 12, 80),
      candidatePool: clampInt(settings.memoryContextCandidatePool, base.memoryContext.candidatePool, memoryContextRerankDocumentLimit, 80),
      rerankDocumentLimit: memoryContextRerankDocumentLimit,
      rerankTopN: clampInt(settings.memoryContextRerankTopN, base.memoryContext.rerankTopN, 4, memoryContextRerankDocumentLimit),
    },
    passiveRecall: {
      queryChars: clampInt(settings.passiveRecallQueryChars, base.passiveRecall.queryChars, 2000, 12000),
      rerankQueryChars: clampInt(settings.passiveRecallRerankQueryChars, base.passiveRecall.rerankQueryChars, 400, 3000),
      searchLimit: clampInt(settings.passiveRecallSearchLimit, base.passiveRecall.searchLimit, 12, 96),
      candidatePool: clampInt(settings.passiveRecallCandidatePool, base.passiveRecall.candidatePool, passiveRecallRerankDocumentLimit, 96),
      diverseCandidateLimit: clampInt(settings.passiveRecallDiverseCandidateLimit, base.passiveRecall.diverseCandidateLimit, passiveRecallRerankDocumentLimit, 48),
      rerankDocumentLimit: passiveRecallRerankDocumentLimit,
      rerankDocumentChars: clampInt(settings.passiveRecallRerankDocumentChars, base.passiveRecall.rerankDocumentChars, 400, 4000),
      rerankTopN: clampInt(settings.passiveRecallRerankTopN, base.passiveRecall.rerankTopN, 2, passiveRecallRerankDocumentLimit),
      memoriesPerInjection: clampInt(settings.passiveRecallMemoriesPerInjection, base.passiveRecall.memoriesPerInjection, 1, 5),
      memoriesPerTurn: clampInt(settings.passiveRecallMemoriesPerTurn, base.passiveRecall.memoriesPerTurn, 0, 30),
    },
  };
}

export async function getRetrievalBudget(): Promise<RetrievalBudget> {
  return resolveRetrievalBudget(await getSettings());
}
