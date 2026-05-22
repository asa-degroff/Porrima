// Shared GPU/memory coordination for image backends. Both ComfyUI and sdcpp
// call `acquireResources()` before generation — it waits for any active LLM
// stream to finish, then unloads LLM models (smallest-first), frees cached
// buffers, and (for ComfyUI only) restarts the service to clear the ROCm HIP
// allocator leak if VRAM still can't be reclaimed.

import { execFile } from "child_process";
import { readFile } from "node:fs/promises";
import { isActive, activeStreamCount, waitForIdle } from "./llm-activity.js";

// Minimum free VRAM (in bytes) required before starting generation.
// Image generation typically needs 6-10GB depending on resolution and model.
// With dual-GPU setup (ComfyUI on GPU 1), LLMs on GPU 0 don't compete
// for the same VRAM, so the threshold can be lower.
export const MIN_FREE_VRAM_BYTES = 6 * 1024 * 1024 * 1024; // 6 GB

// Minimum free RAM (in bytes) required before starting sd-server. sd-server
// with --offload-to-cpu pins ~13GB of weights in RAM; 15GB gives some headroom
// for activation tensors and OS buffers.
export const MIN_FREE_RAM_BYTES = 15 * 1024 * 1024 * 1024; // 15 GB

export function fmtGB(bytes: number): string {
  return `${(bytes / (1024 ** 3)).toFixed(1)}GB`;
}

// ─── Status types ────────────────────────────────────────────────────────────

export type CoordinatorPhase =
  | "checking"
  | "waiting-for-llm"
  | "freeing-cache"
  | "unloading"
  | "restarting"
  | "ready";

export interface CoordinatorStatus {
  phase: CoordinatorPhase;
  message: string;
}

export interface ResourceRequest {
  for: "comfyui" | "sdcpp";
  // VRAM is relevant for ComfyUI — baseUrl gives access to /system_stats + /free.
  vram?: { baseUrl: string; minFreeBytes?: number };
  // RAM is relevant for sdcpp (weights live in RAM via --offload-to-cpu).
  ram?: { minFreeBytes?: number };
  onStatus?: (status: CoordinatorStatus) => void;
  signal?: AbortSignal;
}

// ─── Capacity checks ─────────────────────────────────────────────────────────

/**
 * Check free VRAM from ComfyUI system_stats.
 * Returns free bytes, -1 if no GPU devices, or null if unreachable.
 */
export async function checkFreeVRAM(baseUrl: string): Promise<number | null> {
  try {
    const res = await fetch(`${baseUrl}/system_stats`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const stats = await res.json();
    const devices = stats.devices || [];
    if (devices.length === 0) return -1;
    return devices[0].vram_free || 0;
  } catch {
    return null;
  }
}

/**
 * Read system RAM availability from /proc/meminfo. "MemAvailable" is the
 * kernel's estimate of memory that can be allocated without swapping
 * (unlike "MemFree" which excludes reclaimable buff/cache).
 */
export async function getFreeRAMBytes(): Promise<number> {
  try {
    const content = await readFile("/proc/meminfo", "utf-8");
    const match = content.match(/MemAvailable:\s+(\d+)\s+kB/);
    if (!match) return 0;
    return parseInt(match[1], 10) * 1024;
  } catch {
    return 0;
  }
}

// ─── LLM unload (incremental, smallest-first) ────────────────────────────────

interface UnloadableModel {
  id: string;
  sizeBytes: number;
  unload: () => Promise<void>;
}

/**
 * Param-count heuristic for llama.cpp models, which don't expose weight size
 * via /v1/models. "Qwen3.5-4B-Q4_K_M" → ~2GB estimate. Returns Infinity if
 * unparseable, so unknown models sort last (unload last).
 */
function estimateLlamaCppSize(modelId: string): number {
  const match = modelId.match(/(\d+(?:\.\d+)?)\s*B/i);
  if (!match) return Number.POSITIVE_INFINITY;
  const billions = parseFloat(match[1]);
  // Rough: Q4 ≈ 0.5 bytes/weight, so billions × 0.5GB per billion.
  return billions * 0.5 * 1024 * 1024 * 1024;
}

async function collectLoadedModels(): Promise<UnloadableModel[]> {
  const { getSettings } = await import("./chat-storage.js");
  const settings = await getSettings();
  const result: UnloadableModel[] = [];

  // llama.cpp: /v1/models lists all configured models; filter to loaded.
  if (settings.llamacppEnabled) {
    try {
      const lcUrl = settings.llamacppUrl || "http://localhost:8080";
      const modelsRes = await fetch(`${lcUrl}/v1/models`, { signal: AbortSignal.timeout(3000) });
      if (modelsRes.ok) {
        const modelsData = await modelsRes.json();
        for (const m of modelsData.data || []) {
          if (m.status?.value !== "loaded") continue;
          const id: string | undefined = m.id;
          if (!id) continue;
          result.push({
            id,
            sizeBytes: estimateLlamaCppSize(id),
            unload: async () => {
              await fetch(`${lcUrl}/models/unload`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: id }),
                signal: AbortSignal.timeout(30_000),
              });
              const { invalidateLoadedModel } = await import("./openai-compat-provider.js");
              invalidateLoadedModel();
            },
          });
        }
      }
    } catch (err) {
      console.warn("[coordinator] Failed to list llama.cpp models:", err);
    }
  }

  return result;
}

export interface UnloadOptions {
  onProgress?: (modelId: string) => void;
  // Called after each successful unload. Return true to stop early.
  shouldStop?: () => Promise<boolean> | boolean;
  signal?: AbortSignal;
}

/**
 * Unload LLM models smallest-first, optionally stopping early when a deficit
 * is covered. Called with no options, it unloads everything (matches the old
 * unloadLLMModels() behavior for ComfyUI's pre-generation VRAM sweep).
 */
export async function unloadLLMModels(options: UnloadOptions = {}): Promise<void> {
  const { onProgress, shouldStop, signal } = options;

  const models = await collectLoadedModels();
  models.sort((a, b) => a.sizeBytes - b.sizeBytes);

  for (const m of models) {
    if (signal?.aborted) return;
    console.log(`[coordinator] Unloading model: ${m.id} (${fmtGB(m.sizeBytes)})`);
    onProgress?.(m.id);
    try {
      await m.unload();
    } catch (err) {
      console.warn(`[coordinator] Failed to unload ${m.id}:`, err);
      continue;
    }
    if (shouldStop && (await shouldStop())) return;
  }
}

// ─── ComfyUI-specific helpers ────────────────────────────────────────────────

/**
 * Ask ComfyUI to free its own cached models from VRAM.
 */
export async function freeComfyUIModels(baseUrl: string): Promise<void> {
  try {
    await fetch(`${baseUrl}/free`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(10_000),
    });
    console.log("[coordinator] Freed ComfyUI cached models from VRAM");
  } catch (err) {
    console.warn("[coordinator] Failed to free ComfyUI models:", err);
  }
}

/**
 * Restart ComfyUI via systemd to fully release VRAM leaked by PyTorch's HIP
 * allocator on ROCm. The systemd unit auto-restarts on exit; this function
 * waits for /system_stats to respond again before returning.
 */
export async function restartComfyUIService(baseUrl: string): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      execFile("systemctl", ["--user", "restart", "comfyui.service"], (error) => {
        if (error) reject(new Error(`systemctl restart failed: ${error.message}`));
        else resolve();
      });
    });

    const maxWait = 30_000;
    const startTime = Date.now();
    while (Date.now() - startTime < maxWait) {
      try {
        const res = await fetch(`${baseUrl}/system_stats`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          console.log("[coordinator] Restarted ComfyUI service, back online");
          return;
        }
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.warn("[coordinator] Restart timed out waiting for ComfyUI to come back online");
  } catch (err) {
    console.warn("[coordinator] Failed to restart ComfyUI:", err);
  }
}

// ─── Legacy VRAM wait (still used by ComfyUI path) ───────────────────────────

/**
 * Wait until the ComfyUI GPU has enough free VRAM. Kept for backward
 * compatibility with the existing ComfyUI code path — new code should use
 * `acquireResources` instead, which wraps this plus LLM-activity awareness
 * and RAM coordination.
 */
export async function waitForFreeVRAM(
  baseUrl: string,
  minFreeBytes = MIN_FREE_VRAM_BYTES,
  maxWaitMs = 120_000,
  onWaiting?: () => void,
): Promise<boolean> {
  const start = Date.now();
  let unloaded = false;
  let restarted = false;

  const initialFree = await checkFreeVRAM(baseUrl);
  if (initialFree === null) return false;
  if (initialFree === -1) return true;
  if (initialFree >= minFreeBytes) {
    console.log(`[coordinator] VRAM available: ${fmtGB(initialFree)} free (no unload needed)`);
    return true;
  }

  console.log(`[coordinator] Waiting for VRAM: ${fmtGB(initialFree)} free, need ${fmtGB(minFreeBytes)}`);
  onWaiting?.();

  while (Date.now() - start < maxWaitMs) {
    if (!unloaded) {
      unloaded = true;
      await freeComfyUIModels(baseUrl);

      const afterComfyUIFree = await checkFreeVRAM(baseUrl);
      if (afterComfyUIFree !== null && afterComfyUIFree !== -1 && afterComfyUIFree >= minFreeBytes) {
        console.log(`[coordinator] VRAM available after ComfyUI model unload: ${fmtGB(afterComfyUIFree)} free`);
        return true;
      }

      console.log(`[coordinator] Still need ${fmtGB(minFreeBytes - (afterComfyUIFree ?? 0))} more VRAM, unloading LLM models`);
      await unloadLLMModels();
      await new Promise((r) => setTimeout(r, 3000));
    }

    const freeVram = await checkFreeVRAM(baseUrl);
    if (freeVram === null) return false;
    if (freeVram === -1) return true;
    if (freeVram >= minFreeBytes) {
      console.log(`[coordinator] VRAM available: ${fmtGB(freeVram)} free`);
      return true;
    }

    if (!restarted && unloaded && freeVram < minFreeBytes * 0.8) {
      console.log(`[coordinator] VRAM still only ${fmtGB(freeVram)} free after model unload — restarting ComfyUI to reclaim HIP allocator memory`);
      restarted = true;
      await restartComfyUIService(baseUrl);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    await new Promise((r) => setTimeout(r, 3000));
  }

  console.warn(`[coordinator] VRAM wait timed out after ${maxWaitMs / 1000}s`);
  return false;
}

// ─── Unified entry point ─────────────────────────────────────────────────────

const POST_UNLOAD_POLL_INTERVAL_MS = 2000;
const POST_UNLOAD_MAX_WAIT_MS = 60_000;

/**
 * Coordinate resource acquisition for an image backend. Emits status events
 * through `onStatus` so the UI can show what's happening. Throws if the
 * deficit can't be covered.
 *
 * Flow:
 *   1. checking              — assess current VRAM/RAM vs requirement
 *   2. waiting-for-llm       — if deficit and an LLM stream is live, wait
 *   3. freeing-cache         — (ComfyUI only) POST /free
 *   4. unloading             — unload LLM models smallest-first, stop at deficit
 *   5. restarting            — (ComfyUI only) last-resort systemctl restart
 *   6. ready                 — deficit covered
 */
export async function acquireResources(req: ResourceRequest): Promise<void> {
  const emit = (phase: CoordinatorPhase, message: string) =>
    req.onStatus?.({ phase, message });

  emit("checking", "Checking resource availability...");

  const hasDeficit = async (): Promise<string | null> => {
    if (req.vram) {
      const free = await checkFreeVRAM(req.vram.baseUrl);
      if (free === null) return null; // can't reach ComfyUI — let caller fail later
      if (free === -1) return null; // CPU-only — no VRAM concern
      const need = req.vram.minFreeBytes ?? MIN_FREE_VRAM_BYTES;
      if (free < need) return `VRAM ${fmtGB(free)}/${fmtGB(need)}`;
    }
    if (req.ram) {
      const free = await getFreeRAMBytes();
      const need = req.ram.minFreeBytes ?? MIN_FREE_RAM_BYTES;
      if (free < need) return `RAM ${fmtGB(free)}/${fmtGB(need)}`;
    }
    return null;
  };

  let deficit = await hasDeficit();
  if (!deficit) return;

  // Wait for any active LLM stream to finish — unloading mid-stream would
  // cut off a user's in-flight chat response.
  if (isActive()) {
    const n = activeStreamCount();
    emit("waiting-for-llm", `Waiting for ${n} active chat stream${n === 1 ? "" : "s"} to finish...`);
    await waitForIdle(req.signal);
    deficit = await hasDeficit();
    if (!deficit) {
      emit("ready", "Ready");
      return;
    }
  }

  // ComfyUI-only: free its own cached models first (cheap, often enough).
  if (req.for === "comfyui" && req.vram) {
    emit("freeing-cache", "Freeing ComfyUI cached models...");
    await freeComfyUIModels(req.vram.baseUrl);
    deficit = await hasDeficit();
    if (!deficit) {
      emit("ready", "Ready");
      return;
    }
  }

  // Unload LLM models incrementally, smallest-first.
  await unloadLLMModels({
    signal: req.signal,
    onProgress: (modelId) => emit("unloading", `Unloading ${modelId}...`),
    shouldStop: async () => (await hasDeficit()) === null,
  });

  // Driver may not report freed memory instantly — poll briefly.
  const pollDeadline = Date.now() + POST_UNLOAD_MAX_WAIT_MS;
  while (Date.now() < pollDeadline) {
    if (req.signal?.aborted) throw new Error("Resource acquisition aborted");
    deficit = await hasDeficit();
    if (!deficit) {
      emit("ready", "Ready");
      return;
    }
    await new Promise((r) => setTimeout(r, POST_UNLOAD_POLL_INTERVAL_MS));
  }

  // ComfyUI-only: last-resort restart to clear HIP allocator leak.
  if (req.for === "comfyui" && req.vram) {
    emit("restarting", "Restarting ComfyUI to reclaim GPU memory...");
    await restartComfyUIService(req.vram.baseUrl);
    await new Promise((r) => setTimeout(r, 5000));
    deficit = await hasDeficit();
    if (!deficit) {
      emit("ready", "Ready");
      return;
    }
  }

  throw new Error(
    `Could not acquire resources for ${req.for}: ${deficit ?? "unknown deficit"} after all recovery steps`,
  );
}
