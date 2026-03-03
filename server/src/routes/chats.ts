import { Router } from "express";
import { v4 as uuid } from "uuid";
import { listChats, getChat, saveChat, deleteChat, getSettings, saveSettings } from "../services/storage.js";
import { buildMemoryAugmentedPrompt, getCachedAugmentedPrompt } from "../services/memory-context.js";
import { getAgentToolDefinitions } from "../services/agent-tools.js";
import type { Chat } from "../types.js";

const router = Router();

// List all chats
router.get("/", async (_req, res) => {
  const chats = await listChats();
  res.json(chats);
});

// Get a single chat (with messages)
router.get("/:id", async (req, res) => {
  const chat = await getChat(req.params.id);
  if (!chat) return res.status(404).json({ error: "Chat not found" });
  res.json(chat);
});

// Create a new chat
router.post("/", async (req, res) => {
  const { modelId, type, contextWindow } = req.body;
  const settings = await getSettings();
  const effectiveModelId = modelId || settings.defaultModelId || "qwen3:8b";
  const savedContextWindow = settings.modelContextWindows?.[effectiveModelId];
  const chat: Chat = {
    id: uuid(),
    title: type === "agent" ? "New Agent Chat" : "New Chat",
    type: type === "agent" ? "agent" : "quick",
    modelId: effectiveModelId,
    systemPrompt: settings.defaultSystemPrompt,
    ...(contextWindow ?? savedContextWindow ? { contextWindow: contextWindow ?? savedContextWindow } : {}),
    messages: [],
    createdAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
  };
  await saveChat(chat);
  res.status(201).json(chat);
});

// Update chat metadata
router.patch("/:id", async (req, res) => {
  const chat = await getChat(req.params.id);
  if (!chat) return res.status(404).json({ error: "Chat not found" });

  if (req.body.title !== undefined) chat.title = req.body.title;
  if (req.body.modelId !== undefined) chat.modelId = req.body.modelId;
  if (req.body.systemPrompt !== undefined) chat.systemPrompt = req.body.systemPrompt;
  if (req.body.contextWindow !== undefined) {
    if (req.body.contextWindow === null) {
      delete chat.contextWindow;
      // Remove per-model override
      const settings = await getSettings();
      if (settings.modelContextWindows?.[chat.modelId]) {
        delete settings.modelContextWindows[chat.modelId];
        await saveSettings(settings);
      }
    } else {
      chat.contextWindow = req.body.contextWindow;
      // Persist per-model for future chats
      const settings = await getSettings();
      const mcw = settings.modelContextWindows ?? {};
      mcw[chat.modelId] = req.body.contextWindow;
      await saveSettings({ ...settings, modelContextWindows: mcw });
    }
  }

  await saveChat(chat);
  res.json(chat);
});

// Get the rendered system prompt and tools for debugging
// Uses cached prompt from last message send when available to avoid
// a cold Ollama embedding call that can take seconds on first use.
router.get("/:id/rendered-prompt", async (req, res) => {
  const chat = await getChat(req.params.id);
  if (!chat) return res.status(404).json({ error: "Chat not found" });

  let systemPrompt = chat.systemPrompt || "You are a helpful assistant.";
  if (chat.type === "agent") {
    const cached = getCachedAugmentedPrompt(chat.id);
    if (cached) {
      systemPrompt = cached;
    } else {
      systemPrompt = await buildMemoryAugmentedPrompt(systemPrompt, chat.messages);
    }
  }

  const tools = chat.type === "agent"
    ? getAgentToolDefinitions()
    : [];

  res.json({ systemPrompt, tools });
});

// Delete a chat
router.delete("/:id", async (req, res) => {
  const deleted = await deleteChat(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Chat not found" });
  res.status(204).end();
});

export default router;
