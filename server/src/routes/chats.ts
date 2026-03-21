import { Router } from "express";
import { v4 as uuid } from "uuid";
import { listChats, getChat, saveChat, deleteChat, getSettings, createChat, getProject } from "../services/chat-storage.js";
import { readAgentsMd } from "../services/project-storage.js";
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
  const { modelId, type, contextWindow, projectId } = req.body;
  const settings = await getSettings();
  const effectiveModelId = modelId || settings.defaultModelId || "qwen3:8b";
  
  // Validate model exists before creating chat
  try {
    const { discoverOllamaModels } = await import("../services/models.js");
    const models = await discoverOllamaModels();
    if (!models.find(m => m.id === effectiveModelId)) {
      return res.status(400).json({ 
        error: `Model "${effectiveModelId}" not available`,
        availableModels: models.map(m => m.id)
      });
    }
  } catch (e: any) {
    console.error("[chats] model validation failed:", e.message);
    return res.status(503).json({ error: "Cannot validate model - Ollama may be unreachable" });
  }
  
  const savedContextWindow = settings.modelContextWindows?.[effectiveModelId];
  let systemPrompt = settings.defaultSystemPrompt || "You are a helpful assistant.";
  
  // Inject project context if creating a chat within a project
  if (projectId) {
    const project = await getProject(projectId);
    if (project) {
      const agentsMd = await readAgentsMd(project.path);
      if (agentsMd) {
        systemPrompt = `You are working on the project: ${project.name}
Path: ${project.path}

Project context from AGENTS.md:
${agentsMd}

${systemPrompt}`;
      }
    }
  }
  
  const chat: Chat = {
    id: uuid(),
    title: type === "agent" ? "New Agent Chat" : "New Chat",
    type: type === "agent" ? "agent" : "quick",
    modelId: effectiveModelId,
    systemPrompt,
    ...(contextWindow ?? savedContextWindow ? { contextWindow: contextWindow ?? savedContextWindow } : {}),
    messages: [],
    createdAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
    ...(projectId ? { projectId } : {}),
  };
  await createChat(chat);
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

// Get the rendered system prompt and tools for debugging
// Uses cached prompt from last message send when available to avoid
// a cold Ollama embedding call that can take seconds on first use.
router.get("/:id/rendered-prompt", async (req, res) => {
  const chat = await getChat(req.params.id);
  if (!chat) return res.status(404).json({ error: "Chat not found" });

  let systemPrompt = chat.systemPrompt || "You are an autonmous agent.";
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
