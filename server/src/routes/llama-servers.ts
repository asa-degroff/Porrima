import { Router } from "express";
import path from "path";
import os from "os";
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
import { findLocalModel, listLocalModels, scanDirectory, resolveModelsDirs, type LlamaModelKind } from "../services/llama-models-disk.js";
import { getDefaultLlamaBin, isOverridableSlot, isRouterCapableSlot, renderRouterExecStart, resolveSlotEnvironment } from "../services/llama-launch-templates.js";
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
  canUseRouterMode,
  type LlamaServiceConfig,
} from "../services/llama-service-config.js";
import { normalizeExtractionRequestSettings } from "../services/extraction-settings.js";
import { canExposeNonDiskLlamaModel } from "../services/llama-model-aliases.js";

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

export interface RouterDirConflict {
  modelScanDir: string;
  currentModelsDir: string;
  modelId: string;
}

async function applySlotModelRuntime(
  id: LlamaServerId,
  modelId: string,
  settings: Awaited<ReturnType<typeof getSettings>>,
  options: { reconfigureModelsDir?: boolean; scanDir?: string } = {}
): Promise<{ modelId: string; overridePath: string | null; mode: "router-load" | "override-restart"; reconfiguredModelsDir?: string }> {
  const normalizedModelId = normalizeRouterModelId(modelId.trim());
  const preStatus = await getLlamaServerStatus(id, settings);
  const inRouterMode = preStatus.http.routerMode;
  const currentModelsDir = inRouterMode ? await resolveSlotModelsDir(id, settings) : undefined;
  const preferredScanDir = options.scanDir || currentModelsDir;
  const model = await findLocalModel(normalizedModelId, settings.llamaModelsDirs, preferredScanDir);
  if (!model) {
    throw new Error(`Model not found in any configured models directory: ${normalizedModelId}`);
  }
  if (options.scanDir && model.scanDir !== options.scanDir) {
    throw new Error(`Model ${normalizedModelId} was not found in selected directory: ${options.scanDir}`);
  }
  if (model.kind !== SLOT_KIND[id]) {
    throw new Error(`Model ${normalizedModelId} is kind '${model.kind}', not '${SLOT_KIND[id]}' as required by ${id}`);
  }

  if (inRouterMode) {
    // Check if the model is already available in the router's --models-dir.
    // If the model's scanDir differs from the service's modelsDir, the router
    // won't be able to load it without a --models-dir reconfiguration.
    if (currentModelsDir && model.scanDir !== currentModelsDir) {
      if (!options.reconfigureModelsDir) {
        // Signal conflict — the client should ask the user to confirm.
        const conflict: RouterDirConflict = {
          modelScanDir: model.scanDir,
          currentModelsDir,
          modelId: model.id,
        };
        const err: any = new Error("model directory mismatch");
        err.conflict = conflict;
        err.status = 409;
        throw err;
      }
      // User confirmed — reconfigure the service's --models-dir and restart.
      await reconfigureSlotModelsDir(id, model.scanDir, settings);
      // Wait for the server to come back up
      await waitForServerHealthy(id, settings, 15_000);
    }

    const freshStatus = await getLlamaServerStatus(id, settings);
    const ctxOverride = id === "extraction" ? settings.extractionCtxSize : undefined;
    const result = await ensureRouterModelLoaded(freshStatus.url, model.id, { contextWindow: ctxOverride, force: true });
    if (result === "not-router") {
      throw new Error(`Slot reported router mode but /models/load returned 404. Try refreshing.`);
    }
    if (result === "error") {
      throw new Error(`Slot accepted but failed to load model ${normalizedModelId}. Check service logs.`);
    }
    return {
      modelId: model.id,
      overridePath: null,
      mode: "router-load",
      reconfiguredModelsDir: options.reconfigureModelsDir ? model.scanDir : undefined,
    };
  }

  if (id === "inference") {
    throw new Error("Chat inference model changes require router mode. Update the managed service config or restart with --models-dir.");
  }

  const currentConfig = await hydrateDefaultConfig(id, settings);
  const nextConfig = mergeServiceConfig(id, settings, {
    ...currentConfig,
    mode: "single",
    modelPath: model.ggufPath,
    modelId: model.id,
  });
  const execStart = renderServiceExecStart(id, nextConfig);
  const unitName = await resolveSlotUnitName(id);
  const envLines = nextConfig.environment.length ? nextConfig.environment : [];
  const result = await applyModelOverride(unitName, execStart, { environmentLines: envLines.length ? envLines : undefined });
  persistServiceConfigToSettings(id, settings, nextConfig);
  invalidateRouterCache(preStatus.url);
  return { modelId: model.id, overridePath: result.overridePath, mode: "override-restart" };
}

/**
 * Resolve the current --models-dir for a slot by reading its deployed
 * service config (managed drop-in if present, otherwise defaults).
 */
async function resolveSlotModelsDir(id: LlamaServerId, settings: Awaited<ReturnType<typeof getSettings>>): Promise<string | undefined> {
  if (!canUseRouterMode(id)) return undefined;
  try {
    const unitName = await resolveSlotUnitName(id);
    const config = getDefaultServiceConfig(id, settings);
    const override = await readOverride(unitName);
    if (override.contents) {
      const parsed = parseManagedServiceConfig(id, override.contents, config);
      return parsed.modelsDir;
    }
    return config.modelsDir;
  } catch {
    return undefined;
  }
}

/**
 * Reconfigure a slot's --models-dir by writing a managed systemd drop-in
 * and restarting the service. Uses the slot's current config with only
 * the modelsDir and mode changed.
 */
async function reconfigureSlotModelsDir(id: LlamaServerId, newModelsDir: string, settings: Awaited<ReturnType<typeof getSettings>>): Promise<void> {
  const unitName = await resolveSlotUnitName(id);
  const baseConfig = getDefaultServiceConfig(id, settings);
  const override = await readOverride(unitName);
  const currentConfig = override.contents ? parseManagedServiceConfig(id, override.contents, baseConfig) : baseConfig;
  // Override the modelsDir and ensure router mode
  const config: LlamaServiceConfig = {
    ...currentConfig,
    mode: "router",
    modelsDir: newModelsDir,
    modelPath: undefined,
    modelId: undefined,
  };
  const execStart = renderServiceExecStart(id, config);
  const envLines = config.environment.length ? config.environment : resolveSlotEnvironment(id, settings);
  await applyModelOverride(unitName, execStart, { environmentLines: envLines.length ? envLines : undefined });
  invalidateRouterCache();
}

/**
 * Poll a llama.cpp server until it becomes healthy or the timeout is reached.
 * Used after a --models-dir reconfiguration which requires a service restart.
 */
async function waitForServerHealthy(id: LlamaServerId, settings: Awaited<ReturnType<typeof getSettings>>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await getLlamaServerStatus(id, settings);
      if (status.http.status === "ok") return;
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 500));
  }
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

    const settings = await getSettings();
    const all = await listLocalModels(settings.llamaModelsDirs);
    const filtered = kindFilter ? all.filter((m) => m.kind === kindFilter) : all;
    const models = new Map<string, {
      id: string;
      name: string;
      ggufPath?: string;
      sizeBytes: number;
      kind: LlamaModelKind;
      hasMmproj: boolean;
      scanDir?: string;
      source: "disk" | "server" | "settings";
    }>();

    for (const m of filtered) {
      // Use a compound key when the same id appears in multiple scan dirs.
      // This ensures both entries are visible in the dropdown.
      const mapKey = models.has(m.id) ? `${m.id}::${m.scanDir}` : m.id;
      models.set(mapKey, {
        id: m.id,
        name: m.name,
        ggufPath: m.ggufPath,
        sizeBytes: m.sizeBytes,
        kind: m.kind,
        hasMmproj: m.hasMmproj,
        scanDir: m.scanDir,
        source: "disk",
      });
    }

    if (slot && kindFilter && canExposeNonDiskLlamaModel(slot)) {
      const server = await getLlamaServerStatus(slot, settings).catch(() => null);
      const expectedModel = server?.expectedModel;
      if (expectedModel && !models.has(expectedModel)) {
        models.set(expectedModel, {
          id: expectedModel,
          name: expectedModel,
          sizeBytes: 0,
          kind: kindFilter,
          hasMmproj: false,
          source: "settings",
        });
      }
      for (const id of server?.http.modelIds || []) {
        if (!id || models.has(id)) continue;
        models.set(id, {
          id,
          name: id,
          sizeBytes: 0,
          kind: kindFilter,
          hasMmproj: false,
          source: "server",
        });
      }
    }

    res.json({
      models: [...models.values()].sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Failed to list local llama.cpp models" });
  }
});

// Model scan paths — list, add, remove directories scanned for GGUF models.
router.get("/scan-paths", async (_req, res) => {
  const settings = await getSettings();
  const dirs = resolveModelsDirs(settings.llamaModelsDirs);
  const results = await Promise.all(
    dirs.map(async (dir) => {
      try {
        const models = await scanDirectory(dir, { requireReadable: true });
        return { path: dir, modelCount: models.length, valid: true };
      } catch (e: any) {
        return { path: dir, modelCount: 0, valid: false, error: e?.message || "Directory not found or not readable" };
      }
    })
  );
  res.json({ dirs: results });
});

// Preview a candidate scan directory — returns model count and first few
// model names without persisting anything.
router.post("/scan-paths/preview", async (req, res) => {
  const candidate = typeof req.body?.path === "string" ? req.body.path.trim() : "";
  if (!candidate) {
    res.status(400).json({ error: "path is required" });
    return;
  }
  try {
    // Expand ~ to home directory
    const expanded = candidate.startsWith("~/")
      ? path.join(os.homedir(), candidate.slice(2))
      : candidate;
    const models = await scanDirectory(expanded, { requireReadable: true });
    res.json({
      path: expanded,
      modelCount: models.length,
      models: models.slice(0, 10).map((m) => ({ id: m.id, kind: m.kind, hasMmproj: m.hasMmproj })),
      valid: true,
    });
  } catch (e: any) {
    res.json({
      path: candidate,
      modelCount: 0,
      models: [],
      valid: false,
      error: e?.message || "Directory not found or not readable",
    });
  }
});

// Add a scan path to settings.
router.post("/scan-paths", async (req, res) => {
  const candidate = typeof req.body?.path === "string" ? req.body.path.trim() : "";
  if (!candidate) {
    res.status(400).json({ error: "path is required" });
    return;
  }
  // Expand ~
  const expanded = candidate.startsWith("~/")
    ? path.join(os.homedir(), candidate.slice(2))
    : candidate;
  const settings = await getSettings();
  const dirs = resolveModelsDirs(settings.llamaModelsDirs);
  if (dirs.includes(expanded)) {
    res.status(409).json({ error: "Directory already in scan paths" });
    return;
  }
  let models;
  try {
    models = await scanDirectory(expanded, { requireReadable: true });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "Directory not found or not readable" });
    return;
  }
  dirs.push(expanded);
  settings.llamaModelsDirs = dirs;
  await saveSettings(settings);
  res.json({ dirs: [{ path: expanded, modelCount: models.length, valid: true }] });
});

// Remove a scan path from settings.
router.delete("/scan-paths", async (req, res) => {
  const target = typeof req.query.path === "string" ? req.query.path.trim() : "";
  if (!target) {
    res.status(400).json({ error: "path query parameter is required" });
    return;
  }
  const expanded = target.startsWith("~/")
    ? path.join(os.homedir(), target.slice(2))
    : target;
  const settings = await getSettings();
  const dirs = resolveModelsDirs(settings.llamaModelsDirs);
  const filtered = dirs.filter((d) => d !== expanded);
  if (filtered.length === dirs.length) {
    res.status(404).json({ error: "Directory not found in scan paths" });
    return;
  }
  settings.llamaModelsDirs = filtered;
  await saveSettings(settings);
  res.json({ removed: expanded });
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
    if (id === "inference") invalidateModelCache();
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
    let changed = false;
    if (settings.llamaServiceConfigs) {
      changed = Object.prototype.hasOwnProperty.call(settings.llamaServiceConfigs, id) || changed;
      delete settings.llamaServiceConfigs[id];
    }
    if (settings.llamaServerBins) {
      changed = Object.prototype.hasOwnProperty.call(settings.llamaServerBins, id) || changed;
      delete settings.llamaServerBins[id];
    }
    if (changed) {
      await saveSettings(settings);
    }
    if (id === "inference") invalidateModelCache();
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
  const reconfigureModelsDir = Boolean(req.body?.reconfigureModelsDir);
  const scanDir = typeof req.body?.scanDir === "string" && req.body.scanDir.trim()
    ? req.body.scanDir.trim()
    : undefined;

  try {
    const settings = await getSettings();
    const applied = await applySlotModelRuntime(id, modelId, settings, { reconfigureModelsDir, scanDir });
    persistSlotModelId(id, settings, applied.modelId);
    await saveSettings(settings);
    if (id === "inference") invalidateModelCache();

    const server = await getLlamaServerStatus(id, settings);
    res.json({ server, overridePath: applied.overridePath, mode: applied.mode, reconfiguredModelsDir: applied.reconfiguredModelsDir });
  } catch (e: any) {
    if (e.conflict) {
      res.status(e.status || 409).json({
        error: e.message,
        conflict: e.conflict,
      });
      return;
    }
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
    let pendingBinaryPath: string | undefined;

    // Map request fields to settings keys per server role
    if (def.id === "inference") {
      if (body.url !== undefined) settings.llamacppUrl = (body.url as string).trim() || undefined;
      if (body.modelId !== undefined) settings.defaultModelId = (body.modelId as string).trim() || settings.defaultModelId;
      if (body.enabled !== undefined) settings.llamacppEnabled = Boolean(body.enabled);
      if (body.sharesGpu !== undefined) settings.llamacppSharesGpu = Boolean(body.sharesGpu);
      if (body.binaryPath !== undefined) {
        const v = (body.binaryPath as string)?.trim();
        pendingBinaryPath = v || "";
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
        pendingBinaryPath = v || "";
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
        pendingBinaryPath = v || "";
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
        pendingBinaryPath = v || "";
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
        pendingBinaryPath = v || "";
        if (!settings.llamaServerBins) settings.llamaServerBins = {};
        if (v) settings.llamaServerBins["title-generation"] = v;
        else delete settings.llamaServerBins["title-generation"];
      }
    }

    if (pendingBinaryPath !== undefined && isOverridableSlot(def.id)) {
      const unitName = await resolveSlotUnitName(def.id);
      const currentConfig = await hydrateDefaultConfig(def.id, settings);
      const binaryPath = pendingBinaryPath || getDefaultLlamaBin();
      const nextConfig = mergeServiceConfig(def.id, settings, {
        ...currentConfig,
        binaryPath,
        environment: updateBinaryEnvironment(currentConfig.environment, binaryPath),
      });
      await validateServiceConfig(def.id, nextConfig);
      const execStart = renderServiceExecStart(def.id, nextConfig);
      await applyModelOverride(
        unitName,
        execStart,
        { environmentLines: nextConfig.environment.length ? nextConfig.environment : undefined }
      );
      persistServiceConfigToSettings(def.id, settings, nextConfig);
    }

    if (pendingModelId && isOverridableSlot(def.id)) {
      const localModel = await findLocalModel(normalizeRouterModelId(pendingModelId), settings.llamaModelsDirs);
      if (localModel) {
        const applied = await applySlotModelRuntime(def.id, pendingModelId, settings);
        persistSlotModelId(def.id, settings, applied.modelId);
      } else if (def.id === "reranker" || def.id === "embedding") {
        // These are single-model services and may be launched directly from an
        // absolute GGUF path outside ~/.local/share/llama-models. In that case
        // changing the request model name is still valid because llama.cpp
        // accepts aliases for the currently served model, but there is no local
        // disk entry to use for rewriting ExecStart.
        persistSlotModelId(def.id, settings, pendingModelId);
      } else {
        const applied = await applySlotModelRuntime(def.id, pendingModelId, settings);
        persistSlotModelId(def.id, settings, applied.modelId);
      }
    }

    await saveSettings(settings);
    if (def.id === "inference") invalidateModelCache();

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
    const model = await findLocalModel(config.modelId, settings.llamaModelsDirs);
    if (model) config.modelPath = model.ggufPath;
  }
  return config;
}

async function hydrateServiceConfig(id: LlamaServerId, settings: Awaited<ReturnType<typeof getSettings>>, patch: Partial<LlamaServiceConfig>): Promise<LlamaServiceConfig> {
  const config = mergeServiceConfig(id, settings, patch);
  if (config.mode === "single" && config.modelId && !config.modelPath) {
    const model = await findLocalModel(config.modelId, settings.llamaModelsDirs);
    if (model) config.modelPath = model.ggufPath;
  }
  return config;
}

function updateBinaryEnvironment(environment: string[], binaryPath: string): string[] {
  const withoutLdLibraryPath = environment.filter((line) => !line.startsWith("LD_LIBRARY_PATH="));
  if (binaryPath === getDefaultLlamaBin()) return withoutLdLibraryPath;
  return [`LD_LIBRARY_PATH=${path.dirname(binaryPath)}`, ...withoutLdLibraryPath];
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
