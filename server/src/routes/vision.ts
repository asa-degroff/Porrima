import { Router } from "express";
import {
  analyzeImage,
  chatAboutImage,
  saveAnalyzedImage,
  getAnalyzedImages,
  getAnalyzedImage,
  updateAnalyzedImage,
  deleteAnalyzedImage,
  getPresets,
} from "../services/vision-analysis.js";

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

// Get single analyzed image (with imageData for chat)
router.get("/images/:id", async (req, res) => {
  try {
    const image = await getAnalyzedImage(req.params.id);
    if (!image) {
      return res.status(404).json({ error: "Image not found" });
    }
    res.json(image);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Analyze and save an image
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

// Chat about an image
router.post("/images/:id/chat", async (req, res) => {
  try {
    const { message } = req.body as { message: string };
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
      image.model
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
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Re-analyze with different preset
router.post("/images/:id/reanalyze", async (req, res) => {
  try {
    const { preset } = req.body as { preset: string };
    const image = await getAnalyzedImage(req.params.id);

    if (!image) {
      return res.status(404).json({ error: "Image not found" });
    }

    const result = await analyzeImage(image.imageData, preset || "detailed", image.model);

    const updated = await updateAnalyzedImage(req.params.id, {
      description: result.description,
      preset: result.preset,
      model: result.model,
      conversation: [], // Reset conversation on re-analyze
    });

    const { imageData: _, ...sanitized } = updated!;
    res.json(sanitized);
  } catch (e: any) {
    console.error("Vision re-analyze error:", e);
    res.status(500).json({ error: e.message });
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

// Serve image files
router.get("/images/:id/:filename", async (req, res) => {
  const { createReadStream } = await import("fs");
  const { access } = await import("fs/promises");
  const { join } = await import("path");
  const visionDir = join(
    process.env.HOME || process.env.USERPROFILE || ".",
    ".quje-agent",
    "vision"
  );

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
