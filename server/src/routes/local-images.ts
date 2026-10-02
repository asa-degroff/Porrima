import { createReadStream } from "fs";
import { Router } from "express";
import { resolveLocalImageRequest } from "../services/local-image-serving.js";

const router = Router();

/**
 * Serve an image referenced by local filesystem path in markdown.
 * `path` may be absolute, `~/...`, or a `file://` URL; validation (allowed
 * roots, magic-byte type check, size cap) lives in local-image-serving.ts.
 */
router.get("/", async (req, res) => {
  const rawPath = typeof req.query.path === "string" ? req.query.path : "";
  if (!rawPath) {
    return res.status(400).json({ error: "Missing path parameter" });
  }

  const resolution = await resolveLocalImageRequest(rawPath);
  if (!resolution.ok) {
    return res.status(resolution.status).json({ error: resolution.error });
  }

  res.setHeader("Content-Type", resolution.mimeType);
  res.setHeader("Content-Length", resolution.size);
  res.setHeader("Cache-Control", "private, max-age=60");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const stream = createReadStream(resolution.path);
  stream.on("error", (error) => {
    // The file can vanish between resolution and streaming (scratch files are
    // routinely cleaned up). Without this handler the stream error would
    // become an uncaught exception and take the server down.
    if (res.headersSent) {
      res.destroy(error);
    } else {
      res.status(404).json({ error: "Image not found" });
    }
  });
  stream.pipe(res);
});

export default router;
