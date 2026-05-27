import type { ImageGenerationParams, ComfyUIStatus } from "../types.js";
import { getSettings } from "./chat-storage.js";
import type { CoordinatorStatus } from "./resource-coordinator.js";

export type ImageBackendStatus = ComfyUIStatus;
export type { CoordinatorStatus } from "./resource-coordinator.js";

export interface GenerateProgress {
  step: number;
  totalSteps: number;
}

export interface ImageBackend {
  name: string;
  getStatus(overrideUrl?: string): Promise<ImageBackendStatus>;
  getModels(overrideUrl?: string): Promise<string[]>;
  generate(
    generationId: string,
    clientId: string,
    params: ImageGenerationParams,
    onLinkJob: (jobId: string) => void,
    onProgress?: (progress: GenerateProgress) => void,
    onStatus?: (status: CoordinatorStatus) => void,
  ): Promise<{ imageData: Buffer; resolvedSeed: number }>;
}

export async function getImageBackend(): Promise<ImageBackend> {
  const settings = await getSettings();
  return getImageBackendByName(settings.imageBackend);
}

export async function getImageBackendByName(
  name: string | undefined,
): Promise<ImageBackend> {
  if (name === "sdcpp") {
    const { sdcppBackend } = await import("./sdcpp.js");
    return sdcppBackend;
  }
  const { comfyuiBackend } = await import("./comfyui.js");
  return comfyuiBackend;
}
