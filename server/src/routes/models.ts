import { Router } from "express";
import { discoverOllamaModels } from "../services/models.js";

const router = Router();

router.get("/", async (_req, res) => {
  try {
    const models = await discoverOllamaModels();
    res.json(models);
  } catch (e) {
    res.status(503).json({ error: "Cannot connect to Ollama. Is it running?" });
  }
});

export default router;
