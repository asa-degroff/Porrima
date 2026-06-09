import { Router } from "express";
import {
  listNotebookEntries,
  getNotebookEntry,
  createNotebookEntry,
  updateNotebookEntry,
  deleteNotebookEntry,
  searchNotebookEntries,
} from "../services/notebook-storage.js";
import { getSettings } from "../services/chat-storage.js";
import { extractMemoriesFromText } from "../services/memory-extraction.js";
import { saveUserImage, stripImageAttachmentData } from "../services/user-image-storage.js";
import type { ImageAttachment, NotebookEntry } from "../types.js";

const router = Router();

// Search notebook entries (both user and agent)
router.get("/search", (req, res) => {
  const { q, author, limit } = req.query;
  if (!q || typeof q !== 'string') {
    return res.status(400).json({ error: "Query parameter 'q' is required" });
  }
  const authorFilter = author === 'user' || author === 'agent' ? author : undefined;
  const numLimit = typeof limit === 'string' ? parseInt(limit, 10) : undefined;
  const results = searchNotebookEntries(q, { author: authorFilter, limit: numLimit });
  res.json({ results, query: q });
});

// Get user notebook entries
router.get("/user", async (_req, res) => {
  const index = await listNotebookEntries('user');
  res.json(index);
});

// Get agent notebook entries
router.get("/agent", async (_req, res) => {
  const index = await listNotebookEntries('agent');
  res.json(index);
});

// Bulk fetch entries (accepts POST with { entries: [{ author, id }] })
router.post("/bulk", async (req, res) => {
  const { entries } = req.body;
  if (!Array.isArray(entries)) {
    return res.status(400).json({ error: "entries array required" });
  }
  
  const results: Record<string, NotebookEntry | null> = {};
  for (const entry of entries) {
    if (!entry.author || !entry.id) continue;
    if (entry.author !== 'user' && entry.author !== 'agent') continue;
    const fullEntry = await getNotebookEntry(entry.author as 'user' | 'agent', entry.id);
    results[entry.id] = fullEntry;
  }
  
  res.json(results);
});

// Get single entry
router.get("/:author/:id", async (req, res) => {
  const { author, id } = req.params;
  if (author !== 'user' && author !== 'agent') {
    return res.status(400).json({ error: "Invalid author" });
  }
  const entry = await getNotebookEntry(author as 'user' | 'agent', id);
  if (!entry) return res.status(404).json({ error: "Entry not found" });
  res.json(entry);
});

// Create user entry
router.post("/user", async (req, res) => {
  const { content, images } = req.body;
  if (!content) return res.status(400).json({ error: "Content required" });
  
  const entry = await createNotebookEntry('user', content);

  // Persist images if provided
  if (images?.length) {
    const persistedImages: ImageAttachment[] = [];
    for (const img of images) {
      if (img.id && img.url && img.thumbUrl) {
        persistedImages.push(stripImageAttachmentData(img));
        continue;
      }
      try {
        if (!img.data) {
          persistedImages.push(img);
          continue;
        }
        const buffer = Buffer.from(img.data, "base64");
        const id = crypto.randomUUID();
        const record = await saveUserImage(id, buffer, img.mimeType, img.name);
        persistedImages.push({
          mimeType: img.mimeType,
          name: img.name,
          id: record.id,
          url: record.url,
          thumbUrl: record.thumbUrl,
        });
      } catch (e) {
        console.error("[notebook] Failed to persist image:", e);
        persistedImages.push(img);
      }
    }
    entry.images = persistedImages;
    await updateNotebookEntry('user', entry.id, { images: persistedImages });
  }

  // Auto-extract memories from user entry (fire-and-forget)
  const settings = await getSettings();
  const modelId = settings.extractionModelId || settings.defaultModelId;
  extractMemoriesFromText(modelId, content, 'user', entry.id).catch(e =>
    console.error("[notebook] User entry memory extraction failed:", e)
  );

  res.status(201).json(entry);
});

// NOTE: The manual agent review trigger endpoint was removed.
// Agent notebook writing now happens via the automation/synthesis system.

// Update entry (add links, edit content, attach images)
router.patch("/:author/:id", async (req, res) => {
  const { author, id } = req.params;
  if (author !== 'user' && author !== 'agent') {
    return res.status(400).json({ error: "Invalid author" });
  }

  // Allowlist mutable fields only
  const { content, links, images } = req.body;
  const updates: Record<string, unknown> = {};
  if (content !== undefined) updates.content = content;
  if (links !== undefined) updates.links = links;
  if (images !== undefined) updates.images = images;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No valid fields to update" });
  }

  const entry = await updateNotebookEntry(author as 'user' | 'agent', id, updates);
  if (!entry) return res.status(404).json({ error: "Entry not found" });
  res.json(entry);
});

// Delete entry
router.delete("/:author/:id", async (req, res) => {
  const { author, id } = req.params;
  if (author !== 'user' && author !== 'agent') {
    return res.status(400).json({ error: "Invalid author" });
  }
  
  const deleted = await deleteNotebookEntry(author as 'user' | 'agent', id);
  if (!deleted) return res.status(404).json({ error: "Entry not found" });
  res.status(204).end();
});

export default router;
