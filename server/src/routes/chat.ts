import { Router } from "express";
import { getChat, saveChat } from "../services/storage.js";
import { streamChat } from "../services/agent.js";
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
    const assistantMsg = await streamChat(
      chat.modelId,
      chat.messages,
      (event) => {
        if (event.type === "text_delta") {
          res.write(
            `event: text_delta\ndata: ${JSON.stringify({ delta: event.delta })}\n\n`
          );
        }
      },
      abortController.signal
    );

    // Save the assistant message
    chat.messages.push(assistantMsg);
    await saveChat(chat);

    res.write(
      `event: done\ndata: ${JSON.stringify({ message: assistantMsg })}\n\n`
    );
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
