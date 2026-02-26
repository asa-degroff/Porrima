import { streamSimple, type Context, type AssistantMessageEvent } from "@mariozechner/pi-ai";
import { createPiModel, discoverOllamaModels } from "./models.js";
import type { ChatMessage, MessageUsage } from "../types.js";

export interface StreamChatResult extends ChatMessage {
  thinking?: string;
  usage?: MessageUsage;
}

export async function streamChat(
  modelId: string,
  messages: ChatMessage[],
  systemPrompt: string,
  onEvent: (event: AssistantMessageEvent) => void,
  signal?: AbortSignal
): Promise<StreamChatResult> {
  const ollamaModels = await discoverOllamaModels();
  const ollamaModel = ollamaModels.find((m) => m.id === modelId);
  if (!ollamaModel) throw new Error(`Model not found: ${modelId}`);

  const piModel = createPiModel(ollamaModel);

  // Build context from chat messages
  const context: Context = {
    systemPrompt,
    messages: messages.map((m) => {
      if (m.role === "assistant") {
        // Reconstruct pi-ai AssistantMessage structure
        const content: any[] = [];
        if (m.thinking) {
          content.push({ type: "thinking", thinking: m.thinking });
        }
        content.push({ type: "text", text: m.content });
        return {
          role: "assistant" as const,
          content,
          api: "openai-completions" as const,
          provider: "ollama",
          model: modelId,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop" as const,
          timestamp: m.timestamp,
        };
      }
      return {
        role: "user" as const,
        content: m.content,
        timestamp: m.timestamp,
      };
    }),
  };

  const eventStream = streamSimple(piModel, context, {
    apiKey: "ollama",
    signal,
    reasoning: piModel.reasoning ? "medium" : undefined,
  });

  let fullText = "";
  let thinkingText = "";
  let usage: MessageUsage | undefined;

  for await (const event of eventStream) {
    onEvent(event);
    if (event.type === "text_delta") {
      fullText += event.delta;
    } else if (event.type === "thinking_delta") {
      thinkingText += event.delta;
    } else if (event.type === "done") {
      const u = event.message.usage;
      usage = {
        input: u.input,
        output: u.output,
        totalTokens: u.totalTokens,
      };
    }
  }

  return {
    role: "assistant",
    content: fullText,
    thinking: thinkingText || undefined,
    usage,
    timestamp: Date.now(),
  };
}
