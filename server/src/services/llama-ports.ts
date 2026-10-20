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

/** Strata's server default (docs/design/strata-backend.md §3). Not a llama
 *  slot: the inference slot points here when inferenceBackend is "strata". */
export const STRATA_DEFAULT_PORT = 8080;
export const STRATA_DEFAULT_URL = `http://${LLAMA_SERVER_URL_HOST}:${STRATA_DEFAULT_PORT}`;
