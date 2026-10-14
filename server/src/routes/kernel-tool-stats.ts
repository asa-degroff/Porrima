import { Router } from "express";
import type { Request, Response } from "express";
import {
  getKernelToolAggregates,
  getKernelToolSamples,
  clearKernelToolStats,
} from "../services/kernel-tool-stats.js";

const router = Router();

/**
 * GET /api/kernel-tool-stats
 * Kernel tool dispatch telemetry (docs/design/kernel-codemode.md §4.9):
 * per-tool aggregates (the Phase D evidence view) + recent samples.
 */
router.get("/", (_req: Request, res: Response) => {
  try {
    const aggregates = getKernelToolAggregates();
    const samples = getKernelToolSamples(100);
    res.json({ aggregates, samples });
  } catch (err) {
    console.error("[kernel-tool-stats] GET / failed:", err);
    res.status(500).json({ error: "Failed to get kernel tool stats" });
  }
});

/**
 * POST /api/kernel-tool-stats/clear
 * Clear all dispatch samples (admin/debug endpoint).
 */
router.post("/clear", (_req: Request, res: Response) => {
  try {
    clearKernelToolStats();
    res.json({ cleared: true });
  } catch (err) {
    console.error("[kernel-tool-stats] POST /clear failed:", err);
    res.status(500).json({ error: "Failed to clear kernel tool stats" });
  }
});

export default router;
