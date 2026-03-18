import { Router } from "express";
import { discoverOllamaModels } from "../services/models.js";

const router = Router();

router.get("/", async (_req, res) => {
  try {
    const models = await discoverOllamaModels();
    res.json(models);
  } catch (e: any) {
    console.error("[models] discovery failed:", e.message);
    res.status(503).json({ error: "Cannot connect to Ollama. Is it running?", details: e.message });
  }
});

// Health check for a specific model
router.get("/health/:modelId", async (req, res) => {
  const { modelId } = req.params;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`http://localhost:11434/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelId }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      return res.status(503).json({ 
        model: modelId, 
        status: "unavailable", 
        error: `Ollama returned ${response.status}` 
      });
    }
    
    res.json({ model: modelId, status: "ok" });
  } catch (e: any) {
    res.status(503).json({ 
      model: modelId, 
      status: "unavailable", 
      error: e.message 
    });
  }
});

export default router;
