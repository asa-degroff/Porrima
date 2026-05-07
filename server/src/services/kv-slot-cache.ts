/**
 * KV Slot Cache — persist and restore llama.cpp slot state to disk between turns.
 *
 * Uses the llama.cpp server's /slots/{id}?action=save|restore REST endpoint
 * (enabled by --slot-save-path) to skip full prefill on returning
 * conversations. Each chat/model/context shape gets its own slot file.
 *
 * For single-slot servers (-np 1), slot ID is always 0.
 * For multi-slot servers, the slot registry manages assignments with LRU eviction.
 */

import { createHash, randomUUID } from "crypto";
import { slotRegistry, type SlotLeaseRecord } from "./kv-slot-registry.js";

export interface KvSlotLease extends SlotLeaseRecord {
  restoreAttempted: boolean;
  restored: boolean;
  saveAttempted: boolean;
  saved: boolean;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function slotEndpoint(
  baseUrl: string,
  slotId: number,
  action: "save" | "restore",
): string {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}/slots/${slotId}`);
  url.searchParams.set("action", action);
  return url.toString();
}

async function responseErrorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return "";
  return ` - ${text.slice(0, 500)}`;
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
 * Generate a model/context-aware slot file name. A llama.cpp slot file is not
 * portable across model families or materially different context settings.
 */
export function slotFileNameForChat(
  chatId: string,
  modelId: string,
  contextWindow?: number,
): string {
  const cacheKey = `${chatId}\0${modelId}\0${contextWindow ?? "default"}`;
  const hash = createHash("sha256").update(cacheKey).digest("hex").slice(0, 20);
  return `slot_${hash}.bin`;
}

export async function acquireSlotLease(opts: {
  chatId: string;
  baseUrl: string;
  modelId: string;
  contextWindow?: number;
}): Promise<KvSlotLease> {
  const fileName = slotFileNameForChat(opts.chatId, opts.modelId, opts.contextWindow);
  const record = await slotRegistry.acquireSlotLease({
    ...opts,
    fileName,
    leaseId: randomUUID(),
  });
  const lease: KvSlotLease = {
    ...record,
    restoreAttempted: false,
    restored: false,
    saveAttempted: false,
    saved: false,
  };

  if (lease.slotId == null) {
    console.warn(
      `[kv-slot] slot cache disabled for chat ${opts.chatId.slice(0, 8)}... ` +
      `model=${opts.modelId} reason=${lease.disabledReason ?? "unknown"}`,
    );
  } else if (lease.evictedChatId) {
    console.log(
      `[kv-slot] assigned chat ${opts.chatId.slice(0, 8)}... to slot ${lease.slotId} ` +
      `(evicted ${lease.evictedChatId.slice(0, 8)}..., model=${opts.modelId})`,
    );
  } else {
    console.log(
      `[kv-slot] assigned chat ${opts.chatId.slice(0, 8)}... to slot ${lease.slotId} ` +
      `(model=${opts.modelId})`,
    );
  }

  return lease;
}

export async function releaseSlotLease(lease: KvSlotLease): Promise<void> {
  await slotRegistry.releaseLease(lease);
}

export async function releaseSlotAssignmentsForChat(chatId: string): Promise<void> {
  await slotRegistry.releaseChat(chatId);
}

/**
 * Restore a slot's KV cache from disk before inference.
 *
 * @param baseUrl - llama.cpp server base URL (e.g. "http://localhost:8080")
 * @param slotId - slot index to restore
 * @param fileName - name of the slot file to restore
 * @param modelId - router-mode model ID to proxy the slot request to
 * @returns true if a slot file was found and restored, false if no file existed
 */
export async function restoreSlot(
  baseUrl: string,
  slotId: number,
  fileName: string,
  modelId?: string,
): Promise<boolean> {
  try {
    const url = slotEndpoint(baseUrl, slotId, "restore");
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(modelId ? { filename: fileName, model: modelId } : { filename: fileName }),
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
      const detail = await responseErrorDetail(response);
      console.warn(
        `[kv-slot] restore failed for slot ${slotId}: ${response.status} ${response.statusText}${detail}`,
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

export async function restoreSlotForLease(lease: KvSlotLease): Promise<boolean> {
  if (lease.restoreAttempted) return lease.restored;
  lease.restoreAttempted = true;
  if (lease.slotId == null) return false;

  const restored = await restoreSlot(
    lease.baseUrl,
    lease.slotId,
    lease.fileName,
    lease.modelId,
  );
  lease.restored = restored;
  await slotRegistry.markRestore(lease, restored).catch(() => {});
  if (!restored) {
    console.log(
      `[kv-slot] no cached slot for chat ${lease.chatId.slice(0, 8)}... ` +
      `(slot ${lease.slotId}, model=${lease.modelId})`,
    );
  }
  return restored;
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
  modelId?: string,
): Promise<boolean> {
  try {
    const url = slotEndpoint(baseUrl, slotId, "save");
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(modelId ? { filename: fileName, model: modelId } : { filename: fileName }),
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
      const detail = await responseErrorDetail(response);
      console.warn(
        `[kv-slot] save failed for slot ${slotId}: ${response.status} ${response.statusText}${detail}`,
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

export async function saveSlotForLease(lease: KvSlotLease): Promise<boolean> {
  if (lease.saveAttempted) return lease.saved;
  lease.saveAttempted = true;
  if (lease.slotId == null) return false;

  const saved = await saveSlot(
    lease.baseUrl,
    lease.slotId,
    lease.fileName,
    lease.modelId,
  );
  lease.saved = saved;
  await slotRegistry.markSave(lease, saved).catch(() => {});
  return saved;
}


