import { Router } from "express";
import { v4 as uuid } from "uuid";
import { listChats, getChat, saveChat, deleteChat, getSettings } from "../services/storage.js";
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
  const chat: Chat = {
    id: uuid(),
    title: type === "agent" ? "New Agent Chat" : "New Chat",
    type: type === "agent" ? "agent" : "quick",
    modelId: modelId || settings.defaultModelId || "qwen3:8b",
    systemPrompt: settings.defaultSystemPrompt,
    ...(contextWindow ? { contextWindow } : {}),
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
    } else {
      chat.contextWindow = req.body.contextWindow;
    }
  }

  await saveChat(chat);
  res.json(chat);
});

// Delete a chat
router.delete("/:id", async (req, res) => {
  const deleted = await deleteChat(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Chat not found" });
  res.status(204).end();
});

export default router;
