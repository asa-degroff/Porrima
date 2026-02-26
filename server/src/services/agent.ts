import { stream, type Context, type AssistantMessageEvent } from "@mariozechner/pi-ai";
import { createPiModel, discoverOllamaModels } from "./models.js";
import type { ChatMessage } from "../types.js";

export async function streamChat(
  modelId: string,
  messages: ChatMessage[],
  onEvent: (event: AssistantMessageEvent) => void,
  signal?: AbortSignal
): Promise<ChatMessage> {
  // Find the model
  const ollamaModels = await discoverOllamaModels();
  const ollamaModel = ollamaModels.find((m) => m.id === modelId);
  if (!ollamaModel) throw new Error(`Model not found: ${modelId}`);

  const piModel = createPiModel(ollamaModel);

  // Build context from chat messages
  const context: Context = {
    systemPrompt: "You are a helpful assistant.",
    messages: messages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
      timestamp: m.timestamp,
      // Assistant messages need extra fields for pi-ai type compatibility
      ...(m.role === "assistant"
        ? {
            content: [{ type: "text" as const, text: m.content }],
            api: "openai-completions" as const,
            provider: "ollama",
            model: modelId,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop" as const,
          }
        : {}),
    })),
  };

  const eventStream = stream(piModel, context, { apiKey: "ollama", signal });

  let fullText = "";

  for await (const event of eventStream) {
    onEvent(event);
    if (event.type === "text_delta") {
      fullText += event.delta;
    }
  }

  return {
    role: "assistant",
    content: fullText,
    timestamp: Date.now(),
  };
}
