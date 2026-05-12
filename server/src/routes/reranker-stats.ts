import { Router } from "express";
import type { Request, Response } from "express";
import { getRerankerStatsSummary, getRerankerRuns, clearRerankerStats } from "../services/reranker-stats.js";

const router = Router();

// The timeout is needed to correctly classify timeouts in the summary.
// Match the value in reranker.ts.
const RERANKER_TIMEOUT_MS = 25_000;

/**
 * GET /api/reranker-stats
 * Get reranker performance summary + recent runs.
 */
router.get("/", async (_req: Request, res: Response) => {
  try {
    const summary = getRerankerStatsSummary(RERANKER_TIMEOUT_MS);
    const runs = getRerankerRuns(50);
    res.json({ summary, runs });
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