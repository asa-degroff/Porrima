import type { ImageGenerationParams, ComfyUIStatus } from "../types.js";

export type ImageBackendStatus = ComfyUIStatus;

export interface GenerateProgress {
  step: number;
  totalSteps: number;
}

export interface ImageBackend {
  name: string;
  getStatus(): Promise<ImageBackendStatus>;
  getModels(): Promise<string[]>;
  generate(
    generationId: string,
    clientId: string,
    params: ImageGenerationParams,
    onLinkJob: (jobId: string) => void,
    onProgress?: (progress: GenerateProgress) => void,
  ): Promise<{ imageData: Buffer; resolvedSeed: number }>;
}

export async function getImageBackend(): Promise<ImageBackend> {
  const { comfyuiBackend } = await import("./comfyui.js");
  return comfyuiBackend;
}
