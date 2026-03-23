import type { CreativeDirection } from "./creative-engine.js";
import { generateImageWithState } from "./comfyui.js";
import { saveGeneratedImage } from "./image-storage.js";
import { addCorpusEntry, enrichCorpusEntry } from "./image-corpus.js";
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
 * Integrates with the ComfyUI queue system and tracks agent generations.
 */
export async function executeDirection(
  direction: CreativeDirection,
  chatId: string,
  config: AutonomousGenerationConfig = DEFAULT_AUTONOMOUS_CONFIG
): Promise<{ success: boolean; imageId?: string; imageUrl?: string; error?: string }> {
  
  console.log(`[creative-engine] Executing direction: ${direction.type} - ${direction.description}`);
  
  // Analyze dimensions based on prompt
  const dims = analyzeDimensions(direction.proposedPrompt, config);
  console.log(`[creative-engine] Dimensions: ${dims.width}x${dims.height}`);
  
  // Generate with state tracking
  const generationId = crypto.randomUUID();
  const clientId = crypto.randomUUID();
  
  try {
    const result = await generateImageWithState(
      generationId,
      clientId,
      {
        positivePrompt: direction.proposedPrompt,
        model: config.modelId,
        steps: config.steps,
        cfgScale: config.cfgScale,
        width: dims.width,
        height: dims.height,
        sampler: config.sampler,
        scheduler: config.scheduler,
      },
      (promptId) => {
        console.log(`[creative-engine] Linked ComfyUI prompt ID: ${promptId}`);
      },
      (progress) => {
        if (progress.step % 5 === 0 || progress.step === progress.totalSteps) {
          console.log(`[creative-engine] Generation progress: ${progress.step}/${progress.totalSteps}`);
        }
      }
    );
    
    // Save with agent tracking
    const imageId = crypto.randomUUID();
    const imageUrl = await saveGeneratedImage(imageId, result.imageData, {
      params: {
        positivePrompt: direction.proposedPrompt,
        model: config.modelId,
        steps: config.steps,
        cfgScale: config.cfgScale,
        width: dims.width,
        height: dims.height,
        sampler: config.sampler,
        scheduler: config.scheduler,
      },
      resolvedSeed: result.resolvedSeed,
      createdAt: new Date().toISOString(),
      chatId,
      generatedBy: 'agent',
      directionId: direction.id,
    });
    
    // Add to image corpus so future clustering/directions can see this generation
    const corpusEntry = {
      id: crypto.randomUUID(),
      type: "generated" as const,
      imagePath: imageUrl.replace("/api/images/", ""),
      prompt: direction.proposedPrompt,
      description: "",
      elements: {},
      promptEmbedding: undefined as number[] | undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      chatId,
      generationId,
      directionId: direction.id,
    };

    // Enrich with embedding and elements (async, non-blocking)
    enrichCorpusEntry(corpusEntry.id, direction.proposedPrompt, undefined).catch(console.error);
    await addCorpusEntry(corpusEntry);

    console.log(`[creative-engine] Generation complete: ${imageId} (${imageUrl}), added to corpus`);
    return { success: true, imageId, imageUrl };
    
  } catch (err: any) {
    console.error("[creative-engine] Generation failed:", err.message);
    return { success: false, error: err.message || "Generation failed" };
  }
}

