import { Router } from "express";
import { deleteUserImage, getUserImageDir } from "../services/user-image-storage.js";
import { getChat, saveChat } from "../services/chat-storage.js";
import { access } from "fs/promises";
import { createReadStream } from "fs";
import { join } from "path";

const router = Router();

/**
 * DELETE /chat/:chatId/image/:imageId
 * Remove a user-attached image
 */
router.delete("/chat/:chatId/image/:imageId", async (req, res) => {
  const { chatId, imageId } = req.params;
  const chat = await getChat(chatId);
  if (!chat) {
    return res.status(404).json({ error: "Chat not found" });
  }

  const deleted = await deleteUserImage(imageId);
  if (!deleted) {
    return res.status(404).json({ error: "Image not found" });
  }

  for (const msg of chat.messages) {
    if (msg.images) {
      msg.images = msg.images.filter(img => img.id !== imageId);
    }
  }

  await saveChat(chat);
  res.json({ success: true });
});

/**
 * GET /:id/thumb
 * Serve thumbnail (WebP)
 */
router.get("/:id/thumb", async (req, res) => {
  const thumbPath = join(getUserImageDir(req.params.id), "thumb.webp");
  try {
    await access(thumbPath);
    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    createReadStream(thumbPath).pipe(res);
  } catch {
    res.status(404).json({ error: "Thumbnail not found" });
  }
});

/**
 * GET /:id/image.:ext
 * Serve full-resolution image
 */
router.get("/:id/image.:ext", async (req, res) => {
  const dir = getUserImageDir(req.params.id);
  const ext = req.params.ext;
  const validExts = ["jpg", "jpeg", "png", "webp", "gif"];
  if (!validExts.includes(ext)) {
    return res.status(400).json({ error: "Invalid extension" });
  }

  const imagePath = join(dir, `image.${ext}`);
  try {
    await access(imagePath);
    const contentType = `image/${ext === "jpg" || ext === "jpeg" ? "jpeg" : ext}`;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    createReadStream(imagePath).pipe(res);
  } catch {
    res.status(404).json({ error: "Image not found" });
  }
});

export default router;
