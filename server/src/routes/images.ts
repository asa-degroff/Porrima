import { Router } from "express";
import { getImageBackend, getImageBackendByName } from "../services/image-backend.js";
import { saveGeneratedImage, getImagePath, getImagePathPNG, getThumbPath, ensureThumbnail, getImageMetadata, listImages, deleteImage, toggleImageFavorite } from "../services/image-storage.js";
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
import { searchCorpusHybrid, deleteCorpusEntryByImagePath } from "../services/image-corpus.js";
import { access } from "fs/promises";
import { createReadStream } from "fs";
import type { ImageGenerationParams } from "../types.js";

const router = Router();

// Load persisted generations on startup
loadGenerations().then(() => cleanupOldGenerations());

// Static paths BEFORE /:id param route

router.get("/status", async (req, res) => {
  try {
    const backendParam = typeof req.query.backend === "string" ? req.query.backend : undefined;
    const overrideUrl = typeof req.query.url === "string" ? req.query.url : undefined;
    const backend = backendParam
      ? await getImageBackendByName(backendParam)
      : await getImageBackend();
    const status = await backend.getStatus(overrideUrl);
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

router.post("/search", async (req, res) => {
  try {
    const { query, limit } = req.body as { query: string; limit?: number };
    console.log("[images] search request:", { query, limit });
    if (!query) {
      return res.status(400).json({ error: "query is required" });
    }
    const corpusResults = await searchCorpusHybrid(query, limit || 20);
    console.log("[images] search results:", corpusResults.length);

    // Transform corpus entries into GeneratedImage-compatible shape.
    // Generated images: imagePath is the storage ID, served at /api/images/{id}
    // Analyzed images: imagePath is "vision/images/{visionId}/{filename}", served at /api/vision/images/{visionId}
    const results = await Promise.all(corpusResults.map(async (entry) => {
      // Analyzed images: visionId is the canonical key, but fall back to parsing imagePath
      const visionId = entry.visionId || (entry.type === "analyzed" ? entry.imagePath.split("/")[2] : null);
      if (entry.type === "analyzed" && visionId) {
        return {
          id: visionId,
          url: `/api/vision/images/${visionId}`,
          params: { positivePrompt: entry.description || "", negativePrompt: "", model: "", steps: 0, cfg: 0, width: 0, height: 0 },
          resolvedSeed: 0,
          createdAt: new Date(entry.createdAt).toISOString(),
          chatId: entry.chatId,
          description: entry.description,
          type: entry.type,
          score: entry.score,
        };
      }

      // Generated images — imagePath is the image storage ID
      const imageId = entry.imagePath;
      const metadata = await getImageMetadata(imageId);
      return {
        id: imageId,
        url: `/api/images/${imageId}`,
        params: metadata?.params ?? { positivePrompt: entry.prompt ?? "", negativePrompt: "", model: "", steps: 0, cfg: 0, width: 0, height: 0 },
        resolvedSeed: metadata?.resolvedSeed ?? 0,
        createdAt: metadata?.createdAt ?? new Date(entry.createdAt).toISOString(),
        chatId: entry.chatId,
        description: entry.description,
        type: entry.type,
        score: entry.score,
        generatedBy: metadata?.generatedBy ?? 'user',
      };
    }));

    res.json(results);
  } catch (e: any) {
    console.error("[images] search error:", e);
    res.status(500).json({ error: e.message });
  }
});

router.get("/models", async (req, res) => {
  try {
    const backend = await getImageBackend();
    const overrideUrl = typeof req.query.url === "string" ? req.query.url : undefined;
    const models = await backend.getModels(overrideUrl);
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
    const backend = await getImageBackend();
    const result = await backend.generate(
      generation.id,
      generation.clientId,
      params,
      (jobId) => {
        linkComfyUIIds(generation.id, jobId);
      },
      (progress) => {
        updateProgress(generation.id, progress.step, progress.totalSteps);
        res.write(
          `event: progress\ndata: ${JSON.stringify({ step: progress.step, totalSteps: progress.totalSteps })}\n\n`
        );
      },
      (status) => {
        res.write(
          `event: status\ndata: ${JSON.stringify(status)}\n\n`
        );
      }
    );

    const id = crypto.randomUUID();
    const url = await saveGeneratedImage(id, result.imageData, {
      params,
      resolvedSeed: result.resolvedSeed,
      createdAt: new Date().toISOString(),
      chatId,
      generatedBy: 'user',
    });

    const image = {
      id,
      url,
      params,
      resolvedSeed: result.resolvedSeed,
      createdAt: new Date().toISOString(),
      chatId,
      generatedBy: 'user',
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
    
    // Also remove from corpus — use imagePath lookup since corpus entry ID ≠ image ID
    await deleteCorpusEntryByImagePath(req.params.id);
    
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
  const imagePathPNG = getImagePathPNG(req.params.id);
  
  try {
    // Try JXL first (new format), fall back to PNG for older images
    let filePath: string;
    let contentType: string;
    
    try {
      await access(imagePath);
      filePath = imagePath;
      contentType = "image/jxl";
    } catch {
      await access(imagePathPNG);
      filePath = imagePathPNG;
      contentType = "image/png";
    }
    
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    createReadStream(filePath).pipe(res);
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

router.post("/:id/favorite", async (req, res) => {
  try {
    const newFavoriteState = await toggleImageFavorite(req.params.id);
    if (newFavoriteState === null) {
      return res.status(404).json({ error: "Image not found" });
    }
    res.json({ success: true, isFavorite: newFavoriteState });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
