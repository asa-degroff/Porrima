import { Router } from "express";
import { v4 as uuid } from "uuid";
import { embed, isEmbeddingModelAvailable } from "../services/embeddings.js";
import {
  addMemory,
  updateMemory,
  deleteMemory,
  searchMemories,
  getMemoryById,
  getMemoryCount,
  getLastSynthesis,
  getAllMemories,
  createSupersessionLink,
  removeSupersessionLink,
  getMemoryLineage,
} from "../services/memory-storage.js";
import { runDailySynthesis } from "../services/synthesis.js";
import { getExtractionMetrics, backfillSupersessions } from "../services/memory-extraction.js";
import type { Memory, MemorySummary } from "../types.js";

const router = Router();

function stripEmbedding(memory: Memory): MemorySummary {
  const { embedding, ...rest } = memory;
  return rest;
}

// Check embedding model availability and extraction health
router.get("/status", async (_req, res) => {
  const available = await isEmbeddingModelAvailable();
  const memoryCount = await getMemoryCount();
  const lastSynthesis = await getLastSynthesis();
  res.json({
    embeddingModelAvailable: available,
    memoryCount,
    lastSynthesis,
    extraction: getExtractionMetrics(),
  });
});

// Synthesis status (must be before /:id to avoid matching "synthesis" as an id)
router.get("/synthesis/status", async (_req, res) => {
  const memoryCount = await getMemoryCount();
  const lastSynthesis = await getLastSynthesis();
  res.json({
    lastSynthesis,
    memoryCount,
  });
});

// Manually trigger synthesis
router.post("/synthesis/run", async (_req, res) => {
  try {
    await runDailySynthesis();
    const memoryCount = await getMemoryCount();
    const lastSynthesis = await getLastSynthesis();
    res.json({
      success: true,
      lastSynthesis,
      memoryCount,
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
  const memories = await getAllMemories();
  res.json(memories);
});

// Create memory (auto-embeds)
router.post("/", async (req, res) => {
  const { text, category, importance, sourceChatId, sourceType, sourceId } = req.body;
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
    sourceType: sourceType || 'chat',
    sourceId: sourceId || sourceChatId || '',
  };

  await addMemory(memory);
  res.status(201).json(stripEmbedding(memory));
});

// Get single memory
router.get("/:id", async (req, res) => {
  const memory = await getMemoryById(req.params.id);
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

  const memory = await getMemoryById(req.params.id);
  res.json(stripEmbedding(memory!));
});

// Delete memory
router.delete("/:id", async (req, res) => {
  const deleted = await deleteMemory(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Memory not found" });
  res.status(204).end();
});

// Get memory lineage (supersession chain)
router.get("/:id/lineage", async (req, res) => {
  const lineage = await getMemoryLineage(req.params.id);
  res.json(lineage);
});

// Create supersession link (manual override)
router.post("/:id/supersede", async (req, res) => {
  const { olderMemoryId, confidence } = req.body;
  if (!olderMemoryId) {
    return res.status(400).json({ error: "olderMemoryId is required" });
  }
  
  const newerMemoryId = req.params.id;
  const conf = confidence ?? 0.75;
  
  try {
    await createSupersessionLink(newerMemoryId, olderMemoryId, conf);
    res.status(201).json({ success: true, newerMemoryId, olderMemoryId });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Remove supersession link (false positive correction)
router.delete("/:id/supersession", async (req, res) => {
  const { olderMemoryId, reason } = req.body;
  if (!olderMemoryId) {
    return res.status(400).json({ error: "olderMemoryId is required" });
  }
  
  const newerMemoryId = req.params.id;
  
  try {
    await removeSupersessionLink(newerMemoryId, olderMemoryId, reason);
    res.status(200).json({ success: true, newerMemoryId, olderMemoryId });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Get memories by time range
router.get("/timeline", async (req, res) => {
  const { from, to, groupedBy } = req.query;
  
  const memories = await getAllMemories();
  
  let filtered = memories;
  if (from) {
    filtered = filtered.filter(m => new Date(m.createdAt) >= new Date(from as string));
  }
  if (to) {
    filtered = filtered.filter(m => new Date(m.createdAt) <= new Date(to as string));
  }
  
  // Sort by createdAt descending (newest first)
  filtered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  
  res.json(filtered);
});

// Trigger backfill supersession scan (admin operation)
router.post("/backfill-supersessions", async (_req, res) => {
  try {
    await backfillSupersessions();
    res.json({ success: true, message: "Backfill supersession scan complete" });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Detect potential contradictions (for synthesis review)
router.get("/contradictions", async (_req, res) => {
  const memories = await getAllMemories();
  
  // Group by semantic similarity (simple heuristic: same topic keywords)
  const topicGroups: Record<string, string[]> = {};
  for (const m of memories) {
    const topic = m.text.split(/\s+/).filter(w => w.length > 4)[0]?.toLowerCase() || 'unknown';
    if (!topicGroups[topic]) topicGroups[topic] = [];
    topicGroups[topic].push(m.id);
  }
  
  const contradictions: Array<{
    olderId: string;
    newerId: string;
    olderText: string;
    newerText: string;
    confidence: number;
  }> = [];
  
  for (const topic of Object.keys(topicGroups)) {
    const ids = topicGroups[topic];
    if (ids.length < 2) continue;
    
    const groupMemories = memories.filter(m => ids.includes(m.id)).sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    
    for (let i = 0; i < groupMemories.length - 1; i++) {
      const older = groupMemories[i];
      const newer = groupMemories[i + 1];
      
      // Skip if already linked
      if (older.supersededBy || newer.supersedes) continue;
      
      const confidence = calculateContradictionConfidence(older.text, newer.text);
      if (confidence > 0.50) {
        contradictions.push({
          olderId: older.id,
          newerId: newer.id,
          olderText: older.text,
          newerText: newer.text,
          confidence,
        });
      }
    }
  }
  
  res.json(contradictions);
});

function calculateContradictionConfidence(text1: string, text2: string): number {
  // Simple heuristic for contradiction detection
  const contradictionPatterns = [
    /\bnot\b/i,
    /\bno longer\b/i,
    /\bchanged\b/i,
    /\breplaced\b/i,
    /\binstead of\b/i,
    /\bpreviously\b/i,
    /\bwas\b.*\bnow\b/i,
  ];
  
  const hasContradiction = contradictionPatterns.some(p => p.test(text1) || p.test(text2));
  
  // Word overlap
  const words1 = new Set(text1.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const words2 = new Set(text2.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const overlap = [...words1].filter(w => words2.has(w)).length;
  const overlapScore = Math.min(1, overlap / 5);
  
  return (hasContradiction ? 0.6 : 0.2) + overlapScore * 0.4;
}

export default router;
