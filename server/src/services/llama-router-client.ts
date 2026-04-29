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
  modelId: string,
  options: EnsureRouterLoadOptions = {}
): Promise<"loaded" | "not-router" | "error"> {
  if (!baseUrl || !modelId) return "error";
  const url = normalize(baseUrl);

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
      console.warn(`[router-client] /models/load ${url} ${modelId} returned ${res.status}`);
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
