/**
 * Non-disk aliases are useful for dedicated single-model services that may be
 * launched from an absolute GGUF path outside the configured scan tree.
 *
 * Chat-style slots load through the local GGUF scanner and router apply path,
 * so router-advertised HF repo presets such as `org/model:quant` are not
 * valid choices even if llama.cpp includes them in /v1/models.
 */
export function canExposeNonDiskLlamaModel(slot: string | undefined): boolean {
  return slot === "embedding" || slot === "reranker";
}
