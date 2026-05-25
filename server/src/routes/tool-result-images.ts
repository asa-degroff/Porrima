import { createReadStream } from "fs";
import { access } from "fs/promises";
import { join } from "path";
import { Router } from "express";
import { getToolResultImageDir } from "../services/tool-result-image-storage.js";

const router = Router();

router.get("/:id/image.:ext", async (req, res) => {
  const ext = req.params.ext.toLowerCase();
  const validExts = ["jpg", "jpeg", "png", "webp", "gif", "jxl", "bin"];
  if (!validExts.includes(ext)) {
    return res.status(400).json({ error: "Invalid extension" });
  }

  const imagePath = join(getToolResultImageDir(req.params.id), `image.${ext}`);
  try {
    await access(imagePath);
    const contentType =
      ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
      ext === "bin" ? "application/octet-stream" :
      `image/${ext}`;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    createReadStream(imagePath).pipe(res);
  } catch {
    res.status(404).json({ error: "Image not found" });
  }
});

export default router;
