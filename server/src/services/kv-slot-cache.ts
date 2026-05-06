/**
 * KV Slot Cache — persist and restore llama.cpp slot state to disk between turns.
 *
 * Uses the llama.cpp server's /slots/{id}/save and /slots/{id}/restore REST
 * endpoints (enabled by --slot-save-path) to skip full prefill on returning
 * conversations. Each chat gets its own slot file named after its chat ID.
 *
 * For single-slot servers (-np 1), slot ID is always 0.
 * For multi-slot servers, slot ID is derived from chat ID for stability.
 */

import { createHash } from "crypto";

// Default slot ID for single-slot servers
const DEFAULT_SLOT_ID = 0;

/**
 * Generate a deterministic slot ID from a chat ID.
 * For single-slot servers, always returns 0.
 * For multi-slot servers, hashes the chat ID to a stable slot index.
 */
export function slotIdForChat(chatId: string, numSlots: number = 1): number {
  if (numSlots <= 1) return DEFAULT_SLOT_ID;

  // Hash the chat ID to a stable slot index.
  // Using a simple hash that distributes evenly across slots.
  const hash = createHash("md5").update(chatId).digest();
  const num = hash.readUInt32BE(0);
  return num % numSlots;
}

/**
 * Generate a slot file name from a chat ID.
 * Uses a truncated SHA-256 hash for a stable, filesystem-safe name.
 */
export function slotFileName(chatId: string): string {
  const hash = createHash("sha256").update(chatId).digest("hex").slice(0, 16);
  return `slot_${hash}.bin`;
}

/**
 * Restore a slot's KV cache from disk before inference.
 *
 * @param baseUrl - llama.cpp server base URL (e.g. "http://localhost:8080")
 * @param slotId - slot index to restore
 * @param fileName - name of the slot file to restore
 * @returns true if a slot file was found and restored, false if no file existed
 */
export async function restoreSlot(
  baseUrl: string,
  slotId: number,
  fileName: string,
): Promise<boolean> {
  try {
    const url = `${baseUrl}/slots/${slotId}/restore`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: fileName }),
      signal: AbortSignal.timeout(30000), // 30s timeout for large slot restores
    });

    if (response.ok) {
      const data = await response.json().catch(() => null);
      console.log(
        `[kv-slot] restored slot ${slotId} from ${fileName}: ` +
        `${data?.tokens ?? "?"} tokens`,
      );
      return true;
    } else if (response.status === 404) {
      // No slot file exists yet — this is normal for first turns
      return false;
    } else {
      console.warn(
        `[kv-slot] restore failed for slot ${slotId}: ${response.status} ${response.statusText}`,
      );
      return false;
    }
  } catch (err) {
    // Non-fatal — the turn can proceed without the cache
    console.warn(
      `[kv-slot] restore error for slot ${slotId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/**
 * Save a slot's KV cache to disk after inference.
 *
 * @param baseUrl - llama.cpp server base URL
 * @param slotId - slot index to save
 * @param fileName - name of the slot file to save to
 * @returns true if the slot was saved successfully
 */
export async function saveSlot(
  baseUrl: string,
  slotId: number,
  fileName: string,
): Promise<boolean> {
  try {
    const url = `${baseUrl}/slots/${slotId}/save`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: fileName }),
      signal: AbortSignal.timeout(60000), // 60s timeout for large slot saves
    });

    if (response.ok) {
      const data = await response.json().catch(() => null);
      console.log(
        `[kv-slot] saved slot ${slotId} to ${fileName}: ` +
        `${data?.tokens ?? "?"} tokens`,
      );
      return true;
    } else {
      console.warn(
        `[kv-slot] save failed for slot ${slotId}: ${response.status} ${response.statusText}`,
      );
      return false;
    }
  } catch (err) {
    // Non-fatal — the turn completed, just the cache wasn't persisted
    console.warn(
      `[kv-slot] save error for slot ${slotId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/**
 * Wrapper that restores before and saves after a turn's inference.
 *
 * Usage in chat.ts:
 *   await withSlotCache(model.baseUrl, chat.id, numSlots, async () => {
 *     await runAgentLoop({ ... });
 *   });
 *
 * The save happens after the callback completes, regardless of whether
 * the turn produced content or hit an error. This ensures the slot state
 * reflects the latest context even on partial turns.
 */
export async function withSlotCache<T>(
  baseUrl: string,
  chatId: string,
  numSlots: number,
  fn: () => Promise<T>,
): Promise<T> {
  const slotId = slotIdForChat(chatId, numSlots);
  const fileName = slotFileName(chatId);

  // Restore before inference
  const restored = await restoreSlot(baseUrl, slotId, fileName);
  if (restored) {
    console.log(`[kv-slot] using cached slot for chat ${chatId.slice(0, 8)}...`);
  }

  let result: T;
  let errored = false;
  try {
    result = await fn();
  } catch (err) {
    errored = true;
    throw err;
  } finally {
    // Save after inference (success or error)
    // On error, the slot may contain partial state, but that's acceptable —
    // it's better to have a stale cache than no cache at all.
    await saveSlot(baseUrl, slotId, fileName);
    if (errored) {
      console.log(`[kv-slot] saved slot for chat ${chatId.slice(0, 8)}... after error`);
    }
  }

  return result;
}
