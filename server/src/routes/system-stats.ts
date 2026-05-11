import { Router } from "express";
import { getHistory, getCurrent, setHistoryDuration, getHistoryDuration, setHiddenGpus, getHiddenGpus } from "../services/system-stats.js";

const router = Router();

// GET /api/system-stats — returns current stats + history buffer
router.get("/", (_req, res) => {
  try {
    res.json({
      current: getCurrent(),
      history: getHistory(),
      bufferSeconds: getHistoryDuration(),
      hiddenGpus: getHiddenGpus(),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/system-stats — update settings (buffer duration, hidden GPUs)
router.patch("/", async (req, res) => {
  try {
    const { bufferSeconds, hiddenGpus } = req.body || {};
    if (typeof bufferSeconds === "number") {
      setHistoryDuration(bufferSeconds);
    }
    if (Array.isArray(hiddenGpus)) {
      setHiddenGpus(hiddenGpus);
    }
    res.json({
      bufferSeconds: getHistoryDuration(),
      hiddenGpus: getHiddenGpus(),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
