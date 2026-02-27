import { Router } from "express";
import type { Message, ToolResultMessage, ToolCall } from "@mariozechner/pi-ai";
import { getChat, saveChat } from "../services/storage.js";
import { streamChat, chatMessagesToPiMessages } from "../services/agent.js";
import { extractMemories, preCompactionFlush } from "../services/memory-extraction.js";
import { discoverOllamaModels } from "../services/models.js";
import { buildMemoryAugmentedPrompt } from "../services/memory-context.js";
import { getAgentTools, executeTool } from "../services/agent-tools.js";
import {
  loadPendingState,
  savePendingState,
  hasPendingState,
} from "../services/agent-state.js";
import type { ChatMessage, ChatToolCall, ChatToolResult } from "../types.js";

const router = Router();

const MAX_TOOL_ITERATIONS = 20;

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
    // Check for pending agent state (ask_user resume flow)
    const pendingState = await loadPendingState(chatId);

    let piMessages: Message[];
    let systemPrompt: string;
    let tools: ReturnType<typeof getAgentTools> | undefined;

    // Collect all tool calls and results across iterations for persistence
    const allToolCalls: ChatToolCall[] = [];
    const allToolResults: ChatToolResult[] = [];

    if (pendingState) {
      // RESUME: the user's message is the answer to ask_user
      // Inject it as a ToolResultMessage for the pending ask_user call
      piMessages = pendingState.piMessages;
      systemPrompt = pendingState.systemPrompt;
      tools = chat.type === "agent" ? getAgentTools() : undefined;

      const toolResultMsg: ToolResultMessage = {
        role: "toolResult",
        toolCallId: pendingState.askToolCallId,
        toolName: "ask_user",
        content: [{ type: "text", text: message }],
        isError: false,
        timestamp: Date.now(),
      };
      piMessages.push(toolResultMsg);

      // Don't add user message to chat history — it's captured as tool result
      // But we do want to show it in the UI, so add it as a user message
      chat.messages.push({
        role: "user",
        content: message,
        timestamp: Date.now(),
      });
      await saveChat(chat);
    } else {
      // NORMAL: add user message and build fresh context
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

      // Augment system prompt with memories for agent chats
      systemPrompt = chat.systemPrompt || "You are a helpful assistant.";
      if (chat.type === "agent") {
        systemPrompt = await buildMemoryAugmentedPrompt(
          systemPrompt,
          chat.messages
        );
      }

      tools = chat.type === "agent" ? getAgentTools() : undefined;
      piMessages = chatMessagesToPiMessages(chat.messages, chat.modelId);
    }

    console.log(`[chat] type=${chat.type} tools=${tools ? tools.map(t => t.name).join(",") : "none"}`);


    let finalContent = "";
    let finalThinking: string | undefined;
    let finalUsage: ChatMessage["usage"];
    let iterations = 0;
    let waitingForInput = false;

    // Agent tool loop
    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;

      const result = await streamChat(
        chat.modelId,
        piMessages,
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
          } else if (event.type === "toolcall_start") {
            const partial = event.partial.content[event.contentIndex] as ToolCall | undefined;
            if (partial) {
              res.write(
                `event: tool_status\ndata: ${JSON.stringify({ name: partial.name || "...", status: "running" })}\n\n`
              );
            }
          }
        },
        { signal: abortController.signal, tools }
      );

      // Accumulate content
      if (result.content) {
        finalContent += (finalContent ? "\n\n" : "") + result.content;
      }
      if (!finalThinking && result.thinking) {
        finalThinking = result.thinking;
      }
      finalUsage = result.usage;

      // If no tool use, we're done
      if (result.stopReason !== "toolUse" || !result.toolCalls?.length) {
        break;
      }

      // Append assistant message to pi-ai context
      piMessages.push(result.assistantMessage);

      // Check for ask_user tool FIRST (it's special)
      const askUserCall = result.toolCalls.find((tc) => tc.name === "ask_user");
      if (askUserCall) {
        const question = askUserCall.arguments.question || "What would you like me to do?";

        // Send ask_user event to client
        res.write(
          `event: ask_user\ndata: ${JSON.stringify({ question })}\n\n`
        );

        // Save pending state for resume
        await savePendingState(chatId, {
          piMessages,
          systemPrompt,
          askToolCallId: askUserCall.id,
        });

        // Track for persistence
        allToolCalls.push({
          id: askUserCall.id,
          name: askUserCall.name,
          arguments: askUserCall.arguments,
        });

        waitingForInput = true;
        break;
      }

      // Execute each tool call
      for (const toolCall of result.toolCalls) {
        console.log(`[tool] Executing ${toolCall.name}:`, toolCall.arguments);

        const toolResult = await executeTool(toolCall, chat.id, (event) => {
          if (event.type === "artifact") {
            res.write(
              `event: artifact\ndata: ${JSON.stringify(event.data)}\n\n`
            );
          }
        });

        // Send tool status to client
        res.write(
          `event: tool_status\ndata: ${JSON.stringify({
            name: toolCall.name,
            status: toolResult.isError ? "error" : "done",
            result: toolResult.content,
          })}\n\n`
        );

        // Track for persistence
        allToolCalls.push({
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
        });
        allToolResults.push({
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: toolResult.content,
          isError: toolResult.isError,
        });

        // Build pi-ai ToolResultMessage
        const toolResultMsg: ToolResultMessage = {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: toolResult.content }],
          isError: toolResult.isError,
          timestamp: Date.now(),
        };
        piMessages.push(toolResultMsg);
      }

      // Continue loop — model will generate another response
    }

    if (waitingForInput) {
      // Save partial assistant message with tool calls so far
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: finalContent,
        thinking: finalThinking,
        usage: finalUsage,
        toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
        toolResults: allToolResults.length > 0 ? allToolResults : undefined,
        timestamp: Date.now(),
      };

      chat.messages.push(assistantMsg);
      await saveChat(chat);

      res.write(
        `event: done\ndata: ${JSON.stringify({ message: assistantMsg, waitingForInput: true })}\n\n`
      );
    } else {
      // Build the final assistant message to save
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: finalContent,
        thinking: finalThinking,
        usage: finalUsage,
        toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
        toolResults: allToolResults.length > 0 ? allToolResults : undefined,
        timestamp: Date.now(),
      };

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
              const effectiveContextWindow = chat.contextWindow ?? model.contextWindow;
              const usageRatio = assistantMsg.usage.totalTokens / effectiveContextWindow;
              if (usageRatio > 0.75) {
                preCompactionFlush(chat.modelId, chat.id, chat.messages)
                  .catch((err) => console.error("[memory] pre-compaction flush failed:", err));
              }
            }
          } catch {}
        }
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
