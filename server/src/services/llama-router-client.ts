/**
 * Lightweight client for llama.cpp router-mode slots (title-generation,
 * extraction). Wraps POST /models/load + POST /models/unload with a per-baseUrl
 * cache so callers can be liberal about preflighting without spamming the
 * server. Single-model slots return 404 from these endpoints — we treat 404
 * as "no router here, the slot is whatever was launched at startup" and
 * silently no-op.
 */

interface LoadedRecord {
  modelId: string;
  contextWindow?: number;
  loadedAt: number;
}

const lastLoadedByBaseUrl = new Map<string, LoadedRecord>();

function normalize(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Strip a trailing `.gguf` extension from a model id. Single-model llama.cpp
 * launches without `--alias` default the model id to the filename (e.g.
 * "Qwen3.5-4B-Q4_K_M.gguf"), so legacy settings often carry the suffix.
 * Router mode lists models by directory name (no extension) and rejects the
 * suffixed form with HTTP 400 "model not found". Always normalize before
 * sending an id to /models/load or /v1/chat/completions on a router-mode slot.
 */
export function normalizeRouterModelId(id: string): string {
  return id.replace(/\.gguf$/i, "");
}

export interface EnsureRouterLoadOptions {
  contextWindow?: number;
  /** Per-load arg overrides forwarded into the `args` field of /models/load */
  extraArgs?: string[];
  timeoutMs?: number;
}

/**
 * Ensure `modelId` is the currently-loaded model on a router-mode slot. Safe
 * to call before every request — short-circuits when our cache already knows
 * the right model is loaded. Returns:
 *   - "loaded": load succeeded (or was already loaded)
 *   - "not-router": the endpoint is not a router (404 from /models/load),
 *     caller should send the request as-is.
 *   - "error": load attempted but failed; caller should still send the
 *     request (the server will use whatever it has and may 400 itself).
 */
export async function ensureRouterModelLoaded(
  baseUrl: string,
  rawModelId: string,
  options: EnsureRouterLoadOptions = {}
): Promise<"loaded" | "not-router" | "error"> {
  if (!baseUrl || !rawModelId) return "error";
  const url = normalize(baseUrl);
  const modelId = normalizeRouterModelId(rawModelId);

  const cached = lastLoadedByBaseUrl.get(url);
  if (cached?.modelId === modelId && cached.contextWindow === options.contextWindow) {
    return "loaded";
  }

  const args: string[] = [];
  if (options.contextWindow) {
    args.push("--ctx-size", String(options.contextWindow));
  }
  if (options.extraArgs?.length) {
    args.push(...options.extraArgs);
  }

  const body: Record<string, unknown> = { model: modelId };
  if (args.length > 0) body.args = args;

  try {
    const res = await fetch(`${url}/models/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
    });

    if (res.status === 404) return "not-router";
    if (!res.ok) {
      // The router rejects redundant loads with 400 "model is already running".
      // That isn't a failure — the model we wanted is already the active one,
      // so treat it as a successful load and populate the cache. Without this,
      // every request after a server restart re-pings /models/load and re-eats
      // the same 400 because the cache never warms up.
      const text = await res.text().catch(() => "");
      if (res.status === 400 && /already running/i.test(text)) {
        lastLoadedByBaseUrl.set(url, { modelId, contextWindow: options.contextWindow, loadedAt: Date.now() });
        return "loaded";
      }
      console.warn(`[router-client] /models/load ${url} ${modelId} returned ${res.status}: ${text.slice(0, 200)}`);
      return "error";
    }
    lastLoadedByBaseUrl.set(url, { modelId, contextWindow: options.contextWindow, loadedAt: Date.now() });
    return "loaded";
  } catch (e: any) {
    console.warn(`[router-client] /models/load ${url} ${modelId} failed:`, e?.message || e);
    return "error";
  }
}

export function invalidateRouterCache(baseUrl?: string) {
  if (baseUrl) lastLoadedByBaseUrl.delete(normalize(baseUrl));
  else lastLoadedByBaseUrl.clear();
}
