/**
 * Per-chat high-water mark of observed context size, used as a floor on the
 * context-window denominator (fix 4, Aug 23 — the window-denominator half of
 * the fb9cdb6f analysis).
 *
 * The denominator every ratio in the compaction machinery divides by comes
 * from model discovery (`model.contextWindow`). Discovery reads the server's
 * reported default generation settings, which can disagree with the running
 * slot's actual --ctx (fb9cdb6f: 113152 cached vs ~190k real). A denominator
 * smaller than the real context makes ratios exceed 1.0, which is how the
 * budget math walked into its degenerate branches.
 *
 * The observation that CANNOT be stale is the one the server just served: a
 * call that succeeded with usage.totalTokens = T proves the window is at
 * least T. We track the max such observation per chat (high-water — the
 * strongest lower bound, and it persists across compactions so the floor
 * keeps capping the ratio while discovery remains wrong), keyed by
 * (chatId, modelId, baseUrl) so a model or instance swap resets the mark.
 *
 * Error direction is deliberately conservative: the floor can only be at or
 * below the true window, so it can at most compact a little early — never
 * OOM, never wipe. When the floor engages, getEffectiveContextWindow logs
 * loudly; those logs are the detection signal for the discovery side.
 */

interface ContextObservation {
  modelId: string;
  baseUrl: string;
  /** Max successful-call totalTokens (prompt + output) observed. */
  highWater: number;
  /** When the current high-water was set. */
  updatedAt: number;
}

const observations = new Map<string, ContextObservation>();

function normalizeUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Record a successful model call for a chat. Call sites: the provider's
 * stream-end, where usage.totalTokens is final. Aborted/errored calls have
 * no final usage and are not recorded (callers gate on it).
 */
export function recordContextObservation(
  chatId: string,
  modelId: string,
  baseUrl: string,
  totalTokens: number,
): void {
  if (!chatId || !modelId || !baseUrl) return;
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return;

  const prev = observations.get(chatId);
  // Identity change (model swap, server move): the old observation was
  // measured against a different window — it proves nothing about this one.
  if (prev && (prev.modelId !== modelId || normalizeUrl(prev.baseUrl) !== normalizeUrl(baseUrl))) {
    observations.set(chatId, { modelId, baseUrl, highWater: totalTokens, updatedAt: Date.now() });
    return;
  }
  const highWater = Math.max(prev?.highWater ?? 0, totalTokens);
  observations.set(chatId, { modelId, baseUrl, highWater, updatedAt: Date.now() });
}

/**
 * The current high-water floor for a chat, or 0 when there is no
 * observation (or it belongs to a different model).
 */
export function getContextWindowFloor(chatId: string, modelId?: string): number {
  const entry = observations.get(chatId);
  if (!entry) return 0;
  if (modelId && entry.modelId !== modelId) return 0;
  return entry.highWater;
}

/**
 * Floor a discovered context window at the observed high-water.
 *
 * Returns the effective denominator plus a flag for logging: `engaged` is
 * true when the floor raised the denominator (i.e. discovery reported less
 * than a context that demonstrably fit — stale discovery suspected).
 */
export function applyContextWindowFloor(
  discoveredWindow: number,
  floor: number,
): { window: number; engaged: boolean } {
  if (floor <= 0 || !Number.isFinite(discoveredWindow) || discoveredWindow <= 0) {
    return { window: discoveredWindow, engaged: false };
  }
  if (floor > discoveredWindow) {
    return { window: floor, engaged: true };
  }
  return { window: discoveredWindow, engaged: false };
}

/** Test-only: clear all observations. */
export function _resetContextObservations(): void {
  observations.clear();
}
