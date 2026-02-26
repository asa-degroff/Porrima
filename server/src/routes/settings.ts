import { Router } from "express";
import { getSettings, saveSettings } from "../services/storage.js";

const router = Router();

router.get("/", async (_req, res) => {
  const settings = await getSettings();
  res.json(settings);
});

router.put("/", async (req, res) => {
  const settings = await saveSettings(req.body);
  res.json(settings);
});

export default router;
