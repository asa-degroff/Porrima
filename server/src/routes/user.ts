import express from "express";
import {
  loadUserDocument,
  saveUserDocument,
  deleteUserDocument,
  getUserFilePath,
} from "../services/user-store.js";

const router = express.Router();

/**
 * GET /api/user
 * Get the user document (returns 404 if not set - it's optional).
 */
router.get("/", async (_req, res) => {
  try {
    const userDoc = await loadUserDocument();
    if (!userDoc) {
      return res.status(404).json({ error: "User document not set" });
    }
    res.json({
      content: userDoc.content,
      lastModified: userDoc.lastModified,
      path: getUserFilePath(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/user
 * Create or update the user document.
 */
router.put("/", async (req, res) => {
  try {
    const { content } = req.body;
    if (!content) {
      return res.status(400).json({ error: "Content is required" });
    }
    await saveUserDocument(content);
    const userDoc = await loadUserDocument();
    res.json({
      content: userDoc?.content,
      lastModified: userDoc?.lastModified,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/user
 * Delete the user document.
 */
router.delete("/", async (_req, res) => {
  try {
    await deleteUserDocument();
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
