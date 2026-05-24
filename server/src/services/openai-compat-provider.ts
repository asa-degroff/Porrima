import {
  registerApiProvider,
  createAssistantMessageEventStream,
  parseStreamingJson,
} from "@mariozechner/pi-ai";
import type {
  Model,
  Api,
  Context,
  SimpleStreamOptions,
  StreamOptions,
  AssistantMessage,
  AssistantMessageEvent,
  Tool,
  StopReason,
} from "@mariozechner/pi-ai";
import { transformMessages } from "@mariozechner/pi-ai/dist/providers/transform-messages.js";
import { sanitizeSurrogates } from "@mariozechner/pi-ai/dist/utils/sanitize-unicode.js";
import { createHash, randomUUID } from "crypto";
import { fetch as undiciFetch, Agent as UndiciAgent } from "undici";
import sharp from "sharp";
import type { LlamaSlotLease } from "./llama-slot-leases.js";
import type { ModelProgressCallback, ModelProgressEvent } from "./model-progress.js";
import { compareWithWarmPrompt, digestPromptText } from "./llama-prompt-debug.js";

// llama.cpp's mtmd decoder (stb_image-based) supports JPEG/PNG/BMP/GIF but NOT WebP.
// The client encodes uploads as WebP for size, so we re-encode unsupported formats
// to JPEG here before forwarding.
const LLAMACPP_SUPPORTED_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/bmp",
]);

function isPlaceholderEllipsis(text: string | undefined): boolean {
  if (!text) return false;
  const normalized = text.replace(/\s/g, "").replace(/…/g, "...");
  return normalized.length > 0 && /^(\.{3})+$/.test(normalized);
}

export async function normalizeImageForLlamaCpp(
  data: string,
  mimeType: string
): Promise<{ data: string; mimeType: string }> {
  if (LLAMACPP_SUPPORTED_IMAGE_MIME.has(mimeType.toLowerCase())) {
    return { data, mimeType };
  }
  try {
    const buf = Buffer.from(data, "base64");
    const out = await sharp(buf).jpeg({ quality: 90 }).toBuffer();
    return { data: out.toString("base64"), mimeType: "image/jpeg" };
  } catch (err) {
    console.warn(
      `[openai-compat] Failed to re-encode ${mimeType} image for llama.cpp:`,
      err instanceof Error ? err.message : err
    );
    return { data, mimeType };
  }
}

// Long-lived HTTP agent for llama.cpp SSE streaming.
// Cold model load + large prompt processing can take 15-20 minutes before
// the first SSE event arrives. Node's default undici headersTimeout (300s)
// is too short and causes "fetch failed" errors.
// IMPORTANT: Must use undici.fetch (not global fetch) — Node 22's global fetch
// does NOT honor the dispatcher option, silently falling back to defaults.
function readPositiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const LLAMACPP_STREAM_HEADERS_TIMEOUT_MS = readPositiveIntEnv("LLAMACPP_STREAM_HEADERS_TIMEOUT_MS", 7_200_000);
const LLAMACPP_PREFILL_POLL_INTERVAL_MS = readPositiveIntEnv("LLAMACPP_PREFILL_POLL_INTERVAL_MS", 10_000);
const LLAMACPP_PREFILL_POLL_TIMEOUT_MS = readPositiveIntEnv("LLAMACPP_PREFILL_POLL_TIMEOUT_MS", 120_000);
const LLAMACPP_PREFILL_AUTO_INDICATOR_MIN_PROMPT_TOKENS = readPositiveIntEnv("LLAMACPP_PREFILL_AUTO_INDICATOR_MIN_PROMPT_TOKENS", 8_192);
const LLAMACPP_PREFILL_AUTO_INDICATOR_MIN_PROCESSED_TOKENS = readPositiveIntEnv("LLAMACPP_PREFILL_AUTO_INDICATOR_MIN_PROCESSED_TOKENS", 2_048);
const LLAMACPP_PROMPT_DEBUG = process.env.LLAMACPP_PROMPT_DEBUG !== "0";

const llamaStreamAgent = new UndiciAgent({
  headersTimeout: LLAMACPP_STREAM_HEADERS_TIMEOUT_MS,
  bodyTimeout: 0,             // No body timeout (SSE streams indefinitely)
  keepAliveTimeout: 60_000,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OpenAIChatChunk {
  id: string;
  object: string;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  timings?: {
    prompt_n: number;
    prompt_ms: number;
    prompt_per_token_ms: number;
    prompt_per_second: number;
    predicted_n: number;
    predicted_ms: number;
    predicted_per_token_ms: number;
    predicted_per_second: number;
    load_ms?: number;
    sample_ms?: number;
  };
}

export interface LlamaCacheMetadata {
  cachePrompt: boolean;
  cacheMode: "cache_prompt" | "disabled";
  requestDigest: string;
  requestMessageCount: number;
  requestCharCount: number;
  estimatedPromptTokens?: number;
  containsImages: boolean;
  slotId?: number;
  reportedPromptTokens?: number;
  promptEvalTokens?: number;
  inferredCachedTokens?: number;
  inferredCacheHitRatio?: number;
}

const IMAGE_PROMPT_TOKEN_ESTIMATE = 256;

function estimateRequestChars(messages: any[], tools: any[] | undefined): number {
  try {
    return JSON.stringify({ messages, tools: tools ?? [] }).length;
  } catch {
    return 0;
  }
}

function estimatePromptTokensFromChars(charCount: number): number | undefined {
  if (!Number.isFinite(charCount) || charCount <= 0) return undefined;
  return Math.max(1, Math.ceil(charCount / 3.3));
}

function redactPromptPayloadForTokenEstimate(value: unknown): { value: unknown; imageCount: number } {
  let imageCount = 0;

  const redact = (item: unknown): unknown => {
    if (typeof item === "string") {
      if (/^data:image\/[\w+.-]+;base64,/i.test(item)) {
        imageCount++;
        return "[image]";
      }
      return item.replace(/data:image\/[\w+.-]+;base64,[A-Za-z0-9+/=_-]+/gi, () => {
        imageCount++;
        return "[image]";
      });
    }

    if (Array.isArray(item)) {
      return item.map(redact);
    }

    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const redacted: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(record)) {
        redacted[key] = redact(child);
      }
      return redacted;
    }

    return item;
  };

  return { value: redact(value), imageCount };
}

export function estimatePromptTokensForProgress(messages: any[], tools: any[] | undefined): number | undefined {
  try {
    const { value, imageCount } = redactPromptPayloadForTokenEstimate({ messages, tools: tools ?? [] });
    const textTokens = estimatePromptTokensFromChars(JSON.stringify(value).length) ?? 0;
    const imageTokens = imageCount * IMAGE_PROMPT_TOKEN_ESTIMATE;
    const total = textTokens + imageTokens;
    return total > 0 ? total : undefined;
  } catch {
    return undefined;
  }
}

export function digestPromptPayload(body: any): string {
  const promptPayload = {
    model: body.model,
    messages: body.messages,
    tools: body.tools ?? [],
    chat_template_kwargs: body.chat_template_kwargs,
  };
  return createHash("sha1")
    .update(JSON.stringify(promptPayload))
    .digest("hex")
    .slice(0, 12);
}

function containsImagePromptPart(value: unknown): boolean {
  if (typeof value === "string") {
    return /^data:image\/[\w+.-]+;base64,/i.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsImagePromptPart);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.type === "image_url" || record.type === "input_image" || record.type === "image") {
      return true;
    }
    return Object.values(record).some(containsImagePromptPart);
  }
  return false;
}

export async function buildOpenAICompatChatBody(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<{ body: any; cachePrompt: boolean }> {
  const messages = await convertMessages(model, context);
  const body: any = {
    model: model.id,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (options?.maxTokens) {
    body.max_tokens = options.maxTokens;
  }

  if (options?.temperature !== undefined) {
    body.temperature = options.temperature;
  }

  if (context.tools && context.tools.length > 0) {
    body.tools = convertTools(context.tools);
  }

  const llamaSlotLease = getLlamaSlotLease(options);
  const useLlamaSlotLease = !!llamaSlotLease &&
    normalizeBaseUrl(llamaSlotLease.baseUrl) === normalizeBaseUrl(model.baseUrl) &&
    llamaSlotLease.modelId === model.id;
  if (llamaSlotLease && !useLlamaSlotLease) {
    console.warn(
      `[openai-compat] ignoring mismatched llama slot lease for model=${model.id}: ` +
      `lease model=${llamaSlotLease.modelId} slot=${llamaSlotLease.slotId}`,
    );
  }
  if (useLlamaSlotLease) {
    body.id_slot = llamaSlotLease.slotId;
  }

  // llama.cpp exposes prompt KV reuse through its `cache_prompt` request
  // parameter. The OpenAI-compatible endpoint accepts server-specific
  // generation parameters, so set it explicitly instead of relying on
  // defaults that vary across llama.cpp builds.
  const cachePrompt = process.env.LLAMACPP_CACHE_PROMPT !== "0";
  if (cachePrompt) {
    body.cache_prompt = true;
  }

  if (model.reasoning) {
    body.chat_template_kwargs = { enable_thinking: true };
  }

  // Global preserve_thinking toggle. llama.cpp forwards this as a chat
  // template kwarg; templates that support it (notably Qwen3.6) retain
  // historical reasoning traces in context.
  try {
    const { getSettings } = await import("./chat-storage.js");
    const settings = await getSettings();
    if (settings.preserveThinking || settings.modelPreserveThinking?.[model.id]) {
      body.chat_template_kwargs = {
        ...(body.chat_template_kwargs ?? {}),
        preserve_thinking: true,
      };
    }
  } catch { /* non-critical */ }

  return { body, cachePrompt };
}

function buildCacheMetadata(
  cachePrompt: boolean,
  body: any,
): LlamaCacheMetadata {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = body.tools;
  const slotId = typeof body.id_slot === "number" ? body.id_slot : undefined;
  return {
    cachePrompt,
    cacheMode: cachePrompt ? "cache_prompt" : "disabled",
    requestDigest: digestPromptPayload(body),
    requestMessageCount: messages.length,
    requestCharCount: estimateRequestChars(messages, tools),
    estimatedPromptTokens: estimatePromptTokensForProgress(messages, tools),
    containsImages: containsImagePromptPart(messages),
    slotId,
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function getLlamaSlotLease(options?: SimpleStreamOptions): LlamaSlotLease | null {
  const lease = (options as any)?.llamaSlotLease;
  if (!lease || typeof lease !== "object") return null;
  if (typeof lease.chatId !== "string" || typeof lease.modelId !== "string") return null;
  if (typeof lease.baseUrl !== "string" || typeof lease.poolKey !== "string") return null;
  if (typeof lease.leaseId !== "string") return null;
  if (!Number.isInteger(lease.slotId) || lease.slotId < 0) return null;
  return lease as LlamaSlotLease;
}

function getModelProgressCallback(options?: SimpleStreamOptions): ModelProgressCallback | undefined {
  const callback = (options as any)?.onModelProgress;
  return typeof callback === "function" ? callback as ModelProgressCallback : undefined;
}

function getShowIndicatorFromOptions(options?: SimpleStreamOptions): boolean | undefined {
  const value = (options as any)?.modelProgressShowIndicator;
  if (value === true) return true;
  if (value === false) return false;
  return undefined;
}

function getPromptDebugChatId(options?: SimpleStreamOptions): string | undefined {
  const explicit = (options as any)?.llamaPromptDebugChatId;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  return getLlamaSlotLease(options)?.chatId;
}

async function renderPromptForDebug(
  baseUrl: string,
  body: any,
  signal?: AbortSignal,
): Promise<string> {
  const templateBody: any = {
    model: body.model,
    messages: body.messages,
  };
  if (body.tools?.length) {
    templateBody.tools = body.tools;
  }
  if (body.chat_template_kwargs) {
    templateBody.chat_template_kwargs = body.chat_template_kwargs;
  }

  const res = await undiciFetch(`${normalizeBaseUrl(baseUrl)}/apply-template`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(templateBody),
    signal,
    dispatcher: llamaStreamAgent,
  }) as unknown as Response;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`/apply-template failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  if (typeof json?.prompt !== "string") {
    throw new Error("/apply-template returned invalid response (missing 'prompt')");
  }
  return json.prompt;
}

function clampRatio(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function readNumberByKeys(obj: any, keys: string[]): number | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    const value = finiteNumber(obj[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function getSlotArray(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.slots)) return payload.slots;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function getSlotId(slot: any): number | undefined {
  return readNumberByKeys(slot, ["id", "id_slot", "slot_id"]);
}

function isSlotProcessing(slot: any): boolean {
  if (!slot || typeof slot !== "object") return false;
  if (slot.is_processing === true || slot.processing === true) return true;
  const taskId = readNumberByKeys(slot, ["id_task", "task_id"]);
  if (taskId !== undefined && taskId >= 0) return true;
  const state = String(slot.state ?? slot.status ?? "").toLowerCase();
  return state.includes("process") || state.includes("busy") || state === "1";
}

function readProcessedTokens(slot: any): number | undefined {
  return readNumberByKeys(slot, [
    "n_tokens",
    "n_past",
    "n_prompt_tokens_processed",
    "prompt_tokens_processed",
    "processed_tokens",
    "n_prompt_processed",
    "n_cache_tokens",
  ]) ?? readNumberByKeys(slot?.progress, [
    "n_tokens",
    "processed_tokens",
    "prompt_tokens_processed",
  ]);
}

function readPromptTokens(slot: any, fallback?: number): number | undefined {
  return readNumberByKeys(slot, [
    "n_prompt_tokens",
    "task_n_tokens",
    "n_prompt_tokens_total",
    "prompt_tokens_total",
    "total_prompt_tokens",
    "n_tokens_prompt",
  ]) ?? readNumberByKeys(slot?.task, [
    "n_tokens",
    "prompt_tokens",
  ]) ?? fallback;
}

interface SlotProgressSnapshot {
  slotId?: number;
  processedTokens?: number;
  promptTokens?: number;
  confidence: ModelProgressEvent["confidence"];
}

function extractSlotProgress(
  payload: any,
  preferredSlotId: number | undefined,
  fallbackPromptTokens: number | undefined,
): SlotProgressSnapshot | null {
  const slots = getSlotArray(payload);
  if (!slots.length) return null;

  const candidates = slots
    .map((slot) => ({
      slotId: getSlotId(slot),
      processing: isSlotProcessing(slot),
      processedTokens: readProcessedTokens(slot),
      promptTokens: readPromptTokens(slot, fallbackPromptTokens),
    }))
    .filter((candidate) => candidate.processing);

  if (!candidates.length) return null;

  const selected = preferredSlotId !== undefined
    ? candidates.find((candidate) => candidate.slotId === preferredSlotId) ?? candidates[0]
    : candidates
        .filter((candidate) => candidate.processing)
        .sort((a, b) => (b.processedTokens ?? -1) - (a.processedTokens ?? -1))[0] ?? candidates[0];

  if (!selected) return null;
  return {
    slotId: selected.slotId,
    processedTokens: selected.processedTokens,
    promptTokens: selected.promptTokens,
    confidence: preferredSlotId !== undefined && selected.slotId === preferredSlotId ? "matched-slot" : "inferred-active-slot",
  };
}

function estimateRemainingMs(input: {
  processedTokens?: number;
  promptTokens?: number;
  firstProcessedTokens?: number;
  firstProgressAt?: number;
  now: number;
}): number | undefined {
  const { processedTokens, promptTokens, firstProcessedTokens, firstProgressAt, now } = input;
  if (
    processedTokens === undefined ||
    promptTokens === undefined ||
    firstProcessedTokens === undefined ||
    firstProgressAt === undefined ||
    processedTokens >= promptTokens
  ) {
    return undefined;
  }
  const elapsedSeconds = (now - firstProgressAt) / 1000;
  const processedSinceFirst = processedTokens - firstProcessedTokens;
  if (elapsedSeconds <= 0 || processedSinceFirst <= 0) return undefined;
  const tokensPerSecond = processedSinceFirst / elapsedSeconds;
  if (tokensPerSecond <= 0) return undefined;
  return Math.max(0, Math.round(((promptTokens - processedTokens) / tokensPerSecond) * 1000));
}

function cacheStateFromProgress(processedTokens?: number, promptTokens?: number): ModelProgressEvent["cacheState"] {
  if (processedTokens === undefined || promptTokens === undefined || promptTokens <= 0) return "unknown";
  const ratio = processedTokens / promptTokens;
  if (ratio >= 0.9) return "hot";
  if (ratio >= 0.5) return "partial";
  return "cold";
}

/**
 * Probe a specific slot to check if it has existing context.
 * Returns the number of cached tokens, or null if the probe fails.
 * Uses the /slots?model= endpoint (same as the progress poller) and filters by slotId.
 */
async function probeSlotContextTokens(baseUrl: string, modelId: string, slotId: number): Promise<number | null> {
  try {
    const url = `${normalizeBaseUrl(baseUrl)}/slots?model=${encodeURIComponent(modelId)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const payload = await res.json().catch(() => null);
    const slots = getSlotArray(payload);
    if (!slots.length) return null;
    // Find the matching slot
    const slot = slots.find((s: any) => {
      const id = getSlotId(s);
      return id !== undefined && id === slotId;
    });
    if (!slot) return null;
    // Check common field names for current context length
    const ctxTokens = readNumberByKeys(slot, [
      "n_context_tokens",
      "n_tokens",
      "n_past",
      "context_used",
      "tokens_used",
    ]);
    return ctxTokens ?? null;
  } catch {
    return null;
  }
}

/**
 * Determine cache state before the request starts, using explicit signals
 * rather than inferring from prefill progress (which conflates progress with hits).
 *
 * Signals checked in order:
 *  1. Lease eviction — if evictedChatId is set, we just evicted another chat → cold
 *  2. Slot probe — check n_context_tokens on the assigned slot → 0 means cold
 *  3. Unknown — fall back to progress-based detection during polling
 */
async function determineCacheState(
  baseUrl: string,
  modelId: string,
  lease: LlamaSlotLease | null,
): Promise<ModelProgressEvent["cacheState"]> {
  // Signal 1: eviction is definitive
  if (lease?.evictedChatId) return "cold";

  // Signal 2: probe the assigned slot
  if (lease) {
    const ctxTokens = await probeSlotContextTokens(baseUrl, modelId, lease.slotId);
    if (ctxTokens !== null) {
      return ctxTokens > 0 ? "hot" : "cold";
    }
  }

  // No definitive signal — progress-based fallback will be used
  return "unknown";
}

function shouldAutoShowPrefillIndicator(
  progress: Omit<ModelProgressEvent, "updatedAt" | "showIndicator">,
  opts?: { containsImages?: boolean; initialCacheState?: ModelProgressEvent["cacheState"] },
): boolean {
  if (progress.phase !== "prefill") return false;
  if (progress.cacheState !== "cold") return false;
  if (progress.confidence === "unknown") return false;
  if (opts?.containsImages && opts.initialCacheState === "unknown") {
    return false;
  }
  const promptTokens = progress.promptTokens ?? 0;
  if (promptTokens < LLAMACPP_PREFILL_AUTO_INDICATOR_MIN_PROMPT_TOKENS) return false;

  // In recent llama.cpp builds, n_prompt_tokens is the full rendered prompt
  // while n_prompt_tokens_processed is only the newly evaluated suffix after
  // cache reuse. A small processed/full ratio can therefore mean "good cache
  // hit", not "cold prefill". Require some real prompt work before surfacing
  // the non-first-turn auto indicator.
  const processedTokens = progress.processedTokens ?? 0;
  return processedTokens >= LLAMACPP_PREFILL_AUTO_INDICATOR_MIN_PROCESSED_TOKENS;
}

function startLlamaPrefillMonitor(input: {
  baseUrl: string;
  modelId: string;
  slotId?: number;
  estimatedPromptTokens?: number;
  containsImages?: boolean;
  onProgress?: ModelProgressCallback;
  signal?: AbortSignal;
  showIndicator?: boolean;
  /** Cache state determined before the request (eviction/slot probe).
   *  When "cold" or "hot", overrides the progress-based detection.
   *  When "unknown", falls back to progress ratio on first snapshot. */
  initialCacheState?: ModelProgressEvent["cacheState"];
}): () => void {
  const { baseUrl, modelId, slotId, estimatedPromptTokens, containsImages, onProgress, signal, showIndicator, initialCacheState } = input;
  if (!onProgress) return () => {};

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const startedAt = Date.now();
  let lastProcessedTokens: number | undefined;
  let firstProcessedTokens: number | undefined;
  let firstProgressAt: number | undefined;
  // Lock cache state once determined: use the pre-request signal if available,
  // otherwise fall back to the progress ratio on the first snapshot only.
  let lockedCacheState: ModelProgressEvent["cacheState"] =
    initialCacheState !== undefined ? initialCacheState : "unknown";

  const emit = (progress: Omit<ModelProgressEvent, "updatedAt" | "showIndicator">) => {
    onProgress({
      ...progress,
      showIndicator: showIndicator ?? shouldAutoShowPrefillIndicator(progress, {
        containsImages,
        initialCacheState: initialCacheState ?? "unknown",
      }),
      updatedAt: Date.now(),
    });
  };

  const schedule = () => {
    if (stopped || signal?.aborted) return;
    timer = setTimeout(() => {
      void poll();
    }, LLAMACPP_PREFILL_POLL_INTERVAL_MS);
  };

  const poll = async () => {
    if (stopped || signal?.aborted) return;
    try {
      const url = `${normalizeBaseUrl(baseUrl)}/slots?model=${encodeURIComponent(modelId)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(LLAMACPP_PREFILL_POLL_TIMEOUT_MS) });
      if (stopped || signal?.aborted) return;
      if (res.ok) {
        const payload = await res.json().catch(() => null);
        const snapshot = extractSlotProgress(payload, slotId, estimatedPromptTokens);
        if (snapshot) {
          const now = Date.now();
          const processedTokens = snapshot.processedTokens;
          const promptTokens = snapshot.promptTokens;
          const progressed = processedTokens !== undefined &&
            (lastProcessedTokens === undefined || processedTokens > lastProcessedTokens);

          if (progressed || lastProcessedTokens === undefined) {
            if (processedTokens !== undefined) {
              lastProcessedTokens = processedTokens;
              if (firstProcessedTokens === undefined) {
                firstProcessedTokens = processedTokens;
                firstProgressAt = now;
              }
            }
            // Lock cache state on first snapshot if not pre-determined.
            // After the first snapshot, the progress ratio is no longer a
            // reliable indicator (it just measures how far into prefill we are).
            if (lockedCacheState === "unknown") {
              lockedCacheState = cacheStateFromProgress(processedTokens, promptTokens);
            }
            const progress = processedTokens !== undefined && promptTokens !== undefined && promptTokens > 0
              ? clampRatio(processedTokens / promptTokens)
              : undefined;
            emit({
              phase: "prefill",
              modelId,
              baseUrl: normalizeBaseUrl(baseUrl),
              slotId: snapshot.slotId,
              processedTokens,
              promptTokens,
              progress,
              elapsedMs: now - startedAt,
              estimatedRemainingMs: estimateRemainingMs({
                processedTokens,
                promptTokens,
                firstProcessedTokens,
                firstProgressAt,
                now,
              }),
              cacheState: lockedCacheState,
              confidence: snapshot.confidence,
            });
          }
        }
      }
    } catch {
      // Slot probes can time out while llama.cpp is inside a large prompt batch.
      // The stream wrapper keeps the old first-event timeout until real progress arrives.
    } finally {
      schedule();
    }
  };

  emit({
    phase: "loading",
    modelId,
    baseUrl: normalizeBaseUrl(baseUrl),
    slotId,
    promptTokens: estimatedPromptTokens,
    elapsedMs: 0,
    cacheState: lockedCacheState,
    confidence: slotId !== undefined ? "matched-slot" : "unknown",
  });
  void poll();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

// ---------------------------------------------------------------------------
// Message conversion (OpenAI format)
// ---------------------------------------------------------------------------

async function convertMessages(model: Model<Api>, context: Context): Promise<any[]> {
  const transformed = transformMessages(context.messages, model);
  const params: any[] = [];

  if (context.systemPrompt) {
    // Gemma 4 models need /think directive prepended to reliably enable thinking
    // output when tools are present. The chat_template_kwargs enable_thinking
    // flag alone is insufficient with complex system prompts.
    const needsThinkDirective = model.reasoning && model.id.toLowerCase().includes("gemma");
    const systemContent = needsThinkDirective
      ? `/think\n${context.systemPrompt}`
      : context.systemPrompt;
    params.push({ role: "system", content: sanitizeSurrogates(systemContent) });
  }

  for (let i = 0; i < transformed.length; i++) {
    const msg = transformed[i];

    if ((msg as any).role === "system") {
      const content = typeof (msg as any).content === "string" ? (msg as any).content : "";
      if (content) {
        const role = params.length === 0 ? "system" : "user";
        params.push({ role, content: sanitizeSurrogates(content) });
      }
      continue;
    }

    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        params.push({ role: "user", content: sanitizeSurrogates(msg.content) });
      } else {
        // Multipart content: OpenAI format with content parts
        const parts: any[] = [];
        for (const item of msg.content) {
          if (item.type === "text") {
            parts.push({ type: "text", text: sanitizeSurrogates(item.text) });
          } else if (item.type === "image") {
            if (model.input.includes("image")) {
              const rawMime = (item as any).mimeType || "image/jpeg";
              const { data, mimeType } = await normalizeImageForLlamaCpp(
                (item as any).data,
                rawMime
              );
              parts.push({
                type: "image_url",
                image_url: { url: `data:${mimeType};base64,${data}` },
              });
            }
          }
        }
        if (parts.length > 0) {
          params.push({ role: "user", content: parts });
        }
      }
    } else if (msg.role === "assistant") {
      const assistantMsg = msg as any;
      const textBlocks = assistantMsg.content.filter((b: any) => b.type === "text");
      const toolCalls = assistantMsg.content.filter((b: any) => b.type === "toolCall");
      const thinkingBlocks = assistantMsg.content.filter((b: any) => b.type === "thinking");

      const nonEmptyText = textBlocks
        .filter((b: any) => b.type === "text" && b.text && b.text.trim().length > 0 && !isPlaceholderEllipsis(b.text))
        .map((b: any) => b.text)
        .join("");
      const content = nonEmptyText ? sanitizeSurrogates(nonEmptyText) : null;

      // Include reasoning_content for proper context replay (DeepSeek API convention)
      const thinkingText = thinkingBlocks
        .filter((b: any) => b.type === "thinking" && (b as any).thinking?.trim() && !isPlaceholderEllipsis((b as any).thinking))
        .map((b: any) => (b as any).thinking)
        .join("\n");

      const openaiMsg: any = { role: "assistant" };
      if (content) openaiMsg.content = content;
      if (thinkingText) openaiMsg.reasoning_content = sanitizeSurrogates(thinkingText);

      if (toolCalls.length > 0) {
        openaiMsg.tool_calls = toolCalls.map((tc: any) => ({
          id: tc.id || `call_${randomUUID().slice(0, 8)}`,
          type: "function",
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments || {}),
          },
        }));
      }

      if (!content && toolCalls.length === 0) continue;
      params.push(openaiMsg);
    } else if (msg.role === "toolResult") {
      // Collect consecutive tool results
      let j = i;
      const imageParts: any[] = [];
      for (; j < transformed.length && transformed[j].role === "toolResult"; j++) {
        const tr = transformed[j] as any;
        const textResult = tr.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");
        const hasImages = tr.content.some((c: any) => c.type === "image");

        params.push({
          role: "tool",
          tool_call_id: tr.toolCallId || tr.toolName,
          content: sanitizeSurrogates(textResult || "(see attached image)"),
        });

        if (hasImages && model.input.includes("image")) {
          for (const block of tr.content) {
            if (block.type === "image") {
              const rawMime = (block as any).mimeType || "image/jpeg";
              const { data, mimeType } = await normalizeImageForLlamaCpp(
                (block as any).data,
                rawMime
              );
              imageParts.push({
                type: "image_url",
                image_url: { url: `data:${mimeType};base64,${data}` },
              });
            }
          }
        }
      }
      i = j - 1;

      // Inject images as a follow-up user message (same as other vision-capable providers)
      if (imageParts.length > 0) {
        params.push({
          role: "user",
          content: [
            { type: "text", text: "Attached image(s) from tool result:" },
            ...imageParts,
          ],
        });
      }
    }
  }

  return params;
}

// ---------------------------------------------------------------------------
// Tool conversion (OpenAI function calling format)
// ---------------------------------------------------------------------------

function convertTools(tools: Tool[]): any[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

// ---------------------------------------------------------------------------
// Stop reason mapping
// ---------------------------------------------------------------------------

function mapStopReason(reason: string | null): StopReason {
  if (!reason) return "stop";
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "toolUse";
    default:
      return "stop";
  }
}

// ---------------------------------------------------------------------------
// SSE stream parser
// ---------------------------------------------------------------------------

async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<OpenAIChatChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Cancel the reader on abort so the underlying body stream is closed and
  // undici destroys the TCP socket. Without this, breaking the read loop only
  // releases the lock — the socket can linger in the keep-alive pool and
  // llama.cpp keeps generating tokens until its next sink.write fails.
  const onAbort = () => {
    reader.cancel(new Error("aborted")).catch(() => {});
  };
  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue; // Skip empty lines and comments
        if (trimmed === "data: [DONE]") return;
        if (trimmed.startsWith("data: ")) {
          const json = trimmed.slice(6);
          try {
            yield JSON.parse(json) as OpenAIChatChunk;
          } catch {
            // Skip malformed JSON
          }
        }
      }
    }

    // Process remaining buffer
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("data: ") && trimmed !== "data: [DONE]") {
        try {
          yield JSON.parse(trimmed.slice(6)) as OpenAIChatChunk;
        } catch { /* skip */ }
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Model loading (router mode)
// ---------------------------------------------------------------------------

/**
 * Track the last model loaded to avoid redundant /models/load calls.
 * This is a per-process cache; safe because llama.cpp connections are
 * to a single server per baseUrl.
 */
let lastLoadedModel: { baseUrl: string; modelId: string; contextWindow?: number } | null = null;
const modelsNeedingReload = new Set<string>();

interface EnsureModelLoadedOptions {
  forceReload?: boolean;
  reason?: string;
}

function modelStateKey(baseUrl: string, modelId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}::${modelId}`;
}

/** Clear the cached model state (e.g., after GPU coordination unloads slots). */
export function invalidateLoadedModel() {
  lastLoadedModel = null;
}

/** Mark a router model as needing an unload/load cycle before the next request. */
export function markModelForReload(baseUrl: string, modelId: string, reason?: string) {
  lastLoadedModel = null;
  modelsNeedingReload.add(modelStateKey(baseUrl, modelId));
  console.warn(
    `[openai-compat] Marked ${modelId} for reload${reason ? `: ${reason}` : ""}`
  );
}

export function isLlamaCppChildConnectionError(status: number | undefined, errorText: string): boolean {
  if (status === undefined || status < 500) return false;
  return /proxy error:\s*(failed to read connection|could not establish connection)/i.test(errorText);
}

/** Check whether llama.cpp currently has a model loaded on GPU. */
export function isLlamaCppModelLoaded(): boolean {
  return lastLoadedModel !== null;
}

/**
 * Wait for a model to be fully ready to accept requests after loading.
 * Polls the /v1/models endpoint until the model status is "loaded".
 */
async function waitForModelReady(baseUrl: string, modelId: string, maxWaitMs = 120_000): Promise<void> {
  const start = Date.now();
  const pollInterval = 1000;
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        const model = data.data?.find((m: any) => m.id === modelId);
        if (model?.status?.value === "loaded") {
          return;
        }
        // Detect load failure — child process exited with error
        if (model?.status?.value === "error" || model?.status?.value === "exited") {
          console.error(`[openai-compat] Model ${modelId} failed to load (status: ${model.status.value})`);
          throw new Error(`Model ${modelId} failed to load`);
        }
        // If model disappeared from the list entirely after some time, it failed
        if (!model && Date.now() - start > 10_000) {
          console.error(`[openai-compat] Model ${modelId} not found in model list after load request`);
          throw new Error(`Model ${modelId} not found after load`);
        }
      }
    } catch (err) {
      // Re-throw load failure errors (not transient network issues)
      if (err instanceof Error && err.message.includes("failed to load")) throw err;
      if (err instanceof Error && err.message.includes("not found after")) throw err;
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }
  console.warn(`[openai-compat] Model ${modelId} did not reach 'loaded' status within ${maxWaitMs}ms, proceeding anyway`);
}

/**
 * Wait for a model to be fully unloaded before reloading with new parameters.
 */
async function waitForModelUnloaded(baseUrl: string, modelId: string, maxWaitMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        const model = data.data?.find((m: any) => m.id === modelId);
        if (!model || model.status?.value === "unloaded") {
          return;
        }
      }
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Parse `--ctx-size N` from a llama-server argv array. Returns undefined if
 * the flag is absent or unparseable. Used to recover the actual context window
 * of an already-loaded model after a Node restart wipes our in-memory cache.
 */
function parseCtxSizeFromArgs(args: unknown): number | undefined {
  if (!Array.isArray(args)) return undefined;
  const i = args.indexOf("--ctx-size");
  if (i < 0 || i + 1 >= args.length) return undefined;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

interface LoadedLlamaModel {
  id: string;
  contextWindow?: number;
}

/**
 * Query llama.cpp for every model currently resident in router mode.
 * `contextWindow` is parsed from the model's argv (`--ctx-size`) and may be
 * undefined if the flag was omitted.
 */
async function getLoadedModels(baseUrl: string): Promise<LoadedLlamaModel[]> {
  try {
    const res = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || [])
      .filter((m: any) => m.status?.value === "loaded" && typeof m.id === "string")
      .map((m: any) => ({
        id: m.id,
        contextWindow: parseCtxSizeFromArgs(m.status?.args),
      }));
  } catch {
    return [];
  }
}

/**
 * Query llama.cpp to find which model is actually loaded right now.
 * Returns { id, contextWindow } if exactly one model is in "loaded" state.
 * Callers that need to clean up stale concurrent children should use
 * `getLoadedModels()` instead.
 */
async function getActualLoadedModel(baseUrl: string): Promise<LoadedLlamaModel | null> {
  const loaded = await getLoadedModels(baseUrl);
  if (loaded.length === 1) {
    return loaded[0];
  }
  return null;
}

async function unloadModel(baseUrl: string, modelId: string): Promise<boolean> {
  const unloadRes = await fetch(`${baseUrl}/models/unload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelId }),
    signal: AbortSignal.timeout(30_000),
  });
  if (unloadRes.ok) {
    console.log(`[openai-compat] Unloaded model: ${modelId}`);
    await waitForModelUnloaded(baseUrl, modelId);
    return true;
  }
  console.warn(`[openai-compat] Unload returned ${unloadRes.status} for ${modelId}`);
  return false;
}

/**
 * Ensure the target model is loaded on the llama.cpp server with the right context window.
 * In router mode, calls POST /models/load which blocks until the model is ready.
 * If the context window changed, the model is reloaded with the new size.
 * In single-model mode, the endpoint doesn't exist — we catch and ignore 404s.
 */
export async function ensureModelLoaded(
  baseUrl: string,
  modelId: string,
  contextWindow?: number,
  options: EnsureModelLoadedOptions = {}
): Promise<void> {
  try {
    const stateKey = modelStateKey(baseUrl, modelId);
    const forcedReload = options.forceReload === true || modelsNeedingReload.delete(stateKey);
    if (forcedReload) {
      lastLoadedModel = null;
      console.log(
        `[openai-compat] Force reloading ${modelId}${options.reason ? `: ${options.reason}` : ""}`
      );
    }

    const loadedModels = await getLoadedModels(baseUrl);
    const extraLoadedModels = loadedModels.filter((m) => m.id !== modelId);
    if (extraLoadedModels.length > 0) {
      lastLoadedModel = null;
      console.log(
        `[openai-compat] Unloading stale loaded model(s) before using ${modelId}: ${extraLoadedModels.map((m) => m.id).join(", ")}`
      );
      for (const loaded of extraLoadedModels) {
        await unloadModel(baseUrl, loaded.id).catch((err) => {
          console.warn(`[openai-compat] Unload failed for ${loaded.id}:`, err instanceof Error ? err.message : err);
          return false;
        });
      }
    }

    const targetLive = loadedModels.find((m) => m.id === modelId);
    if (!forcedReload && targetLive && extraLoadedModels.length > 0) {
      await waitForModelReady(baseUrl, modelId).catch(() => {});
      lastLoadedModel = { baseUrl, modelId, contextWindow: targetLive.contextWindow ?? contextWindow };
      return;
    }

    // Skip if we already loaded this model — context window is set on first load only.
    // We don't reload for context window changes because:
    // 1. Background callers (extraction, title gen) may request a different ctx than the active chat
    // 2. Reloading mid-turn kills active connections and disrupts the agent loop
    // 3. The application layer (compaction, token counting) handles context limits
    if (!forcedReload && lastLoadedModel?.baseUrl === baseUrl && lastLoadedModel?.modelId === modelId) {
      return;
    }

    // Unload the previous model first to free VRAM. After a Node restart the
    // in-memory `lastLoadedModel` cache is empty even when the router has a
    // different model loaded — without recovering that live state we'd skip
    // the unload, send /models/load for the new model on top, and OOM the GPU.
    // Recover the actual loaded model name from /v1/models when our cache is
    // empty so the unload path triggers correctly.
    let previousModelId = lastLoadedModel?.modelId;
    if (!previousModelId) {
      const actual = await getActualLoadedModel(baseUrl);
      if (actual && actual.id !== modelId) {
        previousModelId = actual.id;
        console.log(`[openai-compat] Recovered live loaded model=${actual.id} for ${baseUrl} (in-memory cache was empty)`);
      }
    }
    const needsUnload = previousModelId !== undefined && previousModelId !== modelId;
    const needsReload = forcedReload || (lastLoadedModel?.baseUrl === baseUrl && lastLoadedModel?.modelId === modelId);

    // Invalidate cache before any model change so failures don't leave stale state
    if (needsUnload) {
      lastLoadedModel = null;
    }

    if (needsUnload || needsReload) {
      try {
        const unloadModelId = needsUnload ? previousModelId! : modelId;
        await unloadModel(baseUrl, unloadModelId);
      } catch (err) {
        console.warn(`[openai-compat] Unload failed:`, err instanceof Error ? err.message : err);
      }
    }

    // Wait briefly after unload for VRAM to be freed
    if (needsUnload) await new Promise((r) => setTimeout(r, 1000));

    const loadBody: any = { model: modelId };
    if (contextWindow) {
      loadBody.args = ["--ctx-size", String(contextWindow)];
    }

    const res = await fetch(`${baseUrl}/models/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(loadBody),
      signal: AbortSignal.timeout(120_000), // Model loading can take a while
    });

    if (res.ok) {
      try {
        await waitForModelReady(baseUrl, modelId);
        console.log(`[openai-compat] Loaded model: ${modelId}${contextWindow ? ` (ctx=${contextWindow})` : ""}`);
        lastLoadedModel = { baseUrl, modelId, contextWindow };
      } catch (loadErr) {
        console.error(`[openai-compat] Model ${modelId} load accepted but never became ready`);
        lastLoadedModel = null;
        throw loadErr;
      }
    } else if (res.status === 400) {
      const text = await res.text().catch(() => "");
      if (text.includes("already running")) {
        // Verify which model is actually loaded on llama.cpp
        const actualLoaded = await getActualLoadedModel(baseUrl);
        if (actualLoaded && actualLoaded.id !== modelId) {
          // A different model is running — unload it and retry
          console.log(`[openai-compat] Expected ${modelId} but ${actualLoaded.id} is running, forcing switch`);
          try {
            await fetch(`${baseUrl}/models/unload`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: actualLoaded.id }),
              signal: AbortSignal.timeout(30_000),
            });
            await waitForModelUnloaded(baseUrl, actualLoaded.id);
            const retryRes = await fetch(`${baseUrl}/models/load`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(loadBody),
              signal: AbortSignal.timeout(120_000),
            });
            if (retryRes.ok) {
              await waitForModelReady(baseUrl, modelId);
              console.log(`[openai-compat] Loaded model after forced switch: ${modelId}`);
              lastLoadedModel = { baseUrl, modelId, contextWindow };
              return;
            }
            console.warn(`[openai-compat] Retry load after forced unload returned ${retryRes.status}`);
          } catch (err) {
            console.warn(`[openai-compat] Forced switch failed:`, err instanceof Error ? err.message : err);
          }
          // Force switch failed — invalidate cache so next attempt retries
          lastLoadedModel = null;
          return;
        }

        // The requested model IS what's running — handle context window mismatch.
        // After a Node restart the in-memory `lastLoadedModel` cache is empty even
        // when llama-server has the model loaded with the right ctx. Recover the
        // actual ctx from /v1/models (status.args) instead of pessimistically
        // reloading, which would nuke the KV cache and force a full cold prefill.
        const liveCtx = actualLoaded?.contextWindow;
        const knownCtx = lastLoadedModel?.contextWindow ?? liveCtx;
        if (lastLoadedModel?.contextWindow === undefined && liveCtx !== undefined) {
          console.log(`[openai-compat] Recovered live ctx=${liveCtx} for ${modelId} from /v1/models (in-memory cache was empty)`);
        }
        if (forcedReload || (contextWindow && (!knownCtx || knownCtx < contextWindow))) {
          console.log(
            forcedReload
              ? `[openai-compat] Model still reported already running after reload request, unloading ${modelId} and retrying`
              : `[openai-compat] Model already running (ctx=${knownCtx ?? "unknown"}) but need ctx=${contextWindow}, reloading`
          );
          try {
            const unloadRes = await fetch(`${baseUrl}/models/unload`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: modelId }),
              signal: AbortSignal.timeout(30_000),
            });
            if (!unloadRes.ok) {
              console.warn(`[openai-compat] Unload returned ${unloadRes.status}, waiting for model anyway`);
            }
            // Wait for unload to fully complete before reloading
            await waitForModelUnloaded(baseUrl, modelId);

            const reloadBody: any = { model: modelId };
            if (contextWindow) reloadBody.args = ["--ctx-size", String(contextWindow)];
            const reloadRes = await fetch(`${baseUrl}/models/load`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(reloadBody),
              signal: AbortSignal.timeout(120_000),
            });
            if (reloadRes.ok) {
              await waitForModelReady(baseUrl, modelId);
              console.log(`[openai-compat] Reloaded model: ${modelId} (ctx=${contextWindow})`);
              lastLoadedModel = { baseUrl, modelId, contextWindow };
              return;
            }
            console.warn(`[openai-compat] Reload returned ${reloadRes.status}`);
          } catch (err) {
            console.warn(`[openai-compat] Reload sequence failed:`, err instanceof Error ? err.message : err);
          }
          // Reload failed — wait for whatever state the model is in before proceeding
          await waitForModelReady(baseUrl, modelId).catch(() => {});
          if (forcedReload) {
            lastLoadedModel = null;
            modelsNeedingReload.add(stateKey);
            return;
          }
        }
        // No reload needed — populate the cache with the live ctx (if recovered)
        // or the requested ctx (which the running instance already satisfies).
        lastLoadedModel = { baseUrl, modelId, contextWindow: knownCtx ?? contextWindow };
      } else {
        // Non-"already running" 400 error — don't cache
        console.warn(`[openai-compat] /models/load returned 400: ${text}`);
        lastLoadedModel = null;
      }
    } else if (res.status === 404) {
      // Single-model mode — endpoint doesn't exist, proceed normally
      lastLoadedModel = { baseUrl, modelId, contextWindow };
    } else {
      const text = await res.text().catch(() => "");
      console.warn(`[openai-compat] /models/load returned ${res.status}: ${text}`);
      // Don't cache — state is unknown
      lastLoadedModel = null;
    }
  } catch (err) {
    console.warn(`[openai-compat] ensureModelLoaded failed:`, err instanceof Error ? err.message : err);
    // Invalidate cache on any unexpected failure
    lastLoadedModel = null;
  }
}

// ---------------------------------------------------------------------------
// Main stream function
// ---------------------------------------------------------------------------

export const streamOpenAICompat = (
  model: Model<Api>,
  context: Context,
  options?: StreamOptions
) => {
  const stream = createAssistantMessageEventStream();

  (async () => {
    let stopPrefillMonitor: (() => void) | null = null;
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      // Pre-load the model in router mode. This ensures the target model is
      // loaded and ready before we send the chat request. In single-model mode
      // this endpoint doesn't exist, so we catch and ignore errors.
      await ensureModelLoaded(model.baseUrl, model.id, model.contextWindow);

      const llamaSlotLease = getLlamaSlotLease(options);
      const useLlamaSlotLease = !!llamaSlotLease &&
        normalizeBaseUrl(llamaSlotLease.baseUrl) === normalizeBaseUrl(model.baseUrl) &&
        llamaSlotLease.modelId === model.id;
      if (llamaSlotLease && !useLlamaSlotLease) {
        console.warn(
          `[openai-compat] ignoring mismatched llama slot lease for model=${model.id}: ` +
          `lease model=${llamaSlotLease.modelId} slot=${llamaSlotLease.slotId}`,
        );
      }

      const { body, cachePrompt } = await buildOpenAICompatChatBody(model, context, options);

      const url = `${model.baseUrl}/v1/chat/completions`;
      const cacheMetadata = buildCacheMetadata(cachePrompt, body);
      const promptDebugChatId = getPromptDebugChatId(options);
      if (LLAMACPP_PROMPT_DEBUG && promptDebugChatId) {
        try {
          const renderedPrompt = await renderPromptForDebug(model.baseUrl, body, options?.signal);
          compareWithWarmPrompt({
            chatId: promptDebugChatId,
            modelId: model.id,
            payloadDigest: cacheMetadata.requestDigest,
            promptDigest: digestPromptText(renderedPrompt),
            promptChars: renderedPrompt.length,
            prompt: renderedPrompt,
            messageCount: cacheMetadata.requestMessageCount,
            requestChars: cacheMetadata.requestCharCount,
          });
        } catch (err) {
          console.warn(
            `[prompt-debug] chat=${promptDebugChatId} failed to render chat prompt:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      const onModelProgress = getModelProgressCallback(options);
      const showIndicator = getShowIndicatorFromOptions(options);

      // Three-state gating for the user-facing prefill progress indicator:
      //   true  — always show (first turns)
      //   false — always hide (tool iterations, non-UI callers)
      //   undefined — auto-show only when cache state signals a cold prefill

      // Determine cache state upfront from explicit signals rather than
      // inferring from prefill progress (which conflates progress with hits).
      const initialCacheState = await determineCacheState(
        model.baseUrl,
        model.id,
        useLlamaSlotLease ? llamaSlotLease : null,
      );

      stopPrefillMonitor = startLlamaPrefillMonitor({
        baseUrl: model.baseUrl,
        modelId: model.id,
        slotId: cacheMetadata.slotId,
        estimatedPromptTokens: cacheMetadata.estimatedPromptTokens,
        containsImages: cacheMetadata.containsImages,
        onProgress: onModelProgress,
        signal: options?.signal,
        showIndicator,
        initialCacheState,
      });

      // Retry on transient connection failures (fetch failed / ECONNRESET).
      // llama.cpp's router can briefly refuse connections between rapid iterations.
      let response: Response | undefined;
      let lastFetchError: Error | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await undiciFetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: options?.signal,
            dispatcher: llamaStreamAgent,
          }) as unknown as Response;
          lastFetchError = undefined;
          break;
        } catch (err) {
          lastFetchError = err instanceof Error ? err : new Error(String(err));
          if (options?.signal?.aborted) throw lastFetchError;
          if (attempt < 2) {
            console.warn(`[openai-compat] fetch attempt ${attempt + 1} failed: ${lastFetchError.message}, retrying in 1s...`);
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      }
      if (lastFetchError) {
        // Invalidate loaded model cache — connection failure likely means the child
        // process crashed and the router can't proxy to it.
        markModelForReload(model.baseUrl, model.id, lastFetchError.message);
        throw lastFetchError;
      }

      if (!response || !response.ok) {
        const errorText = response ? await response.text().catch(() => "Unknown error") : "No response";
        // Invalidate loaded model cache on server errors — the child process may have
        // crashed (common with vision models on ROCm) and needs to be reloaded.
        if (response && (response.status === 500 || response.status === 502 || response.status === 503)) {
          if (isLlamaCppChildConnectionError(response.status, errorText)) {
            markModelForReload(model.baseUrl, model.id, `server error ${response.status}: ${errorText}`);
          } else {
            console.warn(`[openai-compat] Server error ${response.status}, invalidating model cache`);
            invalidateLoadedModel();
          }
        }
        throw new Error(`llama.cpp API error ${response?.status ?? "?"}: ${errorText}`);
      }

      if (!response.body) {
        throw new Error("No response body from llama.cpp");
      }

      stopPrefillMonitor?.();
      stopPrefillMonitor = null;
      onModelProgress?.({
        phase: "generating",
        modelId: model.id,
        baseUrl: normalizeBaseUrl(model.baseUrl),
        slotId: cacheMetadata.slotId,
        elapsedMs: 0,
        cacheState: "unknown",
        confidence: cacheMetadata.slotId !== undefined ? "matched-slot" : "unknown",
        updatedAt: Date.now(),
      });

      stream.push({ type: "start", partial: output } as AssistantMessageEvent);

      // Gemma 4 channel token filter — strips <|channel>thought\n...<channel|>
      // blocks that leak into delta.content when llama.cpp doesn't route them
      // to reasoning_content. Stateful to handle tokens split across chunks.
      const isGemma = model.id.toLowerCase().includes("gemma");
      let gemmaChannelState: "text" | "maybe-open" | "thinking" | "maybe-close" = "text";
      let gemmaChannelBuffer = "";

      const filterGemmaChannelTokens = (text: string): string => {
        if (!isGemma) return text;

        let result = "";
        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          gemmaChannelBuffer += ch;

          switch (gemmaChannelState) {
            case "text":
              // Look for start of <|channel>
              if (gemmaChannelBuffer.endsWith("<")) {
                gemmaChannelState = "maybe-open";
              } else {
                result += gemmaChannelBuffer;
                gemmaChannelBuffer = "";
              }
              break;

            case "maybe-open":
              // Building up <|channel>thought\n
              if ("<|channel>thought\n".startsWith(gemmaChannelBuffer)) {
                if (gemmaChannelBuffer === "<|channel>thought\n") {
                  // Full opening tag matched — enter thinking state, discard buffer
                  gemmaChannelState = "thinking";
                  gemmaChannelBuffer = "";
                }
                // else keep buffering
              } else {
                // Not a match — flush buffer as regular text
                result += gemmaChannelBuffer;
                gemmaChannelBuffer = "";
                gemmaChannelState = "text";
              }
              break;

            case "thinking":
              // Inside thinking block — look for <channel|>
              if (gemmaChannelBuffer.endsWith("<")) {
                gemmaChannelState = "maybe-close";
              } else {
                // Discard thinking content
                gemmaChannelBuffer = "";
              }
              break;

            case "maybe-close":
              // Building up <channel|>
              if ("<channel|>".startsWith(gemmaChannelBuffer)) {
                if (gemmaChannelBuffer === "<channel|>") {
                  // Full closing tag matched — return to text state
                  gemmaChannelState = "text";
                  gemmaChannelBuffer = "";
                }
                // else keep buffering
              } else {
                // Not a closing tag — discard (still in thinking) and reset
                gemmaChannelBuffer = "";
                gemmaChannelState = "thinking";
              }
              break;
          }
        }
        return result;
      };

      let currentBlock: any = null;
      const blocks = output.content;
      const blockIndex = () => blocks.length - 1;

      // Track incremental tool call accumulation (OpenAI streams tool calls in deltas)
      const pendingToolCalls = new Map<number, {
        id: string;
        name: string;
        argsBuffer: string;
      }>();

      const finishCurrentBlock = (block: any) => {
        if (!block) return;
        if (block.type === "text") {
          stream.push({
            type: "text_end",
            contentIndex: blockIndex(),
            content: block.text,
            partial: output,
          } as AssistantMessageEvent);
        } else if (block.type === "thinking") {
          stream.push({
            type: "thinking_end",
            contentIndex: blockIndex(),
            content: block.thinking,
            partial: output,
          } as AssistantMessageEvent);
        } else if (block.type === "toolCall") {
          if (block.partialArgs) {
            block.arguments = parseStreamingJson(block.partialArgs);
            delete block.partialArgs;
          }
          stream.push({
            type: "toolcall_end",
            contentIndex: blockIndex(),
            toolCall: block,
            partial: output,
          } as AssistantMessageEvent);
        }
      };

      let stopReason: StopReason = "stop";

      // Track llama.cpp timings from the final SSE chunk.
      let llamaTimings: OpenAIChatChunk["timings"] | undefined;

      for await (const chunk of parseSSE(response.body, options?.signal)) {
        // Extract usage from final chunk
        if (chunk.usage) {
          cacheMetadata.reportedPromptTokens = chunk.usage.prompt_tokens || 0;
          output.usage = {
            input: chunk.usage.prompt_tokens || 0,
            output: chunk.usage.completion_tokens || 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: chunk.usage.total_tokens || 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };
        }
        // Capture llama.cpp timings from final chunk
        if (chunk.timings) {
          llamaTimings = chunk.timings;
          cacheMetadata.promptEvalTokens = chunk.timings.prompt_n;
          if (cacheMetadata.reportedPromptTokens !== undefined) {
            const inferredCached = Math.max(0, cacheMetadata.reportedPromptTokens - chunk.timings.prompt_n);
            cacheMetadata.inferredCachedTokens = inferredCached;
            cacheMetadata.inferredCacheHitRatio = cacheMetadata.reportedPromptTokens > 0
              ? inferredCached / cacheMetadata.reportedPromptTokens
              : 0;
          }
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        if (choice.finish_reason) {
          stopReason = mapStopReason(choice.finish_reason);
        }

        const delta = choice.delta;
        if (!delta) continue;

        // Handle reasoning/thinking tokens
        if (delta.reasoning_content && !isPlaceholderEllipsis(delta.reasoning_content)) {
          if (!currentBlock || currentBlock.type !== "thinking") {
            finishCurrentBlock(currentBlock);
            currentBlock = { type: "thinking", thinking: "" };
            output.content.push(currentBlock);
            stream.push({
              type: "thinking_start",
              contentIndex: blockIndex(),
              partial: output,
            } as AssistantMessageEvent);
          }
          currentBlock.thinking += delta.reasoning_content;
          stream.push({
            type: "thinking_delta",
            contentIndex: blockIndex(),
            delta: delta.reasoning_content,
            partial: output,
          } as AssistantMessageEvent);
        }

        // Handle content tokens
        if (delta.content && !isPlaceholderEllipsis(delta.content)) {
          // Filter Gemma 4 channel tokens that leak into content
          const filteredContent = filterGemmaChannelTokens(delta.content);
          if (filteredContent) {
            if (!currentBlock || currentBlock.type !== "text") {
              finishCurrentBlock(currentBlock);
              currentBlock = { type: "text", text: "" };
              output.content.push(currentBlock);
              stream.push({
                type: "text_start",
                contentIndex: blockIndex(),
                partial: output,
              } as AssistantMessageEvent);
            }
            currentBlock.text += filteredContent;
            stream.push({
              type: "text_delta",
              contentIndex: blockIndex(),
              delta: filteredContent,
              partial: output,
            } as AssistantMessageEvent);
          }
        }

        // Handle tool calls (streamed incrementally by index)
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;

            if (tc.id || (tc.function?.name && !pendingToolCalls.has(idx))) {
              // New tool call starting
              finishCurrentBlock(currentBlock);
              currentBlock = null;

              const toolCallId = tc.id || `call_${randomUUID().slice(0, 8)}`;
              const name = tc.function?.name || "";
              pendingToolCalls.set(idx, { id: toolCallId, name, argsBuffer: "" });

              const toolBlock = {
                type: "toolCall" as const,
                id: toolCallId,
                name,
                arguments: {},
                partialArgs: "",
              };
              output.content.push(toolBlock);
              currentBlock = toolBlock;

              stream.push({
                type: "toolcall_start",
                contentIndex: blockIndex(),
                partial: output,
              } as AssistantMessageEvent);
            }

            // Accumulate argument deltas
            if (tc.function?.arguments) {
              const pending = pendingToolCalls.get(idx);
              if (pending) {
                pending.argsBuffer += tc.function.arguments;

                // Find the matching block in output.content
                const block = output.content.find(
                  (b: any) => b.type === "toolCall" && b.id === pending.id
                ) as any;
                if (block) {
                  block.partialArgs = pending.argsBuffer;
                  currentBlock = block;

                  stream.push({
                    type: "toolcall_delta",
                    contentIndex: output.content.indexOf(block),
                    delta: tc.function.arguments,
                    partial: output,
                  } as AssistantMessageEvent);
                }
              }
            }
          }
        }
      }

      // Flush any Gemma channel filter buffer left over at stream end
      // (e.g. a trailing "<" that wasn't part of a channel tag)
      if (isGemma && gemmaChannelBuffer && (gemmaChannelState === "text" || gemmaChannelState === "maybe-open")) {
        if (currentBlock?.type === "text") {
          currentBlock.text += gemmaChannelBuffer;
        }
        gemmaChannelBuffer = "";
      }

      // Finish any remaining tool calls
      if (pendingToolCalls.size > 0) {
        for (const [, pending] of pendingToolCalls) {
          const block = output.content.find(
            (b: any) => b.type === "toolCall" && b.id === pending.id
          ) as any;
          if (block) {
            block.partialArgs = pending.argsBuffer;
            const idx = output.content.indexOf(block);
            block.arguments = parseStreamingJson(block.partialArgs);
            delete block.partialArgs;
            stream.push({
              type: "toolcall_end",
              contentIndex: idx,
              toolCall: block,
              partial: output,
            } as AssistantMessageEvent);
          }
        }
        currentBlock = null;
      } else {
        finishCurrentBlock(currentBlock);
      }

      output.stopReason = stopReason;
      // Attach llama.cpp timings so downstream consumers (model-stats, etc.) can record them.
      if (llamaTimings) {
        (output as any).llamaTimings = llamaTimings;
      }
      (output as any).llamaCache = cacheMetadata;

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      // Defensive: if tool calls were emitted but finish_reason wasn't
      // "tool_calls" (some models / proxies report "stop" instead), promote
      // to "toolUse" so the caller's loop executes them.
      if (output.stopReason === "stop" && output.content.some((b) => b.type === "toolCall")) {
        output.stopReason = "toolUse";
      }

      stream.push({ type: "done", reason: output.stopReason, message: output } as AssistantMessageEvent);
      stream.end();
    } catch (error) {
      stopPrefillMonitor?.();
      stopPrefillMonitor = null;
      for (const block of output.content) delete (block as any).index;
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: "error", reason: output.stopReason, error: output } as AssistantMessageEvent);
      stream.end();
    }
  })();

  return stream;
};

// ---------------------------------------------------------------------------
// Simple stream wrapper
// ---------------------------------------------------------------------------

export const streamSimpleOpenAICompat = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions
) => {
  return streamOpenAICompat(model, context, options);
};

// ---------------------------------------------------------------------------
// Provider registration
// ---------------------------------------------------------------------------

export function registerOpenAICompatProvider() {
  registerApiProvider({
    api: "openai-compat",
    stream: streamOpenAICompat,
    streamSimple: streamSimpleOpenAICompat,
  });
}
