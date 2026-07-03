import { Router } from "express";
import type { Request, Response } from "express";
import { getAllModelSummaries, getModelRuns, clearModelStats } from "../services/model-stats.js";

const router = Router();

function getMostRecentByProvider(
  summaries: ReturnType<typeof getAllModelSummaries>,
  filter: (provider: string) => boolean,
): { modelId: string; provider: string; summary: typeof summaries[0]["summary"] } | null {
  const matches = summaries.filter(s => filter(s.provider));
  if (matches.length === 0) return null;
  // Already sorted by lastUsed DESC from getAllModelSummaries
  return matches[0];
}

/**
 * GET /api/model-stats
 * Get all model performance summaries.
 * With ?active=true, returns only the most recent chat model and extraction model.
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const summaries = getAllModelSummaries();

    if (req.query.active === "true") {
      const mainModel = getMostRecentByProvider(summaries, p => !p.toLowerCase().includes("extraction"));
      const extractionModel = getMostRecentByProvider(summaries, p => p.toLowerCase().includes("extraction"));
      return res.json({ mainModel, extractionModel });
    }

    res.json(summaries);
  } catch (err) {
    console.error("[model-stats] GET / failed:", err);
    res.status(500).json({ error: "Failed to get model stats" });
  }
});

/**
 * GET /api/model-stats/:modelId
 * Get detailed stats (summary + recent runs) for a specific model.
 */
router.get("/:modelId", async (req: Request, res: Response) => {
  try {
    const provider = typeof req.query.provider === "string" ? req.query.provider : undefined;
    const summaries = getAllModelSummaries();
    const match = summaries.find(s => s.modelId === req.params.modelId && (!provider || s.provider === provider));
    if (!match) {
      return res.status(404).json({ error: `No stats found for model: ${req.params.modelId}` });
    }
    const runs = getModelRuns(req.params.modelId as string, 50, match.provider);
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
