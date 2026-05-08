export type ModelProgressPhase = "loading" | "prefill" | "generating";
export type ModelProgressCacheState = "hot" | "partial" | "cold" | "unknown";
export type ModelProgressConfidence = "matched-slot" | "inferred-active-slot" | "unknown";

export interface ModelProgressEvent {
  phase: ModelProgressPhase;
  modelId: string;
  baseUrl?: string;
  slotId?: number;
  processedTokens?: number;
  promptTokens?: number;
  progress?: number;
  elapsedMs: number;
  estimatedRemainingMs?: number;
  cacheState?: ModelProgressCacheState;
  confidence: ModelProgressConfidence;
  updatedAt: number;
}

export type ModelProgressCallback = (progress: ModelProgressEvent) => void;
