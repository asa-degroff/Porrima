import { Router } from "express";
import { discoverAllModels } from "../services/models.js";
import { getSettings } from "../services/chat-storage.js";

const router = Router();

const LLAMACPP_DEFAULT_URL = "http://localhost:8080";

router.get("/", async (req, res) => {
  try {
    const models = await discoverAllModels();
    const provider = req.query.provider as string | undefined;
    const filtered = provider ? models.filter((m) => m.provider === provider) : models;
    res.json(filtered);
  } catch (e: any) {
    console.error("[models] discovery failed:", e.message);
    res.status(503).json({ error: "Cannot connect to inference server. Is llama.cpp running?", details: e.message });
  }
});

// Health check for a specific model
router.get("/health/:modelId", async (req, res) => {
  const { modelId } = req.params;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const settings = await getSettings();
    const baseUrl = settings.llamacppUrl || LLAMACPP_DEFAULT_URL;
    const response = await fetch(`${baseUrl}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      return res.status(503).json({ model: modelId, status: "unavailable", error: `llama.cpp returned ${response.status}` });
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

// Discover models on a specific upstream server, filtered by kind.
// Used by the settings UI to populate embedding/reranker model dropdowns.
// Query params:
//   - url: override the server URL (optional; defaults to llama.cpp standard URL)
//   - kind: "embedding" | "rerank" | "chat" (required)
// Returns { models: Array<{ id: string; name: string }> }. On upstream failure
// returns { models: [], error: string } with HTTP 200 so the UI can fall back
// to a free-text input.
router.get("/discover", async (req, res) => {
  const kind = req.query.kind as string | undefined;
  const urlOverride = req.query.url as string | undefined;

  if (kind !== "embedding" && kind !== "rerank" && kind !== "chat") {
    return res.status(400).json({ models: [], error: "kind must be 'embedding', 'rerank', or 'chat'" });
  }

  // Name-based heuristics — upstream APIs don't expose capability flags.
  const matchesKind = (id: string, k: "embedding" | "rerank" | "chat"): boolean => {
    const lower = id.toLowerCase();
    const isEmbedding = /embed|bge|e5|nomic|mxbai|jina|gte/.test(lower);
    const isRerank = /rerank|cross-encoder/.test(lower);
    if (k === "embedding") return isEmbedding && !isRerank;
    if (k === "rerank") return isRerank;
    return !isEmbedding && !isRerank;
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    // llama.cpp discovery
    const settings = await getSettings();
    const baseUrl = urlOverride || settings.llamacppUrl || LLAMACPP_DEFAULT_URL;
    const response = await fetch(`${baseUrl}/v1/models`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!response.ok) {
      return res.json({ models: [], error: `llama.cpp returned ${response.status}` });
    }
    const data = (await response.json()) as { data: Array<{ id: string }> };
    const models = data.data
      .filter((m) => m.id && !m.id.includes("/"))
      .filter((m) => matchesKind(m.id, kind))
      .map((m) => ({ id: m.id, name: m.id }));
    return res.json({ models });
  } catch (e: any) {
    return res.json({ models: [], error: e.message || "discovery failed" });
  }
});

// Aggregate health check for all configured inference servers.
// Parallel HTTP pings; returns reachability (not systemd state).
router.get("/health-all", async (_req, res) => {
  const settings = await getSettings();
  const inferenceUrl = settings.llamacppUrl?.trim() || LLAMACPP_DEFAULT_URL;
  const extractionUrl = settings.extractionModelUrl?.trim() || "http://localhost:8083";
  const rerankerUrl = settings.rerankerUrl?.trim() || "http://localhost:8082";
  const titleGenerationUrl = settings.titleGenerationUrl?.trim() || "http://localhost:8085";
  const embeddingUrl = settings.embeddingUrl?.trim() || "http://localhost:8084";

  const pingLlamaCpp = async (url: string) => {
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
      return r.ok ? "ok" : "unavailable";
    } catch {
      return "unavailable";
    }
  };

  const [inference, extraction, reranker, titleGeneration, embedding] = await Promise.all([
    pingLlamaCpp(inferenceUrl),
    pingLlamaCpp(extractionUrl),
    pingLlamaCpp(rerankerUrl),
    pingLlamaCpp(titleGenerationUrl),
    pingLlamaCpp(embeddingUrl),
  ]);

  res.json({ inference, extraction, reranker, titleGeneration, embedding });
});

// llama.cpp server health check (proxied to avoid CORS issues)
router.get("/llamacpp/health", async (req, res) => {
  try {
    // Allow optional URL override via query parameter (for extraction model testing)
    const urlOverride = req.query.url as string | undefined;
    const settings = await getSettings();
    const baseUrl = urlOverride || settings.llamacppUrl || LLAMACPP_DEFAULT_URL;
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