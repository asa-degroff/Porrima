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

// Mid-turn extraction: token threshold for triggering a pulse
export const DEFAULT_MID_TURN_EXTRACTION_THRESHOLD = 6000;
export const MIN_MID_TURN_EXTRACTION_THRESHOLD = 500;
export const MAX_MID_TURN_EXTRACTION_THRESHOLD = 32000;
export const DEFAULT_MID_TURN_EXTRACTION_TIMEOUT_MS = 120_000;
export const MIN_MID_TURN_EXTRACTION_TIMEOUT_MS = 15_000;
// Keep in sync with the client SettingsModal cap — the modal offers up to
// this many minutes, so a lower server cap would silently clamp user picks
// (the 5→15 min bump in 5747028 initially drifted exactly this way).
export const MAX_MID_TURN_EXTRACTION_TIMEOUT_MS = 900_000;

/**
 * Context-pressure trigger for mid-turn pulses. When estimated context usage
 * crosses this ratio of the effective window, a pulse is dispatched even if
 * the signal-token threshold hasn't been reached — as long as there is at
 * least MID_TURN_PULSE_MIN_SIGNAL_TOKENS of uncovered content. Sits well
 * below COMPACTION_TRIGGER_RATIO (0.85) so extraction starts before the
 * compaction stall, and keeps the extraction model's cached prompt warm for
 * the pre-compaction flush to continue from.
 */
export const DEFAULT_MID_TURN_EXTRACTION_CONTEXT_RATIO = 0.65;

/** Minimum uncovered signal for a context-ratio-triggered pulse. Avoids
 * firing near-empty pulses when the pressure comes from older context that
 * earlier extractions already covered. */
export const MID_TURN_PULSE_MIN_SIGNAL_TOKENS = 256;

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
> & { llamaServiceConfigs?: Record<string, any> };

/**
 * Number of parallel sequences (slots) the managed service behind `baseUrl`
 * launches, per its llamaServiceConfigs entry. llama.cpp partitions the total
 * context evenly across slots, so prompt budgeting must use the per-slot
 * share — not the server-total n_ctx reported by /props. Returns 1 when no
 * matching config exists (unmanaged server, or single-slot launch).
 */
function configuredParallelForUrl(configs: Record<string, any> | undefined, baseUrl: string): number {
  if (!configs || typeof configs !== "object") return 1;
  const target = normalizeBaseUrl(baseUrl);
  for (const entry of Object.values(configs)) {
    if (!entry || typeof entry !== "object") continue;
    const host = typeof entry.host === "string" ? entry.host.trim() : "";
    const port = positiveInteger(entry.port);
    if (!host || port === undefined) continue;
    if (normalizeBaseUrl(`http://${host}:${port}`) === target) {
      return Math.max(1, positiveInteger(entry.parallel) ?? 1);
    }
  }
  return 1;
}

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

/**
 * Read a context size out of a /props payload, tracking whether the value is
 * the server total or already a per-slot share. llama.cpp exposes the total
 * at the top level and the per-slot share (total / --parallel) inside
 * default_generation_settings — dividing a per-slot value by parallel again
 * would halve the budget twice.
 */
function readPropsCtxSize(data: any): { ctxSize: number; scope: "total" | "slot" } | null {
  const total = positiveInteger(data?.n_ctx);
  if (total !== undefined) return { ctxSize: total, scope: "total" };
  const slot = positiveInteger(data?.default_generation_settings?.n_ctx);
  if (slot !== undefined) return { ctxSize: slot, scope: "slot" };
  const legacy = positiveInteger(data?.max_model_len);
  if (legacy !== undefined) return { ctxSize: legacy, scope: "total" };
  return null;
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
): Promise<{ ctxSize: number; source: Exclude<ExtractionContextSource, "settings">; scope: "total" | "slot" } | null> {
  const url = normalizeBaseUrl(baseUrl);
  const normalizedModelId = normalizeModelId(modelId);
  const propsUrls = normalizedModelId
    ? [`${url}/props?model=${encodeURIComponent(normalizedModelId)}`, `${url}/props`]
    : [`${url}/props`];

  for (const propsUrl of propsUrls) {
    const props = await fetchJson(propsUrl, timeoutMs);
    const found = readPropsCtxSize(props);
    if (found) return { ctxSize: found.ctxSize, source: "props", scope: found.scope };
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
    // --ctx-size / max_model_len describe the launched context as a whole;
    // the per-slot share only exists once the server splits it across slots.
    if (ctxSize) return { ctxSize, source: "models", scope: "total" };
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

  // --parallel N splits the launched context evenly across slots; a single
  // request can only ever use its slot's share, so budget against that.
  const parallel = configuredParallelForUrl(settings.llamaServiceConfigs, baseUrl);
  const perSlotCtx = (total: number) =>
    Math.min(MAX_EXTRACTION_CTX_SIZE, Math.max(1, Math.floor(total / parallel)));

  const live = await discoverLiveExtractionCtxSize(
    baseUrl,
    settings.extractionModelId,
    Math.min(normalized.timeoutMs, 3_000),
  );
  if (!live) {
    // The saved setting stores the launched (total) context.
    return { ...normalized, ctxSize: perSlotCtx(normalized.ctxSize), configuredCtxSize: normalized.ctxSize, ctxSource: "settings" };
  }

  // Only divide when the reported value is the server total. Some builds
  // already expose the per-slot share (default_generation_settings.n_ctx);
  // dividing that again would halve the budget twice.
  const ctxSize = live.scope === "total" ? perSlotCtx(live.ctxSize) : live.ctxSize;
  if (ctxSize !== normalized.ctxSize) {
    const logKey = `${normalizeBaseUrl(baseUrl)}:${normalized.ctxSize}:${live.ctxSize}:${live.scope}:${parallel}:${live.source}`;
    if (lastCtxMismatchLogKey !== logKey) {
      lastCtxMismatchLogKey = logKey;
      console.warn(
        `[extraction] Using live context size ${live.ctxSize} (${live.scope}) from ${live.source}` +
        (live.scope === "total" && parallel > 1 ? ` (${ctxSize} per slot with --parallel ${parallel})` : "") +
        `; saved extractionCtxSize is ${normalized.ctxSize}.`
      );
    }
  }

  return {
    ...normalized,
    // Do not clamp live values up to MIN_EXTRACTION_CTX_SIZE: if the process
    // really reports a smaller context, budgeting must stay below it.
    ctxSize,
    configuredCtxSize: normalized.ctxSize,
    ctxSource: live.source,
  };
}
