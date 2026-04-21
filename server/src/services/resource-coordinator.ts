// Shared GPU/memory coordination for image backends. Both ComfyUI and sdcpp
// call into this module before generation — it unloads LLM models, frees
// cached buffers, and (for ComfyUI only) restarts the service to clear the
// ROCm HIP allocator leak if VRAM can't otherwise be reclaimed.
//
// Phase 1 moves these functions out of comfyui.ts as-is; Phase 2 adds the
// unified acquireResources() entry point that both backends consume.

import { execFile } from "child_process";

// Minimum free VRAM (in bytes) required before starting generation.
// Image generation typically needs 6-10GB depending on resolution and model.
// With dual-GPU setup (ComfyUI on GPU 1), LLMs on GPU 0 don't compete
// for the same VRAM, so the threshold can be lower.
export const MIN_FREE_VRAM_BYTES = 6 * 1024 * 1024 * 1024; // 6 GB

export function fmtGB(bytes: number): string {
  return `${(bytes / (1024 ** 3)).toFixed(1)}GB`;
}

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
 * Ask ComfyUI to free its own cached models from VRAM.
 * Uses the /free endpoint to release GPU memory held by previously loaded
 * models (UNet, CLIP, VAE) that may still be cached even after idle timeout.
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
 * Unload all LLM models (Ollama + llama.cpp) and wait for completion.
 * Awaits each unload request so VRAM is actually freed before returning.
 */
export async function unloadLLMModels(): Promise<void> {
  const { getSettings } = await import("./chat-storage.js");
  const { getOllamaUrl } = await import("./ollama-url.js");
  const settings = await getSettings();
  const ollamaBase = getOllamaUrl(settings);

  // Unload all loaded Ollama models (not just the default)
  try {
    const psRes = await fetch(`${ollamaBase}/api/ps`, {
      signal: AbortSignal.timeout(5000),
    });
    if (psRes.ok) {
      const psData = await psRes.json();
      const loadedModels: string[] = (psData.models || []).map((m: any) => m.name || m.model).filter(Boolean);
      for (const modelName of loadedModels) {
        console.log(`[coordinator] Unloading Ollama model: ${modelName}`);
        await fetch(`${ollamaBase}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: modelName, prompt: "", keep_alive: "0s" }),
          signal: AbortSignal.timeout(30_000),
        });
      }
    }
  } catch (err) {
    console.warn("[coordinator] Failed to unload Ollama models:", err);
  }

  // Unload llama.cpp models
  if (settings.llamacppEnabled) {
    try {
      const lcUrl = settings.llamacppUrl || "http://localhost:8080";
      const modelsRes = await fetch(`${lcUrl}/v1/models`, { signal: AbortSignal.timeout(3000) });
      if (modelsRes.ok) {
        const modelsData = await modelsRes.json();
        for (const m of modelsData.data || []) {
          if (m.status?.value === "loaded") {
            console.log(`[coordinator] Unloading llama.cpp model: ${m.id}`);
            await fetch(`${lcUrl}/models/unload`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: m.id }),
              signal: AbortSignal.timeout(30_000),
            });
          }
        }
      }
      const { invalidateLoadedModel } = await import("./openai-compat-provider.js");
      invalidateLoadedModel();
    } catch (err) {
      console.warn("[coordinator] Failed to unload llama.cpp models:", err);
    }
  }
}

/**
 * Restart ComfyUI via systemd to fully release VRAM.
 *
 * On ROCm, PyTorch's HIP caching allocator retains freed VRAM in an internal
 * pool even after torch.cuda.empty_cache(). After a generation cycle, ~13GB
 * of leaked VRAM remains on the GPU. Restarting the process is the only
 * reliable way to reclaim this memory.
 *
 * The systemd service automatically restarts ComfyUI after the process exits.
 * This function waits for ComfyUI to come back online before returning.
 */
export async function restartComfyUIService(baseUrl: string): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      execFile("systemctl", ["--user", "restart", "comfyui.service"], (error) => {
        if (error) reject(new Error(`systemctl restart failed: ${error.message}`));
        else resolve();
      });
    });

    // Wait for ComfyUI to come back online (typically ~5s)
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

/**
 * Wait until the ComfyUI GPU has enough free VRAM for image generation.
 * Polls /system_stats and unloads LLM models if VRAM is insufficient.
 * With the dual-GPU setup, ComfyUI runs on GPU 1 and LLMs on GPU 0,
 * so they don't compete for the same VRAM. LLM unloading is kept as a
 * fallback for single-GPU configurations or when the 27B model spreads
 * across both GPUs.
 *
 * If ComfyUI has leaked VRAM due to PyTorch's HIP caching allocator on
 * ROCm (which retains ~13GB after generation even after model unload),
 * this function will restart the ComfyUI service to reclaim that VRAM.
 *
 * Returns true if VRAM is available, false if timed out.
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

  // Check once before attempting any unloads
  const initialFree = await checkFreeVRAM(baseUrl);
  if (initialFree === null) return false; // ComfyUI unreachable
  if (initialFree === -1) return true; // No GPU devices — CPU-only mode
  if (initialFree >= minFreeBytes) {
    console.log(`[coordinator] VRAM available: ${fmtGB(initialFree)} free (no unload needed)`);
    return true;
  }

  console.log(`[coordinator] Waiting for VRAM: ${fmtGB(initialFree)} free, need ${fmtGB(minFreeBytes)}`);
  onWaiting?.();

  while (Date.now() - start < maxWaitMs) {
    if (!unloaded) {
      unloaded = true;
      // Free ComfyUI's own cached models first — they may still be in VRAM
      // even if idle-unload-timeout hasn't fired yet
      await freeComfyUIModels(baseUrl);

      // Check VRAM again after freeing ComfyUI's own models
      const afterComfyUIFree = await checkFreeVRAM(baseUrl);
      if (afterComfyUIFree !== null && afterComfyUIFree !== -1 && afterComfyUIFree >= minFreeBytes) {
        console.log(`[coordinator] VRAM available after ComfyUI model unload: ${fmtGB(afterComfyUIFree)} free`);
        return true;
      }

      // Only unload LLM models if ComfyUI's own models weren't enough.
      // With dual-GPU setup, this shouldn't be needed, but serves as a fallback
      // for single-GPU configs or when models spread across both GPUs.
      console.log(`[coordinator] Still need ${fmtGB(minFreeBytes - (afterComfyUIFree ?? 0))} more VRAM, unloading LLM models`);
      await unloadLLMModels();
      // Give VRAM a moment to actually be released by the driver
      await new Promise((r) => setTimeout(r, 3000));
    }

    const freeVram = await checkFreeVRAM(baseUrl);
    if (freeVram === null) return false;
    if (freeVram === -1) return true;
    if (freeVram >= minFreeBytes) {
      console.log(`[coordinator] VRAM available: ${fmtGB(freeVram)} free`);
      return true;
    }

    // If we've unloaded both ComfyUI models and LLM models but still don't
    // have enough VRAM, the HIP caching allocator is likely holding leaked
    // memory. On ROCm, torch.cuda.empty_cache() doesn't return freed VRAM
    // to the driver. Restart ComfyUI to fully release the leaked memory.
    if (!restarted && unloaded && freeVram < minFreeBytes * 0.8) {
      console.log(`[coordinator] VRAM still only ${fmtGB(freeVram)} free after model unload — restarting ComfyUI to reclaim HIP allocator memory`);
      restarted = true;
      await restartComfyUIService(baseUrl);
      // After restart, ComfyUI will be fresh with no leaked VRAM.
      // Give it time to come back online and check again.
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    await new Promise((r) => setTimeout(r, 3000));
  }

  console.warn(`[coordinator] VRAM wait timed out after ${maxWaitMs / 1000}s`);
  return false;
}
