import { Router } from "express";
import { discoverAllModels } from "../services/models.js";
import { getSettings } from "../services/chat-storage.js";
import { getOllamaUrl } from "../services/ollama-url.js";

const router = Router();
const LLAMACPP_DEFAULT_URL = "http://localhost:8080";
const VLLM_DEFAULT_URL = "http://localhost:8095";

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
      const settings = await getSettings();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
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
      res.status(503).json({ model: modelId, status: "unavailable", error: e.message });
    }
    return;
  }

  if (provider === "vllm") {
    try {
      const settings = await getSettings();
      const baseUrl = settings.vllmUrl || VLLM_DEFAULT_URL;
      const response = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) {
        return res.status(503).json({ model: modelId, status: "unavailable", error: `vLLM returned ${response.status}` });
      }
      const data = (await response.json()) as { data?: Array<{ id: string }> };
      const found = data.data?.some((m) => m.id === modelId);
      if (!found) {
        return res.status(404).json({ model: modelId, status: "unavailable", error: "Model not listed by vLLM" });
      }
      res.json({ model: modelId, status: "ok" });
    } catch (e: any) {
      res.status(503).json({ model: modelId, status: "unavailable", error: e.message });
    }
    return;
  }

  // Default: Ollama health check
  try {
    const settings = await getSettings();
    const ollamaBase = getOllamaUrl(settings);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${ollamaBase}/api/show`, {
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

// Discover models on a specific upstream server, filtered by kind.
// Used by the settings UI to populate embedding/reranker model dropdowns.
// Query params:
//   - provider: "ollama" | "llamacpp" | "vllm" (required)
//   - url: override the server URL (optional; defaults to provider's standard URL)
//   - kind: "embedding" | "rerank" | "chat" (required)
// Returns { models: Array<{ id: string; name: string }> }. On upstream failure
// returns { models: [], error: string } with HTTP 200 so the UI can fall back
// to a free-text input.
router.get("/discover", async (req, res) => {
  const provider = req.query.provider as string | undefined;
  const kind = req.query.kind as string | undefined;
  const urlOverride = req.query.url as string | undefined;

  if (provider !== "ollama" && provider !== "llamacpp" && provider !== "vllm") {
    return res.status(400).json({ models: [], error: "provider must be 'ollama', 'llamacpp', or 'vllm'" });
  }
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

    if (provider === "ollama") {
      const settings = await getSettings();
      const baseUrl = urlOverride || getOllamaUrl(settings);
      const response = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!response.ok) {
        return res.json({ models: [], error: `Ollama returned ${response.status}` });
      }
      const data = (await response.json()) as { models: Array<{ name: string }> };
      const models = data.models
        .filter((m) => matchesKind(m.name, kind))
        .map((m) => ({ id: m.name, name: m.name }));
      return res.json({ models });
    }

    // OpenAI-compatible providers: llama.cpp and vLLM
    const baseUrl = urlOverride || (provider === "vllm" ? VLLM_DEFAULT_URL : LLAMACPP_DEFAULT_URL);
    const response = await fetch(`${baseUrl}/v1/models`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!response.ok) {
      return res.json({ models: [], error: `${provider} returned ${response.status}` });
    }
    const data = (await response.json()) as { data: Array<{ id: string }> };
    const models = data.data
      .filter((m) => m.id && (provider === "vllm" || !m.id.includes("/")))
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
  const ollamaUrl = getOllamaUrl(settings);
  const inferenceUrl = settings.llamacppUrl?.trim() || LLAMACPP_DEFAULT_URL;
  const vllmUrl = settings.vllmUrl?.trim() || VLLM_DEFAULT_URL;
  const extractionUrl = settings.extractionModelUrl?.trim() || "http://localhost:8083";
  const rerankerUrl = settings.rerankerUrl?.trim() || "http://localhost:8082";
  const embeddingProvider = settings.embeddingProvider ?? "ollama";
  const embeddingUrl = settings.embeddingUrl?.trim()
    || (embeddingProvider === "llamacpp" ? "http://localhost:8084" : ollamaUrl);

  const pingLlamaCpp = async (url: string) => {
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
      return r.ok ? "ok" : "unavailable";
    } catch {
      return "unavailable";
    }
  };
  const pingOllama = async (url: string) => {
    try {
      const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
      return r.ok ? "ok" : "unavailable";
    } catch {
      return "unavailable";
    }
  };

  const [inference, extraction, reranker, embedding, ollama] = await Promise.all([
    pingLlamaCpp(inferenceUrl),
    pingLlamaCpp(extractionUrl),
    pingLlamaCpp(rerankerUrl),
    embeddingProvider === "llamacpp" ? pingLlamaCpp(embeddingUrl) : pingOllama(embeddingUrl),
    pingOllama(ollamaUrl),
  ]);

  const vllm = settings.vllmEnabled
    ? await pingLlamaCpp(vllmUrl)
    : "unavailable";

  res.json({ inference, vllm, extraction, reranker, embedding, ollama });
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

// vLLM server health check (proxied to avoid CORS issues)
router.get("/vllm/health", async (req, res) => {
  try {
    const urlOverride = req.query.url as string | undefined;
    const settings = await getSettings();
    const baseUrl = urlOverride || settings.vllmUrl || VLLM_DEFAULT_URL;
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      res.json({ status: "ok" });
    } else {
      res.status(503).json({ status: "unavailable", error: `vLLM returned ${response.status}` });
    }
  } catch (e: any) {
    res.status(503).json({ status: "unavailable", error: e.message });
  }
});

export default router;
