import { Router } from "express";
import {
  getCorpus,
  getAllCorpusEntries,
  getCorpusEntry,
  getCorpusStats,
  searchCorpusByElement,
  getCorpusByChat,
  getCorpusByProject,
  enrichCorpusBatch,
} from "../services/image-corpus.js";
import { getSettings } from "../services/chat-storage.js";

const router = Router();

// GET /api/image-corpus - List all corpus entries
router.get("/", async (req, res) => {
  try {
    const entries = await getAllCorpusEntries();
    res.json(entries);
  } catch (err) {
    console.error("[image-corpus] list error:", err);
    res.status(500).json({ error: "Failed to list corpus entries" });
  }
});

// GET /api/image-corpus/stats - Get corpus statistics
router.get("/stats", async (req, res) => {
  try {
    const stats = await getCorpusStats();
    res.json(stats);
  } catch (err) {
    console.error("[image-corpus] stats error:", err);
    res.status(500).json({ error: "Failed to get corpus stats" });
  }
});

// GET /api/image-corpus/:id - Get single corpus entry
router.get("/:id", async (req, res) => {
  try {
    const entry = await getCorpusEntry(req.params.id);
    if (!entry) {
      return res.status(404).json({ error: "Entry not found" });
    }
    res.json(entry);
  } catch (err) {
    console.error("[image-corpus] get error:", err);
    res.status(500).json({ error: "Failed to get corpus entry" });
  }
});

// GET /api/image-corpus/element/:type/:value - Search by element
router.get("/element/:type/:value", async (req, res) => {
  try {
    const entries = await searchCorpusByElement(
      req.params.type,
      req.params.value
    );
    res.json(entries);
  } catch (err) {
    console.error("[image-corpus] element search error:", err);
    res.status(500).json({ error: "Failed to search by element" });
  }
});

// GET /api/image-corpus/chat/:chatId - Get entries by chat
router.get("/chat/:chatId", async (req, res) => {
  try {
    const entries = await getCorpusByChat(req.params.chatId);
    res.json(entries);
  } catch (err) {
    console.error("[image-corpus] chat search error:", err);
    res.status(500).json({ error: "Failed to get entries by chat" });
  }
});

// GET /api/image-corpus/project/:projectId - Get entries by project
router.get("/project/:projectId", async (req, res) => {
  try {
    const entries = await getCorpusByProject(req.params.projectId);
    res.json(entries);
  } catch (err) {
    console.error("[image-corpus] project search error:", err);
    res.status(500).json({ error: "Failed to get entries by project" });
  }
});

// POST /api/image-corpus/enrich - Trigger batch enrichment
router.post("/enrich", async (req, res) => {
  try {
    const settings = await getSettings();
    const extractionModelId = settings.extractionModelId || settings.defaultModelId;
    const batchSize = req.body.batchSize || 10;
    const enrichedCount = await enrichCorpusBatch(batchSize, extractionModelId);
    res.json({ enrichedCount, batchSize });
  } catch (err) {
    console.error("[image-corpus] enrich error:", err);
    res.status(500).json({ error: "Failed to enrich corpus" });
  }
});

export default router;
