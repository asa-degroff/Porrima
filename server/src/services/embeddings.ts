const OLLAMA_BASE = "http://localhost:11434";
const EMBEDDING_MODEL = "qwen3-embedding:0.6b";

export async function embed(text: string): Promise<number[]> {
  const res = await fetch(`${OLLAMA_BASE}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
      keep_alive: "0s",
      options: { num_gpu: 0 },
    }),
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Embedding failed (${res.status}): ${msg}`);
  }

  const data = (await res.json()) as { embeddings: number[][] };
  return data.embeddings[0];
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${OLLAMA_BASE}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts,
      keep_alive: "0s",
      options: { num_gpu: 0 },
    }),
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Batch embedding failed (${res.status}): ${msg}`);
  }

  const data = (await res.json()) as { embeddings: number[][] };
  return data.embeddings;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  // Ollama returns L2-normalized vectors, so dot product = cosine similarity
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

export async function isEmbeddingModelAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`);
    if (!res.ok) return false;
    const data = (await res.json()) as { models: Array<{ name: string }> };
    return data.models.some((m) => m.name.startsWith(EMBEDDING_MODEL.split(":")[0]));
  } catch {
    return false;
  }
}
