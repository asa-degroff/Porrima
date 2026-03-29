import crypto from "crypto";
import { readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { GeneratedImage } from "../types.js";
import { generateImageWithState } from "./comfyui.js";
import { saveGeneratedImage } from "./image-storage.js";
import { createGeneration, linkComfyUIIds, updateProgress, completeGeneration } from "./image-generation.js";
import { DEFAULT_AUTONOMOUS_CONFIG, type AutonomousGenerationConfig } from "./autonomous-generation.js";
import { analyzeDimensions } from "./autonomous-generation.js";

const IMAGES_DIR = join(homedir(), ".quje-agent", "images");

/**
 * State for tracking generate_and_review iterations within a single tool call.
 * Stored in-memory during the tool execution, not persisted.
 */
export interface GenerationReviewState {
  iteration: number;
  maxIterations: number;
  creativeIntent: string;
  imageHistory: Array<{
    imageUrl: string;
    prompt: string;
    iteration: number;
  }>;
  lastPrompt?: string;
  pendingImage?: {
    data: string; // base64
    mimeType: string;
    imageUrl: string;
  };
}

/**
 * Generate an image and prepare it for agent review.
 * Returns the image data as base64 so it can be attached to the tool result.
 */
export async function generateForReview(
  prompt: string,
  chatId: string,
  config: AutonomousGenerationConfig = DEFAULT_AUTONOMOUS_CONFIG
): Promise<{
  success: boolean;
  imageData?: { base64: string; mimeType: string };
  imageUrl?: string;
  imageId?: string;
  generationId?: string;
  error?: string;
  resolvedSeed?: number;
}> {
  console.log(`[generate-review] Generating for review: ${prompt.slice(0, 80)}...`);

  // Analyze dimensions based on prompt
  const dims = analyzeDimensions(prompt, config);
  console.log(`[generate-review] Dimensions: ${dims.width}x${dims.height}`);

  const generationParams = {
    positivePrompt: prompt,
    negativePrompt: "",
    model: config.modelId,
    steps: config.steps,
    cfgScale: config.cfgScale,
    width: dims.width,
    height: dims.height,
    sampler: config.sampler,
    scheduler: config.scheduler,
    seed: -1, // Random seed for each iteration
  };

  const generationId = crypto.randomUUID();
  const clientId = crypto.randomUUID();

  try {
    const result = await generateImageWithState(
      generationId,
      clientId,
      generationParams,
      (promptId) => {
        linkComfyUIIds(generationId, promptId);
        console.log(`[generate-review] Linked ComfyUI prompt ID: ${promptId}`);
      },
      (progress) => {
        updateProgress(generationId, progress.step, progress.totalSteps);
        if (progress.step % 5 === 0 || progress.step === progress.totalSteps) {
          console.log(`[generate-review] Generation progress: ${progress.step}/${progress.totalSteps}`);
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
    });

    // Mark complete
    await completeGeneration(generationId, imageUrl);

    // Use WebP thumbnail for agent review — Ollama rejects JXL ("400 invalid image input")
    const imageFilename = imageUrl.replace("/api/images/", "");
    const thumbPath = join(IMAGES_DIR, imageFilename, "thumb.webp");
    const imageBuffer = await readFile(thumbPath);
    const mimeType = "image/webp";

    console.log(`[generate-review] Generation complete: ${imageId} (${imageUrl})`);
    
    return {
      success: true,
      imageData: {
        base64: imageBuffer.toString("base64"),
        mimeType,
      },
      imageUrl,
      imageId,
      generationId,
      resolvedSeed: result.resolvedSeed,
    };
  } catch (err: any) {
    console.error("[generate-review] Generation failed:", err.message);
    return {
      success: false,
      generationId,
      error: err.message || "Generation failed",
    };
  }
}

/**
 * Build a review prompt for the agent to evaluate a generated image.
 * This is used internally to guide the agent's evaluation when it sees the image.
 */
export function buildReviewContext(
  creativeIntent: string,
  currentPrompt: string,
  iteration: number,
  maxIterations: number,
  previousAttempts?: Array<{ prompt: string; iteration: number }>
): string {
  let context = `**Creative Intent:** ${creativeIntent}

**Current Prompt (Iteration ${iteration}/${maxIterations}):** ${currentPrompt}

`;

  if (previousAttempts && previousAttempts.length > 0) {
    context += `**Previous Attempts:**\n`;
    for (const attempt of previousAttempts) {
      context += `- Iteration ${attempt.iteration}: ${attempt.prompt}\n`;
    }
    context += "\n";
  }

  context += `**Your Task:** Evaluate the generated image above against the creative intent.
- Does it capture the essence of what you're trying to achieve?
- What's working well? What's missing or off?
- If this is iteration ${maxIterations}, you should accept unless it's completely wrong.
- If you want to retry, provide a refined prompt that addresses the gaps.

Be specific and honest in your evaluation.`;

  return context;
}

/**
 * Format the tool result for a generate_and_review call.
 * Returns text summary + image attachment so the agent can see what was generated.
 */
export function formatReviewResult(
  result: Awaited<ReturnType<typeof generateForReview>>,
  iteration: number,
  maxIterations: number,
  creativeIntent: string,
  currentPrompt: string
): { content: any[]; details: GenerationReviewState } {
  if (!result.success || !result.imageData) {
    return {
      content: [
        {
          type: "text",
          text: `**Generation Failed (Iteration ${iteration}/${maxIterations})**\n\nError: ${result.error}\n\nYou can retry with a modified prompt or accept this outcome.`,
        },
      ],
      details: {
        iteration,
        maxIterations,
        creativeIntent,
        imageHistory: [],
      },
    };
  }

  const reviewContext = buildReviewContext(creativeIntent, currentPrompt, iteration, maxIterations);

  // Image is excluded from tool result content because Ollama rejects images
  // in tool result messages ("400 invalid image input"). Instead, the image is
  // stashed in details.pendingImage and injected as a user message via
  // getSteeringMessages after the tool result is processed.
  return {
    content: [
      {
        type: "text",
        text: `**Generated Image (Iteration ${iteration}/${maxIterations})**\n\nPrompt: ${currentPrompt}\nSeed: ${result.resolvedSeed}\nImage ID: ${result.imageId}\nImage URL: ${result.imageUrl}\n\n${reviewContext}`,
      },
    ],
    details: {
      iteration,
      maxIterations,
      creativeIntent,
      imageHistory: [
        {
          imageUrl: result.imageUrl!,
          prompt: currentPrompt,
          iteration,
        },
      ],
      pendingImage: {
        data: result.imageData.base64,
        mimeType: result.imageData.mimeType,
        imageUrl: result.imageUrl!,
      },
    },
  };
}
