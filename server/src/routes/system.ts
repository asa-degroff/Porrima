import { Router } from "express";
import { isAutomationActive } from "../services/automation-lock.js";
import { getRecentExtractionRuns } from "../services/memory-extraction-observability.js";
import {
  getStoredSystemPauseState,
  pauseSystem,
  resumeSystem,
} from "../services/system-pause.js";

const router = Router();

function hasRunningExtraction(): boolean {
  return getRecentExtractionRuns().some((run) => run.status === "running");
}

function backgroundWorkPending(): boolean {
  return isAutomationActive() || hasRunningExtraction();
}

router.get("/pause", async (_req, res) => {
  try {
    res.json(await getStoredSystemPauseState({ pending: backgroundWorkPending() }));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/pause", async (req, res) => {
  try {
    const body = req.body ?? {};
    const state = await pauseSystem({
      indefinite: body.indefinite === true,
      durationMs: typeof body.durationMs === "number" ? body.durationMs : undefined,
    });
    res.json({ ...state, pending: state.active && backgroundWorkPending() });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/resume", async (_req, res) => {
  try {
    res.json(await resumeSystem());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
