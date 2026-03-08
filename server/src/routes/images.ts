import { Router } from "express";
import { getComfyUIStatus, getComfyUIModels, generateImage } from "../services/comfyui.js";
import { saveGeneratedImage, getImagePath, getImageMetadata } from "../services/image-storage.js";
import { v4 as uuid } from "uuid";
import { access } from "fs/promises";
import { createReadStream } from "fs";
import type { ImageGenerationParams } from "../types.js";

const router = Router();

// Static paths BEFORE /:id param route

router.get("/status", async (_req, res) => {
  try {
    const status = await getComfyUIStatus();
    res.json(status);
  } catch (e: any) {
    res.json({ available: false, queueSize: 0, models: [] });
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

router.post("/generate", async (req, res) => {
  const params = req.body as ImageGenerationParams;

  if (!params.positivePrompt) {
    return res.status(400).json({ error: "positivePrompt is required" });
  }

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Send keepalive comments every 15s to prevent Cloudflare Tunnel
  // from dropping the connection during model loading (100s idle timeout)
  const keepalive = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 15_000);

  try {
    const result = await generateImage(params, (progress) => {
      res.write(
        `event: progress\ndata: ${JSON.stringify({ step: progress.step, totalSteps: progress.totalSteps })}\n\n`
      );
    });

    const id = uuid();
    const url = await saveGeneratedImage(id, result.imageData, {
      params,
      resolvedSeed: result.resolvedSeed,
      createdAt: new Date().toISOString(),
    });

    const image = {
      id,
      url,
      params,
      resolvedSeed: result.resolvedSeed,
      createdAt: new Date().toISOString(),
    };

    res.write(`event: done\ndata: ${JSON.stringify({ image })}\n\n`);
  } catch (e: any) {
    res.write(
      `event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`
    );
  } finally {
    clearInterval(keepalive);
    res.end();
  }
});

// Param routes

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
