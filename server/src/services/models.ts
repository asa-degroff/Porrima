import type { Model } from "@mariozechner/pi-ai";
import type { OllamaModel } from "../types.js";

const OLLAMA_BASE = "http://localhost:11434";

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
  // Conservative default: 32k tokens. Better to compact early than overflow.
  // Cloud models and models with failed /api/show calls will use this safe default.
  const result: ModelInfoResult = {
    contextWindow: 32768,
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

function supportsReasoning(family: string): boolean {
  return family.startsWith("qwen3");
}

/**
 * Get the effective context window for a chat, with safety guards.
 * 
 * Priority order:
 * 1. Explicit chat override (chat.contextWindow) - user knows best
 * 2. Model's detected context window (model.contextWindow) - from /api/show
 * 3. Conservative default (32768) - safe fallback
 * 
 * This function exists to prevent context overflow when /api/show fails
 * or returns unreliable data. The conservative default ensures compaction
 * triggers before the model hits its actual limit.
 */
export function getEffectiveContextWindow(chat: { contextWindow?: number }, model: OllamaModel | undefined): number {
  if (chat.contextWindow) {
    return chat.contextWindow;
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

function formatModelName(id: string, paramSize: string): string {
  const base = id.split(":")[0];
  const parts = base.split(/[-_]/);
  const name = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
  return paramSize ? `${name} ${paramSize}` : name;
}
