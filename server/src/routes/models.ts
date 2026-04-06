import { Router } from "express";
import { discoverAllModels } from "../services/models.js";
import { getSettings } from "../services/chat-storage.js";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const models = await discoverAllModels();
    const provider = req.query.provider as string | undefined;
    const filtered = provider ? models.filter((m) => m.provider === provider) : models;
    res.json(filtered);
  } catch (e: any) {
    console.error("[models] discovery failed:", e.message);
    res.status(503).json({ error: "Cannot connect to inference providers. Is Ollama running?", details: e.message });
  }
});

// Health check for a specific model
router.get("/health/:modelId", async (req, res) => {
  const { modelId } = req.params;
  const provider = req.query.provider as string | undefined;

  // Determine which provider to check
  if (provider === "llamacpp") {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`http://localhost:8080/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!response.ok) {
        return res.status(503).json({ model: modelId, status: "unavailable", error: `llama.cpp returned ${response.status}` });
      }
      res.json({ model: modelId, status: "ok" });
    } catch (e: any) {
      res.status(503).json({ model: modelId, status: "unavailable", error: e.message });
    }
    return;
  }

  // Default: Ollama health check
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

// llama.cpp server health check (proxied to avoid CORS issues)
router.get("/llamacpp/health", async (req, res) => {
  try {
    // Allow optional URL override via query parameter (for extraction model testing)
    const urlOverride = req.query.url as string | undefined;
    const settings = await getSettings();
    const baseUrl = urlOverride || settings.llamacppUrl || "http://localhost:8080";
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (response.ok) {
      res.json({ status: "ok" });
    } else {
      res.status(503).json({ status: "unavailable", error: `llama.cpp returned ${response.status}` });
    }
  } catch (e: any) {
    res.status(503).json({ status: "unavailable", error: e.message });
  }
});

export default router;
