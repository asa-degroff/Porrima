import { Router } from "express";
import type { Settings, VllmModelProfile } from "../types.js";
import { getSettings, saveSettings } from "../services/chat-storage.js";
import { invalidateModelCache } from "../services/models.js";
import {
  getVllmSupervisorStatus,
  getVllmProfiles,
  getVllmProfileUrl,
  restartVllmProfile,
  startVllmProfile,
  stopVllmProfile,
  ensureVllmProfile,
} from "../services/vllm-supervisor.js";

const router = Router();

async function persistProfileOverride(profile: VllmModelProfile): Promise<string> {
  const settings = await getSettings();
  const normalized = getVllmProfiles({ ...(settings as Settings), vllmProfiles: [profile] })[0];
  const existing = getVllmProfiles(settings).filter((p) =>
    p.id !== normalized.id && p.servedModelName !== normalized.servedModelName
  );
  await saveSettings({
    ...settings,
    vllmEnabled: true,
    vllmManagedEnabled: true,
    vllmActiveProfileId: normalized.id,
    vllmProfiles: [normalized, ...existing],
    vllmUrl: getVllmProfileUrl(normalized),
  });
  invalidateModelCache();
  return normalized.id;
}

router.get("/status", async (_req, res) => {
  try {
    res.json(await getVllmSupervisorStatus());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

router.post("/start", async (req, res) => {
  try {
    const profileId = req.body?.profile
      ? await persistProfileOverride(req.body.profile as VllmModelProfile)
      : typeof req.body?.profileId === "string" ? req.body.profileId : undefined;
    res.json(await startVllmProfile(profileId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(503).json({ error: message, status: await getVllmSupervisorStatus().catch(() => undefined) });
  }
});

router.post("/stop", async (_req, res) => {
  try {
    res.json(await stopVllmProfile());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message, status: await getVllmSupervisorStatus().catch(() => undefined) });
  }
});

router.post("/restart", async (req, res) => {
  try {
    const profileId = req.body?.profile
      ? await persistProfileOverride(req.body.profile as VllmModelProfile)
      : typeof req.body?.profileId === "string" ? req.body.profileId : undefined;
    res.json(await restartVllmProfile(profileId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(503).json({ error: message, status: await getVllmSupervisorStatus().catch(() => undefined) });
  }
});

router.post("/ensure", async (req, res) => {
  try {
    const modelId = typeof req.body?.modelId === "string" ? req.body.modelId : "";
    if (!modelId) return res.status(400).json({ error: "modelId is required" });
    const url = await ensureVllmProfile(modelId);
    res.json({ url, status: await getVllmSupervisorStatus() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(503).json({ error: message, status: await getVllmSupervisorStatus().catch(() => undefined) });
  }
});

export default router;
