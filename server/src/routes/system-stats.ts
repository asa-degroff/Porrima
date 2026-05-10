import { Router } from "express";
import { getHistory, getCurrent, setHistoryDuration, getHistoryDuration } from "../services/system-stats.js";

const router = Router();

// GET /api/system-stats — returns current stats + history buffer
router.get("/", (_req, res) => {
  try {
    res.json({
      current: getCurrent(),
      history: getHistory(),
      bufferSeconds: getHistoryDuration(),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/system-stats — update settings (buffer duration)
router.patch("/", async (req, res) => {
  try {
    const { bufferSeconds } = req.body || {};
    if (typeof bufferSeconds === "number") {
      setHistoryDuration(bufferSeconds);
    }
    res.json({ bufferSeconds: getHistoryDuration() });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
