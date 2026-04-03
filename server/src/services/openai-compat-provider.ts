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

function convertMessages(model: Model<Api>, context: Context): any[] {
  const transformed = transformMessages(context.messages, model);
  const params: any[] = [];

  if (context.systemPrompt) {
    params.push({ role: "system", content: sanitizeSurrogates(context.systemPrompt) });
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
              parts.push({
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${item.data}` },
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

      const nonEmptyText = textBlocks
        .filter((b: any) => b.type === "text" && b.text && b.text.trim().length > 0)
        .map((b: any) => b.text)
        .join("");
      const content = nonEmptyText ? sanitizeSurrogates(nonEmptyText) : null;

      const openaiMsg: any = { role: "assistant" };
      if (content) openaiMsg.content = content;

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
              imageParts.push({
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${(block as any).data}` },
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
      const messages = convertMessages(model, context);
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

      const url = `${model.baseUrl}/v1/chat/completions`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options?.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw new Error(`llama.cpp API error ${response.status}: ${errorText}`);
      }

      if (!response.body) {
        throw new Error("No response body from llama.cpp");
      }

      stream.push({ type: "start", partial: output } as AssistantMessageEvent);

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
          currentBlock.text += delta.content;
          stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: delta.content,
            partial: output,
          } as AssistantMessageEvent);
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
