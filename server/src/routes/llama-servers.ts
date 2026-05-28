import { Router } from "express";
import { getSettings, saveSettings } from "../services/chat-storage.js";
import {
  getLlamaServerLogs,
  getLlamaServerStatus,
  getLlamaServerStatuses,
  getLlamaUnitCat,
  getLlamaUnitEnabled,
  resolveSlotUnitName,
  runLlamaServerAction,
  setLlamaUnitEnabled,
  type LlamaServerAction,
  type LlamaServerId,
} from "../services/llama-supervisor.js";
import { findLocalModel, listLocalModels, type LlamaModelKind } from "../services/llama-models-disk.js";
import { getDefaultLlamaBin, isOverridableSlot, isRouterCapableSlot, renderExecStart, renderRouterExecStart, resolveSlotEnvironment, type OverridableSlotId } from "../services/llama-launch-templates.js";
import { applyModelOverride, clearModelOverride, readOverride } from "../services/llama-overrides.js";
import { ensureRouterModelLoaded, invalidateRouterCache, normalizeRouterModelId } from "../services/llama-router-client.js";
import { invalidateModelCache } from "../services/models.js";
import {
  getDefaultServiceConfig,
  getServiceCapabilities,
  mergeServiceConfig,
  parseManagedServiceConfig,
  renderManagedDropIn,
  renderServiceExecStart,
  validateServiceConfig,
  type LlamaServiceConfig,
} from "../services/llama-service-config.js";
import { normalizeExtractionRequestSettings } from "../services/extraction-settings.js";

const router = Router();

const SLOT_KIND: Record<string, LlamaModelKind> = {
  inference: "chat",
  "title-generation": "chat",
  extraction: "chat",
  reranker: "rerank",
  embedding: "embedding",
};

function supportsRuntimeModelApply(id: string): id is LlamaServerId {
  return id === "inference" || isOverridableSlot(id);
}

async function applySlotModelRuntime(
  id: LlamaServerId,
  modelId: string,
  settings: Awaited<ReturnType<typeof getSettings>>
): Promise<{ modelId: string; overridePath: string | null; mode: "router-load" | "override-restart" }> {
  const normalizedModelId = normalizeRouterModelId(modelId.trim());
  const model = await findLocalModel(normalizedModelId);
  if (!model) {
    throw new Error(`Model not found in local llama-models directory: ${normalizedModelId}`);
  }
  if (model.kind !== SLOT_KIND[id]) {
    throw new Error(`Model ${normalizedModelId} is kind '${model.kind}', not '${SLOT_KIND[id]}' as required by ${id}`);
  }

  const preStatus = await getLlamaServerStatus(id, settings);
  const inRouterMode = preStatus.http.routerMode;

  if (inRouterMode) {
    const ctxOverride = id === "extraction" ? settings.extractionCtxSize : undefined;
    const result = await ensureRouterModelLoaded(preStatus.url, model.id, { contextWindow: ctxOverride, force: true });
    if (result === "not-router") {
      throw new Error(`Slot reported router mode but /models/load returned 404. Try refreshing.`);
    }
    if (result === "error") {
      throw new Error(`Slot accepted but failed to load model ${normalizedModelId}. Check service logs.`);
    }
    return { modelId: model.id, overridePath: null, mode: "router-load" };
  }

  if (id === "inference") {
    throw new Error("Chat inference model changes require router mode. Update the managed service config or restart with --models-dir.");
  }

  const execStart = renderExecStart(id, { ggufPath: model.ggufPath, modelId: model.id, settings });
  const unitName = await resolveSlotUnitName(id);
  const envLines = resolveSlotEnvironment(id, settings);
  const result = await applyModelOverride(unitName, execStart, { environmentLines: envLines.length ? envLines : undefined });
  invalidateRouterCache(preStatus.url);
  return { modelId: model.id, overridePath: result.overridePath, mode: "override-restart" };
}

function persistSlotModelId(
  id: LlamaServerId,
  settings: Awaited<ReturnType<typeof getSettings>>,
  modelId: string
): void {
  if (id === "inference") settings.defaultModelId = modelId;
  else if (id === "title-generation") settings.titleGenerationModelId = modelId;
  else if (id === "extraction") settings.extractionModelId = modelId;
  else if (id === "reranker") settings.rerankerModelId = modelId;
  else if (id === "embedding") settings.embeddingModel = modelId;
}

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

router.get("/:id/config", async (req, res) => {
  const id = req.params.id;
  if (!getDefinition(id)) {
    res.status(400).json({ error: `Unknown server: ${id}` });
    return;
  }
  try {
    const settings = await getSettings();
    const unitName = await resolveSlotUnitName(id);
    const defaults = await hydrateDefaultConfig(id as LlamaServerId, settings);
    const enabled = await getLlamaUnitEnabled(id);
    const cat = await getLlamaUnitCat(id).catch(() => ({ unitName, contents: "" }));
    const preview = renderManagedDropIn({ id: id as LlamaServerId, unitName, config: defaults });
    res.json({
      config: defaults,
      defaults,
      capabilities: getServiceCapabilities(id as LlamaServerId),
      unit: {
        unitName,
        enabled: enabled.enabled,
        enabledState: enabled.state,
        cat: cat.contents,
      },
      preview,
    });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "Failed to load service config" });
  }
});

router.post("/:id/config/preview", async (req, res) => {
  const id = req.params.id;
  if (!getDefinition(id)) {
    res.status(400).json({ error: `Unknown server: ${id}` });
    return;
  }
  try {
    const settings = await getSettings();
    const unitName = await resolveSlotUnitName(id);
    const config = await hydrateServiceConfig(id as LlamaServerId, settings, req.body?.config || req.body || {});
    const preview = renderManagedDropIn({ id: id as LlamaServerId, unitName, config });
    res.json({ config, preview });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "Failed to preview service config" });
  }
});

router.put("/:id/config", async (req, res) => {
  const id = req.params.id;
  if (!getDefinition(id)) {
    res.status(400).json({ error: `Unknown server: ${id}` });
    return;
  }
  try {
    const settings = await getSettings();
    const unitName = await resolveSlotUnitName(id);
    const config = await hydrateServiceConfig(id as LlamaServerId, settings, req.body?.config || req.body || {});
    await validateServiceConfig(id as LlamaServerId, config);
    const execStart = renderServiceExecStart(id as LlamaServerId, config);
    const result = await applyModelOverride(unitName, execStart, { environmentLines: config.environment.length ? config.environment : undefined });
    persistServiceConfigToSettings(id as LlamaServerId, settings, config);
    await saveSettings(settings);
    invalidateRouterCache();
    const server = await getLlamaServerStatus(id, settings);
    const preview = renderManagedDropIn({ id: id as LlamaServerId, unitName, config });
    res.json({ server, config, preview, overridePath: result.overridePath });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "Failed to apply service config" });
  }
});

router.delete("/:id/config", async (req, res) => {
  const id = req.params.id;
  if (!getDefinition(id)) {
    res.status(400).json({ error: `Unknown server: ${id}` });
    return;
  }
  try {
    const unitName = await resolveSlotUnitName(id);
    const result = await clearModelOverride(unitName);
    invalidateRouterCache();
    const settings = await getSettings();
    if (settings.llamaServiceConfigs) {
      delete settings.llamaServiceConfigs[id];
      await saveSettings(settings);
    }
    const server = await getLlamaServerStatus(id, settings);
    res.json({ server, removed: result.removed });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Failed to reset service config" });
  }
});

router.put("/:id/enabled", async (req, res) => {
  const id = req.params.id;
  if (!getDefinition(id)) {
    res.status(400).json({ error: `Unknown server: ${id}` });
    return;
  }
  try {
    const enabled = Boolean(req.body?.enabled);
    const result = await setLlamaUnitEnabled(id, enabled);
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "Failed to update systemd enablement" });
  }
});

// POST /:id/apply-model — Switch the model that a llama.cpp server serves.
// Two paths:
//   - Router mode (inference/title-generation/extraction with --models-dir): hits
//     /models/load on the slot's URL. No systemd write, no restart, no
//     downtime — just persist the modelId in settings so consumers send the
//     matching model name in chat-completion requests.
//   - Single-model mode for non-inference slots: writes a systemd drop-in
//     override that swaps the ExecStart's -m and --alias, then daemon-reload
//     + restart the unit.
// Body: { modelId: string }.
//
// Must be declared BEFORE the generic POST /:id/:action route below — Express
// matches in declaration order and "/:id/:action" with action="apply-model"
// would otherwise shadow this and 400 with "action must be start/stop/restart".
router.post("/:id/apply-model", async (req, res) => {
  const id = req.params.id;
  if (!supportsRuntimeModelApply(id)) {
    res.status(400).json({ error: `Server does not support runtime model apply: ${id}` });
    return;
  }
  const modelId = typeof req.body?.modelId === "string" ? req.body.modelId.trim() : "";
  if (!modelId) {
    res.status(400).json({ error: "modelId is required" });
    return;
  }

  try {
    const settings = await getSettings();
    const applied = await applySlotModelRuntime(id, modelId, settings);
    persistSlotModelId(id, settings, applied.modelId);
    await saveSettings(settings);
    if (id === "inference") invalidateModelCache();

    const server = await getLlamaServerStatus(id, settings);
    res.json({ server, overridePath: applied.overridePath, mode: applied.mode });
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
    let pendingModelId: string | null = null;

    // Map request fields to settings keys per server role
    if (def.id === "inference") {
      if (body.url !== undefined) settings.llamacppUrl = (body.url as string).trim() || undefined;
      if (body.modelId !== undefined) settings.defaultModelId = (body.modelId as string).trim() || settings.defaultModelId;
      if (body.enabled !== undefined) settings.llamacppEnabled = Boolean(body.enabled);
      if (body.sharesGpu !== undefined) settings.llamacppSharesGpu = Boolean(body.sharesGpu);
      if (body.binaryPath !== undefined) {
        const v = (body.binaryPath as string)?.trim();
        if (!settings.llamaServerBins) settings.llamaServerBins = {};
        if (v) settings.llamaServerBins["inference"] = v;
        else delete settings.llamaServerBins["inference"];
      }
    }
    if (def.id === "extraction") {
      if (body.url !== undefined) settings.extractionModelUrl = (body.url as string).trim() || undefined;
      if (body.modelId !== undefined) {
        const v = (body.modelId as string).trim();
        pendingModelId = v || null;
      }
      if (body.ctxSize !== undefined) settings.extractionCtxSize = Number(body.ctxSize);
      if (body.maxTokens !== undefined) settings.extractionMaxTokens = Number(body.maxTokens);
      if (body.timeoutMs !== undefined) settings.extractionTimeoutMs = Number(body.timeoutMs);
      if (body.ctxSize !== undefined || body.maxTokens !== undefined || body.timeoutMs !== undefined) {
        const normalized = normalizeExtractionRequestSettings(settings);
        settings.extractionCtxSize = normalized.ctxSize;
        settings.extractionMaxTokens = normalized.maxTokens;
        settings.extractionTimeoutMs = normalized.timeoutMs;
      }
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
        pendingModelId = v || null;
      }
      if (body.binaryPath !== undefined) {
        const v = (body.binaryPath as string)?.trim();
        if (!settings.llamaServerBins) settings.llamaServerBins = {};
        if (v) settings.llamaServerBins["reranker"] = v;
        else delete settings.llamaServerBins["reranker"];
      }
    }
    if (def.id === "embedding") {
      if (body.provider !== undefined) settings.embeddingProvider = body.provider as "llamacpp";
      if (body.url !== undefined) settings.embeddingUrl = (body.url as string).trim() || undefined;
      if (body.modelId !== undefined) {
        const v = (body.modelId as string).trim();
        pendingModelId = v || null;
      }
      if (body.binaryPath !== undefined) {
        const v = (body.binaryPath as string)?.trim();
        if (!settings.llamaServerBins) settings.llamaServerBins = {};
        if (v) settings.llamaServerBins["embedding"] = v;
        else delete settings.llamaServerBins["embedding"];
      }
    }
    if (def.id === "title-generation") {
      if (body.enabled !== undefined) settings.titleGenerationEnabled = Boolean(body.enabled);
      if (body.url !== undefined) settings.titleGenerationUrl = (body.url as string).trim() || undefined;
      if (body.modelId !== undefined) {
        const v = (body.modelId as string).trim();
        pendingModelId = v || null;
      }
      if (body.binaryPath !== undefined) {
        const v = (body.binaryPath as string)?.trim();
        if (!settings.llamaServerBins) settings.llamaServerBins = {};
        if (v) settings.llamaServerBins["title-generation"] = v;
        else delete settings.llamaServerBins["title-generation"];
      }
    }

    if (pendingModelId && isOverridableSlot(def.id)) {
      const applied = await applySlotModelRuntime(def.id, pendingModelId, settings);
      persistSlotModelId(def.id, settings, applied.modelId);
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

async function hydrateDefaultConfig(id: LlamaServerId, settings: Awaited<ReturnType<typeof getSettings>>): Promise<LlamaServiceConfig> {
  const saved = settings.llamaServiceConfigs?.[id] as Partial<LlamaServiceConfig> | undefined;
  let config = mergeServiceConfig(id, settings, saved || {});
  const unitName = await resolveSlotUnitName(id);
  const override = await readOverride(unitName);
  if (override.contents) {
    config = parseManagedServiceConfig(id, override.contents, config);
  }
  if (config.mode === "single" && config.modelId && !config.modelPath) {
    const model = await findLocalModel(config.modelId);
    if (model) config.modelPath = model.ggufPath;
  }
  return config;
}

async function hydrateServiceConfig(id: LlamaServerId, settings: Awaited<ReturnType<typeof getSettings>>, patch: Partial<LlamaServiceConfig>): Promise<LlamaServiceConfig> {
  const config = mergeServiceConfig(id, settings, patch);
  if (config.mode === "single" && config.modelId && !config.modelPath) {
    const model = await findLocalModel(config.modelId);
    if (model) config.modelPath = model.ggufPath;
  }
  return config;
}

function persistServiceConfigToSettings(id: LlamaServerId, settings: Awaited<ReturnType<typeof getSettings>>, config: LlamaServiceConfig): void {
  if (!settings.llamaServiceConfigs) settings.llamaServiceConfigs = {};
  settings.llamaServiceConfigs[id] = config;

  if (!settings.llamaServerBins) settings.llamaServerBins = {};
  if (config.binaryPath) settings.llamaServerBins[id] = config.binaryPath;
  if (config.binaryPath === getDefaultLlamaBin()) delete settings.llamaServerBins[id];

  if (id === "inference") {
    settings.llamacppUrl = `http://${config.host}:${config.port}`;
    if (config.mode === "single" && config.modelId) settings.defaultModelId = config.modelId;
  } else if (id === "extraction") {
    settings.extractionModelUrl = `http://${config.host}:${config.port}`;
    settings.extractionCtxSize = config.ctxSize;
    if (config.modelId) settings.extractionModelId = config.modelId;
  } else if (id === "reranker") {
    settings.rerankerUrl = `http://${config.host}:${config.port}`;
    if (config.modelId) settings.rerankerModelId = config.modelId;
  } else if (id === "embedding") {
    settings.embeddingUrl = `http://${config.host}:${config.port}`;
    if (config.modelId) settings.embeddingModel = config.modelId;
  } else if (id === "title-generation") {
    settings.titleGenerationUrl = `http://${config.host}:${config.port}`;
    if (config.modelId) settings.titleGenerationModelId = config.modelId;
  }
}
