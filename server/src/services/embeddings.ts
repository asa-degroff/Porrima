import { getSettings } from "./chat-storage.js";

const OLLAMA_DEFAULT_URL = "http://localhost:11434";
const LLAMACPP_DEFAULT_URL = "http://localhost:8084";
const DEFAULT_EMBEDDING_MODEL = "qwen3-embedding:0.6b";

interface EmbeddingConfig {
  provider: "ollama" | "llamacpp";
  url: string;
  model: string;
}

async function getEmbeddingConfig(): Promise<EmbeddingConfig> {
  const s = await getSettings();
  const provider = s.embeddingProvider ?? "ollama";
  const url = s.embeddingUrl || (provider === "llamacpp" ? LLAMACPP_DEFAULT_URL : OLLAMA_DEFAULT_URL);
  const model = s.embeddingModel || DEFAULT_EMBEDDING_MODEL;
  return { provider, url, model };
}

async function embedOllama(cfg: EmbeddingConfig, input: string | string[]): Promise<number[][]> {
  const res = await fetch(`${cfg.url}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.model,
      input,
      keep_alive: "0s",
      options: { num_gpu: 0 },
    }),
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Embedding failed (${res.status}): ${msg}`);
  }

  const data = (await res.json()) as { embeddings: number[][] };
  return data.embeddings;
}

async function embedLlamaCpp(cfg: EmbeddingConfig, input: string | string[]): Promise<number[][]> {
  // llama.cpp /v1/embeddings follows the OpenAI embeddings API shape.
  const res = await fetch(`${cfg.url}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.model,
      input,
    }),
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Embedding failed (${res.status}): ${msg}`);
  }

  const data = (await res.json()) as {
    data: Array<{ embedding: number[]; index?: number }>;
  };
  const sorted = [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const vectors = sorted.map((d) => d.embedding);
  // llama.cpp does not always L2-normalize. Normalize so cosine == dot product.
  return vectors.map(normalizeL2);
}

function normalizeL2(v: number[]): number[] {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum) || 1;
  if (Math.abs(norm - 1) < 1e-6) return v;
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

export async function embed(text: string): Promise<number[]> {
  const cfg = await getEmbeddingConfig();
  const vectors = cfg.provider === "llamacpp" ? await embedLlamaCpp(cfg, text) : await embedOllama(cfg, text);
  return vectors[0];
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const cfg = await getEmbeddingConfig();
  return cfg.provider === "llamacpp" ? await embedLlamaCpp(cfg, texts) : await embedOllama(cfg, texts);
}

export async function embedWithConfig(cfg: EmbeddingConfig, text: string): Promise<number[]> {
  const vectors = cfg.provider === "llamacpp" ? await embedLlamaCpp(cfg, text) : await embedOllama(cfg, text);
  return vectors[0];
}

export async function embedBatchWithConfig(cfg: EmbeddingConfig, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  return cfg.provider === "llamacpp" ? await embedLlamaCpp(cfg, texts) : await embedOllama(cfg, texts);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  // Vectors are L2-normalized, so dot product == cosine similarity.
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

export async function isEmbeddingModelAvailable(): Promise<boolean> {
  try {
    const cfg = await getEmbeddingConfig();
    if (cfg.provider === "llamacpp") {
      // Probe with a tiny embed; if it works, the model is loaded.
      const res = await fetch(`${cfg.url}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: cfg.model, input: "ping" }),
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    }
    const res = await fetch(`${cfg.url}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const data = (await res.json()) as { models: Array<{ name: string }> };
    const prefix = cfg.model.split(":")[0];
    return data.models.some((m) => m.name.startsWith(prefix));
  } catch {
    return false;
  }
}

export type { EmbeddingConfig };
export { getEmbeddingConfig };
