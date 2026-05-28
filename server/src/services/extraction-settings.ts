import type { Settings } from "../types.js";

export const DEFAULT_EXTRACTION_CTX_SIZE = 16_384;
export const MIN_EXTRACTION_CTX_SIZE = 2_048;
export const MAX_EXTRACTION_CTX_SIZE = 131_072;

export const DEFAULT_EXTRACTION_MAX_TOKENS = 4_000;
export const MIN_EXTRACTION_MAX_TOKENS = 100;
export const MAX_EXTRACTION_MAX_TOKENS = 32_768;

export const DEFAULT_EXTRACTION_TIMEOUT_MS = 600_000;
export const MIN_EXTRACTION_TIMEOUT_MS = 60_000;
export const MAX_EXTRACTION_TIMEOUT_MS = 86_400_000;

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function normalizeExtractionRequestSettings(settings: Pick<Settings, "extractionCtxSize" | "extractionMaxTokens" | "extractionTimeoutMs">): {
  ctxSize: number;
  maxTokens: number;
  timeoutMs: number;
} {
  return {
    ctxSize: clampNumber(settings.extractionCtxSize, DEFAULT_EXTRACTION_CTX_SIZE, MIN_EXTRACTION_CTX_SIZE, MAX_EXTRACTION_CTX_SIZE),
    maxTokens: clampNumber(settings.extractionMaxTokens, DEFAULT_EXTRACTION_MAX_TOKENS, MIN_EXTRACTION_MAX_TOKENS, MAX_EXTRACTION_MAX_TOKENS),
    timeoutMs: clampNumber(settings.extractionTimeoutMs, DEFAULT_EXTRACTION_TIMEOUT_MS, MIN_EXTRACTION_TIMEOUT_MS, MAX_EXTRACTION_TIMEOUT_MS),
  };
}
