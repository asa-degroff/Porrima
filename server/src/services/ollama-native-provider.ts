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
  Message,
  StopReason,
} from "@mariozechner/pi-ai";
import { transformMessages } from "@mariozechner/pi-ai/dist/providers/transform-messages.js";
import { sanitizeSurrogates } from "@mariozechner/pi-ai/dist/utils/sanitize-unicode.js";
import { randomUUID } from "crypto";
import { isLlamaCppModelLoaded } from "./openai-compat-provider.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OllamaChatChunk {
  model: string;
  message?: {
    role: string;
    content?: string;
    thinking?: string;
    tool_calls?: Array<{
      function: { name: string; arguments: Record<string, any> };
    }>;
  };
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

interface OllamaStreamOptions extends StreamOptions {
  reasoningEffort?: string;
  keepAlive?: string | number;  // e.g., "15m", "5m", 300 (seconds), -1 (forever), 0 (unload immediately)
  numGpu?: number;              // Number of layers to offload to GPU
  numPredict?: number;          // Max tokens to generate (overrides model default)
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

function convertMessages(model: Model<Api>, context: Context): any[] {
  const transformed = transformMessages(context.messages, model);
  const params: any[] = [];

  if (context.systemPrompt) {
    params.push({ role: "system", content: sanitizeSurrogates(context.systemPrompt) });
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
        // Multipart content: extract text and images separately
        const textParts: string[] = [];
        const images: string[] = [];
        for (const item of msg.content) {
          if (item.type === "text") {
            textParts.push(sanitizeSurrogates(item.text));
          } else if (item.type === "image") {
            if (model.input.includes("image")) {
              images.push(item.data);
            }
          }
        }
        const content = textParts.join("\n") || "";
        if (!content && images.length === 0) continue;
        const userMsg: any = { role: "user", content };
        if (images.length > 0) userMsg.images = images;
        params.push(userMsg);
      }
    } else if (msg.role === "assistant") {
      const assistantMsg = msg as AssistantMessage;
      const textBlocks = assistantMsg.content.filter((b) => b.type === "text");
      const toolCalls = assistantMsg.content.filter((b) => b.type === "toolCall");
      const thinkingBlocks = assistantMsg.content.filter((b) => b.type === "thinking");

      // Build content string from text blocks
      const nonEmptyText = textBlocks
        .filter((b) => b.type === "text" && b.text && b.text.trim().length > 0)
        .map((b) => (b as any).text)
        .join("");
      const content = nonEmptyText ? sanitizeSurrogates(nonEmptyText) : "";

      const ollamaMsg: any = { role: "assistant", content };

      // Include thinking text if present (for same-model history replay)
      const thinkingText = thinkingBlocks
        .filter((b) => b.type === "thinking" && (b as any).thinking?.trim())
        .map((b) => (b as any).thinking)
        .join("\n");
      if (thinkingText) {
        ollamaMsg.thinking = thinkingText;
      }

      if (toolCalls.length > 0) {
        ollamaMsg.tool_calls = toolCalls.map((tc: any) => ({
          function: {
            name: tc.name,
            arguments: tc.arguments, // Already a parsed object
          },
        }));
      }

      if (!content && toolCalls.length === 0) continue;

      params.push(ollamaMsg);
    } else if (msg.role === "toolResult") {
      const toolMsg = msg as any;
      const imageBlocks: string[] = [];

      // Collect consecutive tool results
      let j = i;
      for (; j < transformed.length && transformed[j].role === "toolResult"; j++) {
        const tr = transformed[j] as any;
        const textResult = tr.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");
        const hasImages = tr.content.some((c: any) => c.type === "image");
        const hasText = textResult.length > 0;

        params.push({
          role: "tool",
          content: sanitizeSurrogates(hasText ? textResult : "(see attached image)"),
          tool_name: tr.toolName,
        });

        if (hasImages && model.input.includes("image")) {
          for (const block of tr.content) {
            if (block.type === "image") {
              imageBlocks.push((block as any).data);
            }
          }
        }
      }
      i = j - 1;

      // If tool results contained images, inject as a follow-up user message
      if (imageBlocks.length > 0) {
        params.push({
          role: "user",
          content: "Attached image(s) from tool result:",
          images: imageBlocks,
        });
      }
    }
  }

  return params;
}

// ---------------------------------------------------------------------------
// Tool conversion
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

function mapStopReason(reason?: string): StopReason {
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
// NDJSON stream parser
// ---------------------------------------------------------------------------

async function* parseNDJSON(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<OllamaChatChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Cancel the reader on abort so the underlying body stream is closed and
  // the HTTP socket is destroyed. Without this, breaking the read loop only
  // releases the lock and Ollama keeps generating tokens until its next write
  // fails on the now-orphaned connection.
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
        if (!trimmed) continue;
        try {
          yield JSON.parse(trimmed) as OllamaChatChunk;
        } catch {
          // Skip malformed JSON lines
        }
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      try {
        yield JSON.parse(buffer.trim()) as OllamaChatChunk;
      } catch {
        // Skip malformed final chunk
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Main stream function
// ---------------------------------------------------------------------------

export const streamOllamaNative = (
  model: Model<Api>,
  context: Context,
  options?: OllamaStreamOptions
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
      const messages = convertMessages(model, context);
      const body: any = {
        model: model.id,
        messages,
        stream: true,
        options: {
          num_ctx: model.contextWindow,
        },
      };

      // Configurable keep_alive (default: "60m" — keep model loaded for responsive follow-ups.
      // Extraction and title gen use separate CPU instances, so VRAM contention is minimal.
      // ComfyUI's waitForFreeVRAM handles explicit unloading when GPU is needed.)
      if (options?.keepAlive !== undefined) {
        body.keep_alive = options.keepAlive;
      } else {
        body.keep_alive = "60m";
      }

      if (context.tools && context.tools.length > 0) {
        body.tools = convertTools(context.tools);
      }

      // Enable thinking for reasoning models
      if (model.reasoning && options?.reasoningEffort) {
        body.think = true;
      }

      // num_predict: prefer explicit option, fall back to maxTokens for backwards compat
      if (options?.numPredict !== undefined) {
        body.options.num_predict = options.numPredict;
      } else if (options?.maxTokens) {
        body.options.num_predict = options.maxTokens;
      }

      if (options?.temperature !== undefined) {
        body.options.temperature = options.temperature;
      }

      // GPU layer offloading: force CPU when llama.cpp owns the GPU,
      // otherwise respect explicit option. Skip for cloud models which
      // don't run locally.
      const isCloud = model.id.includes(":cloud");
      if (!isCloud && isLlamaCppModelLoaded()) {
        body.options.num_gpu = 0;
      } else if (options?.numGpu !== undefined) {
        body.options.num_gpu = options.numGpu;
      }

      const url = `${model.baseUrl}/api/chat`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options?.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw new Error(`Ollama API error ${response.status}: ${errorText}`);
      }

      if (!response.body) {
        throw new Error("No response body from Ollama");
      }

      stream.push({ type: "start", partial: output } as AssistantMessageEvent);

      let currentBlock: any = null;
      const blocks = output.content;
      const blockIndex = () => blocks.length - 1;

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

      for await (const chunk of parseNDJSON(response.body, options?.signal)) {
        // Final chunk with stats
        if (chunk.done) {
          const promptTokens = chunk.prompt_eval_count || 0;
          const evalTokens = chunk.eval_count || 0;
          output.usage = {
            input: promptTokens,
            output: evalTokens,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: promptTokens + evalTokens,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };
          output.stopReason = mapStopReason(chunk.done_reason);
          continue;
        }

        const msg = chunk.message;
        if (!msg) continue;

        // Handle thinking tokens
        if (msg.thinking !== undefined && msg.thinking !== null && msg.thinking.length > 0) {
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
          if (currentBlock.type === "thinking") {
            currentBlock.thinking += msg.thinking;
            stream.push({
              type: "thinking_delta",
              contentIndex: blockIndex(),
              delta: msg.thinking,
              partial: output,
            } as AssistantMessageEvent);
          }
        }

        // Handle content tokens
        if (msg.content !== undefined && msg.content !== null && msg.content.length > 0) {
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
          if (currentBlock.type === "text") {
            currentBlock.text += msg.content;
            stream.push({
              type: "text_delta",
              contentIndex: blockIndex(),
              delta: msg.content,
              partial: output,
            } as AssistantMessageEvent);
          }
        }

        // Handle tool calls
        // Ollama delivers complete tool calls (not streamed), so we emit
        // start/delta/end immediately for each one
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const tc of msg.tool_calls) {
            finishCurrentBlock(currentBlock);

            const toolCallId = `call_${randomUUID().slice(0, 8)}`;
            const argsStr = JSON.stringify(tc.function.arguments || {});

            currentBlock = {
              type: "toolCall",
              id: toolCallId,
              name: tc.function.name,
              arguments: tc.function.arguments || {},
              partialArgs: argsStr,
            };
            output.content.push(currentBlock);

            stream.push({
              type: "toolcall_start",
              contentIndex: blockIndex(),
              partial: output,
            } as AssistantMessageEvent);

            stream.push({
              type: "toolcall_delta",
              contentIndex: blockIndex(),
              delta: argsStr,
              partial: output,
            } as AssistantMessageEvent);

            // Immediately finish since args are complete
            finishCurrentBlock(currentBlock);
            currentBlock = null;
          }
        }
      }

      finishCurrentBlock(currentBlock);

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error("An unknown error occurred");
      }

      // Some Ollama models emit tool_calls but finish with done_reason="stop"
      // instead of "tool_calls". Callers rely on stopReason === "toolUse" to
      // continue the tool loop; without this promotion, tools are emitted but
      // never executed and their results never written.
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

export const streamSimpleOllamaNative = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions
) => {
  return streamOllamaNative(model, context, {
    ...options,
    reasoningEffort: options?.reasoning,
  });
};

// ---------------------------------------------------------------------------
// Provider registration
// ---------------------------------------------------------------------------

export function registerOllamaNativeProvider() {
  registerApiProvider({
    api: "ollama-native",
    stream: streamOllamaNative,
    streamSimple: streamSimpleOllamaNative,
  });
}
