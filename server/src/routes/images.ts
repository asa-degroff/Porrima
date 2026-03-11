import { Router } from "express";
import { getComfyUIStatus, getComfyUIModels, generateImageWithState } from "../services/comfyui.js";
import { saveGeneratedImage, getImagePath, getThumbPath, ensureThumbnail, getImageMetadata, listImages, deleteImage } from "../services/image-storage.js";
import {
  loadGenerations,
  createGeneration,
  getGeneration,
  getAllGenerations,
  linkComfyUIIds,
  updateProgress,
  completeGeneration,
  failGeneration,
  subscribeToGeneration,
  cleanupOldGenerations,
} from "../services/image-generation.js";
import { access } from "fs/promises";
import { createReadStream } from "fs";
import type { ImageGenerationParams } from "../types.js";

const router = Router();

// Load persisted generations on startup
loadGenerations().then(() => cleanupOldGenerations());

// Static paths BEFORE /:id param route

router.get("/status", async (_req, res) => {
  try {
    const status = await getComfyUIStatus();
    res.json(status);
  } catch (e: any) {
    res.json({ available: false, queueSize: 0, models: [] });
  }
});

router.get("/list", async (_req, res) => {
  try {
    const images = await listImages();
    res.json(images);
  } catch {
    res.json([]);
  }
});

router.get("/models", async (_req, res) => {
  try {
    const models = await getComfyUIModels();
    res.json(models);
  } catch {
    res.json([]);
  }
});

// Get all generations (for recovery)
router.get("/generations", async (_req, res) => {
  const generations = getAllGenerations();
  res.json(generations);
});

// SSE endpoint to subscribe to a specific generation's progress
router.get("/generation/:id/events", async (req, res) => {
  const { id } = req.params;
  const generation = getGeneration(id);

  if (!generation) {
    return res.status(404).json({ error: "Generation not found" });
  }

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Send current state immediately so client knows where we are
  res.write(`event: state\ndata: ${JSON.stringify(generation)}\n\n`);

  // Subscribe to updates
  const unsubscribe = subscribeToGeneration(id, (state) => {
    res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
  });

  // Keepalive every 15s
  const keepalive = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 15_000);

  req.on("close", () => {
    clearInterval(keepalive);
    unsubscribe();
  });
});

router.post("/generate", async (req, res) => {
  const params = req.body as ImageGenerationParams;
  const chatId = req.body.chatId as string | undefined;

  if (!params.positivePrompt) {
    return res.status(400).json({ error: "positivePrompt is required" });
  }

  // Create generation state
  const generation = createGeneration(params, chatId);

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Send generation ID immediately so client can re-subscribe if disconnected
  res.write(`event: started\ndata: ${JSON.stringify({ id: generation.id })}\n\n`);

  // Send keepalive comments every 15s to prevent Cloudflare Tunnel
  // from dropping the connection during model loading (100s idle timeout)
  const keepalive = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 15_000);

  try {
    const result = await generateImageWithState(
      generation.id,
      generation.clientId,
      params,
      (promptId) => {
        linkComfyUIIds(generation.id, promptId);
      },
      (progress) => {
        updateProgress(generation.id, progress.step, progress.totalSteps);
        res.write(
          `event: progress\ndata: ${JSON.stringify({ step: progress.step, totalSteps: progress.totalSteps })}\n\n`
        );
      }
    );

    const id = crypto.randomUUID();
    const url = await saveGeneratedImage(id, result.imageData, {
      params,
      resolvedSeed: result.resolvedSeed,
      createdAt: new Date().toISOString(),
      chatId,
    });

    const image = {
      id,
      url,
      params,
      resolvedSeed: result.resolvedSeed,
      createdAt: new Date().toISOString(),
      chatId,
    };

    // Mark generation as complete with the image URL
    completeGeneration(generation.id, url);

    res.write(`event: done\ndata: ${JSON.stringify({ image, generationId: generation.id })}\n\n`);
  } catch (e: any) {
    failGeneration(generation.id, e.message);
    res.write(
      `event: error\ndata: ${JSON.stringify({ error: e.message, generationId: generation.id })}\n\n`
    );
  } finally {
    clearInterval(keepalive);
    res.end();
  }
});

// Param routes

router.delete("/:id", async (req, res) => {
  try {
    const deleted = await deleteImage(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: "Image not found" });
    }
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/:id/thumb", async (req, res) => {
  const thumbPath = getThumbPath(req.params.id);
  try {
    await access(thumbPath);
  } catch {
    // Generate thumbnail on-the-fly for older images
    const created = await ensureThumbnail(req.params.id);
    if (!created) {
      // Fall back to full image
      const imagePath = getImagePath(req.params.id);
      try {
        await access(imagePath);
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        createReadStream(imagePath).pipe(res);
        return;
      } catch {
        return res.status(404).json({ error: "Image not found" });
      }
    }
  }
  res.setHeader("Content-Type", "image/webp");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  createReadStream(thumbPath).pipe(res);
});

router.get("/:id", async (req, res) => {
  const imagePath = getImagePath(req.params.id);
  try {
    await access(imagePath);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    createReadStream(imagePath).pipe(res);
  } catch {
    res.status(404).json({ error: "Image not found" });
  }
});

router.get("/:id/metadata", async (req, res) => {
  const metadata = await getImageMetadata(req.params.id);
  if (!metadata) {
    return res.status(404).json({ error: "Image not found" });
  }
  res.json(metadata);
});

export default router;
