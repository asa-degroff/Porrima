import { Router } from "express";
import { getChat, saveChat } from "../services/storage.js";
import { streamChat } from "../services/agent.js";
import { extractMemories, preCompactionFlush } from "../services/memory-extraction.js";
import { discoverOllamaModels } from "../services/models.js";
import { buildMemoryAugmentedPrompt } from "../services/memory-context.js";
import {
  parseToolCalls,
  executeMemoryTool,
  stripToolBlocks,
} from "../services/memory-tools.js";
import type { ChatMessage } from "../types.js";

const router = Router();

// Send message and stream response via SSE
router.post("/", async (req, res) => {
  const { chatId, message } = req.body as {
    chatId: string;
    message: string;
  };

  if (!chatId || !message) {
    return res.status(400).json({ error: "chatId and message are required" });
  }

  const chat = await getChat(chatId);
  if (!chat) return res.status(404).json({ error: "Chat not found" });

  // Add user message
  const userMsg: ChatMessage = {
    role: "user",
    content: message,
    timestamp: Date.now(),
  };
  chat.messages.push(userMsg);

  // Auto-generate title from first message
  if (chat.messages.length === 1) {
    chat.title = message.slice(0, 50) + (message.length > 50 ? "..." : "");
  }

  await saveChat(chat);

  // Set up SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const abortController = new AbortController();
  req.on("close", () => abortController.abort());

  try {
    // Augment system prompt with memories for agent chats
    let systemPrompt = chat.systemPrompt || "You are a helpful assistant.";
    if (chat.type === "agent") {
      systemPrompt = await buildMemoryAugmentedPrompt(
        systemPrompt,
        chat.messages
      );
    }

    let assistantMsg = await streamChat(
      chat.modelId,
      chat.messages,
      systemPrompt,
      (event) => {
        if (event.type === "text_delta") {
          res.write(
            `event: text_delta\ndata: ${JSON.stringify({ delta: event.delta })}\n\n`
          );
        } else if (event.type === "thinking_delta") {
          res.write(
            `event: thinking_delta\ndata: ${JSON.stringify({ delta: event.delta })}\n\n`
          );
        }
      },
      abortController.signal
    );

    // Check for tool calls in agent chats
    if (chat.type === "agent") {
      const toolCalls = parseToolCalls(assistantMsg.content);
      if (toolCalls.length > 0) {
        // Execute all tools
        for (const tool of toolCalls) {
          console.log(`[memory-tool] Executing ${tool.name}:`, tool.args);
          const result = await executeMemoryTool(tool, chat.id);

          // Send tool result event to client
          res.write(
            `event: tool_result\ndata: ${JSON.stringify({ name: result.name, success: result.success, result: result.result })}\n\n`
          );

          // Add tool interaction to chat context for follow-up
          chat.messages.push({
            role: "assistant",
            content: assistantMsg.content,
            thinking: assistantMsg.thinking,
            timestamp: Date.now(),
          });
          chat.messages.push({
            role: "user",
            content: `[Tool result for ${result.name}]: ${result.result}`,
            timestamp: Date.now(),
          });
        }

        // Stream a follow-up response incorporating tool results
        const followUp = await streamChat(
          chat.modelId,
          chat.messages,
          systemPrompt,
          (event) => {
            if (event.type === "text_delta") {
              res.write(
                `event: text_delta\ndata: ${JSON.stringify({ delta: event.delta })}\n\n`
              );
            }
          },
          abortController.signal
        );

        // Remove the temporary tool context messages
        chat.messages.splice(chat.messages.length - 2, 2);

        // Save the cleaned-up assistant message (tool blocks stripped + follow-up appended)
        const cleanedContent = stripToolBlocks(assistantMsg.content);
        assistantMsg = {
          ...followUp,
          content: cleanedContent
            ? `${cleanedContent}\n\n${followUp.content}`
            : followUp.content,
          thinking: assistantMsg.thinking,
        };
      }
    }

    // Save the assistant message
    chat.messages.push(assistantMsg);
    await saveChat(chat);

    res.write(
      `event: done\ndata: ${JSON.stringify({ message: assistantMsg })}\n\n`
    );

    // Fire-and-forget memory extraction for agent chats
    if (chat.type === "agent") {
      extractMemories(chat.modelId, chat.id, message, assistantMsg.content)
        .catch((err) => console.error("[memory] extraction failed:", err));

      // Check for pre-compaction flush if usage is high
      if (assistantMsg.usage) {
        try {
          const models = await discoverOllamaModels();
          const model = models.find((m) => m.id === chat.modelId);
          if (model) {
            const usageRatio = assistantMsg.usage.totalTokens / model.contextWindow;
            if (usageRatio > 0.75) {
              preCompactionFlush(chat.modelId, chat.id, chat.messages)
                .catch((err) => console.error("[memory] pre-compaction flush failed:", err));
            }
          }
        } catch {}
      }
    }
  } catch (e: any) {
    if (e.name !== "AbortError") {
      res.write(
        `event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`
      );
    }
  } finally {
    res.end();
  }
});

export default router;
