import { Router } from "express";
import type { Request, Response } from "express";
import { getAllModelSummaries, getModelRuns, clearModelStats } from "../services/model-stats.js";
import { getSettings } from "../services/chat-storage.js";
import { fetchVllmCacheMetrics } from "../services/vllm-metrics.js";
import { getVllmMetricsBaseUrl } from "../services/vllm-supervisor.js";

const router = Router();

/**
 * GET /api/model-stats
 * Get all model performance summaries.
 */
router.get("/", async (_req: Request, res: Response) => {
  try {
    const summaries = getAllModelSummaries();
    res.json(summaries);
  } catch (err) {
    console.error("[model-stats] GET / failed:", err);
    res.status(500).json({ error: "Failed to get model stats" });
  }
});

/**
 * GET /api/model-stats/vllm-cache
 * Live vLLM prefix/KV cache metrics from the configured vLLM server.
 */
router.get("/vllm-cache", async (_req: Request, res: Response) => {
  try {
    const settings = await getSettings();
    const baseUrl = await getVllmMetricsBaseUrl(settings);
    if (!settings.vllmEnabled) {
      return res.json({
        status: "unavailable",
        url: baseUrl,
        timestamp: Date.now(),
        models: [],
        error: "vLLM provider is disabled",
      });
    }
    res.json(await fetchVllmCacheMetrics(baseUrl));
  } catch (err) {
    console.error("[model-stats] GET /vllm-cache failed:", err);
    res.status(500).json({ error: "Failed to get vLLM cache metrics" });
  }
});

/**
 * GET /api/model-stats/:modelId
 * Get detailed stats (summary + recent runs) for a specific model.
 */
router.get("/:modelId", async (req: Request, res: Response) => {
  try {
    const summaries = getAllModelSummaries();
    const match = summaries.find(s => s.modelId === req.params.modelId);
    if (!match) {
      return res.status(404).json({ error: `No stats found for model: ${req.params.modelId}` });
    }
    const runs = getModelRuns(req.params.modelId as string, 50);
    res.json({
      modelId: req.params.modelId,
      provider: match.provider,
      summary: match.summary,
      runs,
    });
  } catch (err) {
    console.error("[model-stats] GET /:modelId failed:", err);
    res.status(500).json({ error: "Failed to get model stats" });
  }
});

/**
 * POST /api/model-stats/clear
 * Clear all model stats (admin/debug endpoint).
 */
router.post("/clear", async (_req: Request, res: Response) => {
  try {
    clearModelStats();
    res.json({ cleared: true });
  } catch (err) {
    console.error("[model-stats] POST /clear failed:", err);
    res.status(500).json({ error: "Failed to clear model stats" });
  }
});

export default router;
