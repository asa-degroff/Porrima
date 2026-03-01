import { Router } from "express";
import type { Request, Response } from "express";
import type { Message, ToolResultMessage, ToolCall } from "@mariozechner/pi-ai";
import { getChat, saveChat } from "../services/storage.js";
import { streamChat, chatMessagesToPiMessages } from "../services/agent.js";
import { extractMemories, preCompactionFlush } from "../services/memory-extraction.js";
import { discoverOllamaModels } from "../services/models.js";
import { buildMemoryAugmentedPrompt, setCachedAugmentedPrompt } from "../services/memory-context.js";
import { getAgentTools, executeTool } from "../services/agent-tools.js";
import {
  loadPendingState,
  savePendingState,
  hasPendingState,
} from "../services/agent-state.js";
import type { Artifact, Chat, ChatMessage, ChatToolCall, ChatToolResult, ImageAttachment } from "../types.js";

/** Truncate a string to maxChars graphemes, preserving emoji and multi-byte characters */
function truncateTitle(text: string, maxChars: number = 50): string {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const segments = segmenter.segment(text);
  let result = "";
  let count = 0;
  for (const { segment } of segments) {
    if (count >= maxChars) return result + "...";
    result += segment;
    count++;
  }
  return result;
}

const router = Router();

const MAX_TOOL_ITERATIONS = 20;

/**
 * Shared SSE streaming + tool-loop handler.
 * Both POST / (send) and POST /edit call this after their own setup.
 */
async function handleChatStream(
  chat: Chat,
  userMessage: string,
  piMessages: Message[],
  systemPrompt: string,
  tools: ReturnType<typeof getAgentTools> | undefined,
  req: Request,
  res: Response
) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const abortController = new AbortController();
  req.on("close", () => abortController.abort());

  try {
    const allToolCalls: ChatToolCall[] = [];
    const allToolResults: ChatToolResult[] = [];
    const allArtifacts: Artifact[] = [];

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
        await savePendingState(chat.id, {
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
            allArtifacts.push(event.data as Artifact);
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

    // Build the final assistant message
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: finalContent,
      thinking: finalThinking,
      usage: finalUsage,
      toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
      toolResults: allToolResults.length > 0 ? allToolResults : undefined,
      artifacts: allArtifacts.length > 0 ? allArtifacts : undefined,
      timestamp: Date.now(),
    };

    chat.messages.push(assistantMsg);
    await saveChat(chat);

    if (waitingForInput) {
      res.write(
        `event: done\ndata: ${JSON.stringify({ message: assistantMsg, waitingForInput: true })}\n\n`
      );
    } else {
      res.write(
        `event: done\ndata: ${JSON.stringify({ message: assistantMsg })}\n\n`
      );

      // Fire-and-forget memory extraction for agent chats
      if (chat.type === "agent") {
        extractMemories(chat.modelId, chat.id, userMessage, assistantMsg.content)
          .catch((err) => console.error("[memory] extraction failed:", err));

        // Check for pre-compaction flush based on cumulative token usage
        try {
          const models = await discoverOllamaModels();
          const model = models.find((m) => m.id === chat.modelId);
          if (model) {
            const effectiveContextWindow = chat.contextWindow ?? model.contextWindow;
            // Use last message's totalTokens as primary signal (includes full context),
            // but also sum output tokens across all messages as cumulative estimate
            const lastUsage = assistantMsg.usage?.totalTokens ?? 0;
            const cumulativeOutput = chat.messages.reduce(
              (sum, m) => sum + (m.usage?.output ?? 0), 0
            );
            const estimatedUsage = Math.max(lastUsage, cumulativeOutput);
            const usageRatio = estimatedUsage / effectiveContextWindow;
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
}

// Send message and stream response via SSE
router.post("/", async (req, res) => {
  const { chatId, message, images } = req.body as {
    chatId: string;
    message: string;
    images?: ImageAttachment[];
  };

  if (!chatId || (!message && (!images || images.length === 0))) {
    return res.status(400).json({ error: "chatId and message (or images) are required" });
  }

  const chat = await getChat(chatId);
  if (!chat) return res.status(404).json({ error: "Chat not found" });

  // Check for pending agent state (ask_user resume flow)
  const pendingState = await loadPendingState(chatId);

  let piMessages: Message[];
  let systemPrompt: string;
  let tools: ReturnType<typeof getAgentTools> | undefined;

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
      images: images?.length ? images : undefined,
      timestamp: Date.now(),
    });
    await saveChat(chat);
  } else {
    // NORMAL: add user message and build fresh context
    const userMsg: ChatMessage = {
      role: "user",
      content: message,
      images: images?.length ? images : undefined,
      timestamp: Date.now(),
    };
    chat.messages.push(userMsg);

    // Auto-generate title from first message
    if (chat.messages.length === 1) {
      chat.title = truncateTitle(message);
    }

    await saveChat(chat);

    // Augment system prompt with memories for agent chats
    systemPrompt = chat.systemPrompt || "You are a helpful assistant.";
    if (chat.type === "agent") {
      systemPrompt = await buildMemoryAugmentedPrompt(
        systemPrompt,
        chat.messages
      );
      setCachedAugmentedPrompt(chat.id, systemPrompt);
    }

    tools = chat.type === "agent" ? getAgentTools() : undefined;
    piMessages = chatMessagesToPiMessages(chat.messages, chat.modelId);
  }

  await handleChatStream(chat, message, piMessages, systemPrompt, tools, req, res);
});

// Edit message at index and regenerate response via SSE
router.post("/edit", async (req, res) => {
  const { chatId, messageIndex, message } = req.body as {
    chatId: string;
    messageIndex: number;
    message: string;
  };

  if (!chatId || messageIndex == null || !message) {
    return res.status(400).json({ error: "chatId, messageIndex, and message are required" });
  }

  const chat = await getChat(chatId);
  if (!chat) return res.status(404).json({ error: "Chat not found" });

  if (messageIndex < 0 || messageIndex >= chat.messages.length) {
    return res.status(400).json({ error: "messageIndex out of bounds" });
  }

  if (chat.messages[messageIndex].role !== "user") {
    return res.status(400).json({ error: "messageIndex must point to a user message" });
  }

  // Truncate everything from messageIndex onwards
  chat.messages = chat.messages.slice(0, messageIndex);

  // Add edited user message
  const userMsg: ChatMessage = {
    role: "user",
    content: message,
    timestamp: Date.now(),
  };
  chat.messages.push(userMsg);

  // Update title if editing the first message
  if (messageIndex === 0) {
    chat.title = truncateTitle(message);
  }

  await saveChat(chat);

  // Build context
  let systemPrompt = chat.systemPrompt || "You are a helpful assistant.";
  if (chat.type === "agent") {
    systemPrompt = await buildMemoryAugmentedPrompt(systemPrompt, chat.messages);
    setCachedAugmentedPrompt(chat.id, systemPrompt);
  }

  const tools = chat.type === "agent" ? getAgentTools() : undefined;
  const piMessages = chatMessagesToPiMessages(chat.messages, chat.modelId);

  await handleChatStream(chat, message, piMessages, systemPrompt, tools, req, res);
});

export default router;
