import type { LlamaServerId } from "../api/client";

export const LLAMA_SERVER_PORTS: Record<LlamaServerId, number> = {
  inference: 32100,
  extraction: 32101,
  reranker: 32102,
  embedding: 32103,
  "title-generation": 32104,
};

export function getDefaultLlamaServerUrl(id: LlamaServerId): string {
  return `http://localhost:${LLAMA_SERVER_PORTS[id]}`;
}

/** Strata's server default (docs/design/strata-backend.md §3). */
export const STRATA_DEFAULT_PORT = 8080;
export const STRATA_DEFAULT_URL = `http://localhost:${STRATA_DEFAULT_PORT}`;
