import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Agent } from "undici";
import { getSettings } from "./chat-storage.js";
import type { ImageGenerationParams } from "../types.js";
import type { ImageBackend, GenerateProgress, ImageBackendStatus } from "./image-backend.js";
import { acquireResources, type CoordinatorStatus } from "./resource-coordinator.js";

const execFileAsync = promisify(execFile);

// Stop-when-idle lifecycle: sd-server holds ~13GB RAM while running (weights
// pinned by --offload-to-cpu), so we leave it stopped and bring it up only
// when needed, then tear it down after a quiet period. Idle window is long
// enough to coalesce back-to-back generations without paying startup twice.
const IDLE_STOP_DELAY_MS = 5 * 60 * 1000;
const SERVICE_NAME = "sd-server.service";
const READY_POLL_INTERVAL_MS = 1000;
const READY_TIMEOUT_MS = 60_000;

let idleStopTimer: ReturnType<typeof setTimeout> | null = null;

// Undici's default headersTimeout/bodyTimeout is 5 minutes. sd-server's A1111
// sync endpoint blocks for the full generation (can exceed 10 min on Vulkan at
// large resolutions), so we need a dispatcher with timeouts matching our
// per-request AbortSignal budget.
const longRunningDispatcher = new Agent({
  headersTimeout: 30 * 60 * 1000,
  bodyTimeout: 30 * 60 * 1000,
  connectTimeout: 10_000,
});

async function probeReady(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/sdapi/v1/options`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Poll /sdapi/v1/options until sd-server responds (or timeout). Used after
 * systemctl start/restart — the service reports "active" before the Vulkan
 * backend and model loading finish, so we need to probe HTTP readiness.
 */
async function waitReady(baseUrl: string, context: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeReady(baseUrl)) {
      console.log(`[sdcpp] ${SERVICE_NAME} is ready (${context})`);
      return;
    }
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
  }
  throw new Error(
    `${SERVICE_NAME} failed to become ready (${context}) within ${READY_TIMEOUT_MS / 1000}s`,
  );
}

/**
 * Restart sd-server to recover from a zombie state. After a GPU context loss
 * (e.g. "radv/amdgpu: The CS has been cancelled because the context is lost"),
 * the process stays alive and /sdapi/v1/options still responds, but any
 * generation request returns HTTP 500 because the Vulkan backend is dead.
 * systemctl restart gives us a fresh process with a working backend.
 */
async function restartService(
  baseUrl: string,
  onStatus?: (status: CoordinatorStatus) => void,
): Promise<void> {
  onStatus?.({
    phase: "restarting",
    message: "sd-server returned 500 — restarting to recover...",
  });
  console.warn(`[sdcpp] Restarting ${SERVICE_NAME} to recover from zombie state`);
  try {
    await execFileAsync("systemctl", ["--user", "restart", SERVICE_NAME], {
      timeout: 30_000,
    });
  } catch (err: any) {
    throw new Error(
      `Failed to restart ${SERVICE_NAME}: ${err?.stderr || err?.message || err}`,
    );
  }
  await waitReady(baseUrl, "restart");
}

async function ensureRunning(
  baseUrl: string,
  onStatus?: (status: CoordinatorStatus) => void,
): Promise<void> {
  if (await probeReady(baseUrl)) return;

  // Free up resources before starting. sd-server pins ~13GB of weights in RAM
  // via --offload-to-cpu, then streams them to GPU during inference — so we
  // need *both* a RAM reserve AND some free VRAM on the shared GPU. We probe
  // VRAM through ComfyUI's /system_stats endpoint since ComfyUI is pinned to
  // the same GPU and its probe works regardless of which backend is active.
  const settings = await getSettings();
  const comfyuiUrl = settings.comfyuiUrl || "http://127.0.0.1:8188";
  await acquireResources({
    for: "sdcpp",
    ram: {},
    // 5GB covers z_image streaming (4.4GB) + VAE tiling compute buffers +
    // Vulkan overhead. Lower than ComfyUI's 6GB default because
    // --offload-to-cpu means weights don't stay resident in VRAM.
    vram: { baseUrl: comfyuiUrl, minFreeBytes: 5 * 1024 * 1024 * 1024 },
    onStatus,
  });

  onStatus?.({ phase: "ready", message: `Starting ${SERVICE_NAME}...` });
  console.log(`[sdcpp] Starting ${SERVICE_NAME}...`);
  try {
    await execFileAsync("systemctl", ["--user", "start", SERVICE_NAME], {
      timeout: 30_000,
    });
  } catch (err: any) {
    throw new Error(
      `Failed to start ${SERVICE_NAME}: ${err?.stderr || err?.message || err}`,
    );
  }
  await waitReady(baseUrl, "start");
}

function scheduleIdleStop(): void {
  if (idleStopTimer) clearTimeout(idleStopTimer);
  idleStopTimer = setTimeout(async () => {
    idleStopTimer = null;
    console.log(`[sdcpp] Idle timeout reached, stopping ${SERVICE_NAME}`);
    try {
      await execFileAsync("systemctl", ["--user", "stop", SERVICE_NAME], {
        timeout: 30_000,
      });
    } catch (err: any) {
      console.error(
        `[sdcpp] Failed to stop ${SERVICE_NAME}: ${err?.stderr || err?.message || err}`,
      );
    }
  }, IDLE_STOP_DELAY_MS);
}

async function getBaseUrl(overrideUrl?: string): Promise<string> {
  if (overrideUrl) return overrideUrl.replace(/\/+$/, "");
  const settings = await getSettings();
  return (settings.sdcppUrl || "http://127.0.0.1:1234").replace(/\/+$/, "");
}

async function getStatus(overrideUrl?: string): Promise<ImageBackendStatus> {
  const baseUrl = await getBaseUrl(overrideUrl);
  try {
    const res = await fetch(`${baseUrl}/sdapi/v1/options`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { available: false, queueSize: 0, models: [] };
    const models = await getModels();
    return { available: true, queueSize: 0, models };
  } catch {
    return { available: false, queueSize: 0, models: [] };
  }
}

async function getModels(overrideUrl?: string): Promise<string[]> {
  const baseUrl = await getBaseUrl(overrideUrl);
  try {
    const res = await fetch(`${baseUrl}/sdapi/v1/sd-models`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as Array<{
      model_name?: string;
      title?: string;
      filename?: string;
    }>;
    return data
      .map((m) => m.model_name || m.title || m.filename || "")
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Rough pacing for heartbeat progress — no mid-flight progress from the sync
// A1111 endpoint, so we animate 1 fake step per second. Saturates at steps-1
// if real generation is slower; finalizes to steps on completion.
const HEARTBEAT_STEP_MS = 1000;

// Match ComfyUI's per-request global timeout (server/src/services/comfyui.ts:487).
const GENERATION_TIMEOUT_MS = 30 * 60 * 1000;

// ComfyUI scheduler names that don't exist in sd-server. Unlisted names pass
// through unchanged so sd-server returns a clear error on real typos.
const SCHEDULER_MAP: Record<string, string> = {
  normal: "discrete",
  beta: "simple",
};

function mapScheduler(name: string | undefined): string {
  if (!name) return "default";
  return SCHEDULER_MAP[name] ?? name;
}

async function generate(
  _generationId: string,
  _clientId: string,
  params: ImageGenerationParams,
  onLinkJob: (jobId: string) => void,
  onProgress?: (progress: GenerateProgress) => void,
  onStatus?: (status: CoordinatorStatus) => void,
): Promise<{ imageData: Buffer; resolvedSeed: number }> {
  const baseUrl = await getBaseUrl();

  // A new request arrived — cancel any pending auto-stop so we don't tear
  // the service down between ensureRunning() and the actual fetch.
  if (idleStopTimer) {
    clearTimeout(idleStopTimer);
    idleStopTimer = null;
  }
  await ensureRunning(baseUrl, onStatus);

  // Resolve seed client-side — A1111 sync response doesn't reliably echo the
  // actual seed used when we pass -1, so decide it here and send it explicitly.
  const resolvedSeed =
    params.seed != null && params.seed >= 0
      ? params.seed
      : Math.floor(Math.random() * 2 ** 32);

  const body = {
    prompt: params.positivePrompt,
    negative_prompt: params.negativePrompt || "",
    width: params.width,
    height: params.height,
    steps: params.steps,
    cfg_scale: params.cfgScale,
    seed: resolvedSeed,
    sampler_name: params.sampler ?? "euler",
    scheduler: mapScheduler(params.scheduler),
    batch_size: 1,
  };

  // A1111 sync API exposes no job ID. Flip generation status to "processing"
  // with an empty string — linkComfyUIIds treats it as a status transition.
  onLinkJob("");

  onProgress?.({ step: 0, totalSteps: params.steps });
  const startedAt = Date.now();
  const interval = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    const estimated = Math.min(
      params.steps - 1,
      Math.floor(elapsed / HEARTBEAT_STEP_MS),
    );
    onProgress?.({ step: estimated, totalSteps: params.steps });
  }, HEARTBEAT_STEP_MS);

  // Call sd-server's txt2img and parse the response. Throws a tagged error
  // with .status when the HTTP response is non-ok so the caller can branch
  // on retryable-vs-terminal failures.
  const attemptRequest = async (): Promise<Buffer> => {
    const res = await fetch(`${baseUrl}/sdapi/v1/txt2img`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
      // @ts-expect-error — undici extension to fetch, not in lib.dom types
      dispatcher: longRunningDispatcher,
    });

    if (!res.ok) {
      let detail = res.statusText;
      try {
        const parsed = (await res.json()) as { error?: string; detail?: string };
        if (parsed.error || parsed.detail) detail = parsed.error || parsed.detail || detail;
      } catch {
        // body wasn't JSON — keep statusText
      }
      const err: Error & { status?: number } = new Error(
        `sd-server txt2img error (${res.status}): ${detail}`,
      );
      err.status = res.status;
      throw err;
    }

    const data = (await res.json()) as { images?: string[]; info?: string };
    if (!data.images || data.images.length === 0) {
      throw new Error("sd-server returned no images");
    }
    return Buffer.from(data.images[0], "base64");
  };

  try {
    let imageData: Buffer;
    try {
      imageData = await attemptRequest();
    } catch (err: any) {
      // HTTP 500 is the canonical symptom of a lost Vulkan context after a
      // GPU reset — the process stays alive but inference is permanently
      // broken. Restart once and retry. Other errors bubble up unchanged.
      if (err?.status === 500) {
        console.warn(`[sdcpp] ${err.message} — restarting service and retrying once`);
        await restartService(baseUrl, onStatus);
        imageData = await attemptRequest();
      } else {
        throw err;
      }
    }

    onProgress?.({ step: params.steps, totalSteps: params.steps });
    return { imageData, resolvedSeed };
  } catch (err: any) {
    console.error(`[sdcpp] generate failed: ${err?.message || err}`);
    throw err;
  } finally {
    clearInterval(interval);
    scheduleIdleStop();
  }
}

export const sdcppBackend: ImageBackend = {
  name: "sdcpp",
  getStatus,
  getModels,
  generate,
};
