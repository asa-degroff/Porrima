import type { LlamaServerId } from "./llama-supervisor.js";

export const LLAMA_SERVER_HOST = "127.0.0.1";
export const LLAMA_SERVER_URL_HOST = "localhost";

export const LLAMA_SERVER_PORTS: Record<LlamaServerId, number> = {
  inference: 32100,
  extraction: 32101,
  reranker: 32102,
  embedding: 32103,
  "title-generation": 32104,
};

export function getDefaultLlamaServerUrl(id: LlamaServerId): string {
  return `http://${LLAMA_SERVER_URL_HOST}:${LLAMA_SERVER_PORTS[id]}`;
}
