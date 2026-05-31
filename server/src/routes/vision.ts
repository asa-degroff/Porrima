import { Router } from "express";
import {
  analyzeImage,
  analyzeImageStream,
  chatAboutImage,
  saveAnalyzedImage,
  getAnalyzedImages,
  getAnalyzedImage,
  updateAnalyzedImage,
  deleteAnalyzedImage,
  getPresets,
  getVisionThumbPath,
  ensureVisionThumbnail,
} from "../services/vision-analysis.js";
import { deleteCorpusEntryByVisionId } from "../services/image-corpus.js";
import { appDataPath } from "../services/paths.js";

const router = Router();

// Get all analyzed images
router.get("/images", async (_req, res) => {
  try {
    const images = await getAnalyzedImages();
    // Don't send imageData in list view (too large)
    const sanitized = images.map(({ imageData, ...rest }) => rest);
    res.json(sanitized);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Get single analyzed image (strip imageData — client uses the URL, chat reads from disk)
router.get("/images/:id", async (req, res) => {
  try {
    const image = await getAnalyzedImage(req.params.id);
    if (!image) {
      return res.status(404).json({ error: "Image not found" });
    }
    const { imageData: _, ...sanitized } = image;
    res.json(sanitized);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Analyze and save an image (non-streaming, returns complete result)
router.post("/analyze", async (req, res) => {
  try {
    const { imageData, preset, model } = req.body as {
      imageData: string;
      preset: string;
      model?: string;
    };

    if (!imageData) {
      return res.status(400).json({ error: "imageData is required" });
    }

    const result = await analyzeImage(imageData, preset || "detailed", model);
    const filename = `image-${Date.now()}.png`;
    const saved = await saveAnalyzedImage(
      filename,
      imageData,
      result.description,
      result.preset,
      result.model
    );

    // Don't send imageData in response
    const { imageData: _, ...sanitized } = saved;
    res.json(sanitized);
  } catch (e: any) {
    console.error("Vision analysis error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Analyze image with SSE streaming
router.post("/analyze-stream", async (req, res) => {
  try {
    const { imageData, preset, model } = req.body as {
      imageData: string;
      preset: string;
      model?: string;
    };

    if (!imageData) {
      return res.status(400).json({ error: "imageData is required" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("X-Content-Type-Options", "nosniff");

    // Flush headers immediately to keep connection alive
    res.flushHeaders();

    await analyzeImageStream(
      imageData,
      preset || "detailed",
      model,
      (event) => {
        res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
        // Flush chunk if available (requires compression middleware)
        (res as any).flush?.();
      }
    );

    // Ensure the last event is flushed before ending
    (res as any).flush?.();
    res.end();
  } catch (e: any) {
    console.error("Vision stream error:", e);
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    }
  }
});

// Save an already-analyzed image (used after streaming analysis completes)
router.post("/save", async (req, res) => {
  try {
    const { imageData, description, preset, model, chatId, projectId } = req.body as {
      imageData: string;
      description: string;
      preset: string;
      model: string;
      chatId?: string;
      projectId?: string;
    };

    if (!imageData || !description) {
      return res.status(400).json({ error: "imageData and description are required" });
    }

    const filename = `image-${Date.now()}.png`;
    const saved = await saveAnalyzedImage(filename, imageData, description, preset, model, chatId, projectId);
    const { imageData: _, ...sanitized } = saved;
    res.json(sanitized);
  } catch (e: any) {
    console.error("Vision save error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Chat about an image
router.post("/images/:id/chat", async (req, res) => {
  try {
    const { message, model } = req.body as { message: string; model?: string };
    const image = await getAnalyzedImage(req.params.id);

    if (!image) {
      return res.status(404).json({ error: "Image not found" });
    }

    if (!message) {
      return res.status(400).json({ error: "message is required" });
    }

    const response = await chatAboutImage(
      image.imageData,
      image.conversation,
      message,
      image.preset,
      image.description,
      model || image.model
    );

    // Add to conversation history
    const updatedConversation = [
      ...image.conversation,
      { role: "user" as const, content: message, timestamp: Date.now() },
      { role: "assistant" as const, content: response, timestamp: Date.now() },
    ];

    await updateAnalyzedImage(req.params.id, {
      conversation: updatedConversation,
    });

    res.json({ response });
  } catch (e: any) {
    console.error("Vision chat error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Delete an analyzed image
router.delete("/images/:id", async (req, res) => {
  try {
    const deleted = await deleteAnalyzedImage(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: "Image not found" });
    }
    
    // Also remove from corpus to prevent stale references
    await deleteCorpusEntryByVisionId(req.params.id);
    
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Re-analyze with different preset (streaming)
router.post("/images/:id/reanalyze", async (req, res) => {
  try {
    const { preset, stream, model } = req.body as { preset: string; stream?: boolean; model?: string };
    const image = await getAnalyzedImage(req.params.id);

    if (!image) {
      return res.status(404).json({ error: "Image not found" });
    }

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      const result = await analyzeImageStream(
        image.imageData,
        preset || "detailed",
        model || image.model,
        (event) => {
          res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
        }
      );

      const updated = await updateAnalyzedImage(req.params.id, {
        description: result.description,
        preset: result.preset,
        model: result.model,
        conversation: [],
      });

      const { imageData: _, ...sanitized } = updated!;
      res.write(`event: reanalyze_complete\ndata: ${JSON.stringify(sanitized)}\n\n`);
      (res as any).flush?.();
      res.end();
    } else {
      const result = await analyzeImage(image.imageData, preset || "detailed", model || image.model);

      const updated = await updateAnalyzedImage(req.params.id, {
        description: result.description,
        preset: result.preset,
        model: result.model,
        conversation: [],
      });

      const { imageData: _, ...sanitized } = updated!;
      res.json(sanitized);
    }
  } catch (e: any) {
    console.error("Vision re-analyze error:", e);
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    }
  }
});

// Get available presets
router.get("/presets", async (_req, res) => {
  try {
    const presets = getPresets();
    res.json(presets);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Serve thumbnail
router.get("/images/:id/thumb", async (req, res) => {
  const { createReadStream } = await import("fs");
  const { access } = await import("fs/promises");

  const thumbPath = getVisionThumbPath(req.params.id);
  try {
    await access(thumbPath);
  } catch {
    const created = await ensureVisionThumbnail(req.params.id);
    if (!created) {
      return res.status(404).json({ error: "Thumbnail not available" });
    }
  }
  res.setHeader("Content-Type", "image/webp");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  createReadStream(thumbPath).pipe(res);
});

// Serve image files
router.get("/images/:id/:filename", async (req, res) => {
  const { createReadStream } = await import("fs");
  const { access } = await import("fs/promises");
  const { join } = await import("path");
  const visionDir = appDataPath("vision");

  const imagePath = join(
    visionDir,
    "images",
    req.params.id,
    req.params.filename
  );

  try {
    await access(imagePath);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    createReadStream(imagePath).pipe(res);
  } catch {
    res.status(404).json({ error: "Image not found" });
  }
});

export default router;
