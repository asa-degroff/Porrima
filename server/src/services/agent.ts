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
import { createPiModel, discoverOllamaModels } from "./models.js";
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

/** Convert our ChatMessage[] to pi-ai Message[] for the initial context */
export function chatMessagesToPiMessages(
  messages: ChatMessage[],
  modelId: string
): Message[] {
  const result: Message[] = [];

  for (const m of messages) {
    if (m.role === "assistant") {
      const dummyUsage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };

      if (m.toolCalls?.length) {
        // Reconstruct tool-calling turn: assistant with tool calls only
        const toolContent: any[] = [];
        if (m.thinking) {
          toolContent.push({ type: "thinking", thinking: m.thinking });
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
          api: "openai-completions" as const,
          provider: "ollama",
          model: modelId,
          usage: dummyUsage,
          stopReason: "toolUse" as StopReason,
          timestamp: m.timestamp,
        } as AssistantMessage);

        // Tool results follow the tool-calling assistant message
        if (m.toolResults) {
          for (const tr of m.toolResults) {
            result.push({
              role: "toolResult" as const,
              toolCallId: tr.toolCallId,
              toolName: tr.toolName,
              content: [{ type: "text" as const, text: tr.content }],
              isError: tr.isError,
              timestamp: m.timestamp,
            } as ToolResultMessage);
          }
        }

        // Then the final text response as a separate assistant message
        if (m.content) {
          result.push({
            role: "assistant" as const,
            content: [{ type: "text", text: m.content }],
            api: "openai-completions" as const,
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
        if (m.thinking) {
          content.push({ type: "thinking", thinking: m.thinking });
        }
        if (m.content) {
          content.push({ type: "text", text: m.content });
        }
        result.push({
          role: "assistant" as const,
          content,
          api: "openai-completions" as const,
          provider: "ollama",
          model: modelId,
          usage: dummyUsage,
          stopReason: "stop" as StopReason,
          timestamp: m.timestamp,
        } as AssistantMessage);
      }
    } else {
      if (m.images?.length) {
        const content: any[] = [];
        if (m.content) content.push({ type: "text", text: m.content });
        for (const img of m.images) {
          content.push({ type: "image", data: img.data, mimeType: img.mimeType });
        }
        result.push({ role: "user" as const, content, timestamp: m.timestamp });
      } else {
        result.push({
          role: "user" as const,
          content: m.content,
          timestamp: m.timestamp,
        });
      }
    }
  }

  return result;
}

export async function streamChat(
  modelId: string,
  messages: Message[],
  systemPrompt: string,
  onEvent: (event: AssistantMessageEvent) => void,
  options?: { signal?: AbortSignal; tools?: Tool[] }
): Promise<StreamChatResult> {
  const ollamaModels = await discoverOllamaModels();
  const ollamaModel = ollamaModels.find((m) => m.id === modelId);
  if (!ollamaModel) throw new Error(`Model not found: ${modelId}`);

  const piModel = createPiModel(ollamaModel);

  const context: Context = {
    systemPrompt,
    messages,
    tools: options?.tools,
  };

  const eventStream = streamSimple(piModel, context, {
    apiKey: "ollama",
    signal: options?.signal,
    reasoning: piModel.reasoning ? "medium" : undefined,
  });

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

  // Ensure we have an assistant message even on empty responses
  if (!assistantMessage) {
    assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: fullText }],
      api: "openai-completions",
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
