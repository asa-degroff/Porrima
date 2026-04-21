import type { ImageGenerationParams } from "../types.js";

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
