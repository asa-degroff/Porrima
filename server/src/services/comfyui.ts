import WebSocket from "ws";
import { getSettings } from "./storage.js";
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

/**
 * Generate image with state tracking.
 * Calls onLinkComfyUI with the promptId so the route can link it to our generation ID.
 */
export async function generateImageWithState(
  generationId: string,
  clientId: string,
  params: ImageGenerationParams,
  onLinkComfyUI: (promptId: string) => void,
  onProgress?: (progress: GenerateProgress) => void
): Promise<{ imageData: Buffer; resolvedSeed: number }> {
  const baseUrl = await getBaseUrl();
  const workflow = buildWorkflow(params, clientId);
  const resolvedSeed = (workflow["7"].inputs as any).seed as number;

  // Connect WebSocket for progress
  const wsUrl = baseUrl.replace(/^http/, "ws") + `/ws?clientId=${clientId}`;

  return new Promise((resolve, reject) => {
    let promptId: string | null = null;
    let wsTimeout: ReturnType<typeof setTimeout>;

    const ws = new WebSocket(wsUrl);

    const cleanup = () => {
      clearTimeout(wsTimeout);
      try {
        ws.close();
      } catch {}
    };

    // Timeout after 15 minutes
    wsTimeout = setTimeout(() => {
      cleanup();
      reject(new Error("Image generation timed out after 15 minutes"));
    }, 15 * 60 * 1000);

    ws.on("error", (err) => {
      cleanup();
      reject(new Error(`ComfyUI WebSocket error: ${err.message}`));
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
          cleanup();
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
          reject(new Error(`ComfyUI prompt error: ${detail}`));
          return;
        }

        const data = await res.json();
        promptId = data.prompt_id;
        if (promptId) onLinkComfyUI(promptId);
      } catch (err: any) {
        cleanup();
        reject(new Error(`Failed to queue prompt: ${err.message}`));
      }
    });

    ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === "progress" && msg.data?.prompt_id === promptId) {
          onProgress?.({
            step: msg.data.value,
            totalSteps: msg.data.max,
          });
        }

        if (msg.type === "execution_error" && msg.data?.prompt_id === promptId) {
          cleanup();
          const d = msg.data;
          reject(new Error(`ComfyUI error in ${d.node_type || d.node_id}: ${d.exception_message || "unknown error"}`));
          return;
        }

        if (msg.type === "executing" && msg.data?.prompt_id === promptId && msg.data.node === null) {
          // Generation complete — fetch result
          try {
            const histRes = await fetch(
              `${baseUrl}/history/${promptId}`
            );
            if (!histRes.ok) {
              cleanup();
              reject(new Error("Failed to fetch generation history"));
              return;
            }

            const history = await histRes.json();
            const outputs = history[promptId!]?.outputs;
            if (!outputs) {
              cleanup();
              reject(new Error("No outputs in generation history"));
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
              cleanup();
              reject(new Error("No image in generation output"));
              return;
            }

            // Fetch the image data
            const imgRes = await fetch(
              `${baseUrl}/view?filename=${encodeURIComponent(imageInfo.filename)}&subfolder=${encodeURIComponent(imageInfo.subfolder || "")}&type=${encodeURIComponent(imageInfo.type || "output")}`
            );
            if (!imgRes.ok) {
              cleanup();
              reject(new Error("Failed to fetch generated image"));
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

            cleanup();
            resolve({ imageData, resolvedSeed });
          } catch (err: any) {
            cleanup();
            reject(new Error(`Failed to retrieve image: ${err.message}`));
          }
        }
      } catch {
        // Ignore non-JSON messages
      }
    });

    ws.on("close", () => {
      // If we haven't resolved yet, this is unexpected
      if (promptId) {
        // WebSocket closed before completion — might still be ok
        // The resolve/reject should have been called already
      }
    });
  });
}
