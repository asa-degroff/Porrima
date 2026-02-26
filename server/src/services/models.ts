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

export async function discoverOllamaModels(): Promise<OllamaModel[]> {
  const res = await fetch(`${OLLAMA_BASE}/api/tags`);
  if (!res.ok) throw new Error(`Ollama not reachable: ${res.status}`);
  const data = (await res.json()) as OllamaTagResponse;

  return data.models
    .filter((m) => !m.name.includes("embedding"))
    .map((m) => ({
      id: m.name,
      name: formatModelName(m.name, m.details.parameter_size),
      parameterSize: m.details.parameter_size,
      family: m.details.family,
      contextWindow: guessContextWindow(m.details.family),
    }));
}

function supportsReasoning(family: string): boolean {
  return family.startsWith("qwen3");
}

export function createPiModel(
  ollamaModel: OllamaModel
): Model<"openai-completions"> {
  const reasoning = supportsReasoning(ollamaModel.family);
  return {
    id: ollamaModel.id,
    name: ollamaModel.name,
    api: "openai-completions",
    provider: "ollama",
    baseUrl: `${OLLAMA_BASE}/v1`,
    reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: ollamaModel.contextWindow,
    maxTokens: 8192,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      supportsStrictMode: false,
      thinkingFormat: reasoning ? "qwen" : undefined,
    },
  };
}

function formatModelName(id: string, paramSize: string): string {
  const base = id.split(":")[0];
  const parts = base.split(/[-_]/);
  const name = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
  return paramSize ? `${name} ${paramSize}` : name;
}

function guessContextWindow(family: string): number {
  if (family.includes("qwen3")) return 32768;
  return 32768; // safe default
}
