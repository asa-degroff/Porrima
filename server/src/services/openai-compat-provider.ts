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
import { randomUUID } from "crypto";
import { fetch as undiciFetch, Agent as UndiciAgent } from "undici";
import sharp from "sharp";

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
const llamaStreamAgent = new UndiciAgent({
  headersTimeout: 1_800_000,  // 30 minutes — matches LOCAL_INACTIVITY_TIMEOUT_MS
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
        .filter((b: any) => b.type === "text" && b.text && b.text.trim().length > 0)
        .map((b: any) => b.text)
        .join("");
      const content = nonEmptyText ? sanitizeSurrogates(nonEmptyText) : null;

      // Include reasoning_content for proper context replay (DeepSeek API convention)
      const thinkingText = thinkingBlocks
        .filter((b: any) => b.type === "thinking" && (b as any).thinking?.trim())
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

      if (!content && !thinkingText && toolCalls.length === 0) continue;
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

      // Inject images as a follow-up user message (same pattern as Ollama provider)
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

/** Clear the cached model state (e.g., after GPU coordination unloads slots). */
export function invalidateLoadedModel() {
  lastLoadedModel = null;
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
 * Query llama.cpp to find which model is actually loaded right now.
 * Returns the model ID if exactly one model is in "loaded" state, or null.
 */
async function getActualLoadedModel(baseUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    const loaded = data.data?.filter((m: any) => m.status?.value === "loaded");
    if (loaded?.length === 1) return loaded[0].id;
    return null;
  } catch {
    return null;
  }
}

/**
 * Ensure the target model is loaded on the llama.cpp server with the right context window.
 * In router mode, calls POST /models/load which blocks until the model is ready.
 * If the context window changed, the model is reloaded with the new size.
 * In single-model mode, the endpoint doesn't exist — we catch and ignore 404s.
 */
export async function ensureModelLoaded(baseUrl: string, modelId: string, contextWindow?: number): Promise<void> {
  // Skip if we already loaded this model — context window is set on first load only.
  // We don't reload for context window changes because:
  // 1. Background callers (extraction, title gen) may request a different ctx than the active chat
  // 2. Reloading mid-turn kills active connections and disrupts the agent loop
  // 3. The application layer (compaction, token counting) handles context limits
  if (lastLoadedModel?.baseUrl === baseUrl && lastLoadedModel?.modelId === modelId) {
    return;
  }

  try {
    // Unload the previous model first to free VRAM
    const previousModelId = lastLoadedModel?.modelId;
    const needsUnload = lastLoadedModel?.baseUrl === baseUrl && previousModelId !== modelId;
    const needsReload = lastLoadedModel?.baseUrl === baseUrl && previousModelId === modelId;

    // Invalidate cache before any model change so failures don't leave stale state
    if (needsUnload) {
      lastLoadedModel = null;
    }

    if (needsUnload || needsReload) {
      try {
        const unloadModelId = needsUnload ? previousModelId! : modelId;
        const unloadRes = await fetch(`${baseUrl}/models/unload`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: unloadModelId }),
          signal: AbortSignal.timeout(30_000),
        });
        if (unloadRes.ok) {
          console.log(`[openai-compat] Unloaded model: ${unloadModelId}`);
          await waitForModelUnloaded(baseUrl, unloadModelId);
        } else {
          console.warn(`[openai-compat] Unload returned ${unloadRes.status} for ${unloadModelId}`);
        }
      } catch (err) {
        console.warn(`[openai-compat] Unload failed:`, err instanceof Error ? err.message : err);
      }
    }

    // Free Ollama GPU VRAM before loading — Ollama models sitting in VRAM
    // can prevent llama.cpp from offloading layers to GPU, causing CPU fallback.
    try {
      const { getSettings } = await import("./chat-storage.js");
      const { getOllamaUrl } = await import("./ollama-url.js");
      const ollamaBase = getOllamaUrl(await getSettings());
      const psRes = await fetch(`${ollamaBase}/api/ps`, { signal: AbortSignal.timeout(3000) });
      if (psRes.ok) {
        const psData = await psRes.json();
        const loadedModels: string[] = (psData.models || []).map((m: any) => m.name || m.model).filter(Boolean);
        for (const ollamaModel of loadedModels) {
          await fetch(`${ollamaBase}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: ollamaModel, prompt: "", keep_alive: "0s" }),
            signal: AbortSignal.timeout(10_000),
          }).catch(() => {});
        }
        if (loadedModels.length > 0) {
          console.log(`[openai-compat] Freed Ollama VRAM: unloaded ${loadedModels.join(", ")}`);
          await new Promise((r) => setTimeout(r, 2000)); // Wait for VRAM release
        }
      }
    } catch { /* non-critical */ }

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
        const actualModel = await getActualLoadedModel(baseUrl);
        if (actualModel && actualModel !== modelId) {
          // A different model is running — unload it and retry
          console.log(`[openai-compat] Expected ${modelId} but ${actualModel} is running, forcing switch`);
          try {
            await fetch(`${baseUrl}/models/unload`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: actualModel }),
              signal: AbortSignal.timeout(30_000),
            });
            await waitForModelUnloaded(baseUrl, actualModel);
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

        // The requested model IS what's running — handle context window mismatch
        const knownCtx = lastLoadedModel?.contextWindow;
        if (contextWindow && (!knownCtx || knownCtx < contextWindow)) {
          console.log(`[openai-compat] Model already running (ctx=${knownCtx ?? "unknown"}) but need ctx=${contextWindow}, reloading`);
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
        }
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

      if (model.reasoning) {
        body.chat_template_kwargs = { enable_thinking: true };
      }

      const url = `${model.baseUrl}/v1/chat/completions`;

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
        invalidateLoadedModel();
        throw lastFetchError;
      }

      if (!response || !response.ok) {
        const errorText = response ? await response.text().catch(() => "Unknown error") : "No response";
        // Invalidate loaded model cache on server errors — the child process may have
        // crashed (common with vision models on ROCm) and needs to be reloaded.
        if (response && (response.status === 500 || response.status === 502 || response.status === 503)) {
          console.warn(`[openai-compat] Server error ${response.status}, invalidating model cache`);
          invalidateLoadedModel();
        }
        throw new Error(`llama.cpp API error ${response?.status ?? "?"}: ${errorText}`);
      }

      if (!response.body) {
        throw new Error("No response body from llama.cpp");
      }

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

      for await (const chunk of parseSSE(response.body, options?.signal)) {
        // Extract usage from final chunk
        if (chunk.usage) {
          output.usage = {
            input: chunk.usage.prompt_tokens || 0,
            output: chunk.usage.completion_tokens || 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: chunk.usage.total_tokens || 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        if (choice.finish_reason) {
          stopReason = mapStopReason(choice.finish_reason);
        }

        const delta = choice.delta;
        if (!delta) continue;

        // Handle reasoning/thinking tokens
        if (delta.reasoning_content) {
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
        if (delta.content) {
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
