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

import { randomUUID } from "crypto";
import { getChat, getProject, getSettings } from "./chat-storage.js";
import { chatMessagesToPiMessages } from "./agent.js";
import type { ReplayModelIdentity } from "./agent.js";
import { fetch as undiciFetch, Agent as UndiciAgent } from "undici";
import {
  ensureRouterModelLoaded,
  normalizeRouterModelId,
} from "./llama-router-client.js";
import {
  buildOpenAICompatChatBody,
  digestPromptPayload,
} from "./openai-compat-provider.js";
import {
  markLlamaCacheResidencyFinished,
  markLlamaCacheResidencyStarted,
  recordLlamaCacheResidencyRun,
  type LlamaCacheBindingMode,
} from "./llama-cache-residency.js";
import { createPiModelFromProvider, discoverAllModels, getEffectiveContextWindow } from "./models.js";
import { getOllamaUrl } from "./ollama-url.js";
import {
  buildSplitAugmentedPrompt,
  resetMemoryContext,
  setCachedAugmentedPrompt,
} from "./memory-context.js";
import { getAgentTools, type ToolSideEffects } from "./agent-tools.js";
import { digestPromptText, recordWarmPromptSnapshot } from "./llama-prompt-debug.js";
import { buildSkillAugmentedPrompt, discoverSkills, type Skill } from "./skills.js";
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
  reason: "user-requested" | "sleep-prewarm" | "post-synthesis";
  /** Timestamp of the warm operation */
  warmedAt: number;
  /** Error message if warming failed */
  error?: string;
}

export interface CacheWarmOptions {
  reason?: "user-requested" | "sleep-prewarm" | "post-synthesis";
  /** Abort signal for timeout control */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LLAMACPP_WARM_TIMEOUT_MS = Number(process.env.LLAMACPP_WARM_TIMEOUT_MS) || 30 * 60_000;
const llamaWarmAgent = new UndiciAgent({
  headersTimeout: LLAMACPP_WARM_TIMEOUT_MS,
  bodyTimeout: 0,
  keepAliveTimeout: 60_000,
});

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

interface CacheResidencyContext {
  chatId: string;
  baseUrl: string;
  modelId: string;
  contextWindow?: number;
  bindingMode: LlamaCacheBindingMode;
}

const NOOP_TOOL_EFFECTS: ToolSideEffects = {
  onArtifact: () => {},
  onVisual: () => {},
  onAskUser: () => {},
};

const CACHE_WARM_SENTINEL_PREFIX = "__porrima_cache_warm_next_user_";

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
  body: any,
  options?: { signal?: AbortSignal }
): Promise<string> {
  const templateBody: any = {
    model: body.model,
    messages: body.messages,
  };
  if (body.chat_template_kwargs) {
    templateBody.chat_template_kwargs = body.chat_template_kwargs;
  }
  if (body.tools?.length) {
    templateBody.tools = body.tools;
  }

  const res = await undiciFetch(`${normalizeBaseUrl(baseUrl)}/apply-template`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(templateBody),
    signal: options?.signal || AbortSignal.timeout(LLAMACPP_WARM_TIMEOUT_MS),
    dispatcher: llamaWarmAgent,
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

  const res = await undiciFetch(`${normalizeBaseUrl(baseUrl)}/completion`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options?.signal || AbortSignal.timeout(LLAMACPP_WARM_TIMEOUT_MS),
    dispatcher: llamaWarmAgent,
  }) as unknown as Response;

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

async function postJson(baseUrl: string, path: string, body: any, signal?: AbortSignal): Promise<any> {
  const res = await undiciFetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: signal || AbortSignal.timeout(LLAMACPP_WARM_TIMEOUT_MS),
    dispatcher: llamaWarmAgent,
  }) as unknown as Response;

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function makeOneTokenShortPrompt(
  baseUrl: string,
  modelId: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<{ prompt: string; fullTokenCount?: number; warmTokenCount?: number; removedToken?: number }> {
  const tokenized = await postJson(baseUrl, "/tokenize", {
    model: modelId,
    content: prompt,
    add_special: false,
  }, signal);
  const tokens = Array.isArray(tokenized?.tokens) ? tokenized.tokens : [];
  if (tokens.length <= 1) {
    return { prompt, fullTokenCount: tokens.length, warmTokenCount: tokens.length };
  }

  const warmTokens = tokens.slice(0, -1);
  const detokenized = await postJson(baseUrl, "/detokenize", {
    model: modelId,
    tokens: warmTokens,
  }, signal);
  if (typeof detokenized?.content !== "string") {
    throw new Error("/detokenize returned invalid response (missing 'content')");
  }

  return {
    prompt: detokenized.content,
    fullTokenCount: tokens.length,
    warmTokenCount: warmTokens.length,
    removedToken: tokens[tokens.length - 1],
  };
}

function buildReplayMessages(
  chatMessages: any[],
  modelId: string,
  model: OllamaModel,
): ReturnType<typeof chatMessagesToPiMessages> {
  const replayIdentity = model?.provider === "llamacpp"
    ? { api: "openai-compat", provider: "llamacpp", model: modelId }
    : { api: "ollama-native", provider: "ollama", model: modelId };
  return chatMessagesToPiMessages(chatMessages, modelId, replayIdentity as ReplayModelIdentity);
}

async function buildWarmSystemPrompt(chat: Awaited<ReturnType<typeof getChat>>, messages: any[]): Promise<string> {
  if (!chat) return "You are a helpful assistant.";

  let systemPrompt = chat.systemPrompt || "You are a helpful assistant.";

  if (chat.type === "agent") {
    // Cache warming is meant to prepare the next turn's stable prefix. Freeze
    // the current memory context into the system prompt now, so the later send
    // path reuses the same prompt instead of doing a fresh retrieval that shifts
    // the entire prefix and misses the warmed slot.
    resetMemoryContext(chat.id);
    const project = chat.projectId ? await getProject(chat.projectId) : null;
    const split = await buildSplitAugmentedPrompt(
      systemPrompt,
      messages,
      chat.id,
      chat.projectId,
      chat.type,
      project?.path,
    );
    systemPrompt = split.systemPrompt;
  }

  if (chat.activeSkills?.length) {
    const skillsCache = new Map<string, Skill>();
    const allSkills = await discoverSkills(chat.projectId);
    for (const skill of allSkills) {
      skillsCache.set(skill.name, skill);
    }
    systemPrompt = buildSkillAugmentedPrompt(systemPrompt, chat.activeSkills, skillsCache);
  }

  setCachedAugmentedPrompt(chat.id, systemPrompt);
  return systemPrompt;
}

async function buildWarmTools(
  chat: Awaited<ReturnType<typeof getChat>>,
  contextWindow: number,
): Promise<ReturnType<typeof getAgentTools> | undefined> {
  if (!chat || chat.type === "quick") return undefined;
  const project = chat.projectId ? await getProject(chat.projectId) : null;
  const tools = getAgentTools(
    chat.id,
    NOOP_TOOL_EFFECTS,
    contextWindow,
    project || undefined,
    chat.type,
  );
  return tools.length > 0 ? tools : undefined;
}

function estimateRequestChars(body: any): number {
  try {
    return JSON.stringify({ messages: body.messages, tools: body.tools ?? [] }).length;
  } catch {
    return 0;
  }
}

interface TemplateRenderPlan {
  body: any;
  mode: "exact" | "next-user-prefix";
  sentinel?: string;
}

function buildTemplateRenderPlan(body: any): TemplateRenderPlan {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastRole = messages[messages.length - 1]?.role;
  if (lastRole !== "assistant") {
    return { body, mode: "exact" };
  }

  const sentinel = `${CACHE_WARM_SENTINEL_PREFIX}${randomUUID().replace(/-/g, "")}__`;
  return {
    body: {
      ...body,
      messages: [
        ...messages,
        {
          role: "user",
          content: sentinel,
        },
      ],
    },
    mode: "next-user-prefix",
    sentinel,
  };
}

function extractWarmPromptFromRenderedTemplate(renderedPrompt: string, plan: TemplateRenderPlan): string {
  if (plan.mode === "exact") return renderedPrompt;

  const sentinelIndex = renderedPrompt.indexOf(plan.sentinel!);
  if (sentinelIndex < 0) {
    throw new Error("/apply-template rendered next-user sentinel was not found");
  }

  return renderedPrompt.slice(0, sentinelIndex);
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
  let residencyContext: CacheResidencyContext | null = null;

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
    const settings = await getSettings();
    const effectiveContextWindow = getEffectiveContextWindow(chat, model, settings);

    // 3. Ensure model is loaded on the router
    const loadResult = await ensureRouterModelLoaded(baseUrl, normalizedModelId, {
      contextWindow: effectiveContextWindow,
    });
    if (loadResult === "error") {
      result.error = `Failed to load model: ${normalizedModelId}`;
      return result;
    }

    // 4. Build the same stable prompt prefix that the normal send path will use.
    const systemPrompt = await buildWarmSystemPrompt(chat, allMessages);
    const piModel = await createPiModelFromProvider(model);
    piModel.contextWindow = effectiveContextWindow;
    piModel.id = normalizedModelId;
    piModel.reasoning = modelSupportsReasoning(model);
    const piMessages = buildReplayMessages(allMessages, chat.modelId, model);
    const tools = await buildWarmTools(chat, effectiveContextWindow);
    const context = {
      systemPrompt,
      messages: piMessages,
      tools,
    };
    const { body } = await buildOpenAICompatChatBody(piModel as any, context as any);
    const promptPayloadDigest = digestPromptPayload(body);
    const requestCharCount = estimateRequestChars(body);

    // 5. Apply chat template with the exact same provider-converted body that
    // the real llama.cpp OpenAI-compatible request uses.
    const renderPlan = buildTemplateRenderPlan(body);
    console.log(
      `[cache-warm] applying template for ${normalizedModelId}, mode=${renderPlan.mode}, kwargs:`,
      body.chat_template_kwargs ?? {},
    );
    console.log(
      `[cache-warm] last message role: ${body.messages?.[body.messages.length - 1]?.role}, ` +
      `content length: ${String(body.messages?.[body.messages.length - 1]?.content).length}, ` +
      `tools=${body.tools?.length ?? 0} payload=${promptPayloadDigest}`,
    );
    const renderedPrompt = await applyChatTemplate(baseUrl, renderPlan.body, {
      signal: options.signal,
    });
    const formattedPrompt = extractWarmPromptFromRenderedTemplate(renderedPrompt, renderPlan);
    const promptDigest = digestPromptText(formattedPrompt);
    if (renderPlan.mode === "next-user-prefix") {
      console.log(
        `[cache-warm] rendered next-user prefix: rendered_chars=${renderedPrompt.length} ` +
        `warm_chars=${formattedPrompt.length}`,
      );
    }
    recordWarmPromptSnapshot({
      chatId,
      modelId: normalizedModelId,
      payloadDigest: promptPayloadDigest,
      promptDigest,
      promptChars: formattedPrompt.length,
      prompt: formattedPrompt,
      messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
      requestChars: requestCharCount,
    });
    const shortPrompt = await makeOneTokenShortPrompt(baseUrl, normalizedModelId, formattedPrompt, options.signal);
    console.log(
      `[cache-warm] one-token-short prefill: full_tokens=${shortPrompt.fullTokenCount ?? "?"} ` +
      `warm_tokens=${shortPrompt.warmTokenCount ?? "?"} removed_token=${shortPrompt.removedToken ?? "?"} ` +
      `full_chars=${formattedPrompt.length} warm_chars=${shortPrompt.prompt.length}`,
    );

    // 6. Mark residency as warming
    residencyContext = {
      chatId,
      baseUrl,
      modelId: normalizedModelId,
      contextWindow: effectiveContextWindow,
      bindingMode: "auto",
    };
    markLlamaCacheResidencyStarted(residencyContext);

    // 7. Prefill only — populates KV cache without generating
    const stats = await prefillOnly(baseUrl, normalizedModelId, shortPrompt.prompt, {
      signal: options.signal,
    });

    // 8. Calculate hit ratio
    const totalTokens = stats.tokensCached + stats.tokensEvaluated;
    const hitRatio = totalTokens > 0 ? stats.tokensCached / totalTokens : 0;

    // 9. Record residency
    recordLlamaCacheResidencyRun({
      chatId,
      baseUrl,
      modelId: normalizedModelId,
      contextWindow: effectiveContextWindow,
      bindingMode: "auto",
      timings: { prompt_n: totalTokens, prompt_ms: stats.promptMs },
      cache: {
        cachePrompt: true,
        cacheMode: "cache_prompt",
        requestDigest: promptPayloadDigest,
        requestMessageCount: Array.isArray(body.messages) ? body.messages.length : 0,
        requestCharCount,
        reportedPromptTokens: totalTokens,
        promptEvalTokens: stats.tokensEvaluated,
        inferredCachedTokens: stats.tokensCached,
        inferredCacheHitRatio: hitRatio,
      },
    });

    // 10. Return success
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
    if (residencyContext) {
      markLlamaCacheResidencyFinished(chatId);
    }
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
