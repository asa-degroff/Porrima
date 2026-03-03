import express from "express";
import {
  loadPersona,
  savePersona,
  listPersonaHistory,
  getPersonaVersion,
  getPersonaPath,
} from "../services/persona-store.js";

const router = express.Router();

/**
 * GET /api/persona
 * Get the current persona document.
 */
router.get("/", async (_req, res) => {
  try {
    const persona = await loadPersona();
    res.json({
      content: persona.content,
      lastModified: persona.lastModified,
      path: getPersonaPath(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/persona
 * Update the entire persona document.
 */
router.put("/", async (req, res) => {
  try {
    const { content, reason } = req.body;
    if (!content) {
      return res.status(400).json({ error: "Content is required" });
    }
    await savePersona(content, reason || "Manual update via API");
    const persona = await loadPersona();
    res.json({
      content: persona.content,
      lastModified: persona.lastModified,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/persona/history
 * List all historical persona versions.
 */
router.get("/history", async (_req, res) => {
  try {
    const versions = await listPersonaHistory();
    res.json({ versions });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/persona/history/:filename
 * Get a specific historical version.
 */
router.get("/history/:filename", async (req, res) => {
  try {
    const { filename } = req.params;
    const content = await getPersonaVersion(filename);
    if (!content) {
      return res.status(404).json({ error: "Version not found" });
    }
    res.json({ filename, content });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
