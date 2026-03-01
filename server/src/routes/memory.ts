import { Router } from "express";
import { v4 as uuid } from "uuid";
import { embed, isEmbeddingModelAvailable } from "../services/embeddings.js";
import {
  loadMemoryStore,
  addMemory,
  updateMemory,
  deleteMemory,
  searchMemories,
} from "../services/memory-storage.js";
import { runDailySynthesis } from "../services/synthesis.js";
import { getExtractionMetrics } from "../services/memory-extraction.js";
import type { Memory, MemorySummary } from "../types.js";

const router = Router();

function stripEmbedding(memory: Memory): MemorySummary {
  const { embedding, ...rest } = memory;
  return rest;
}

// Check embedding model availability and extraction health
router.get("/status", async (_req, res) => {
  const available = await isEmbeddingModelAvailable();
  const store = await loadMemoryStore();
  res.json({
    embeddingModelAvailable: available,
    memoryCount: store.memories.length,
    lastSynthesis: store.lastSynthesis,
    extraction: getExtractionMetrics(),
  });
});

// Synthesis status (must be before /:id to avoid matching "synthesis" as an id)
router.get("/synthesis/status", async (_req, res) => {
  const store = await loadMemoryStore();
  res.json({
    lastSynthesis: store.lastSynthesis,
    memoryCount: store.memories.length,
  });
});

// Manually trigger synthesis
router.post("/synthesis/run", async (_req, res) => {
  try {
    await runDailySynthesis();
    const store = await loadMemoryStore();
    res.json({
      success: true,
      lastSynthesis: store.lastSynthesis,
      memoryCount: store.memories.length,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Semantic search (must be before /:id)
router.post("/search", async (req, res) => {
  const { query, topK } = req.body;
  if (!query) return res.status(400).json({ error: "query is required" });

  let queryEmbedding: number[];
  try {
    queryEmbedding = await embed(query);
  } catch (e: any) {
    return res.status(503).json({ error: `Embedding unavailable: ${e.message}` });
  }

  const results = await searchMemories(queryEmbedding, topK || 5);
  res.json(
    results.map((r) => ({
      ...stripEmbedding(r.memory),
      score: r.score,
    }))
  );
});

// List all memories (without embeddings)
router.get("/", async (_req, res) => {
  const store = await loadMemoryStore();
  res.json(store.memories.map(stripEmbedding));
});

// Create memory (auto-embeds)
router.post("/", async (req, res) => {
  const { text, category, importance, sourceChatId } = req.body;
  if (!text) return res.status(400).json({ error: "text is required" });

  let embedding: number[];
  try {
    embedding = await embed(text);
  } catch (e: any) {
    return res.status(503).json({ error: `Embedding unavailable: ${e.message}` });
  }

  const now = new Date().toISOString();
  const memory: Memory = {
    id: uuid(),
    text,
    category: category || "fact",
    importance: Math.min(10, Math.max(1, importance || 5)),
    embedding,
    createdAt: now,
    lastAccessed: now,
    accessCount: 0,
    sourceChatId: sourceChatId || "",
  };

  await addMemory(memory);
  res.status(201).json(stripEmbedding(memory));
});

// Get single memory
router.get("/:id", async (req, res) => {
  const store = await loadMemoryStore();
  const memory = store.memories.find((m) => m.id === req.params.id);
  if (!memory) return res.status(404).json({ error: "Memory not found" });
  res.json(stripEmbedding(memory));
});

// Update memory (re-embeds if text changes)
router.patch("/:id", async (req, res) => {
  const { text, category, importance } = req.body;
  const updates: Partial<Memory> = {};

  if (text !== undefined) {
    updates.text = text;
    try {
      updates.embedding = await embed(text);
    } catch (e: any) {
      return res.status(503).json({ error: `Embedding unavailable: ${e.message}` });
    }
  }
  if (category !== undefined) updates.category = category;
  if (importance !== undefined)
    updates.importance = Math.min(10, Math.max(1, importance));

  const updated = await updateMemory(req.params.id, updates);
  if (!updated) return res.status(404).json({ error: "Memory not found" });

  const store = await loadMemoryStore();
  const memory = store.memories.find((m) => m.id === req.params.id);
  res.json(stripEmbedding(memory!));
});

// Delete memory
router.delete("/:id", async (req, res) => {
  const deleted = await deleteMemory(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Memory not found" });
  res.status(204).end();
});

export default router;
