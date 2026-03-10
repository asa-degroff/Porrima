import { Type } from "@sinclair/typebox";
import type { Tool, ToolCall } from "@mariozechner/pi-ai";
import { generateImageWithState, MODEL_PRESETS } from "./comfyui.js";
import { saveGeneratedImage } from "./image-storage.js";
import { createGeneration, linkComfyUIIds, updateProgress, completeGeneration } from "./image-generation.js";
import { v4 as uuid } from "uuid";
import type { ImageGenerationParams, GeneratedImage } from "../types.js";

export const IMAGE_TOOLS: Tool[] = [
  {
    name: "generate_image",
    description:
      "Generate an image using a local diffusion model via ComfyUI. Provide a detailed positive prompt describing the image to generate.",
    parameters: Type.Object({
      prompt: Type.String({
        description: "Detailed description of the image to generate",
      }),
      negative_prompt: Type.Optional(
        Type.String({ description: "What to avoid in the image" })
      ),
      width: Type.Optional(
        Type.Number({ description: "Image width in pixels (default 1024)" })
      ),
      height: Type.Optional(
        Type.Number({ description: "Image height in pixels (default 1024)" })
      ),
      steps: Type.Optional(
        Type.Number({ description: "Number of sampling steps" })
      ),
      cfg_scale: Type.Optional(
        Type.Number({ description: "CFG scale (guidance strength)" })
      ),
      model: Type.Optional(
        Type.String({ description: "Diffusion model filename" })
      ),
      seed: Type.Optional(
        Type.Number({ description: "Seed for reproducibility (-1 for random)" })
      ),
    }),
  },
];

export interface ImageToolEvent {
  type: "generated_image";
  data: GeneratedImage;
}

export async function executeImageTool(
  toolCall: ToolCall,
  chatId: string,
  onEvent?: (event: ImageToolEvent) => void
): Promise<{ content: string; isError: boolean }> {
  if (toolCall.name !== "generate_image") {
    return { content: `Unknown image tool: ${toolCall.name}`, isError: true };
  }

  const args = toolCall.arguments;
  if (!args.prompt) {
    return { content: "Missing prompt", isError: true };
  }

  const model = args.model || "z_image-Q4_0.gguf";

  // Apply model presets as defaults
  let preset: Partial<ImageGenerationParams> = {};
  if (model.includes("turbo")) {
    preset = MODEL_PRESETS["z-image-turbo"] || {};
  } else {
    preset = MODEL_PRESETS["z-image-base"] || {};
  }

  const params: ImageGenerationParams = {
    positivePrompt: args.prompt,
    negativePrompt: args.negative_prompt,
    model,
    steps: args.steps ?? preset.steps ?? 30,
    cfgScale: args.cfg_scale ?? preset.cfgScale ?? 4.0,
    width: args.width ?? 1024,
    height: args.height ?? 1024,
    seed: args.seed,
    sampler: preset.sampler ?? "euler",
    scheduler: preset.scheduler ?? "normal",
  };

  try {
    console.log(`[image-tool] Generating image: "${args.prompt.slice(0, 80)}..."`);

    // Create generation state for tracking
    const generation = createGeneration(params, chatId);

    const result = await generateImageWithState(
      generation.id,
      generation.clientId,
      params,
      (promptId) => linkComfyUIIds(generation.id, promptId),
      (progress) => updateProgress(generation.id, progress.step, progress.totalSteps)
    );

    const id = uuid();
    const url = await saveGeneratedImage(id, result.imageData, {
      params,
      resolvedSeed: result.resolvedSeed,
      createdAt: new Date().toISOString(),
      chatId,
    });

    // Mark generation as complete
    completeGeneration(generation.id, url);

    const generatedImage: GeneratedImage = {
      id,
      url,
      params,
      resolvedSeed: result.resolvedSeed,
      createdAt: new Date().toISOString(),
      chatId,
    };

    onEvent?.({ type: "generated_image", data: generatedImage });

    return {
      content: `Image generated successfully.\nURL: ${url}\nSeed: ${result.resolvedSeed}\nModel: ${model}\nSteps: ${params.steps}, CFG: ${params.cfgScale}, Size: ${params.width}x${params.height}`,
      isError: false,
    };
  } catch (e: any) {
    console.error("[image-tool] Generation failed:", e.message);
    return {
      content: `Image generation failed: ${e.message}`,
      isError: true,
    };
  }
}
