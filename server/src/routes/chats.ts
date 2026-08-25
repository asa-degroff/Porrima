import { Router } from "express";
import { v4 as uuid } from "uuid";
import { listChats, getChat, deleteChat, getSettings, createChat, getChatMessageWindow, getChatWithWindow, getDb, chatExists, updateChatMetadata } from "../services/chat-storage.js";
import { getCachedAugmentedPrompt } from "../services/memory-context.js";
import { getAgentToolDefinitions } from "../services/agent-tools.js";
import { cancelDeletedChatWork } from "../services/chat-deletion.js";
import { listVisibleQueueCounts } from "../services/message-queue.js";
import { computeContextBreakdown } from "../services/context-breakdown.js";
import { discoverAllModels, getEffectiveContextWindow } from "../services/models.js";
import type { Chat } from "../types.js";
import type { ChatMetadataUpdate } from "../services/chat-storage.js";

const router = Router();
const MAX_MESSAGE_WINDOW_LIMIT = 1000;

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseMessageLimit(value: unknown): number | undefined {
  const parsed = parsePositiveInt(value);
  return parsed ? Math.min(parsed, MAX_MESSAGE_WINDOW_LIMIT) : undefined;
}

// List all chats
router.get("/", async (_req, res) => {
  const chats = await listChats();
  // Attach visible queued-message counts so the sidebar can show a
  // "messages waiting" indicator. One pass over a few small JSON files.
  const queueCounts = await listVisibleQueueCounts();
  res.json(
    chats.map((chat) => {
      const queueCount = queueCounts.get(chat.id);
      return queueCount ? { ...chat, queueCount } : chat;
    })
  );
});

// Get a page of messages before an absolute sequence index.
router.get("/:id/messages", async (req, res) => {
  if (!(await chatExists(req.params.id))) {
    return res.status(404).json({ error: "Chat not found" });
  }

  const before = parsePositiveInt(req.query.before);
  const limit = parseMessageLimit(req.query.limit);
  const window = getChatMessageWindow(req.params.id, { before, limit });
  res.json(window);
});

// Lightweight header endpoint for cache freshness checks.
// Returns only metadata — no messages — so the client can compare lastModified
// and message count without downloading the full chat.
router.get("/:id/header", async (req, res) => {
  const db = getDb();
  const row = db.prepare(
    "SELECT id, title, type, modelId, lastModified, projectId, contextWindow FROM chats WHERE id = ?"
  ).get(req.params.id) as
    | { id: string; title: string; type: string; modelId: string; lastModified: string; projectId: string | null; contextWindow: number | null }
    | undefined;
  if (!row) return res.status(404).json({ error: "Chat not found" });

  // Get message count for freshness comparison
  const countRow = db.prepare(
    "SELECT COUNT(*) as total FROM chat_message_rows WHERE chat_id = ?"
  ).get(req.params.id) as { total: number };

  res.json({
    id: row.id,
    title: row.title,
    type: row.type,
    modelId: row.modelId,
    lastModified: row.lastModified,
    projectId: row.projectId,
    contextWindow: row.contextWindow,
    messageCount: countRow.total,
  });
});

// Get a single chat (with messages)
// When messageLimit is specified, uses getChatWithWindow to fetch only the
// windowed messages directly from the row table instead of loading and
// parsing ALL messages from both JSON column and row table.
router.get("/:id", async (req, res) => {
  const messageLimit = parseMessageLimit(req.query.messageLimit);

  if (messageLimit) {
    // Optimized path: skip parsing the full message list
    const chat = await getChatWithWindow(req.params.id, { limit: messageLimit });
    if (!chat) return res.status(404).json({ error: "Chat not found" });
    res.json(chat);
    return;
  }

  const chat = await getChat(req.params.id);
  if (!chat) return res.status(404).json({ error: "Chat not found" });
  res.json(chat);
});

// Create a new chat
router.post("/", async (req, res) => {
  const { id: clientId, modelId, type, contextWindow, projectId } = req.body;
  const settings = await getSettings();
  const effectiveModelId = modelId || settings.defaultModelId;
  
  // Skip model validation on chat creation — it blocks for 1-2s due to model discovery.
  // The model will be validated when the first message is sent (chat.ts validates there).
  // This makes chat creation instant.
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
    ...(contextWindow ? { contextWindow } : {}),
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
  const updates: ChatMetadataUpdate = {
    ...(req.body.title !== undefined ? { title: String(req.body.title) } : {}),
    ...(req.body.modelId !== undefined ? { modelId: String(req.body.modelId) } : {}),
    ...(req.body.systemPrompt !== undefined ? { systemPrompt: String(req.body.systemPrompt) } : {}),
    clearContextWindow: req.body.modelId !== undefined && req.body.contextWindow === undefined,
  };
  if (req.body.contextWindow !== undefined) {
    if (req.body.contextWindow === null) {
      updates.contextWindow = null;
    } else {
      const contextWindow = Number(req.body.contextWindow);
      if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
        return res.status(400).json({ error: "contextWindow must be a positive number or null" });
      }
      updates.contextWindow = contextWindow;
    }
  }

  const updated = await updateChatMetadata(req.params.id, updates);
  if (!updated) return res.status(404).json({ error: "Chat not found" });
  res.json(updated);
});

// Get the rendered system prompt and tools for debugging.
// Returns the cached prompt from the last message send when available.
// When the cache is cold (e.g. after a server restart), returns the base
// system prompt with a cached=false flag instead of running a full memory
// retrieval pipeline just for display.
router.get("/:id/rendered-prompt", async (req, res) => {
  const chat = await getChat(req.params.id);
  if (!chat) return res.status(404).json({ error: "Chat not found" });

  const cached = getCachedAugmentedPrompt(chat.id);
  let systemPrompt: string;
  let cachedFlag: boolean;

  if (cached) {
    systemPrompt = cached;
    cachedFlag = true;
  } else {
    systemPrompt = chat.systemPrompt || "You are a helpful assistant.";
    cachedFlag = false;

    if (chat.activeSkills?.length) {
      const { buildSkillAugmentedPrompt, discoverSkills } = await import("../services/skills.js");
      const skillsCache = new Map<string, import("../services/skills.js").Skill>();
      const allSkills = await discoverSkills(chat.projectId);
      for (const s of allSkills) {
        skillsCache.set(s.name, s);
      }
      systemPrompt = buildSkillAugmentedPrompt(systemPrompt, chat.activeSkills, skillsCache);
    }
  }

  const tools = (chat.type === "agent" || chat.type === "system")
    ? getAgentToolDefinitions(chat.type)
    : [];

  res.json({ systemPrompt, tools, cached: cachedFlag });
});

// Attribute the current context across system prompt, memory, tools,
// conversation, and output. Lazy-loaded by the token indicator's detail view.
// Input-side categories are estimates scaled to the real LLM-reported input
// count when one exists; see services/context-breakdown.ts.
router.get("/:id/context-breakdown", async (req, res) => {
  const chat = await getChat(req.params.id);
  if (!chat) return res.status(404).json({ error: "Chat not found" });

  let model;
  try {
    const all = await discoverAllModels();
    model = all.find((m) => m.id === chat.modelId);
  } catch {
    model = undefined;
  }
  const contextWindow = getEffectiveContextWindow(chat, model);

  res.json(computeContextBreakdown(chat, contextWindow));
});

// Delete a chat
router.delete("/:id", async (req, res) => {
  await cancelDeletedChatWork(req.params.id);
  const deleted = await deleteChat(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Chat not found" });
  res.status(204).end();
});

export default router;
