import { Router } from "express";
import { getBrowserFrame } from "../services/browser-frames.js";
import { getBrowserSessionSnapshot } from "../services/browser-session.js";

const router = Router();

/**
 * Serve one auto-captured browser action frame from the in-memory ring.
 * These are observability bytes, not conversation content — bounded per chat,
 * cleared when the browser session closes, never on disk.
 */
router.get("/frame/:chatId/:frameId", (req, res) => {
  const frame = getBrowserFrame(req.params.chatId, req.params.frameId);
  if (!frame) {
    return res.status(404).json({ error: "Browser frame not found or expired" });
  }
  res.setHeader("Content-Type", "image/png");
  // frameId is a fresh uuid per capture, so the bytes never change under it.
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.send(frame.png);
});

/**
 * Current browser-session state for a chat: attached/launched mode, active
 * page URL, remote-debugging consent wait, and the newest frame in the ring.
 * Read by the live viewer to hydrate on chat open or after a reconnect.
 */
router.get("/status/:chatId", (req, res) => {
  res.json(getBrowserSessionSnapshot(req.params.chatId));
});

export default router;
