import type { Settings } from "../types.js";
import { getDefaultLlamaServerUrl, STRATA_DEFAULT_URL } from "./llama-ports.js";

// Backend selection for the inference slot. See
// docs/design/strata-backend.md. llama.cpp keeps its native control
// endpoints (router load, /apply-template, /tokenize, /completion warm);
// Strata is an OpenAI-compatible server whose conversation cache makes the
// native warm path unnecessary. Everything that branches on backend reads
// it through these helpers so the gate stays in one place.

export type InferenceBackend = "llamacpp" | "strata";

export function getInferenceBackend(
  settings: Pick<Settings, "inferenceBackend">,
): InferenceBackend {
  return settings.inferenceBackend === "strata" ? "strata" : "llamacpp";
}

export function isStrataBackend(
  settings: Pick<Settings, "inferenceBackend">,
): boolean {
  return getInferenceBackend(settings) === "strata";
}

/** Resolve the inference-slot base URL for the configured backend. The
 *  llamacppEnabled gate is shared: it toggles local inference discovery
 *  for either server. */
export function resolveInferenceBaseUrl(
  settings: Pick<Settings, "inferenceBackend" | "llamacppUrl" | "strataUrl">,
): string {
  return isStrataBackend(settings)
    ? settings.strataUrl?.trim() || STRATA_DEFAULT_URL
    : settings.llamacppUrl?.trim() || getDefaultLlamaServerUrl("inference");
}

/** Auth headers for a Strata base URL. Strata requires the key on the
 *  metadata endpoints (/props, /slots) when one is configured; llama.cpp
 *  URLs stay keyless. */
export function strataAuthHeaders(
  settings: Pick<Settings, "inferenceBackend" | "strataApiKey">,
): Record<string, string> | undefined {
  if (!isStrataBackend(settings)) return undefined;
  const key = settings.strataApiKey?.trim();
  return key ? { Authorization: `Bearer ${key}` } : undefined;
}
