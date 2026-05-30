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

export type ExtractionContextSource = "settings" | "props" | "models";

export interface EffectiveExtractionRequestSettings {
  ctxSize: number;
  maxTokens: number;
  timeoutMs: number;
  ctxSource: ExtractionContextSource;
  configuredCtxSize: number;
}

type ExtractionSettingsInput = Pick<
  Settings,
  "extractionCtxSize" | "extractionMaxTokens" | "extractionTimeoutMs" | "extractionModelUrl" | "extractionModelId"
>;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function normalizeModelId(id: string | undefined): string | undefined {
  const trimmed = id?.trim();
  return trimmed ? trimmed.replace(/\.gguf$/i, "") : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function parseCtxSizeArg(args: unknown): number | undefined {
  if (!Array.isArray(args)) return undefined;
  const index = args.indexOf("--ctx-size");
  if (index < 0 || index + 1 >= args.length) return undefined;
  return positiveInteger(args[index + 1]);
}

function readPropsCtxSize(data: any): number | undefined {
  return positiveInteger(data?.default_generation_settings?.n_ctx) ??
    positiveInteger(data?.n_ctx) ??
    positiveInteger(data?.max_model_len);
}

function readModelCtxSize(entry: any): number | undefined {
  return parseCtxSizeArg(entry?.status?.args) ??
    positiveInteger(entry?.max_model_len) ??
    positiveInteger(entry?.contextWindow) ??
    positiveInteger(entry?.context_window);
}

async function fetchJson(url: string, timeoutMs: number): Promise<any | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

async function discoverLiveExtractionCtxSize(
  baseUrl: string,
  modelId: string | undefined,
  timeoutMs: number,
): Promise<{ ctxSize: number; source: Exclude<ExtractionContextSource, "settings"> } | null> {
  const url = normalizeBaseUrl(baseUrl);
  const normalizedModelId = normalizeModelId(modelId);
  const propsUrls = normalizedModelId
    ? [`${url}/props?model=${encodeURIComponent(normalizedModelId)}`, `${url}/props`]
    : [`${url}/props`];

  for (const propsUrl of propsUrls) {
    const props = await fetchJson(propsUrl, timeoutMs);
    const ctxSize = readPropsCtxSize(props);
    if (ctxSize) return { ctxSize, source: "props" };
  }

  const models = await fetchJson(`${url}/v1/models`, timeoutMs);
  const entries = Array.isArray(models?.data) ? models.data : [];
  if (entries.length === 0) return null;

  const target = normalizedModelId
    ? entries.find((entry: any) => normalizeModelId(entry?.id) === normalizedModelId)
    : undefined;
  const loaded = entries.filter((entry: any) => entry?.status?.value === "loaded");
  const candidates = target
    ? [target]
    : loaded.length === 1
      ? [loaded[0]]
      : entries.length === 1
        ? [entries[0]]
        : loaded;

  for (const entry of candidates) {
    const ctxSize = readModelCtxSize(entry);
    if (ctxSize) return { ctxSize, source: "models" };
  }
  return null;
}

let lastCtxMismatchLogKey: string | null = null;

/**
 * Resolve the context size used to budget extraction prompts. For a dedicated
 * extraction service, the live llama.cpp process is authoritative; the saved
 * setting is only a fallback when the service cannot report a usable context.
 */
export async function resolveExtractionRequestSettings(settings: ExtractionSettingsInput): Promise<EffectiveExtractionRequestSettings> {
  const normalized = normalizeExtractionRequestSettings(settings);
  const baseUrl = settings.extractionModelUrl?.trim();
  if (!baseUrl) {
    return { ...normalized, configuredCtxSize: normalized.ctxSize, ctxSource: "settings" };
  }

  const live = await discoverLiveExtractionCtxSize(
    baseUrl,
    settings.extractionModelId,
    Math.min(normalized.timeoutMs, 3_000),
  );
  if (!live) {
    return { ...normalized, configuredCtxSize: normalized.ctxSize, ctxSource: "settings" };
  }

  if (live.ctxSize !== normalized.ctxSize) {
    const logKey = `${normalizeBaseUrl(baseUrl)}:${normalized.ctxSize}:${live.ctxSize}:${live.source}`;
    if (lastCtxMismatchLogKey !== logKey) {
      lastCtxMismatchLogKey = logKey;
      console.warn(
        `[extraction] Using live context size ${live.ctxSize} from ${live.source}; saved extractionCtxSize is ${normalized.ctxSize}.`
      );
    }
  }

  return {
    ...normalized,
    // Do not clamp live values up to MIN_EXTRACTION_CTX_SIZE: if the process
    // really reports a smaller context, budgeting must stay below it.
    ctxSize: Math.min(MAX_EXTRACTION_CTX_SIZE, Math.max(1, Math.round(live.ctxSize))),
    configuredCtxSize: normalized.ctxSize,
    ctxSource: live.source,
  };
}
