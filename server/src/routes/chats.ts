import { Router } from "express";
import { v4 as uuid } from "uuid";
import { listChats, getChat, saveChat, deleteChat, getSettings, createChat, getProject } from "../services/chat-storage.js";
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
  const { id: clientId, modelId, type, contextWindow, projectId } = req.body;
  const settings = await getSettings();
  const effectiveModelId = modelId || settings.defaultModelId;
  
  // Skip model validation on chat creation — it blocks for 1-2s due to Ollama discovery.
  // The model will be validated when the first message is sent (chat.ts validates there).
  // This makes chat creation instant.
  const savedContextWindow = settings.modelContextWindows?.[effectiveModelId];
  let systemPrompt = settings.defaultSystemPrompt || "You are a helpful assistant.";
  
  // Note: AGENTS.md is now loaded dynamically in memory-context.ts at prompt build time,
  // not baked into the system prompt at chat creation. This allows for better KV cache
  // efficiency since the stable prefix (persona + user doc + blocks) can be cached separately.
  
  const chat: Chat = {
    id: clientId || uuid(),
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
  if (req.body.modelId !== undefined) {
    chat.modelId = req.body.modelId;
    // When the model changes, apply the user's per-model context window setting
    // (unless an explicit contextWindow is also provided in this same request)
    if (req.body.contextWindow === undefined) {
      const settings = await getSettings();
      const savedContextWindow = settings.modelContextWindows?.[req.body.modelId];
      if (savedContextWindow) {
        chat.contextWindow = savedContextWindow;
      } else {
        // Clear any previous model's override so the new model's detected default is used
        delete chat.contextWindow;
      }
    }
  }
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
  if (chat.type === "agent" || chat.type === "bluesky") {
    const cached = getCachedAugmentedPrompt(chat.id);
    if (cached) {
      systemPrompt = cached;
    } else {
      // Get project path for AGENTS.md loading
      let projectPath: string | undefined;
      if (chat.projectId) {
        const project = await getProject(chat.projectId);
        projectPath = project?.path;
      }
      systemPrompt = await buildMemoryAugmentedPrompt(
        systemPrompt,
        chat.messages,
        chat.id,
        chat.projectId,
        chat.type,
        projectPath
      );
    }
  }

  // Inject active skills into the rendered prompt (matches chat.ts behavior)
  if (chat.activeSkills?.length) {
    const { buildSkillAugmentedPrompt, discoverSkills } = await import("../services/skills.js");
    const skillsCache = new Map<string, import("../services/skills.js").Skill>();
    const allSkills = await discoverSkills(chat.projectId);
    for (const s of allSkills) {
      skillsCache.set(s.name, s);
    }
    systemPrompt = buildSkillAugmentedPrompt(systemPrompt, chat.activeSkills, skillsCache);
  }

  const tools = (chat.type === "agent" || chat.type === "bluesky")
    ? getAgentToolDefinitions(chat.type)
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
