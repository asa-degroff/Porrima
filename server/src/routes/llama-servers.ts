import { Router } from "express";
import { getSettings, saveSettings } from "../services/chat-storage.js";
import {
  getLlamaServerLogs,
  getLlamaServerStatus,
  getLlamaServerStatuses,
  resolveSlotUnitName,
  runLlamaServerAction,
  type LlamaServerAction,
} from "../services/llama-supervisor.js";
import { findLocalModel, listLocalModels, type LlamaModelKind } from "../services/llama-models-disk.js";
import { isOverridableSlot, isRouterCapableSlot, renderExecStart, renderRouterExecStart, resolveSlotEnvironment } from "../services/llama-launch-templates.js";
import { applyModelOverride, clearModelOverride } from "../services/llama-overrides.js";
import { ensureRouterModelLoaded, invalidateRouterCache, normalizeRouterModelId } from "../services/llama-router-client.js";

const router = Router();

const SLOT_KIND: Record<string, LlamaModelKind> = {
  "title-generation": "chat",
  extraction: "chat",
  reranker: "rerank",
  embedding: "embedding",
};

router.get("/", async (_req, res) => {
  try {
    const settings = await getSettings();
    const servers = await getLlamaServerStatuses(settings);
    res.json({ servers });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Failed to load llama.cpp server status" });
  }
});

// List GGUF models on disk, optionally filtered by slot kind.
router.get("/available-models", async (req, res) => {
  try {
    const slot = (req.query.slot as string | undefined) || undefined;
    let kindFilter: LlamaModelKind | null = null;
    if (slot) {
      const kind = SLOT_KIND[slot];
      if (!kind) {
        res.status(400).json({ error: `Unknown slot: ${slot}` });
        return;
      }
      kindFilter = kind;
    }

    const all = await listLocalModels();
    const filtered = kindFilter ? all.filter((m) => m.kind === kindFilter) : all;
    res.json({
      models: filtered.map((m) => ({
        id: m.id,
        name: m.name,
        ggufPath: m.ggufPath,
        sizeBytes: m.sizeBytes,
        kind: m.kind,
        hasMmproj: m.hasMmproj,
      })),
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Failed to list local llama.cpp models" });
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

// POST /:id/apply-model — Switch the model that a llama.cpp slot serves.
// Two paths:
//   - Router mode (title-generation/extraction with --models-dir): hits
//     /models/load on the slot's URL. No systemd write, no restart, no
//     downtime — just persist the modelId in settings so consumers send the
//     matching model name in chat-completion requests.
//   - Single-model mode: writes a systemd drop-in override that swaps the
//     ExecStart's -m and --alias, then daemon-reload + restart the unit.
// Body: { modelId: string }.
//
// Must be declared BEFORE the generic POST /:id/:action route below — Express
// matches in declaration order and "/:id/:action" with action="apply-model"
// would otherwise shadow this and 400 with "action must be start/stop/restart".
router.post("/:id/apply-model", async (req, res) => {
  const id = req.params.id;
  if (!isOverridableSlot(id)) {
    res.status(400).json({ error: `Slot does not support model override: ${id}` });
    return;
  }
  const modelId = typeof req.body?.modelId === "string" ? req.body.modelId.trim() : "";
  if (!modelId) {
    res.status(400).json({ error: "modelId is required" });
    return;
  }

  try {
    const model = await findLocalModel(modelId);
    if (!model) {
      res.status(404).json({ error: `Model not found in local llama-models directory: ${modelId}` });
      return;
    }
    if (model.kind !== SLOT_KIND[id]) {
      res.status(400).json({ error: `Model ${modelId} is kind '${model.kind}', not '${SLOT_KIND[id]}' as required by ${id}` });
      return;
    }

    const settings = await getSettings();
    const preStatus = await getLlamaServerStatus(id, settings);
    const inRouterMode = preStatus.http.routerMode;

    let overridePath: string | null = null;
    let mode: "router-load" | "override-restart";
    if (inRouterMode) {
      // Hot-swap via /models/load. Forwards extraction's per-slot ctx-size
      // through the load args so larger contexts don't get clipped to the
      // launch default. For title-gen we leave ctx at the launch default
      // (4096) since titles are short.
      const ctxOverride = id === "extraction" ? settings.extractionCtxSize : undefined;
      const result = await ensureRouterModelLoaded(preStatus.url, model.id, { contextWindow: ctxOverride });
      if (result === "not-router") {
        res.status(409).json({ error: `Slot reported router mode but /models/load returned 404. Try refreshing.` });
        return;
      }
      if (result === "error") {
        res.status(502).json({ error: `Slot accepted but failed to load model ${modelId}. Check service logs.` });
        return;
      }
      mode = "router-load";
    } else {
      const execStart = renderExecStart(id, { ggufPath: model.ggufPath, modelId: model.id, settings });
      const unitName = await resolveSlotUnitName(id);
      const envLines = resolveSlotEnvironment(id, settings);
      const result = await applyModelOverride(unitName, execStart, { environmentLines: envLines.length ? envLines : undefined });
      overridePath = result.overridePath;
      // After a unit restart, our in-process /models/load cache is stale.
      invalidateRouterCache(preStatus.url);
      mode = "override-restart";
    }

    if (id === "title-generation") settings.titleGenerationModelId = model.id;
    else if (id === "extraction") settings.extractionModelId = model.id;
    else if (id === "reranker") settings.rerankerModelId = model.id;
    else if (id === "embedding") settings.embeddingModel = model.id;
    await saveSettings(settings);

    const server = await getLlamaServerStatus(id, settings);
    res.json({ server, overridePath, mode });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Failed to apply model" });
  }
});

// POST /:id/convert-to-router — Switch a slot to router mode by writing a
// drop-in override that replaces the launch ExecStart with one that uses
// --models-dir. After this, model swaps go through /models/load (no restart).
// Only valid for slots that have a router-mode template (title-generation,
// extraction). Embedding/reranker pin model-class flags at startup, so they
// can't multiplex.
router.post("/:id/convert-to-router", async (req, res) => {
  const id = req.params.id;
  if (!isRouterCapableSlot(id)) {
    res.status(400).json({ error: `Slot does not support router mode: ${id}` });
    return;
  }
  try {
    const settings = await getSettings();
    const execStart = renderRouterExecStart(id, settings);
    const unitName = await resolveSlotUnitName(id);
    const envLines = resolveSlotEnvironment(id, settings);
    const { overridePath } = await applyModelOverride(unitName, execStart, { environmentLines: envLines.length ? envLines : undefined });
    invalidateRouterCache();
    const server = await getLlamaServerStatus(id, settings);
    res.json({ server, overridePath });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Failed to convert slot to router mode" });
  }
});

// DELETE /:id/model-override — Remove the drop-in override and restart the
// unit so it reverts to the original ExecStart from its installed unit file.
router.delete("/:id/model-override", async (req, res) => {
  const id = req.params.id;
  if (!isOverridableSlot(id)) {
    res.status(400).json({ error: `Slot does not support model override: ${id}` });
    return;
  }
  try {
    const unitName = await resolveSlotUnitName(id);
    const result = await clearModelOverride(unitName);
    invalidateRouterCache();
    const settings = await getSettings();
    const server = await getLlamaServerStatus(id, settings);
    res.json({ server, removed: result.removed });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Failed to clear model override" });
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
      if (body.modelId !== undefined) {
        const v = (body.modelId as string).trim();
        settings.extractionModelId = v ? normalizeRouterModelId(v) : undefined;
      }
      if (body.ctxSize !== undefined) settings.extractionCtxSize = Number(body.ctxSize);
      if (body.fallbackEnabled !== undefined) settings.extractionFallbackEnabled = Boolean(body.fallbackEnabled);
      if (body.binaryPath !== undefined) {
        const v = (body.binaryPath as string)?.trim();
        if (!settings.llamaServerBins) settings.llamaServerBins = {};
        if (v) settings.llamaServerBins["extraction"] = v;
        else delete settings.llamaServerBins["extraction"];
      }
    }
    if (def.id === "reranker") {
      if (body.enabled !== undefined) settings.rerankerEnabled = Boolean(body.enabled);
      if (body.url !== undefined) settings.rerankerUrl = (body.url as string).trim() || undefined;
      if (body.modelId !== undefined) {
        const v = (body.modelId as string).trim();
        settings.rerankerModelId = v ? normalizeRouterModelId(v) : undefined;
      }
    }
    if (def.id === "embedding") {
      if (body.provider !== undefined) settings.embeddingProvider = body.provider as "ollama" | "llamacpp";
      if (body.url !== undefined) settings.embeddingUrl = (body.url as string).trim() || undefined;
      if (body.modelId !== undefined) {
        const v = (body.modelId as string).trim();
        settings.embeddingModel = v ? normalizeRouterModelId(v) : undefined;
      }
    }
    if (def.id === "title-generation") {
      if (body.enabled !== undefined) settings.titleGenerationEnabled = Boolean(body.enabled);
      if (body.url !== undefined) settings.titleGenerationUrl = (body.url as string).trim() || undefined;
      if (body.modelId !== undefined) {
        const v = (body.modelId as string).trim();
        settings.titleGenerationModelId = v ? normalizeRouterModelId(v) : undefined;
      }
      if (body.binaryPath !== undefined) {
        const v = (body.binaryPath as string)?.trim();
        if (!settings.llamaServerBins) settings.llamaServerBins = {};
        if (v) settings.llamaServerBins["title-generation"] = v;
        else delete settings.llamaServerBins["title-generation"];
      }
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
