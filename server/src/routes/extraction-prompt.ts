import express from "express";
import {
  loadExtractionPrompt,
  saveExtractionPrompt,
  listExtractionPromptHistory,
  getExtractionPromptVersion,
  getExtractionPromptPath,
} from "../services/extraction-prompt-store.js";

const router = express.Router();

/**
 * GET /api/extraction-prompt
 * Get the current extraction prompt document.
 */
router.get("/", async (_req, res) => {
  try {
    const prompt = await loadExtractionPrompt();
    res.json({
      content: prompt.content,
      lastModified: prompt.lastModified,
      path: getExtractionPromptPath(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/extraction-prompt
 * Update the extraction prompt document.
 */
router.put("/", async (req, res) => {
  try {
    const { content, reason } = req.body;
    if (!content) {
      return res.status(400).json({ error: "Content is required" });
    }
    await saveExtractionPrompt(content, reason || "Manual update via API");
    const prompt = await loadExtractionPrompt();
    res.json({
      content: prompt.content,
      lastModified: prompt.lastModified,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/extraction-prompt/history
 * List all historical versions.
 */
router.get("/history", async (_req, res) => {
  try {
    const versions = await listExtractionPromptHistory();
    res.json({ versions });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/extraction-prompt/history/:filename
 * Get a specific historical version.
 */
router.get("/history/:filename", async (req, res) => {
  try {
    const { filename } = req.params;
    const content = await getExtractionPromptVersion(filename);
    if (!content) {
      return res.status(404).json({ error: "Version not found" });
    }
    res.json({ filename, content });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
