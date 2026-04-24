import { Router } from "express";
import { getSettings, saveSettings } from "../services/chat-storage.js";
import { getLlamaPathInfo, updateLlamaPath, validateLlamaPath, getLlamaServicesStatus } from "../services/llama-path.js";
import { invalidateModelCache } from "../services/models.js";

const router = Router();

router.get("/", async (_req, res) => {
  const settings = await getSettings();
  res.json(settings);
});

router.put("/", async (req, res) => {
  const settings = await saveSettings(req.body);
  invalidateModelCache();
  res.json(settings);
});

// GET /api/settings/llama-path — Current symlink info and service status
router.get("/llama-path", async (_req, res) => {
  try {
    const [pathInfo, serviceStatus] = await Promise.all([
      getLlamaPathInfo(),
      getLlamaServicesStatus(),
    ]);
    res.json({ ...pathInfo, services: serviceStatus });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/settings/llama-path — Update symlink and restart services
router.put("/llama-path", async (req, res) => {
  const { path: newPath } = req.body;
  if (!newPath || typeof newPath !== "string") {
    res.status(400).json({ error: "path is required" });
    return;
  }

  try {
    const result = await updateLlamaPath(newPath.trim());
    if (result.rolledBack) {
      res.status(503).json({ ...result, error: "Services failed to start with new path. Rolled back to previous version." });
    } else {
      res.json(result);
    }
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/settings/llama-path/validate — Validate a candidate path without applying
router.post("/llama-path/validate", async (req, res) => {
  const { path: candidatePath } = req.body;
  if (!candidatePath || typeof candidatePath !== "string") {
    res.status(400).json({ error: "path is required" });
    return;
  }

  try {
    const result = await validateLlamaPath(candidatePath.trim());
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
