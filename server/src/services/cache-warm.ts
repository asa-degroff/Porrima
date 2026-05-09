/**
 * Cache Warm — Prefill KV cache without generating output.
 *
 * Uses llama.cpp's `/apply-template` + `/completion` with `n_predict: 0` to
 * evaluate the full prompt into the KV cache, returning immediately after
 * prefill. The server's `--cache-idle-slots` + `--kv-unified` then holds
 * the context in host memory for instant reuse on the next real request.
 *
 * Two flows:
 *  1. User-initiated: sidebar context menu "Warm Cache" per chat
 *  2. Sleep pre-warm: system chat warms before entering sleep mode
 */

import { getChat, getSettings } from "./chat-storage.js";
import { chatMessagesToPiMessages } from "./agent.js";
import {
  ensureRouterModelLoaded,
  normalizeRouterModelId,
} from "./llama-router-client.js";
import {
  markLlamaCacheResidencyStarted,
  recordLlamaCacheResidencyRun,
} from "./llama-cache-residency.js";
import { discoverAllModels } from "./models.js";
import { getOllamaUrl } from "./ollama-url.js";
import type { OllamaModel } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CacheWarmResult {
  /** True if prefill completed successfully */
  warmed: boolean;
  /** Chat that was warmed */
  chatId: string;
  /** Model used */
  modelId: string;
  /** Time spent on prefill (ms) */
  promptMs?: number;
  /** Tokens served from existing cache */
  tokensCached?: number;
  /** Tokens newly evaluated (not cached) */
  tokensEvaluated?: number;
  /** Ratio of tokens served from cache (0-1) */
  cacheHitRatio?: number;
  /** Total tokens in the prompt */
  totalPromptTokens?: number;
  /** Why this warm was triggered */
  reason: "user-requested" | "sleep-prewarm";
  /** Timestamp of the warm operation */
  warmedAt: number;
  /** Error message if warming failed */
  error?: string;
}

export interface CacheWarmOptions {
  reason?: "user-requested" | "sleep-prewarm";
  /** Abort signal for timeout control */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LLAMACPP_WARM_TIMEOUT_MS = Number(process.env.LLAMACPP_WARM_TIMEOUT_MS) || 30 * 60_000;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the model info for a given model ID.
 */
async function findModelInfo(modelId: string): Promise<{ model: OllamaModel; baseUrl: string } | null> {
  const allModels = await discoverAllModels();
  const normalizedId = normalizeRouterModelId(modelId);
  const model = allModels.find((m) => m.id === modelId) ||
    (normalizedId !== modelId ? allModels.find((m) => m.id === normalizedId) : undefined);

  if (!model) return null;

  // Derive the baseUrl from the model's provider
  if (model.provider === "llamacpp") {
    const settings = await getSettings();
    return { model, baseUrl: settings.llamacppUrl || "http://localhost:8080" };
  } else if (model.provider === "ollama") {
    const settings = await getSettings();
    return { model, baseUrl: getOllamaUrl(settings) };
  }

  // Unknown provider — can't resolve URL
  return null;
}

/**
 * Apply chat template via /apply-template endpoint.
 */
async function applyChatTemplate(
  baseUrl: string,
  modelId: string,
  messages: any[],
  options?: { signal?: AbortSignal; chatTemplateKwargs?: Record<string, any> }
): Promise<string> {
  const body: any = { model: modelId, messages };
  if (options?.chatTemplateKwargs && Object.keys(options.chatTemplateKwargs).length > 0) {
    body.chat_template_kwargs = options.chatTemplateKwargs;
  }

  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/apply-template`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options?.signal || AbortSignal.timeout(LLAMACPP_WARM_TIMEOUT_MS),
  });

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

/**
 * Send a completion request with n_predict=0 to prefill the KV cache
 * without generating any output tokens.
 */
async function prefillOnly(
  baseUrl: string,
  modelId: string,
  prompt: string,
  options?: { signal?: AbortSignal }
): Promise<{
  promptMs: number;
  tokensCached: number;
  tokensEvaluated: number;
}> {
  const body: any = {
    model: modelId,
    prompt,
    n_predict: 0,
    cache_prompt: true,
    return_tokens: false,
  };

  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/completion`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options?.signal || AbortSignal.timeout(LLAMACPP_WARM_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`/completion failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const json = await res.json();

  const promptMs = json.timings?.prompt_ms ?? 0;
  const tokensCached = json.tokens_cached ?? 0;
  const tokensEvaluated = json.tokens_evaluated ?? 0;

  return { promptMs, tokensCached, tokensEvaluated };
}

/**
 * Convert our Chat messages to OpenAI-compatible format for the template.
 */
function buildOaiMessages(
  chatMessages: any[],
  systemPrompt: string,
  modelId: string
): any[] {
  const piMessages = chatMessagesToPiMessages(chatMessages, modelId, undefined);

  const oaiMessages: any[] = [];

  if (systemPrompt) {
    oaiMessages.push({ role: "system", content: systemPrompt });
  }

  for (const msg of piMessages) {
    if (msg.role === "user") {
      oaiMessages.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      const content = msg.content;
      if (Array.isArray(content)) {
        const textParts: string[] = [];
        const thinkingParts: string[] = [];
        for (const part of content) {
          if (part.type === "text") textParts.push(part.text);
          else if (part.type === "thinking") thinkingParts.push(part.thinking);
        }
        const oaiMsg: any = { role: "assistant" };
        if (thinkingParts.length) {
          oaiMsg.reasoning_content = thinkingParts.join("");
        }
        if (textParts.length) {
          oaiMsg.content = textParts.join("");
        } else {
          oaiMsg.content = "";
        }
        oaiMessages.push(oaiMsg);
      } else {
        oaiMessages.push({ role: "assistant", content: String(content) });
      }
    } else if (msg.role === "toolResult") {
      const textContent = Array.isArray(msg.content)
        ? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("")
        : String(msg.content);
      oaiMessages.push({
        role: "tool",
        tool_call_id: msg.toolCallId,
        content: textContent,
      });
    }
  }

  return oaiMessages;
}

// ---------------------------------------------------------------------------
// Main warm function
// ---------------------------------------------------------------------------

/**
 * Warm the KV cache for a chat by sending its full context through the
 * prefill-only path. Returns timing and cache statistics.
 */
export async function warmChatCache(
  chatId: string,
  options: CacheWarmOptions = {}
): Promise<CacheWarmResult> {
  const result: CacheWarmResult = {
    warmed: false,
    chatId,
    modelId: "",
    reason: options.reason ?? "user-requested",
    warmedAt: Date.now(),
  };

  try {
    // 1. Load the chat
    const chat = await getChat(chatId);
    if (!chat) {
      result.error = `Chat not found: ${chatId}`;
      return result;
    }

    result.modelId = chat.modelId;
    const allMessages = chat.messages.length > 0 ? chat.messages : [];

    if (allMessages.length === 0) {
      result.error = "Chat has no messages";
      return result;
    }

    // 2. Find model info (baseUrl, reasoning support)
    const modelInfo = await findModelInfo(chat.modelId);
    if (!modelInfo) {
      result.error = `Model not found: ${chat.modelId}`;
      return result;
    }

    const { model, baseUrl } = modelInfo;
    const normalizedModelId = normalizeRouterModelId(chat.modelId);

    // 3. Ensure model is loaded on the router
    const loadResult = await ensureRouterModelLoaded(baseUrl, normalizedModelId, {
      contextWindow: chat.contextWindow,
    });
    if (loadResult === "error") {
      result.error = `Failed to load model: ${normalizedModelId}`;
      return result;
    }

    // 4. Build OpenAI-compatible messages
    const oaiMessages = buildOaiMessages(allMessages, chat.systemPrompt, chat.modelId);

    // 5. Determine chat template kwargs
    // For cache warming, we disable enable_thinking on reasoning models.
    // The model's GGUF metadata has enable_thinking=true by default, which
    // conflicts with /apply-template when the conversation ends with a
    // completed assistant turn (prefill mode). We just need the raw template
    // output for KV cache — thinking tags are a generation concern.
    const chatTemplateKwargs: Record<string, any> = {};
    if (modelSupportsReasoning(model)) {
      chatTemplateKwargs.enable_thinking = false;
    }

   // 6. Apply chat template
    console.log(`[cache-warm] applying template for ${normalizedModelId}, kwargs:`, chatTemplateKwargs);
    console.log(`[cache-warm] last message role: ${oaiMessages[oaiMessages.length - 1]?.role}, content length: ${String(oaiMessages[oaiMessages.length - 1]?.content).length}`);
    const formattedPrompt = await applyChatTemplate(baseUrl, normalizedModelId, oaiMessages, {
      signal: options.signal,
      chatTemplateKwargs: Object.keys(chatTemplateKwargs).length > 0 ? chatTemplateKwargs : undefined,
    });

    // 7. Mark residency as warming
    markLlamaCacheResidencyStarted({
      chatId,
      baseUrl,
      modelId: normalizedModelId,
      contextWindow: chat.contextWindow,
      bindingMode: "auto",
    });

    // 8. Prefill only — populates KV cache without generating
    const stats = await prefillOnly(baseUrl, normalizedModelId, formattedPrompt, {
      signal: options.signal,
    });

    // 9. Calculate hit ratio
    const totalTokens = stats.tokensCached + stats.tokensEvaluated;
    const hitRatio = totalTokens > 0 ? stats.tokensCached / totalTokens : 0;

    // 10. Record residency
    recordLlamaCacheResidencyRun({
      chatId,
      baseUrl,
      modelId: normalizedModelId,
      contextWindow: chat.contextWindow,
      bindingMode: "auto",
      timings: { prompt_n: totalTokens, prompt_ms: stats.promptMs },
      cache: {
        cachePrompt: true,
        cacheMode: "cache_prompt",
        requestDigest: "",
        requestMessageCount: allMessages.length,
        requestCharCount: formattedPrompt.length,
        reportedPromptTokens: totalTokens,
        promptEvalTokens: stats.tokensEvaluated,
        inferredCachedTokens: stats.tokensCached,
        inferredCacheHitRatio: hitRatio,
      },
    });

    // 11. Return success
    return {
      ...result,
      warmed: true,
      promptMs: stats.promptMs,
      tokensCached: stats.tokensCached,
      tokensEvaluated: stats.tokensEvaluated,
      totalPromptTokens: totalTokens,
      cacheHitRatio: hitRatio,
    };
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    console.warn(`[cache-warm] Failed to warm cache for chat ${chatId}:`, err);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

function supportsReasoningFamily(family: string | undefined): boolean {
  if (!family) return false;
  return family.startsWith("qwen3") || family.startsWith("gemma4");
}

/** Check if a model supports reasoning, using family or name as fallback. */
function modelSupportsReasoning(model: OllamaModel): boolean {
  if (supportsReasoningFamily(model.family)) return true;
  // llama.cpp models often have empty family — check the model ID/name instead
  const id = (model.id || "").toLowerCase();
  const name = (model.name || "").toLowerCase();
  const combined = id + " " + name;
  return combined.includes("qwen3") || combined.includes("gemma4");
}
