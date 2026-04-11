import WebSocket from "ws";
import { execFile } from "child_process";
import { getSettings } from "./chat-storage.js";
import type { ImageGenerationParams, ComfyUIStatus } from "../types.js";

export const MODEL_PRESETS: Record<string, Partial<ImageGenerationParams>> = {
  "z-image-base": {
    steps: 30,
    cfgScale: 4.0,
    sampler: "euler",
    scheduler: "normal",
  },
  "z-image-turbo": {
    steps: 9,
    cfgScale: 0.0,
    sampler: "euler",
    scheduler: "sgm_uniform",
  },
};

async function getBaseUrl(): Promise<string> {
  const settings = await getSettings();
  return settings.comfyuiUrl || "http://127.0.0.1:8188";
}

export async function getComfyUIStatus(): Promise<ComfyUIStatus> {
  const baseUrl = await getBaseUrl();
  try {
    const [statsRes, queueRes] = await Promise.all([
      fetch(`${baseUrl}/system_stats`, { signal: AbortSignal.timeout(3000) }),
      fetch(`${baseUrl}/queue`, { signal: AbortSignal.timeout(3000) }),
    ]);

    if (!statsRes.ok || !queueRes.ok) {
      return { available: false, queueSize: 0, models: [] };
    }

    const queue = await queueRes.json();
    const queueSize =
      (queue.queue_running?.length || 0) + (queue.queue_pending?.length || 0);

    const models = await getComfyUIModels();

    return { available: true, queueSize, models };
  } catch {
    return { available: false, queueSize: 0, models: [] };
  }
}

export async function getComfyUIModels(): Promise<string[]> {
  const baseUrl = await getBaseUrl();
  const models = new Set<string>();

  // Fetch from both UNETLoader (safetensors) and UnetLoaderGGUF (gguf)
  for (const nodeType of ["UNETLoader", "UnetLoaderGGUF"]) {
    try {
      const res = await fetch(`${baseUrl}/object_info/${nodeType}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      const info = await res.json();
      const inputs = info[nodeType]?.input?.required?.unet_name;
      if (Array.isArray(inputs) && Array.isArray(inputs[0])) {
        for (const m of inputs[0]) models.add(m as string);
      }
    } catch {
      // skip
    }
  }

  return [...models];
}

function buildWorkflow(params: ImageGenerationParams, clientId: string): Record<string, any> {
  const seed =
    params.seed != null && params.seed >= 0
      ? params.seed
      : Math.floor(Math.random() * 2 ** 32);

  const isGGUF = params.model.endsWith(".gguf");

  return {
    "1": isGGUF
      ? {
          class_type: "UnetLoaderGGUF",
          inputs: {
            unet_name: params.model,
          },
        }
      : {
          class_type: "UNETLoader",
          inputs: {
            unet_name: params.model,
            weight_dtype: "default",
          },
        },
    "2": {
      class_type: "CLIPLoaderGGUF",
      inputs: {
        clip_name: "qwen_3_4b.safetensors",
        type: "stable_diffusion",
      },
    },
    "3": {
      class_type: "VAELoader",
      inputs: {
        vae_name: "ae.safetensors",
      },
    },
    "4": {
      class_type: "CLIPTextEncode",
      inputs: {
        text: params.positivePrompt,
        clip: ["2", 0],
      },
    },
    "5": {
      class_type: "CLIPTextEncode",
      inputs: {
        text: params.negativePrompt || "",
        clip: ["2", 0],
      },
    },
    "6": {
      class_type: "EmptyLatentImage",
      inputs: {
        width: params.width,
        height: params.height,
        batch_size: 1,
      },
    },
    "7": {
      class_type: "KSampler",
      inputs: {
        model: ["1", 0],
        positive: ["4", 0],
        negative: ["5", 0],
        latent_image: ["6", 0],
        seed,
        steps: params.steps,
        cfg: params.cfgScale,
        sampler_name: params.sampler || "euler",
        scheduler: params.scheduler || "normal",
        denoise: 1.0,
      },
    },
    "8": {
      class_type: "VAEDecode",
      inputs: {
        samples: ["7", 0],
        vae: ["3", 0],
      },
    },
    "9": {
      class_type: "SaveImage",
      inputs: {
        images: ["8", 0],
        filename_prefix: "quje",
      },
    },
  };
}

export interface GenerateProgress {
  step: number;
  totalSteps: number;
}

// Minimum free VRAM (in bytes) required before starting generation.
// Image generation typically needs 6-10GB depending on resolution and model.
// With dual-GPU setup (ComfyUI on GPU 1), LLMs on GPU 0 don't compete
// for the same VRAM, so the threshold can be lower.
const MIN_FREE_VRAM_BYTES = 6 * 1024 * 1024 * 1024; // 6 GB

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
  minFreeBytes = MIN_FREE_VRAM_BYTES,
  maxWaitMs = 120_000,
  onWaiting?: () => void,
): Promise<boolean> {
  const baseUrl = await getBaseUrl();
  const start = Date.now();
  let unloaded = false;
  let restarted = false;

  // Check once before attempting any unloads
  const initialFree = await checkFreeVRAM(baseUrl);
  if (initialFree === null) return false; // ComfyUI unreachable
  if (initialFree === -1) return true; // No GPU devices — CPU-only mode
  if (initialFree >= minFreeBytes) {
    console.log(`[comfyui] VRAM available: ${fmtGB(initialFree)} free (no unload needed)`);
    return true;
  }

  console.log(`[comfyui] Waiting for VRAM: ${fmtGB(initialFree)} free, need ${fmtGB(minFreeBytes)}`);
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
        console.log(`[comfyui] VRAM available after ComfyUI model unload: ${fmtGB(afterComfyUIFree)} free`);
        return true;
      }

      // Only unload LLM models if ComfyUI's own models weren't enough.
      // With dual-GPU setup, this shouldn't be needed, but serves as a fallback
      // for single-GPU configs or when models spread across both GPUs.
      console.log(`[comfyui] Still need ${fmtGB(minFreeBytes - (afterComfyUIFree ?? 0))} more VRAM, unloading LLM models`);
      await unloadLLMModels();
      // Give VRAM a moment to actually be released by the driver
      await new Promise((r) => setTimeout(r, 3000));
    }

    const freeVram = await checkFreeVRAM(baseUrl);
    if (freeVram === null) return false;
    if (freeVram === -1) return true;
    if (freeVram >= minFreeBytes) {
      console.log(`[comfyui] VRAM available: ${fmtGB(freeVram)} free`);
      return true;
    }

    // If we've unloaded both ComfyUI models and LLM models but still don't
    // have enough VRAM, the HIP caching allocator is likely holding leaked
    // memory. On ROCm, torch.cuda.empty_cache() doesn't return freed VRAM
    // to the driver. Restart ComfyUI to fully release the leaked memory.
    if (!restarted && unloaded && freeVram < minFreeBytes * 0.8) {
      console.log(`[comfyui] VRAM still only ${fmtGB(freeVram)} free after model unload — restarting ComfyUI to reclaim HIP allocator memory`);
      restarted = true;
      await restartComfyUIService();
      // After restart, ComfyUI will be fresh with no leaked VRAM.
      // Give it time to come back online and check again.
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    await new Promise((r) => setTimeout(r, 3000));
  }

  console.warn(`[comfyui] VRAM wait timed out after ${maxWaitMs / 1000}s`);
  return false;
}

function fmtGB(bytes: number): string {
  return `${(bytes / (1024 ** 3)).toFixed(1)}GB`;
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
async function restartComfyUIService(): Promise<void> {
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
    const baseUrl = await getBaseUrl();
    while (Date.now() - startTime < maxWait) {
      try {
        const res = await fetch(`${baseUrl}/system_stats`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          console.log("[comfyui] Restarted ComfyUI service, back online");
          return;
        }
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.warn("[comfyui] Restart timed out waiting for ComfyUI to come back online");
  } catch (err) {
    console.warn("[comfyui] Failed to restart ComfyUI:", err);
  }
}

/**
 * Check free VRAM from ComfyUI system_stats.
 * Returns free bytes, -1 if no GPU devices, or null if unreachable.
 */
async function checkFreeVRAM(baseUrl: string): Promise<number | null> {
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
async function freeComfyUIModels(baseUrl: string): Promise<void> {
  try {
    await fetch(`${baseUrl}/free`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(10_000),
    });
    console.log("[comfyui] Freed ComfyUI cached models from VRAM");
  } catch (err) {
    console.warn("[comfyui] Failed to free ComfyUI models:", err);
  }
}

/**
 * Unload all LLM models (Ollama + llama.cpp) and wait for completion.
 * Awaits each unload request so VRAM is actually freed before returning.
 */
async function unloadLLMModels(): Promise<void> {
  const { getSettings } = await import("./chat-storage.js");
  const settings = await getSettings();

  // Unload all loaded Ollama models (not just the default)
  try {
    const psRes = await fetch("http://localhost:11434/api/ps", {
      signal: AbortSignal.timeout(5000),
    });
    if (psRes.ok) {
      const psData = await psRes.json();
      const loadedModels: string[] = (psData.models || []).map((m: any) => m.name || m.model).filter(Boolean);
      for (const modelName of loadedModels) {
        console.log(`[comfyui] Unloading Ollama model: ${modelName}`);
        await fetch("http://localhost:11434/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: modelName, prompt: "", keep_alive: "0s" }),
          signal: AbortSignal.timeout(30_000),
        });
      }
    }
  } catch (err) {
    console.warn("[comfyui] Failed to unload Ollama models:", err);
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
            console.log(`[comfyui] Unloading llama.cpp model: ${m.id}`);
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
      console.warn("[comfyui] Failed to unload llama.cpp models:", err);
    }
  }
}

/**
 * Cancel a ComfyUI prompt by deleting it from the queue.
 * Prevents orphaned jobs from consuming resources after we give up.
 */
async function cancelComfyUIPrompt(promptId: string): Promise<void> {
  try {
    const baseUrl = await getBaseUrl();
    await fetch(`${baseUrl}/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: [promptId] }),
      signal: AbortSignal.timeout(5000),
    });
    // Also interrupt any currently executing node
    await fetch(`${baseUrl}/interrupt`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
    console.log(`[comfyui] Cancelled prompt ${promptId}`);
  } catch (err) {
    console.warn(`[comfyui] Failed to cancel prompt ${promptId}:`, err);
  }
}

// Maximum time to wait after sampling completes for VAE decode + save.
// VAE decode on GPU takes seconds; if it takes minutes, something is wrong
// (likely fell back to CPU due to VRAM pressure).
const POST_SAMPLING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export async function generateImageWithState(
  generationId: string,
  clientId: string,
  params: ImageGenerationParams,
  onLinkComfyUI: (promptId: string) => void,
  onProgress?: (progress: GenerateProgress) => void
): Promise<{ imageData: Buffer; resolvedSeed: number }> {
  // Ensure sufficient VRAM before starting — unloads LLM models if needed.
  // Abort if VRAM can't be freed — proceeding would cause ComfyUI to fall
  // back to CPU, consuming all system RAM and hanging indefinitely.
  const vramReady = await waitForFreeVRAM();
  if (!vramReady) {
    throw new Error("Insufficient VRAM for image generation — could not free enough GPU memory");
  }

  const baseUrl = await getBaseUrl();
  const workflow = buildWorkflow(params, clientId);
  const resolvedSeed = (workflow["7"].inputs as any).seed as number;

  // Connect WebSocket for progress
  const wsUrl = baseUrl.replace(/^http/, "ws") + `/ws?clientId=${clientId}`;

  return new Promise((resolve, reject) => {
    let promptId: string | null = null;
    let globalTimeout: ReturnType<typeof setTimeout>;
    let postSamplingTimeout: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const ws = new WebSocket(wsUrl);

    const cleanup = () => {
      clearTimeout(globalTimeout);
      if (postSamplingTimeout) clearTimeout(postSamplingTimeout);
      try {
        ws.close();
      } catch {}
    };

    const settle = (
      action: "resolve" | "reject",
      value: any,
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (action === "resolve") resolve(value);
      else reject(value);
    };

    // Global timeout — 30 minutes max for any single generation
    globalTimeout = setTimeout(() => {
      const pid = promptId;
      settle("reject", new Error("Image generation timed out after 30 minutes"));
      if (pid) cancelComfyUIPrompt(pid);
    }, 30 * 60 * 1000);

    ws.on("error", (err) => {
      settle("reject", new Error(`ComfyUI WebSocket error: ${err.message}`));
    });

    ws.on("open", async () => {
      try {
        // Queue the prompt
        const res = await fetch(`${baseUrl}/prompt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: workflow,
            client_id: clientId,
          }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({})) as any;
          // Extract node-level errors for a useful message
          let detail = err.error?.message || res.statusText;
          if (err.node_errors) {
            const nodeDetails = Object.entries(err.node_errors)
              .map(([id, info]: [string, any]) => {
                const errs = info.errors?.map((e: any) => e.message || e.details).join("; ") || "unknown";
                return `${info.class_type || id}: ${errs}`;
              })
              .join(", ");
            if (nodeDetails) detail += ` [${nodeDetails}]`;
          }
          settle("reject", new Error(`ComfyUI prompt error: ${detail}`));
          return;
        }

        const data = await res.json();
        promptId = data.prompt_id;
        if (promptId) onLinkComfyUI(promptId);
      } catch (err: any) {
        settle("reject", new Error(`Failed to queue prompt: ${err.message}`));
      }
    });

    ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === "progress" && msg.data?.prompt_id === promptId) {
          // Reset post-sampling timeout on every progress event
          if (postSamplingTimeout) {
            clearTimeout(postSamplingTimeout);
            postSamplingTimeout = null;
          }

          onProgress?.({
            step: msg.data.value,
            totalSteps: msg.data.max,
          });

          // When the last sampling step completes, start the post-sampling
          // timeout. VAE decode + save should complete in seconds on GPU.
          // If it takes >5 minutes, ComfyUI likely fell back to CPU.
          if (msg.data.value >= msg.data.max) {
            postSamplingTimeout = setTimeout(() => {
              const pid = promptId;
              console.warn(`[comfyui] Post-sampling phase timed out after ${POST_SAMPLING_TIMEOUT_MS / 1000}s — likely CPU fallback`);
              settle("reject", new Error(
                "Post-sampling phase (VAE decode) timed out — ComfyUI likely fell back to CPU due to insufficient VRAM"
              ));
              if (pid) cancelComfyUIPrompt(pid);
            }, POST_SAMPLING_TIMEOUT_MS);
          }
        }

        if (msg.type === "execution_error" && msg.data?.prompt_id === promptId) {
          const d = msg.data;
          settle("reject", new Error(`ComfyUI error in ${d.node_type || d.node_id}: ${d.exception_message || "unknown error"}`));
          return;
        }

        if (msg.type === "executing" && msg.data?.prompt_id === promptId && msg.data.node === null) {
          // Generation complete — fetch result
          try {
            const histRes = await fetch(
              `${baseUrl}/history/${promptId}`
            );
            if (!histRes.ok) {
              settle("reject", new Error("Failed to fetch generation history"));
              return;
            }

            const history = await histRes.json();
            const outputs = history[promptId!]?.outputs;
            if (!outputs) {
              settle("reject", new Error("No outputs in generation history"));
              return;
            }

            // Find the SaveImage node output
            let imageInfo: any = null;
            for (const nodeId of Object.keys(outputs)) {
              if (outputs[nodeId].images?.length > 0) {
                imageInfo = outputs[nodeId].images[0];
                break;
              }
            }

            if (!imageInfo) {
              settle("reject", new Error("No image in generation output"));
              return;
            }

            // Fetch the image data
            const imgRes = await fetch(
              `${baseUrl}/view?filename=${encodeURIComponent(imageInfo.filename)}&subfolder=${encodeURIComponent(imageInfo.subfolder || "")}&type=${encodeURIComponent(imageInfo.type || "output")}`
            );
            if (!imgRes.ok) {
              settle("reject", new Error("Failed to fetch generated image"));
              return;
            }

            const imageData = Buffer.from(await imgRes.arrayBuffer());

            // Check queue status before freeing memory
            // Only free memory if no other tasks are queued
            try {
              const queueRes = await fetch(`${baseUrl}/queue`, { signal: AbortSignal.timeout(3000) });
              if (queueRes.ok) {
                const queue = await queueRes.json();
                const queueSize =
                  (queue.queue_running?.length || 0) + (queue.queue_pending?.length || 0);
                if (queueSize === 0) {
                  // No more tasks queued — free memory to prevent leaks
                  await fetch(`${baseUrl}/queue`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ free_memory: true }),
                  });
                }
              }
            } catch {
              // Ignore cleanup errors — image was already retrieved successfully
            }

            settle("resolve", { imageData, resolvedSeed });
          } catch (err: any) {
            settle("reject", new Error(`Failed to retrieve image: ${err.message}`));
          }
        }
      } catch {
        // Ignore non-JSON messages
      }
    });

    ws.on("close", () => {
      // WebSocket closed before completion — reject if we haven't settled yet
      settle("reject", new Error("ComfyUI WebSocket closed unexpectedly before generation completed"));
    });
  });
}
