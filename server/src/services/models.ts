import type { Model } from "@earendil-works/pi-ai";
import type { InferenceModel, Settings } from "../types.js";
import { getSettings } from "./chat-storage.js";
import { getDefaultLlamaServerUrl } from "./llama-ports.js";
import { normalizeRouterModelId } from "./llama-router-client.js";

const LLAMACPP_DEFAULT_URL = getDefaultLlamaServerUrl("inference");

// ---------------------------------------------------------------------------
// llama.cpp model discovery
// ---------------------------------------------------------------------------

interface LlamaCppModelEntry {
  id: string;
  object: string;
  owned_by?: string;
  meta?: { n_ctx?: number; n_ctx_train?: number };
  status?: {
    value?: string;
    args?: string[];
    preset?: string;
  };
}

interface LlamaCppModelsResponse {
  data: LlamaCppModelEntry[];
  models?: Array<{
    name?: string;
    model?: string;
    capabilities?: string[];
  }>;
}

interface LlamaCppPropsResponse {
  default_generation_settings?: {
    n_ctx?: number;
  };
  modalities?: {
    vision?: boolean;
    audio?: boolean;
  };
  model_alias?: string;
}

// Cache for model discovery results (TTL-based)
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let llamacppCache: { models: InferenceModel[]; timestamp: number } | null = null;

export async function discoverLlamaCppModels(settings?: Settings): Promise<InferenceModel[]> {
  if (llamacppCache && Date.now() - llamacppCache.timestamp < MODEL_CACHE_TTL_MS) {
    return llamacppCache.models;
  }

  const s = settings ?? await getSettings();
  if (!s.llamacppEnabled) return [];
  const baseUrl = s.llamacppUrl || LLAMACPP_DEFAULT_URL;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    // Fetch models and props in parallel
    const [modelsRes, propsRes] = await Promise.all([
      fetch(`${baseUrl}/v1/models`, { signal: controller.signal }),
      fetch(`${baseUrl}/props`, { signal: controller.signal }).catch(() => null),
    ]);
    clearTimeout(timeoutId);

    if (!modelsRes.ok) throw new Error(`llama.cpp not reachable: ${modelsRes.status}`);
    const modelsData = (await modelsRes.json()) as LlamaCppModelsResponse;

    // Get context window from /props if available
    let propsData: LlamaCppPropsResponse | undefined;
    let propsContextWindow: number | undefined;
    if (propsRes?.ok) {
      try {
        propsData = (await propsRes.json()) as LlamaCppPropsResponse;
        propsContextWindow = propsData.default_generation_settings?.n_ctx;
      } catch { /* ignore parse errors */ }
    }

    const DEFAULT_CONTEXT_WINDOW = 32768;

    // Query per-model props for loaded models to get accurate modalities and context window
    const loadedModels = modelsData.data.filter((m) => m.status?.value === "loaded");
    const modelPropsMap = new Map<string, LlamaCppPropsResponse>();
    await Promise.all(
      loadedModels.map(async (m) => {
        try {
          const r = await fetch(`${baseUrl}/props?model=${encodeURIComponent(m.id)}`, { signal: AbortSignal.timeout(3000) });
          if (r.ok) modelPropsMap.set(m.id, await r.json());
        } catch { /* ignore — props query is best-effort */ }
      })
    );

    const models: InferenceModel[] = modelsData.data
      .filter((m) => m.id && !m.id.includes("embedding"))
      // Exclude HF-cached model presets (contain '/') — they duplicate local models
      // and try to download from HuggingFace which is unreliable. Local models in
      // --models-dir are the authoritative source.
      .filter((m) => !m.id.includes("/"))
      .map((m) => {
        // A single-model llama.cpp server omits router-only status metadata from
        // /v1/models. In that mode the top-level /props response belongs to the
        // sole model and is the authoritative source for runtime modalities.
        const singleModelProps = modelsData.data.length === 1 &&
          (!propsData?.model_alias || propsData.model_alias === m.id)
          ? propsData
          : undefined;
        const modelProps = modelPropsMap.get(m.id) ?? singleModelProps;

        // Newer llama.cpp versions also expose an Ollama-compatible model list
        // whose capabilities include "multimodal" when an mmproj is loaded.
        const advertisedModel = modelsData.models?.find((candidate) =>
          candidate.model === m.id || candidate.name === m.id
        );
        const hasAdvertisedVision = advertisedModel?.capabilities?.some((capability) => {
          const normalized = capability.toLowerCase();
          return normalized === "multimodal" || normalized === "vision" || normalized === "image";
        }) ?? false;

        // Model args and preset from the router status — available for all models,
        // not just loaded ones. Contains --ctx-size, --mmproj, etc.
        const modelArgs = m.status?.args ?? [];
        const modelPreset = m.status?.preset ?? "";

        // Context window detection — use model args --ctx-size as the most reliable
        // source since the router-level /props returns n_ctx: 0. Per-model /props
        // for loaded models is the next best source.
        let contextWindow = modelProps?.default_generation_settings?.n_ctx ??
          m.meta?.n_ctx ?? propsContextWindow ?? DEFAULT_CONTEXT_WINDOW;
        const ctxSizeArgIdx = modelArgs.indexOf("--ctx-size");
        if (ctxSizeArgIdx !== -1 && ctxSizeArgIdx + 1 < modelArgs.length) {
          const parsed = parseInt(modelArgs[ctxSizeArgIdx + 1], 10);
          if (!isNaN(parsed) && parsed > 0) {
            contextWindow = parsed;
          }
        }

        // Vision detection — four signals in priority order:
        // 1. --mmproj flag in model args/preset (definitive — configured by the user)
        // 2. Advertised multimodal capability from /v1/models
        // 3. /props modalities (per-model in router mode, top-level in single-model mode)
        // 4. Name heuristic (fallback for models without runtime capability data)
        const hasMmproj = modelArgs.some(a => a === "--mmproj" || (typeof a === "string" && a.startsWith("--mmproj"))) ||
          /\nmmproj\s*=/.test(modelPreset) ||
          modelArgs.some(a => typeof a === "string" && a.includes("mmproj") && a.endsWith(".gguf"));

        let supportsImages = false;
        if (hasMmproj) {
          // mmproj is configured — this model definitively supports vision
          supportsImages = true;
        } else if (hasAdvertisedVision) {
          // llama.cpp explicitly advertises a loaded multimodal projector
          supportsImages = true;
        } else if (modelProps?.modalities?.vision) {
          // Runtime props report vision support
          supportsImages = true;
        } else {
          // Name heuristic — catches models whose names indicate vision capability
          // but that might not have mmproj configured yet (e.g., HF-repo models)
          const nameLower = m.id.toLowerCase();
          supportsImages = nameLower.includes("vision") || nameLower.includes("-vl") ||
            nameLower.includes("llava") || nameLower.includes("pixtral");
        }
        return {
          id: m.id,
          name: formatLlamaCppModelName(m.id),
          parameterSize: "",  // llama.cpp /v1/models doesn't provide this
          family: "",
          contextWindow,
          supportsImages,
          provider: "llamacpp" as const,
        };
      });

    llamacppCache = { models, timestamp: Date.now() };
    return models;
  } catch (error) {
    clearTimeout(timeoutId);
    console.error("[models] discoverLlamaCppModels failed:", error);
    if (llamacppCache) {
      console.warn("[models] returning stale llama.cpp cache");
      return llamacppCache.models;
    }
    return [];
  }
}

function formatLlamaCppModelName(id: string): string {
  // llama.cpp model IDs can be filenames like "my-model-Q4_K_M.gguf" or HF-style "org/model"
  let name = id;
  // Strip .gguf extension
  name = name.replace(/\.gguf$/i, "");
  // Strip path prefixes
  if (name.includes("/")) {
    name = name.split("/").pop() || name;
  }
  // Title-case words separated by hyphens/underscores
  return name
    .split(/[-_]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

/**
 * Discover models from all enabled providers.
 * Returns a unified list tagged with their provider.
 */
export async function discoverAllModels(): Promise<InferenceModel[]> {
  return discoverLlamaCppModels();
}

/** Invalidate model caches (e.g., after settings change). */
export function invalidateModelCache() {
  llamacppCache = null;
}

export interface ExtractionRoute {
  baseUrl: string;
  modelId: string;
  ctxSize: number;
}

/**
 * Returns the dedicated extraction server's routing info if configured,
 * otherwise null. Background tasks that match this modelId should route
 * directly to baseUrl (typically a CPU-only llama.cpp instance) instead of
 * going through the chat router and contending with the GPU chat model.
 */
export async function getExtractionRoute(): Promise<ExtractionRoute | null> {
  const settings = await getSettings();
  const baseUrl = settings.extractionModelUrl?.trim();
  const modelId = settings.extractionModelId?.trim();
  if (!baseUrl || !modelId) return null;
  return {
    baseUrl,
    modelId: normalizeRouterModelId(modelId),
    ctxSize: settings.extractionCtxSize ?? 16384,
  };
}

/**
 * Get the effective context window for a chat.
 *
 * Priority order:
 * 1. Explicit chat override (chat.contextWindow) - user knows best
 * 2. Model's detected context window (model.contextWindow) - from discovery
 * 3. Safe fallback (32768) - when detection fails
 */
export function getEffectiveContextWindow(
  chat: { contextWindow?: number; modelId?: string },
  model: InferenceModel | undefined,
): number {
  if (chat.contextWindow) {
    return chat.contextWindow;
  }
  if (model?.contextWindow) {
    return model.contextWindow;
  }
  // Fallback to conservative default - better to compact early than overflow
  return 32768;
}

/**
 * Create a pi-ai Model from a discovered inference model.
 * All models now route through the openai-compat (llama.cpp) provider.
 */
export async function createPiModelFromProvider(
  model: InferenceModel
): Promise<Model<string>> {
  const settings = await getSettings();
  const baseUrl = settings.llamacppUrl || LLAMACPP_DEFAULT_URL;
  const input: ("text" | "image")[] = model.supportsImages ? ["text", "image"] : ["text"];
  return {
    id: model.id,
    name: model.name,
    api: "openai-compat",
    provider: "llamacpp",
    baseUrl,
    reasoning: true, // thinking arrives via delta.reasoning_content; non-reasoning models simply emit none
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: 32768,
  };
}
