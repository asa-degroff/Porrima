import type { Settings } from "../types.js";

export const OLLAMA_DEFAULT_URL = "http://localhost:11434";

// Resolve the Ollama base URL. Precedence: user setting > OLLAMA_URL env var > default.
export function getOllamaUrl(settings: Pick<Settings, "ollamaUrl"> | undefined | null): string {
  return settings?.ollamaUrl?.trim() || process.env.OLLAMA_URL || OLLAMA_DEFAULT_URL;
}
