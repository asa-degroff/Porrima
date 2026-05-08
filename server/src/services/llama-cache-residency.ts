import type { LlamaCacheMetadata } from "./openai-compat-provider.js";

export type LlamaCacheBindingMode = "auto" | "enforced";
export type LlamaCacheResidencyStatus = "warming" | "warm" | "stale";
export type LlamaCacheResidencyConfidence =
  | "confirmed-hit"
  | "partial-hit"
  | "filled-after-miss"
  | "unknown";

export interface LlamaCacheResidencyRecord {
  chatId: string;
  baseUrl: string;
  modelId: string;
  contextWindow?: number;
  bindingMode: LlamaCacheBindingMode;
  status: LlamaCacheResidencyStatus;
  warm: boolean;
  active: boolean;
  confidence: LlamaCacheResidencyConfidence;
  slotId?: number;
  lastStartedAt?: number;
  lastUsedAt: number;
  lastCompletedAt?: number;
  lastRequestDigest?: string;
  reportedPromptTokens?: number;
  promptEvalTokens?: number;
  inferredCachedTokens?: number;
  inferredCacheHitRatio?: number;
  promptMs?: number;
  phase?: string;
  iteration?: number;
}

interface LlamaTimingsLike {
  prompt_n?: number;
  prompt_ms?: number;
}

interface CacheContext {
  chatId: string;
  baseUrl: string;
  modelId: string;
  contextWindow?: number;
  bindingMode: LlamaCacheBindingMode;
  slotId?: number;
}

const DEFAULT_MAX_WARM_PER_POOL = 4;
const DEFAULT_STALE_AFTER_MS = 12 * 60 * 60 * 1000;
const DEFAULT_REMOVAL_GRACE_MS = 24 * 60 * 60 * 1000; // remove stale entries after 24h
const CONFIRMED_HIT_THRESHOLD = 0.9;
const PARTIAL_HIT_THRESHOLD = 0.5;
const MAX_RECORDS = 256; // global cap to prevent unbounded growth

const records = new Map<string, LlamaCacheResidencyRecord>();

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function poolKey(baseUrl: string, modelId: string, contextWindow?: number): string {
  return JSON.stringify([normalizeBaseUrl(baseUrl), modelId, contextWindow ?? null]);
}

function recordKey(input: Pick<CacheContext, "baseUrl" | "modelId" | "contextWindow" | "chatId">): string {
  return `${poolKey(input.baseUrl, input.modelId, input.contextWindow)}:${input.chatId}`;
}

function maxWarmPerPool(): number {
  const parsed = Number(process.env.LLAMACPP_CACHE_RESIDENCY_LIMIT);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return DEFAULT_MAX_WARM_PER_POOL;
}

function staleAfterMs(): number {
  const parsed = Number(process.env.LLAMACPP_CACHE_RESIDENCY_TTL_MS);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return DEFAULT_STALE_AFTER_MS;
}

function removalGraceMs(): number {
  const parsed = Number(process.env.LLAMACPP_CACHE_RESIDENCY_REMOVAL_GRACE_MS);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return DEFAULT_REMOVAL_GRACE_MS;
}

function clampRatio(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function inferHitRatio(cache: LlamaCacheMetadata | undefined, promptEvalTokens: number | undefined): number | undefined {
  if (typeof cache?.inferredCacheHitRatio === "number") {
    return clampRatio(cache.inferredCacheHitRatio);
  }
  if (
    typeof cache?.reportedPromptTokens === "number" &&
    cache.reportedPromptTokens > 0 &&
    typeof promptEvalTokens === "number"
  ) {
    return clampRatio((cache.reportedPromptTokens - promptEvalTokens) / cache.reportedPromptTokens);
  }
  return undefined;
}

function confidenceForHit(hitRatio: number | undefined): LlamaCacheResidencyConfidence {
  if (hitRatio === undefined) return "unknown";
  if (hitRatio >= CONFIRMED_HIT_THRESHOLD) return "confirmed-hit";
  if (hitRatio >= PARTIAL_HIT_THRESHOLD) return "partial-hit";
  return "filled-after-miss";
}

function pruneStale(now = Date.now()): void {
  const ttl = staleAfterMs();
  const removalGrace = removalGraceMs();
  for (const [key, record] of records) {
    if (record.active) continue;
    const age = now - record.lastUsedAt;
    if (age > ttl + removalGrace) {
      // Remove entirely after grace period
      records.delete(key);
    } else if (age > ttl) {
      // Mark stale after TTL
      records.set(key, {
        ...record,
        status: "stale",
        warm: false,
        confidence: "unknown",
      });
    }
  }
  // Global cap: remove oldest stale entries if over limit
  if (records.size > MAX_RECORDS) {
    const sorted = Array.from(records.entries())
      .filter(([, r]) => !r.active)
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    while (records.size > MAX_RECORDS && sorted.length > 0) {
      const [key] = sorted.shift()!;
      records.delete(key);
    }
  }
}

function prunePool(input: Pick<CacheContext, "baseUrl" | "modelId" | "contextWindow">): void {
  const key = poolKey(input.baseUrl, input.modelId, input.contextWindow);
  const poolRecords = Array.from(records.entries())
    .filter(([, record]) =>
      poolKey(record.baseUrl, record.modelId, record.contextWindow) === key &&
      (record.warm || record.active)
    )
    .sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt);

  const limit = maxWarmPerPool();
  for (const [entryKey, record] of poolRecords.slice(limit)) {
    if (record.active) continue;
    records.set(entryKey, {
      ...record,
      status: "stale",
      warm: false,
      confidence: "unknown",
    });
  }
}

export function markLlamaCacheResidencyStarted(input: CacheContext): void {
  const now = Date.now();
  const key = recordKey(input);
  const existing = records.get(key);
  records.set(key, {
    chatId: input.chatId,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    modelId: input.modelId,
    contextWindow: input.contextWindow,
    bindingMode: input.bindingMode,
    status: existing?.warm ? "warm" : "warming",
    warm: existing?.warm ?? false,
    active: true,
    confidence: existing?.confidence ?? "unknown",
    slotId: input.slotId,
    lastStartedAt: now,
    lastUsedAt: now,
    lastCompletedAt: existing?.lastCompletedAt,
    lastRequestDigest: existing?.lastRequestDigest,
    reportedPromptTokens: existing?.reportedPromptTokens,
    promptEvalTokens: existing?.promptEvalTokens,
    inferredCachedTokens: existing?.inferredCachedTokens,
    inferredCacheHitRatio: existing?.inferredCacheHitRatio,
    promptMs: existing?.promptMs,
    phase: existing?.phase,
    iteration: existing?.iteration,
  });
}

export function recordLlamaCacheResidencyRun(input: CacheContext & {
  timings: LlamaTimingsLike;
  cache?: LlamaCacheMetadata;
  phase?: string;
  iteration?: number;
}): void {
  const now = Date.now();
  const key = recordKey(input);
  const promptEvalTokens = input.cache?.promptEvalTokens ?? input.timings.prompt_n;
  const hitRatio = inferHitRatio(input.cache, promptEvalTokens);
  const reportedPromptTokens = input.cache?.reportedPromptTokens;
  const inferredCachedTokens = typeof reportedPromptTokens === "number" && typeof promptEvalTokens === "number"
    ? Math.max(0, reportedPromptTokens - promptEvalTokens)
    : input.cache?.inferredCachedTokens;

  records.set(key, {
    chatId: input.chatId,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    modelId: input.modelId,
    contextWindow: input.contextWindow,
    bindingMode: input.bindingMode,
    status: "warm",
    warm: true,
    active: true,
    confidence: confidenceForHit(hitRatio),
    slotId: input.cache?.slotId ?? input.slotId,
    lastStartedAt: records.get(key)?.lastStartedAt,
    lastUsedAt: now,
    lastCompletedAt: now,
    lastRequestDigest: input.cache?.requestDigest,
    reportedPromptTokens,
    promptEvalTokens,
    inferredCachedTokens,
    inferredCacheHitRatio: hitRatio,
    promptMs: input.timings.prompt_ms,
    phase: input.phase,
    iteration: input.iteration,
  });
  prunePool(input);
}

export function markLlamaCacheResidencyFinished(chatId: string): void {
  for (const [key, record] of records) {
    if (record.chatId !== chatId || !record.active) continue;
    records.set(key, {
      ...record,
      active: false,
      status: record.warm ? "warm" : "stale",
      lastUsedAt: Date.now(),
    });
  }
}

export function listLlamaCacheResidency(): LlamaCacheResidencyRecord[] {
  pruneStale();
  return Array.from(records.values())
    .filter((record) => record.active || record.warm)
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}
