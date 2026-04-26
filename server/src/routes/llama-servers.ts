import { Router } from "express";
import { getSettings, saveSettings } from "../services/chat-storage.js";
import {
  getLlamaServerLogs,
  getLlamaServerStatus,
  getLlamaServerStatuses,
  runLlamaServerAction,
  type LlamaServerAction,
} from "../services/llama-supervisor.js";

const router = Router();

router.get("/", async (_req, res) => {
  try {
    const settings = await getSettings();
    const servers = await getLlamaServerStatuses(settings);
    res.json({ servers });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Failed to load llama.cpp server status" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const settings = await getSettings();
    const server = await getLlamaServerStatus(req.params.id, settings);
    res.json({ server });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "Failed to load llama.cpp server status" });
  }
});

router.get("/:id/logs", async (req, res) => {
  const rawLines = typeof req.query.lines === "string" ? Number.parseInt(req.query.lines, 10) : 200;
  try {
    const result = await getLlamaServerLogs(req.params.id, Number.isFinite(rawLines) ? rawLines : 200);
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "Failed to load llama.cpp server logs" });
  }
});

router.post("/:id/:action", async (req, res) => {
  const action = req.params.action as LlamaServerAction;
  if (action !== "start" && action !== "stop" && action !== "restart") {
    res.status(400).json({ error: "action must be start, stop, or restart" });
    return;
  }

  try {
    const settings = await getSettings();
    const server = await runLlamaServerAction(req.params.id, action, settings);
    res.json({ server });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || `Failed to ${action} llama.cpp server` });
  }
});

// PATCH /:id — Update per-server settings (URL, model, toggles)
router.patch("/:id", async (req, res) => {
  const id = req.params.id;
  const def = getDefinition(id);
  if (!def) {
    res.status(400).json({ error: `Unknown server: ${id}` });
    return;
  }

  try {
    const settings = await getSettings();
    const body = req.body as Record<string, unknown>;

    // Map request fields to settings keys per server role
    if (def.id === "inference") {
      if (body.url !== undefined) settings.llamacppUrl = (body.url as string).trim() || undefined;
      if (body.modelId !== undefined) settings.defaultModelId = (body.modelId as string).trim() || settings.defaultModelId;
      if (body.enabled !== undefined) settings.llamacppEnabled = Boolean(body.enabled);
      if (body.sharesGpu !== undefined) settings.llamacppSharesGpu = Boolean(body.sharesGpu);
    }
    if (def.id === "extraction") {
      if (body.url !== undefined) settings.extractionModelUrl = (body.url as string).trim() || undefined;
      if (body.modelId !== undefined) settings.extractionModelId = (body.modelId as string).trim() || undefined;
      if (body.ctxSize !== undefined) settings.extractionCtxSize = Number(body.ctxSize);
      if (body.fallbackEnabled !== undefined) settings.extractionFallbackEnabled = Boolean(body.fallbackEnabled);
    }
    if (def.id === "reranker") {
      if (body.enabled !== undefined) settings.rerankerEnabled = Boolean(body.enabled);
      if (body.url !== undefined) settings.rerankerUrl = (body.url as string).trim() || undefined;
      if (body.modelId !== undefined) settings.rerankerModelId = (body.modelId as string).trim() || undefined;
    }
    if (def.id === "embedding") {
      if (body.provider !== undefined) settings.embeddingProvider = body.provider as "ollama" | "llamacpp";
      if (body.url !== undefined) settings.embeddingUrl = (body.url as string).trim() || undefined;
      if (body.modelId !== undefined) settings.embeddingModel = (body.modelId as string).trim() || undefined;
    }
    if (def.id === "title-generation") {
      if (body.enabled !== undefined) settings.titleGenerationEnabled = Boolean(body.enabled);
      if (body.url !== undefined) settings.titleGenerationUrl = (body.url as string).trim() || undefined;
      if (body.modelId !== undefined) settings.titleGenerationModelId = (body.modelId as string).trim() || undefined;
    }

    await saveSettings(settings);

    // Return the updated server status so the UI can refresh the card
    const server = await getLlamaServerStatus(id, settings);
    res.json({ server });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "Failed to update server settings" });
  }
});

export default router;

function getDefinition(id: string): { id: string } | null {
  if (
    id === "inference" ||
    id === "extraction" ||
    id === "reranker" ||
    id === "embedding" ||
    id === "title-generation"
  ) {
    return { id };
  }
  return null;
}
