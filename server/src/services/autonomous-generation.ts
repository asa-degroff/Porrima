import type { CreativeDirection } from "./creative-engine.js";
import { generateImageWithState } from "./comfyui.js";
import { saveGeneratedImage } from "./image-storage.js";
import {
  createGeneration,
  linkComfyUIIds,
  updateProgress,
  completeGeneration,
  failGeneration,
} from "./image-generation.js";
import crypto from "crypto";

/**
 * Autonomous generation configuration.
 * Uses z-image base defaults optimized for quality.
 */
export interface AutonomousGenerationConfig {
  modelId: string;           // Default: z-image-BF16.gguf
  steps: number;             // Default: 35
  cfgScale: number;          // Default: 4.0
  baseWidth: number;         // Default: 1024
  baseHeight: number;        // Default: 1365 (portrait) or 1365 (landscape)
  sampler?: string;          // Default: euler
  scheduler?: string;        // Default: normal
  allowDimensionOverride: boolean; // Agent can change aspect ratio based on prompt
}

/**
 * Default config for autonomous generations.
 * Optimized for z-image base model.
 */
export const DEFAULT_AUTONOMOUS_CONFIG: AutonomousGenerationConfig = {
  modelId: "z-image-BF16.gguf",
  steps: 35,
  cfgScale: 4.0,
  baseWidth: 1024,
  baseHeight: 1365,
  sampler: "euler",
  scheduler: "normal",
  allowDimensionOverride: true,
};

/**
 * Analyze prompt to determine optimal dimensions.
 * Uses keyword detection and subject matter analysis.
 */
export function analyzeDimensions(prompt: string, config: AutonomousGenerationConfig): { width: number; height: number } {
  if (!config.allowDimensionOverride) {
    return { width: config.baseWidth, height: config.baseHeight };
  }

  const lowerPrompt = prompt.toLowerCase();

  // Explicit dimension keywords
  if (lowerPrompt.includes('portrait') || lowerPrompt.includes('vertical') || lowerPrompt.includes('tall')) {
    return { width: 1024, height: 1365 };
  }
  if (lowerPrompt.includes('landscape') || lowerPrompt.includes('panoramic') || lowerPrompt.includes('wide')) {
    return { width: 1365, height: 1024 };
  }
  if (lowerPrompt.includes('square') || lowerPrompt.includes('1:1')) {
    return { width: 1024, height: 1024 };
  }

  // Subject matter analysis
  if (lowerPrompt.includes('person') || lowerPrompt.includes('face') || lowerPrompt.includes('portrait of') || lowerPrompt.includes('character')) {
    return { width: 1024, height: 1365 }; // Portrait for people/characters
  }
  if (lowerPrompt.includes('scene') || lowerPrompt.includes('landscape') || lowerPrompt.includes('environment') || lowerPrompt.includes('vista')) {
    return { width: 1365, height: 1024 }; // Landscape for scenes
  }
  if (lowerPrompt.includes('vehicle') || lowerPrompt.includes('ship') || lowerPrompt.includes('mech')) {
    return { width: 1365, height: 1024 }; // Landscape for vehicles
  }

  // Default to portrait (better for most creative generations)
  return { width: config.baseWidth, height: config.baseHeight };
}

/**
 * Execute a creative direction by generating an image.
 * Integrates with the generation state tracking system so progress
 * is visible via SSE subscriptions (same as manual generations).
 */
/**
 * @param existingGenerationId - If provided, reuse a pre-created GenerationState
 *   instead of creating a new one. Used by the corpus execute endpoint to return
 *   the generationId to the client immediately before generation starts.
 */
export async function executeDirection(
  direction: CreativeDirection,
  chatId: string,
  config: AutonomousGenerationConfig = DEFAULT_AUTONOMOUS_CONFIG,
  existingGenerationId?: string
): Promise<{ success: boolean; imageId?: string; imageUrl?: string; generationId?: string; error?: string }> {

  console.log(`[creative-engine] Executing direction: ${direction.type} - ${direction.description}`);

  // Analyze dimensions based on prompt
  const dims = analyzeDimensions(direction.proposedPrompt, config);
  console.log(`[creative-engine] Dimensions: ${dims.width}x${dims.height}`);

  // Register with the generation state tracker so SSE subscribers can follow progress.
  // This is the same system used by manual generations in routes/images.ts.
  const generationParams = {
    positivePrompt: direction.proposedPrompt,
    model: config.modelId,
    steps: config.steps,
    cfgScale: config.cfgScale,
    width: dims.width,
    height: dims.height,
    sampler: config.sampler,
    scheduler: config.scheduler,
  };

  let generationId: string;
  let clientId: string;

  if (existingGenerationId) {
    // Reuse pre-created generation state (from corpus endpoint)
    const { getGeneration } = await import("./image-generation.js");
    const existing = getGeneration(existingGenerationId);
    if (existing) {
      generationId = existing.id;
      clientId = existing.clientId;
    } else {
      // Fallback: create new if pre-created state was lost
      const genState = createGeneration(generationParams, chatId);
      generationId = genState.id;
      clientId = genState.clientId;
    }
  } else {
    const genState = createGeneration(generationParams, chatId);
    generationId = genState.id;
    clientId = genState.clientId;
  }

  console.log(`[creative-engine] Generation ${generationId} registered (direction: ${direction.id})`);

  try {
    const result = await generateImageWithState(
      generationId,
      clientId,
      generationParams,
      (promptId) => {
        linkComfyUIIds(generationId, promptId);
        console.log(`[creative-engine] Linked ComfyUI prompt ID: ${promptId}`);
      },
      (progress) => {
        updateProgress(generationId, progress.step, progress.totalSteps);
        if (progress.step % 5 === 0 || progress.step === progress.totalSteps) {
          console.log(`[creative-engine] Generation progress: ${progress.step}/${progress.totalSteps}`);
        }
      }
    );

    // Save image to disk
    const imageId = crypto.randomUUID();
    const imageUrl = await saveGeneratedImage(imageId, result.imageData, {
      params: generationParams,
      resolvedSeed: result.resolvedSeed,
      createdAt: new Date().toISOString(),
      chatId,
      generatedBy: 'agent',
      directionId: direction.id,
    });

    // Mark complete — this also adds to corpus and emits SSE events
    await completeGeneration(generationId, imageUrl);

    console.log(`[creative-engine] Generation complete: ${imageId} (${imageUrl})`);
    return { success: true, imageId, imageUrl, generationId };

  } catch (err: any) {
    failGeneration(generationId, err.message || "Generation failed");
    console.error("[creative-engine] Generation failed:", err.message);
    return { success: false, generationId, error: err.message || "Generation failed" };
  }
}
