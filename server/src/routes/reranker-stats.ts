import { Router } from "express";
import type { Request, Response } from "express";
import { getRerankerStatsSummary, getRerankerRuns, clearRerankerStats } from "../services/reranker-stats.js";
import { getRetrievalBudget } from "../services/retrieval-settings.js";

const router = Router();

/**
 * GET /api/reranker-stats
 * Get reranker performance summary + recent runs.
 */
router.get("/", async (_req: Request, res: Response) => {
  try {
    const budget = await getRetrievalBudget();
    const summary = getRerankerStatsSummary(budget.rerankerTimeoutMs);
    const runs = getRerankerRuns(50);
    res.json({ summary, runs, timeoutMs: budget.rerankerTimeoutMs });
  } catch (err) {
    console.error("[reranker-stats] GET / failed:", err);
    res.status(500).json({ error: "Failed to get reranker stats" });
  }
});

/**
 * POST /api/reranker-stats/clear
 * Clear all reranker stats (admin/debug endpoint).
 */
router.post("/clear", async (_req: Request, res: Response) => {
  try {
    clearRerankerStats();
    res.json({ cleared: true });
  } catch (err) {
    console.error("[reranker-stats] POST /clear failed:", err);
    res.status(500).json({ error: "Failed to clear reranker stats" });
  }
});

export default router;
