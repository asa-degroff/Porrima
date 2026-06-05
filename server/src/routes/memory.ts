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
  createMemoryBlock,
  updateMemoryBlock,
  getMemoryBlock,
  deleteMemoryBlock,
  listMemoryBlocks,
  getBlockHistory,
  getMaxBlockChars,
} from "../services/memory-storage.js";
import { getExtractionMetrics, backfillSupersessions } from "../services/memory-extraction.js";
import { getRecentExtractionRuns, subscribeExtractionEvents } from "../services/memory-extraction-observability.js";
import { invalidateAllMemoriesCaches, invalidateAllStablePrefixCaches } from "../services/memory-context.js";
import { isSleepCycleActive as computeSleepCycleActive } from "../services/sleep-cycle.js";
import { getActiveAutomationTaskId, isAutomationActive } from "../services/automation-lock.js";
import { runAutomationTask } from "../services/automation-runner.js";
import { getAutomationTask, SYNTHESIS_AUTOMATION_ID, WAKE_AUTOMATION_ID } from "../services/automation-storage.js";
import { clearExpiredSystemPause, getSystemPauseState } from "../services/system-pause.js";
import { getMemoryGraph, type MemoryGraphScope } from "../services/memory-graph.js";
import type { Memory, MemoryCategory, MemorySummary } from "../types.js";
import { VALID_MEMORY_CATEGORIES } from "../types.js";

const router = Router();

function stripEmbedding(memory: Memory): MemorySummary {
  const { embedding, ...rest } = memory;
  return rest;
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseInteger(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseMemoryCategory(value: unknown): MemoryCategory | undefined {
  if (typeof value !== "string" || value === "all") return undefined;
  return (VALID_MEMORY_CATEGORIES as readonly string[]).includes(value)
    ? value as MemoryCategory
    : undefined;
}

function parseGraphScope(value: unknown): MemoryGraphScope {
  return value === "global" || value === "project" ? value : "all";
}

function parseGraphQuery(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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

// Debug observability for the memory extraction agent. Ring buffer of the
// most recent runs — each includes the model input (messages + prompt), raw
// LLM output, and parsed results. In-memory only; survives the process but
// not restarts. Routes are placed before /:id so "extraction" isn't matched
// as a memory id.
router.get("/extraction/recent", (_req, res) => {
  res.json({ runs: getRecentExtractionRuns() });
});

// SSE stream of live extraction events. Emits `event: run` SSE frames whose
// `data` is `{ type: "start" | "output" | "complete" | "error", run: ... }`.
// The client unsubscribes by closing the connection.
router.get("/extraction/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  // Prime the client with the current buffer so the panel can render
  // immediately on connect without a separate /recent fetch.
  res.write(`event: snapshot\ndata: ${JSON.stringify({ runs: getRecentExtractionRuns() })}\n\n`);

  const unsubscribe = subscribeExtractionEvents((ev) => {
    res.write(`event: run\ndata: ${JSON.stringify(ev)}\n\n`);
  });

  // Periodic heartbeat so intermediate proxies don't idle-kill the stream
  // during quiet periods between extractions.
  const heartbeat = setInterval(() => {
    res.write(`: keepalive\n\n`);
  }, 30_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
});

// Synthesis status (must be before /:id to avoid matching "synthesis" as an id)
router.get("/synthesis/status", async (_req, res) => {
  const memoryCount = await getMemoryCount();
  const lastSynthesis = await getLastSynthesis();
  const { isSynthesisActive, isWakeCycleActive } = await import("../services/system-chat.js");
  const { getLastWakeCycleAt } = await import("../services/memory-storage.js");
  const { getSettings } = await import("../services/chat-storage.js");
  const { hasActiveChats } = await import("../services/memory-extraction.js");
  // Check if any extraction run is currently in progress
  const recentRuns = getRecentExtractionRuns();
  const isExtractionRunning = recentRuns.some((r) => r.status === "running");

  // Compute sleep cycle state
  const settings = await clearExpiredSystemPause(await getSettings());
  const sleepCycleThresholdMinutes = settings.sleepCycleThresholdMinutes ?? 60;
  const sleepCycleActive = computeSleepCycleActive(settings, {
    hasActiveChats: hasActiveChats(),
    defaultThresholdMinutes: 60,
  });

  const lastWakeCycleAt = await getLastWakeCycleAt();
  const wakeTask = getAutomationTask(WAKE_AUTOMATION_ID);

  const automationRunning = isAutomationActive();
  const systemPause = getSystemPauseState(settings, {
    pending: automationRunning || isExtractionRunning,
  });

  res.json({
    lastSynthesis,
    memoryCount,
    isSynthesizing: isSynthesisActive(),
    isAutomationRunning: automationRunning,
    activeAutomationTaskId: getActiveAutomationTaskId(),
    isExtractionRunning,
    systemPause,
    // Sleep cycle
    sleepCycleActive,
    sleepCycleThresholdMinutes,
    lastUserActivityAt: settings.lastUserActivityAt ?? null,
    lastAgentCompletedAt: settings.lastAgentCompletedAt ?? null,
    sleepModeTriggeredAt: settings.sleepModeTriggeredAt ?? null,
    // Wake cycle
    isWakeCycleRunning: isWakeCycleActive(),
    lastWakeCycleAt,
    wakeCycleEnabled: wakeTask?.enabled ?? settings.wakeCycleEnabled ?? false,
  });
});

// Kick off synthesis in the background and log any failure.
// Synthesis runs can take minutes — far longer than any reasonable HTTP idle
// timeout (the Cloudflare tunnel drops at 100s). Callers observe completion
// by polling /synthesis/status (isSynthesizing goes false, lastSynthesis
// advances).
function dispatchSynthesis(origin: string): void {
  runAutomationTask(SYNTHESIS_AUTOMATION_ID, "manual")
    .then((result) => {
      if (!result.success) {
        console.error(`[synthesis/${origin}] failed:`, result.error);
      } else {
        console.log(
          `[synthesis/${origin}] complete: ${result.summary.length}ch summary, ${result.toolCalls.length} tool calls`,
        );
      }
    })
    .catch((e: any) => {
      console.error(`[synthesis/${origin}] threw:`, e?.message || e);
    });
}

// Manually trigger synthesis. Returns 202 Accepted immediately; clients poll
// /synthesis/status for completion.
router.post("/synthesis/run", async (_req, res) => {
  try {
    const { isSynthesisActive } = await import("../services/system-chat.js");
    if (isSynthesisActive() || isAutomationActive()) {
      return res.status(409).json({
        error: "Synthesis or automation already in progress",
        activeAutomationTaskId: getActiveAutomationTaskId(),
      });
    }
    dispatchSynthesis("run");
    res.status(202).json({ started: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Release the system to autonomous mode. Stamps sleepModeTriggeredAt which:
// (a) immediately activates the sleep cycle (bypassing the inactivity threshold)
// (b) suppresses periodic synthesis for 2h (the scheduler handles scheduling)
// Unlike the previous design, this no longer dispatches synthesis immediately —
// the scheduler runs synthesis and wake cycles on their normal schedule.
// The 2h cooldown prevents the periodic synthesis from double-firing right after release.
//
// Also enqueues a sleep-prewarm for the system chat so the next synthesis/wake
// cycle starts fast. Fire-and-forget — doesn't block the 202 response.
//
// Returns 202 immediately to survive proxy idle timeouts.
router.post("/synthesis/sleep", async (_req, res) => {
  try {
    const { getSettings, saveSettings } = await import("../services/chat-storage.js");
    const settings = await getSettings();
    settings.sleepModeTriggeredAt = new Date().toISOString();
    await saveSettings(settings);

    // Fire-and-forget sleep prewarm for system chat
    try {
      const { enqueueWarm } = await import("../services/cache-warm-queue.js");
      enqueueWarm("system", "sleep-prewarm").catch((e: any) => {
        console.warn("[sleep] Sleep prewarm failed:", e.message);
      });
    } catch (e: any) {
      console.warn("[sleep] Failed to enqueue sleep prewarm:", e.message);
    }

    res.status(202).json({ started: true, sleepModeTriggeredAt: settings.sleepModeTriggeredAt });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Warm the KV cache for a chat without generating output.
// Uses /apply-template + /completion with n_predict=0 to prefill the cache.
// Queued — only one warm runs at a time; others wait behind it.
router.post("/cache-warm/:chatId", async (req, res) => {
  try {
    const { chatId } = req.params;
    const { reason } = req.body || {};
    const validReasons = ["user-requested", "sleep-prewarm", "post-synthesis"];
    const warmReason = validReasons.includes(reason) ? reason : "user-requested";

    const { enqueueWarm, isChatWarming, cancelQueuedWarms } = await import("../services/cache-warm-queue.js");

    // If already warming or queued, cancel the old request and enqueue a new one
    // (newer request supersedes older one)
    if (isChatWarming(chatId)) {
      cancelQueuedWarms(chatId);
    }

    const result = await enqueueWarm(chatId, warmReason);

    if (result.warmed) {
      console.log(
        `[cache-warm] ${chatId}: warmed in ${result.promptMs}ms, ` +
        `${result.tokensCached} cached / ${result.totalPromptTokens} total ` +
        `(${(result.cacheHitRatio! * 100).toFixed(0)}% hit) — ${warmReason}`
      );
    } else {
      console.warn(`[cache-warm] ${chatId}: failed — ${result.error}`);
    }

    res.json(result);
  } catch (e: any) {
    console.error(`[cache-warm] unexpected error:`, e);
    res.status(500).json({
      warmed: false,
      chatId: req.params.chatId,
      reason: "user-requested",
      warmedAt: Date.now(),
      error: e.message,
    });
  }
});

// Get cache residency status for all chats.
router.get("/cache-residency", async (_req, res) => {
  try {
    const { listLlamaCacheResidency } = await import("../services/llama-cache-residency.js");
    const records = listLlamaCacheResidency();
    res.json({ records });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Manually trigger a wake cycle. Returns 202 Accepted immediately.
router.post("/wake/run", async (_req, res) => {
  try {
    const { isWakeCycleActive } = await import("../services/system-chat.js");
    if (isWakeCycleActive() || isAutomationActive()) {
      return res.status(409).json({
        error: "Wake cycle or automation already in progress",
        activeAutomationTaskId: getActiveAutomationTaskId(),
      });
    }
    runAutomationTask(WAKE_AUTOMATION_ID, "manual")
      .then((result) => {
        if (!result.success) {
          console.error(`[wake/manual] failed:`, result.error);
        } else {
          console.log(`[wake/manual] complete: ${result.summary.length}ch, ${result.toolCalls.length} tools`);
        }
      })
      .catch((e: any) => {
        console.error(`[wake/manual] threw:`, e?.message || e);
      });
    res.status(202).json({ started: true });
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

// Semantic graph for the memory viewer (must be before /:id)
router.get("/graph", async (req, res) => {
  try {
    const category = parseMemoryCategory(req.query.category);
    const includeSuperseded = req.query.includeSuperseded === "true";
    const minSimilarity = parseNumber(req.query.minSimilarity);
    const neighbors = parseInteger(req.query.neighbors);
    const limit = parseInteger(req.query.limit);
    const scope = parseGraphScope(req.query.scope);
    const query = parseGraphQuery(req.query.q);
    let queryEmbedding: number[] | undefined;

    if (query) {
      try {
        queryEmbedding = await embed(query);
      } catch (e: any) {
        return res.status(503).json({ error: `Embedding unavailable: ${e.message}` });
      }
    }

    const graph = await getMemoryGraph({
      ...(category ? { category } : {}),
      includeSuperseded,
      ...(minSimilarity !== undefined ? { minSimilarity } : {}),
      ...(neighbors !== undefined ? { neighbors } : {}),
      ...(limit !== undefined ? { limit } : {}),
      scope,
      ...(query ? { query } : {}),
      ...(queryEmbedding ? { queryEmbedding } : {}),
    });
    res.json(graph);
  } catch (e: any) {
    console.error("[memory] graph error:", e);
    res.status(500).json({ error: e.message || "Failed to build memory graph" });
  }
});

// List all memories (without embeddings)
router.get("/", async (req, res) => {
  const sortBy = (req.query.sortBy as string) || "created_at_desc";
  const category = typeof req.query.category === "string" && req.query.category !== "all"
    ? req.query.category
    : undefined;
  const limitRaw = Number.parseInt(req.query.limit as string, 10);
  const offsetRaw = Number.parseInt(req.query.offset as string, 10);
  const hasPagination = Number.isFinite(limitRaw) || Number.isFinite(offsetRaw);

  if (hasPagination) {
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 100, 1), 500);
    const offset = Math.max(Number.isFinite(offsetRaw) ? offsetRaw : 0, 0);
    const [memories, total] = await Promise.all([
      getAllMemories(sortBy as any, { limit, offset, category }),
      getMemoryCount({ category }),
    ]);
    res.json({
      items: memories,
      total,
      limit,
      offset,
      hasMore: offset + memories.length < total,
    });
    return;
  }

  const memories = await getAllMemories(sortBy as any, { category });
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

// ---------------------------------------------------------------------------
// Memory Blocks API
// ---------------------------------------------------------------------------

// List blocks (optional filters: scope, projectId, includeInternal)
router.get("/blocks", async (_req, res) => {
  const { scope, projectId, includeInternal } = _req.query as { scope?: string; projectId?: string; includeInternal?: string };
  const blocks = listMemoryBlocks({
    scope: scope as "global" | "project" | undefined,
    projectId,
    includeInternal: includeInternal === "true",
  });
  res.json(blocks);
});

// Create block
router.post("/blocks", async (req, res) => {
  const { name, description, content, scope, projectId } = req.body;
  if (!name || !description || !content) {
    return res.status(400).json({ error: "name, description, and content are required" });
  }
  const maxChars = await getMaxBlockChars();
  if (content.length > maxChars) {
    return res.status(400).json({ error: `Content exceeds ${maxChars} character limit` });
  }
  const id = `blk-${uuid()}`;
  const now = new Date().toISOString();
  const block = createMemoryBlock({
    id,
    name,
    description,
    content,
    scope: scope || "global",
    projectId: projectId || "",
    createdAt: now,
    updatedAt: now,
    updatedBy: "user",
    supersededBy: undefined,
    supersedes: undefined,
  });
  // Blocks affect the stable prefix — invalidate all caches
  invalidateAllStablePrefixCaches();
  res.status(201).json(block);
});

// Get single block
router.get("/blocks/:id", async (req, res) => {
  const block = getMemoryBlock(req.params.id);
  if (!block) return res.status(404).json({ error: "Block not found" });
  res.json(block);
});

// Update block
router.patch("/blocks/:id", async (req, res) => {
  const { content, description, name } = req.body;
  const success = updateMemoryBlock(req.params.id, {
    content,
    description,
    name,
    updatedBy: "user",
  });
  if (!success) return res.status(404).json({ error: "Block not found" });
  invalidateAllStablePrefixCaches();
  res.json(getMemoryBlock(req.params.id));
});

// Delete block
router.delete("/blocks/:id", async (req, res) => {
  const success = deleteMemoryBlock(req.params.id);
  if (!success) return res.status(404).json({ error: "Block not found" });
  invalidateAllStablePrefixCaches();
  res.json({ deleted: true });
});

// Block history (supersession chain)
router.get("/blocks/:id/history", async (req, res) => {
  const block = getMemoryBlock(req.params.id);
  if (!block) return res.status(404).json({ error: "Block not found" });
  const history = getBlockHistory(req.params.id);
  res.json(history);
});

// ---------------------------------------------------------------------------
// Individual Memory CRUD (must come after /blocks routes)
// ---------------------------------------------------------------------------

// Get single memory
router.get("/:id", async (req, res) => {
  const memory = await getMemoryById(req.params.id);
  if (!memory) return res.status(404).json({ error: "Memory not found" });
  res.json(stripEmbedding(memory));
});

// Update memory (re-embeds if text changes)
router.patch("/:id", async (req, res) => {
  const { text, category, importance } = req.body;

  const existing = await getMemoryById(req.params.id);
  if (!existing) return res.status(404).json({ error: "Memory not found" });

  // Text change → create a new memory that supersedes the old one (preserves lineage)
  if (text !== undefined && text !== existing.text) {
    let embedding: number[];
    try {
      embedding = await embed(text);
    } catch (e: any) {
      return res.status(503).json({ error: `Embedding unavailable: ${e.message}` });
    }

    const now = new Date().toISOString();
    const newMemory: Memory = {
      id: uuid(),
      text,
      category: category ?? existing.category,
      importance: importance !== undefined
        ? Math.min(10, Math.max(1, importance))
        : existing.importance,
      embedding,
      createdAt: now,
      lastAccessed: now,
      accessCount: 0,
      sourceChatId: existing.sourceChatId,
      ...(existing.projectId ? { projectId: existing.projectId } : {}),
    };

    await addMemory(newMemory);
    const linked = await createSupersessionLink(newMemory.id, existing.id, 1.0);
    if (!linked) {
      console.log(`[memory] Manual supersession link rejected (cycle detected): ${existing.id} ↛ ${newMemory.id}`);
    }
    return res.json(stripEmbedding(newMemory));
  }

  // Non-text updates (category, importance) — edit in place
  const updates: Partial<Memory> = {};
  if (category !== undefined) updates.category = category;
  if (importance !== undefined)
    updates.importance = Math.min(10, Math.max(1, importance));

  if (Object.keys(updates).length > 0) {
    await updateMemory(req.params.id, updates);
  }

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

  // Fetch both memories to validate temporal ordering
  const newerMemory = await getMemoryById(newerMemoryId);
  const olderMemory = await getMemoryById(olderMemoryId);

  if (!newerMemory || !olderMemory) {
    return res.status(404).json({ error: "Memory not found" });
  }

  // Validate that newer memory was actually created after older memory
  if (new Date(newerMemory.createdAt) <= new Date(olderMemory.createdAt)) {
    return res.status(400).json({
      error: "Newer memory must be created after older memory",
      newerCreatedAt: newerMemory.createdAt,
      olderCreatedAt: olderMemory.createdAt,
    });
  }

  try {
    const linked = await createSupersessionLink(newerMemoryId, olderMemoryId, conf);
    if (!linked) {
      return res.status(400).json({ error: "Supersession link rejected (cycle detected)" });
    }
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
    res.json({ success: true, message: "Heuristic backfill supersession is disabled; delayed extraction now performs LLM-reviewed linking." });
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

// Conversation search (FTS5 over chat history)
router.post("/conversations/search", async (req, res) => {
  const { query, chatId, limit } = req.body;
  if (!query) return res.status(400).json({ error: "query is required" });

  const { searchChatMessages, getChatTitle } = await import("../services/chat-storage.js");

  const matches = searchChatMessages(query, { chatId, limit: limit || 10 });

  const results = matches.map(m => ({
    chatId: m.chatId,
    chatTitle: getChatTitle(m.chatId),
    messageIndex: m.messageIndex,
    role: m.role,
    content: m.content,
    rank: m.rank,
  }));

  res.json(results);
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
