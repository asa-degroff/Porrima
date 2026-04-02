import type { Model } from "@mariozechner/pi-ai";
import type { OllamaModel, Settings } from "../types.js";
import { getSettings } from "./chat-storage.js";

const OLLAMA_BASE = "http://localhost:11434";
const LLAMACPP_DEFAULT_URL = "http://localhost:8080";

interface OllamaTagResponse {
  models: Array<{
    name: string;
    model: string;
    details: {
      parameter_size: string;
      family: string;
    };
  }>;
}

interface ModelInfoResult {
  contextWindow: number;
  supportsImages: boolean;
}

async function getModelCapabilities(modelName: string): Promise<ModelInfoResult> {
  // Safe default for cloud models and models with failed /api/show calls.
  // When detection succeeds, the model's actual context_length is used.
  // Users can set a lower limit per-model in settings if KV cache is a concern.
  const DEFAULT_CONTEXT_WINDOW = 32768;
  const result: ModelInfoResult = {
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    supportsImages: false,
  };

  // Cloud models can't be queried via /api/show (local Ollama endpoint only)
  // Return the conservative default with a log message
  if (modelName.includes(":cloud")) {
    console.log(`[models] ${modelName}: cloud model, using default context window ${result.contextWindow}`);
    return result;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout
    const res = await fetch(`${OLLAMA_BASE}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelName }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      console.warn(`[models] ${modelName}: /api/show returned ${res.status}, using default context window ${result.contextWindow}`);
      return result;
    }
    const data = await res.json();
    const modelInfo = data.model_info as Record<string, unknown> | undefined;
    if (modelInfo) {
      let detected = false;
      for (const key of Object.keys(modelInfo)) {
        // Context length detection
        if (key.endsWith(".context_length") && typeof modelInfo[key] === "number") {
          result.contextWindow = modelInfo[key] as number;
          detected = true;
        }
        // Vision capability detection: look for vision-related keys
        // Examples: qwen35.vision.*, llava.*, bakllava.*, etc.
        if (key.includes(".vision") || key.includes("llava") || key.includes("clip")) {
          result.supportsImages = true;
        }
      }
      if (detected) {
        console.log(`[models] ${modelName}: detected context window ${result.contextWindow}`);
      } else {
        console.warn(`[models] ${modelName}: /api/show succeeded but no context_length found, using default ${result.contextWindow}`);
      }
    } else {
      console.warn(`[models] ${modelName}: /api/show returned no model_info, using default ${result.contextWindow}`);
    }
  } catch (err) {
    console.warn(`[models] ${modelName}: /api/show failed (${err instanceof Error ? err.message : String(err)}), using default context window ${result.contextWindow}`);
  }
  return result;
}

// Cache for model discovery results (TTL-based)
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let modelCache: { models: OllamaModel[]; timestamp: number } | null = null;

export async function discoverOllamaModels(): Promise<OllamaModel[]> {
  if (modelCache && Date.now() - modelCache.timestamp < MODEL_CACHE_TTL_MS) {
    return modelCache.models;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout for discovery (handles 50+ models)

  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error(`Ollama not reachable: ${res.status}`);
    const data = (await res.json()) as OllamaTagResponse;

    const filtered = data.models.filter((m) => !m.name.includes("embedding"));

    // Use Promise.allSettled to isolate individual model failures
    // A single broken model shouldn't take down all model discovery
    const results = await Promise.allSettled(
      filtered.map(async (m) => {
        const capabilities = await getModelCapabilities(m.name);
        return {
          id: m.name,
          name: formatModelName(m.name, m.details.parameter_size),
          parameterSize: m.details.parameter_size,
          family: m.details.family,
          contextWindow: capabilities.contextWindow,
          supportsImages: capabilities.supportsImages,
        };
      })
    );

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    
    if (rejected.length > 0) {
      console.warn(`[models] ${rejected.length} model(s) failed to load:`);
      rejected.forEach((r, idx) => {
        const modelName = filtered[idx]?.name ?? "unknown";
        console.warn(`  - ${modelName}: ${r.reason?.message || String(r.reason)}`);
      });
    }
    
    const models = fulfilled.map(r => r.value);
    modelCache = { models, timestamp: Date.now() };
    return models;
  } catch (error) {
    clearTimeout(timeoutId);
    console.error("[models] discoverOllamaModels failed:", error);
    // Return cached models on failure if available (graceful degradation)
    if (modelCache) {
      console.warn("[models] returning stale cache due to Ollama failure");
      return modelCache.models;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// llama.cpp model discovery
// ---------------------------------------------------------------------------

interface LlamaCppModelsResponse {
  data: Array<{
    id: string;
    object: string;
    owned_by?: string;
    meta?: { n_ctx_train?: number };
  }>;
}

interface LlamaCppPropsResponse {
  default_generation_settings?: {
    n_ctx?: number;
  };
}

let llamacppCache: { models: OllamaModel[]; timestamp: number } | null = null;

export async function discoverLlamaCppModels(settings?: Settings): Promise<OllamaModel[]> {
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
    let propsContextWindow: number | undefined;
    if (propsRes?.ok) {
      try {
        const propsData = (await propsRes.json()) as LlamaCppPropsResponse;
        propsContextWindow = propsData.default_generation_settings?.n_ctx;
      } catch { /* ignore parse errors */ }
    }

    const DEFAULT_CONTEXT_WINDOW = 32768;

    const models: OllamaModel[] = modelsData.data
      .filter((m) => m.id && !m.id.includes("embedding"))
      .map((m) => {
        const contextWindow = m.meta?.n_ctx_train ?? propsContextWindow ?? DEFAULT_CONTEXT_WINDOW;
        // Vision heuristic: check model name for common vision model patterns
        const nameLower = m.id.toLowerCase();
        const supportsImages = nameLower.includes("vision") || nameLower.includes("-vl") ||
          nameLower.includes("llava") || nameLower.includes("pixtral");
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
    return []; // Graceful — llama.cpp being down shouldn't break Ollama
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
export async function discoverAllModels(): Promise<OllamaModel[]> {
  const settings = await getSettings();
  const [ollamaModels, llamacppModels] = await Promise.all([
    discoverOllamaModels().catch((err) => {
      console.error("[models] Ollama discovery failed:", err);
      return [] as OllamaModel[];
    }),
    discoverLlamaCppModels(settings),
  ]);

  // Tag Ollama models that don't have a provider field yet
  const tagged = ollamaModels.map((m) => ({ ...m, provider: m.provider ?? ("ollama" as const) }));
  return [...tagged, ...llamacppModels];
}

/** Invalidate model caches (e.g., after settings change). */
export function invalidateModelCache() {
  modelCache = null;
  llamacppCache = null;
}

function supportsReasoning(family: string): boolean {
  return family.startsWith("qwen3");
}

/**
 * Get the effective context window for a chat.
 *
 * Priority order:
 * 1. Explicit chat override (chat.contextWindow) - user knows best
 * 2. Per-model setting (settings.modelContextWindows[modelId]) - user's persistent preference
 * 3. Model's detected context window (model.contextWindow) - from /api/show
 * 4. Safe fallback (32768) - when detection fails
 */
export function getEffectiveContextWindow(
  chat: { contextWindow?: number; modelId?: string },
  model: OllamaModel | undefined,
  settings?: { modelContextWindows?: Record<string, number> }
): number {
  if (chat.contextWindow) {
    return chat.contextWindow;
  }
  if (chat.modelId && settings?.modelContextWindows?.[chat.modelId]) {
    return settings.modelContextWindows[chat.modelId];
  }
  if (model?.contextWindow) {
    return model.contextWindow;
  }
  // Fallback to conservative default - better to compact early than overflow
  return 32768;
}

export function createPiModel(
  ollamaModel: OllamaModel
): Model<"ollama-native"> {
  const reasoning = supportsReasoning(ollamaModel.family);
  // Only advertise image support if the model actually has vision capabilities
  const input: ("text" | "image")[] = ollamaModel.supportsImages ? ["text", "image"] : ["text"];
  return {
    id: ollamaModel.id,
    name: ollamaModel.name,
    api: "ollama-native",
    provider: "ollama",
    baseUrl: OLLAMA_BASE,
    reasoning,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: ollamaModel.contextWindow,
    maxTokens: 32768,
  };
}

/**
 * Create a pi-ai Model from any provider's model.
 * Dispatches to the correct API based on the model's provider field.
 */
export async function createPiModelFromProvider(
  model: OllamaModel
): Promise<Model<string>> {
  if (model.provider === "llamacpp") {
    const settings = await getSettings();
    const baseUrl = settings.llamacppUrl || LLAMACPP_DEFAULT_URL;
    const input: ("text" | "image")[] = model.supportsImages ? ["text", "image"] : ["text"];
    return {
      id: model.id,
      name: model.name,
      api: "openai-compat",
      provider: "llamacpp",
      baseUrl,
      reasoning: false, // llama.cpp OpenAI API doesn't expose reasoning tokens
      input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow,
      maxTokens: 32768,
    };
  }
  return createPiModel(model);
}

function formatModelName(id: string, paramSize: string): string {
  const base = id.split(":")[0];
  const parts = base.split(/[-_]/);
  const name = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
  return paramSize ? `${name} ${paramSize}` : name;
}
