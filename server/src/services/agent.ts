import {
  streamSimple,
  type Context,
  type AssistantMessageEvent,
  type AssistantMessage,
  type Message,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
  type StopReason,
} from "@mariozechner/pi-ai";
import { createPiModelFromProvider, discoverAllModels, getExtractionRoute } from "./models.js";
import { normalizeRouterModelId } from "./llama-router-client.js";
import type { Model } from "@mariozechner/pi-ai";
import type { ChatMessage, MessageUsage } from "../types.js";

export interface StreamChatResult {
  role: "assistant";
  content: string;
  thinking?: string;
  usage?: MessageUsage;
  timestamp: number;
  toolCalls?: ToolCall[];
  stopReason: StopReason;
  /** Raw pi-ai AssistantMessage for appending to context in tool loops */
  assistantMessage: AssistantMessage;
}

function isPlaceholderEllipsis(text: string | undefined): boolean {
  if (!text) return false;
  const normalized = text.replace(/\s/g, "").replace(/…/g, "...");
  return normalized.length > 0 && /^(\.{3})+$/.test(normalized);
}

function stripPlaceholderEllipsisBlocks(text: string): string {
  return text
    .split(/\n{2,}/)
    .filter((block) => !isPlaceholderEllipsis(block))
    .join("\n\n");
}

function visibleAssistantContent(message: ChatMessage): string {
  const textSegments = message.segments?.filter((segment) =>
    segment.type === "text" && segment.content && !isPlaceholderEllipsis(segment.content)
  );
  if (textSegments?.length) {
    return textSegments.map((segment) => segment.content).join("");
  }
  return stripPlaceholderEllipsisBlocks(message.content || "");
}

export function mergeSystemContextWithUserContent(
  systemContext: string | string[] | undefined,
  userContent: string
): string {
  const systemParts = Array.isArray(systemContext) ? systemContext : systemContext ? [systemContext] : [];
  const parts = [...systemParts, userContent].filter((part) => part && part.trim().length > 0);
  return parts.join("\n\n");
}

/** Convert our ChatMessage[] to pi-ai Message[] for the initial context */
export function chatMessagesToPiMessages(
  messages: ChatMessage[],
  modelId: string
): Message[] {
  const result: Message[] = [];
  const pendingSystemContexts: string[] = [];
  let pendingSystemTimestamp: number | undefined;

  const takePendingSystemContext = () => {
    const content = pendingSystemContexts.splice(0);
    const timestamp = pendingSystemTimestamp;
    pendingSystemTimestamp = undefined;
    return { content, timestamp };
  };

  const flushPendingSystemContext = (fallbackTimestamp?: number) => {
    if (pendingSystemContexts.length === 0) return;
    const pending = takePendingSystemContext();
    const content = mergeSystemContextWithUserContent(pending.content, "");
    if (!content) return;
    result.push({
      role: "user" as const,
      content,
      timestamp: pending.timestamp ?? fallbackTimestamp ?? Date.now(),
    });
  };

  for (const m of messages) {
    // Skip out-of-context messages (preserved for UI, not for LLM)
    if (m._outOfContext) continue;

    if (m.role === "system") {
      // Persisted memory-delta messages live in chat history with role "system"
      // so the UI can hide them. Model replay merges them into the following
      // user turn instead of emitting a mid-transcript system role, which Qwen
      // llama.cpp templates reject and which would otherwise differ from the
      // live turn's KV-cacheable prompt shape.
      if (m.content?.trim()) {
        pendingSystemContexts.push(m.content);
        pendingSystemTimestamp = m.timestamp;
      }
      continue;
    }

    if (m.role === "assistant") {
      flushPendingSystemContext(m.timestamp);

      const dummyUsage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };

      const visibleContent = visibleAssistantContent(m);
      const visibleThinking = isPlaceholderEllipsis(m.thinking) ? "" : (m.thinking || "");

      if (m.toolCalls?.length) {
        const isCanonicalToolFragment = m._toolLoopFragment === true;
        // Canonical split rows mirror the live tool loop: any text emitted
        // before a tool call belongs in the same assistant message as the call.
        // Legacy collapsed rows kept final answer text on the same ChatMessage,
        // so those still expand to assistant(tool calls) -> tool results ->
        // assistant(final text).
        const toolContent: any[] = [];
        if (visibleThinking) {
          toolContent.push({ type: "thinking", thinking: visibleThinking });
        }
        if (isCanonicalToolFragment && visibleContent) {
          toolContent.push({ type: "text", text: visibleContent });
        }
        for (const tc of m.toolCalls) {
          toolContent.push({
            type: "toolCall",
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          });
        }
        result.push({
          role: "assistant" as const,
          content: toolContent,
          api: "ollama-native" as const,
          provider: "ollama",
          model: modelId,
          usage: dummyUsage,
          stopReason: "toolUse" as StopReason,
          timestamp: m.timestamp,
        } as AssistantMessage);

        // Tool results follow the tool-calling assistant message
        if (m.toolResults) {
          for (const tr of m.toolResults) {
            // For tool results, the content should be the text + images array
            // This matches how pi-ai expects ToolResultMessage content
            // Safety truncation: cap tool result text to prevent oversized results
            // from persisted messages blowing up the context on replay.
            const MAX_TOOL_RESULT_CHARS = 60_000;
            let trText = tr.content || "";
            if (trText.length > MAX_TOOL_RESULT_CHARS) {
              trText = trText.slice(0, MAX_TOOL_RESULT_CHARS) + `\n[Truncated from ${(trText.length / 1024).toFixed(0)}KB]`;
            }
            const content: any[] = [{ type: "text" as const, text: trText }];
            // Attach images if present (for generate_and_review tool)
            if (tr.images?.length) {
              console.log(`[agent] Attaching ${tr.images.length} image(s) to tool result ${tr.toolCallId} (${tr.toolName})`);
              console.log(`[agent] Image sizes: ${tr.images.map(img => `${(img.data.length / 1024).toFixed(1)}KB ${img.mimeType}`).join(", ")}`);
              for (const img of tr.images) {
                content.push({ type: "image" as const, data: img.data, mimeType: img.mimeType });
              }
            }
            console.log(`[agent] ToolResultMessage created with ${content.length} content items (${content.filter(c => c.type === "image").length} images)`);
            result.push({
              role: "toolResult" as const,
              toolCallId: tr.toolCallId,
              toolName: tr.toolName,
              content,
              isError: tr.isError,
              timestamp: m.timestamp,
            } as ToolResultMessage);
          }
        }

        // Then the final text response as a separate assistant message for
        // legacy collapsed rows only.
        if (!isCanonicalToolFragment && visibleContent) {
          result.push({
            role: "assistant" as const,
            content: [{ type: "text", text: visibleContent }],
            api: "ollama-native" as const,
            provider: "ollama",
            model: modelId,
            usage: dummyUsage,
            stopReason: "stop" as StopReason,
            timestamp: m.timestamp,
          } as AssistantMessage);
        }
      } else {
        // No tool calls — simple text response
        const content: any[] = [];
        if (visibleThinking) {
          content.push({ type: "thinking", thinking: visibleThinking });
        }
        if (visibleContent) {
          content.push({ type: "text", text: visibleContent });
        }
        result.push({
          role: "assistant" as const,
          content,
          api: "ollama-native" as const,
          provider: "ollama",
          model: modelId,
          usage: dummyUsage,
          stopReason: "stop" as StopReason,
          timestamp: m.timestamp,
        } as AssistantMessage);
      }
    } else {
      const pending = pendingSystemContexts.length > 0
        ? takePendingSystemContext()
        : { content: [], timestamp: undefined };
      const contentWithSystemContext = mergeSystemContextWithUserContent(
        pending.content,
        m.content
      );

      if (m.images?.length) {
        const content: any[] = [];
        if (contentWithSystemContext) content.push({ type: "text", text: contentWithSystemContext });
        for (const img of m.images) {
          content.push({ type: "image", data: img.data, mimeType: img.mimeType });
        }
        result.push({ role: "user" as const, content, timestamp: m.timestamp });
      } else {
        result.push({
          role: "user" as const,
          content: contentWithSystemContext,
          timestamp: m.timestamp,
        });
      }
    }
  }

  flushPendingSystemContext();

  return result;
}

export async function streamChat(
  modelId: string,
  messages: Message[],
  systemPrompt: string,
  onEvent: (event: AssistantMessageEvent) => void,
  options?: { signal?: AbortSignal; tools?: Tool[]; keepAlive?: string | number; numGpu?: number; numPredict?: number }
): Promise<StreamChatResult> {
  // Extraction routing: if the requested model matches the configured extraction
  // model and an extraction URL is set, route directly to that server (typically
  // CPU-only) instead of hitting the chat router and contending with the GPU
  // chat model. Background jobs (notebooks, corpus enrichment, zeitgeist, etc.)
  // pass extractionModelId here and benefit automatically.
  let piModel: Model<string>;
  const extractionRoute = await getExtractionRoute();
  const normalizedModelId = normalizeRouterModelId(modelId);
  if (extractionRoute && extractionRoute.modelId === normalizedModelId) {
    piModel = {
      id: extractionRoute.modelId,
      name: extractionRoute.modelId,
      api: "openai-compat",
      provider: "llamacpp",
      baseUrl: extractionRoute.baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: extractionRoute.ctxSize,
      maxTokens: 2048,
    };
  } else {
    const allModels = await discoverAllModels();
    const model = allModels.find((m) => m.id === modelId) ??
      (normalizedModelId !== modelId ? allModels.find((m) => m.id === normalizedModelId) : undefined);
    if (!model) throw new Error(`Model not found: ${modelId}`);
    piModel = await createPiModelFromProvider(model);
  }

  const context: Context = {
    systemPrompt,
    messages,
    tools: options?.tools,
  };

  // Pass Ollama-specific options (they're extensions to SimpleStreamOptions)
  const streamOptions: any = {
    apiKey: "ollama",
    signal: options?.signal,
    reasoning: piModel.reasoning ? "medium" : undefined,
  };
  if (options?.keepAlive !== undefined) streamOptions.keepAlive = options.keepAlive;
  if (options?.numGpu !== undefined) streamOptions.numGpu = options.numGpu;
  if (options?.numPredict !== undefined) streamOptions.numPredict = options.numPredict;

  const eventStream = streamSimple(piModel, context, streamOptions);

  let fullText = "";
  let thinkingText = "";
  let usage: MessageUsage | undefined;
  let toolCalls: ToolCall[] = [];
  let stopReason: StopReason = "stop";
  let assistantMessage: AssistantMessage | undefined;

  for await (const event of eventStream) {
    onEvent(event);
    if (event.type === "text_delta") {
      fullText += event.delta;
    } else if (event.type === "thinking_delta") {
      thinkingText += event.delta;
    } else if (event.type === "toolcall_end") {
      toolCalls.push(event.toolCall);
    } else if (event.type === "done") {
      const u = event.message.usage;
      usage = {
        input: u.input,
        output: u.output,
        totalTokens: u.totalTokens,
      };
      stopReason = event.reason;
      assistantMessage = event.message;
    } else if (event.type === "error") {
      stopReason = event.reason;
      assistantMessage = event.error;
    }
  }

  // Surface provider errors to the caller. Without this, an error event gets
  // silently recorded on the result and the caller can't distinguish a failed
  // stream from a genuinely empty generation (which caused synthesis to write
  // a bogus "LLM summary was empty" fallback when the model errored mid-stream).
  if (stopReason === "error") {
    const errMessage =
      (assistantMessage as any)?.errorMessage ||
      "Provider stream ended with error";
    throw new Error(`[streamChat] ${modelId}: ${errMessage}`);
  }

  // Ensure we have an assistant message even on empty responses
  if (!assistantMessage) {
    assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: fullText }],
      api: "ollama-native",
      provider: "ollama",
      model: modelId,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason,
      timestamp: Date.now(),
    };
  }

  return {
    role: "assistant",
    content: fullText,
    thinking: thinkingText || undefined,
    usage,
    timestamp: Date.now(),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    stopReason,
    assistantMessage,
  };
}
