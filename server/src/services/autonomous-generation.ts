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
import { join } from "path";
import { homedir } from "os";
import type { Message } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import { agentLoop } from "@mariozechner/pi-agent-core";
import type { AgentContext, AgentLoopConfig, AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { Z_IMAGE_INSTRUCTIONS, loadThumbnail } from "./creative-engine.js";
import type { ImageCorpusEntry } from "./image-corpus.js";
import { postDirectionProgress } from "./chat-poster.js";

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
 * Build the system prompt for the autonomous review agent loop.
 * Combines creative direction context with z-image instructions.
 */
function buildAutonomousSystemPrompt(direction: CreativeDirection): string {
  const elementLines = Object.entries(direction.elementCombination)
    .filter(([_, v]) => v)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  return `You are an autonomous creative agent generating images for a visual corpus.
You have the generate_and_review tool to create and iteratively refine images.

**Your Creative Direction:** ${direction.type.toUpperCase()}
**Goal:** ${direction.description}

**Element Combination:**
${elementLines}

**Novelty Target:** ${(direction.noveltyScore * 100).toFixed(0)}% new compared to existing corpus

When evaluating each generated image:
- Does it capture the essence of the creative direction?
- Does it successfully combine the specified elements (themes, settings, styles)?
- Is the novelty level appropriate — distinct from the reference images shown?
- Be specific about what needs to change: composition, lighting, subject matter, style.

**CRITICAL: All prompts you pass to generate_and_review (both initial and refined) MUST follow the z-image workflow below. Never pass a short one-line description — always produce a full, detailed, structured prompt.**

${Z_IMAGE_INSTRUCTIONS}`;
}

/**
 * Build the initial user message with the proposed prompt and corpus reference images.
 * Includes thumbnails as vision context so the agent can judge novelty and alignment.
 */
async function buildAutonomousUserMessage(
  direction: CreativeDirection,
  corpusMembers?: ImageCorpusEntry[],
): Promise<Message> {
  const content: any[] = [];

  // Load corpus reference thumbnails for vision context
  if (corpusMembers && corpusMembers.length > 0) {
    const thumbs = await Promise.all(corpusMembers.slice(0, 3).map(m => loadThumbnail(m)));
    for (const thumb of thumbs) {
      if (thumb) {
        content.push({ type: "image", data: thumb.data, mimeType: thumb.mimeType });
      }
    }
  }

  const textPrompt = `Generate an image using the generate_and_review tool. You MUST pass the ENTIRE prompt below as the initialPrompt parameter exactly as written — do NOT summarize, shorten, or paraphrase it. The full detailed prompt is critical for image quality.

<initialPrompt>
${direction.proposedPrompt}
</initialPrompt>

Creative intent: ${direction.description}

${corpusMembers && corpusMembers.length > 0 ? "The reference images above show existing corpus entries. Your generation should be distinct from these while aligning with the creative direction." : ""}

Use the generate_and_review tool now with the COMPLETE prompt above as initialPrompt. When iterating on subsequent attempts, continue to produce full z-image prompts following the instructions in your system prompt — never reduce a prompt to a single sentence.`;

  content.push({ type: "text", text: textPrompt });

  return { role: "user" as const, content, timestamp: Date.now() };
}

/**
 * Build a generate_and_review tool for the autonomous agent loop.
 * This is a standalone version that doesn't need chat UI effects.
 */
function buildAutonomousGenerateReviewTool(
  chatId: string,
  directionId: string,
  pendingImageRef: { current: { data: string; mimeType: string } | null },
): AgentTool {
  return {
    name: "generate_and_review",
    description: "Generate an image and review it against your creative intent. The initialPrompt MUST be a full, detailed z-image prompt (multiple paragraphs with subject, composition, lighting, colors, textures) — never a short one-line summary. You can iterate up to maxIterations times, refining the prompt each time.",
    parameters: Type.Object({
      initialPrompt: Type.String({ description: "The FULL detailed z-image prompt — must include subject, composition, lighting, colors, textures. Pass the complete prompt verbatim, never summarize." }),
      creativeIntent: Type.String({ description: "What you're trying to achieve" }),
      maxIterations: Type.Optional(Type.Number({ description: "Maximum iterations (default 3, range 1-5)" })),
      iteration: Type.Optional(Type.Number({ description: "Current iteration number (internal use)" })),
      imageHistory: Type.Optional(Type.Array(Type.Object({
        imageUrl: Type.String(),
        prompt: Type.String(),
        iteration: Type.Number(),
      }), { description: "Previous generation attempts (internal use)" })),
    }),
    label: "generate_and_review",
    execute: async (_toolCallId, params) => {
      const args = params as Record<string, any>;
      const iteration = args.iteration ?? 1;
      const maxIterations = Math.min(Math.max(args.maxIterations ?? 3, 1), 5);

      console.log(`[autonomous-review] generate_and_review iteration ${iteration}/${maxIterations}`);

      try {
        const { generateForReview, formatReviewResult } = await import("./generate-review.js");

        const result = await generateForReview(args.initialPrompt, chatId, undefined, { directionId });

        if (!result.success) {
          return {
            content: [{ type: "text", text: `**Generation Failed (Iteration ${iteration}/${maxIterations})**\n\nError: ${result.error}\n\nYou can retry with a modified prompt.` }],
            details: {
              iteration,
              maxIterations,
              creativeIntent: args.creativeIntent,
              imageHistory: args.imageHistory || [],
              lastPrompt: args.initialPrompt,
            },
            isError: true,
          } as AgentToolResult<any>;
        }

        const reviewResult = formatReviewResult(
          result,
          iteration,
          maxIterations,
          args.creativeIntent,
          args.initialPrompt
        );

        if (args.imageHistory) {
          reviewResult.details.imageHistory = [...args.imageHistory, ...reviewResult.details.imageHistory];
        }
        reviewResult.details.lastPrompt = args.initialPrompt;

        // Stash pending image for steering message injection
        if (reviewResult.details.pendingImage) {
          pendingImageRef.current = {
            data: reviewResult.details.pendingImage.data,
            mimeType: reviewResult.details.pendingImage.mimeType,
          };
        }

        return reviewResult as AgentToolResult<any>;
      } catch (e: any) {
        console.error(`[autonomous-review] generate_and_review error:`, e.message);
        return {
          content: [{ type: "text", text: `**Generation Error (Iteration ${iteration}/${maxIterations})**\n\n${e.message}` }],
          details: {
            iteration,
            maxIterations,
            creativeIntent: args.creativeIntent,
            imageHistory: args.imageHistory || [],
            lastPrompt: args.initialPrompt,
          },
          isError: true,
        } as AgentToolResult<any>;
      }
    },
  };
}

/**
 * Execute a creative direction with iterative review and refinement.
 * Runs an agent loop with the generate_and_review tool, allowing the LLM
 * to autonomously generate, evaluate, and refine images.
 *
 * GPU coordination: The agent loop alternates between Ollama (LLM evaluation)
 * and ComfyUI (image generation). Caller should ensure Ollama is available.
 *
 * @param corpusMembers - Optional corpus entries to include as vision context
 *   so the agent can judge novelty against existing images.
 * @param existingGenerationId - If provided, reuse a pre-created GenerationState
 *   instead of creating a new one.
 */
export async function executeDirectionWithReview(
  direction: CreativeDirection,
  chatId: string,
  config: AutonomousGenerationConfig = DEFAULT_AUTONOMOUS_CONFIG,
  options: {
    maxIterations?: number;
    modelId?: string;
    existingGenerationId?: string;
    corpusMembers?: ImageCorpusEntry[];
  } = {}
): Promise<{
  success: boolean;
  imageId?: string;
  imageUrl?: string;
  generationId?: string;
  error?: string;
  iterations?: number;
  acceptedAtIteration?: number;
  finalPrompt?: string;
}> {
  const maxIterations = Math.min(options.maxIterations ?? 3, 5);
  const reviewModelId = options.modelId ?? "qwen3.5:9b";

  console.log(`[autonomous-review] Starting agent loop for direction: ${direction.type} - ${direction.description}`);
  console.log(`[autonomous-review] Max iterations: ${maxIterations}, model: ${reviewModelId}`);

  // Post progress message if chatId is the directions chat
  if (chatId && options.corpusMembers) {
    try {
      const { postDirectionProgress } = await import("./chat-poster.js");
      await postDirectionProgress(chatId, direction.id, "started", {
        description: direction.description,
        type: direction.type,
      });
    } catch (e) {
      console.error("[autonomous-review] Failed to post progress:", e);
    }
  }

  // Shared ref for the pending image — the tool stashes it here,
  // getSteeringMessages injects it as a user message so the agent can see it.
  const pendingImageRef: { current: { data: string; mimeType: string } | null } = { current: null };

  // Build tools — only generate_and_review for autonomous mode
  const tool = buildAutonomousGenerateReviewTool(chatId, direction.id, pendingImageRef);

  // Build system prompt with direction context and z-image instructions
  const systemPrompt = buildAutonomousSystemPrompt(direction);

  // Build initial user message with corpus thumbnails and proposed prompt
  const userMessage = await buildAutonomousUserMessage(direction, options.corpusMembers);

  // Discover the review model
  const { discoverOllamaModels, createPiModel } = await import("./models.js");
  const ollamaModels = await discoverOllamaModels();
  const ollamaModel = ollamaModels.find(m => m.id === reviewModelId);
  if (!ollamaModel) {
    return { success: false, error: `Model ${reviewModelId} not available` };
  }
  const piModel = createPiModel(ollamaModel);

  // Build agent context
  const context: AgentContext = {
    systemPrompt,
    messages: [],
    tools: [tool],
  };

  // Build agent loop config
  const loopConfig: AgentLoopConfig = {
    model: piModel,
    apiKey: "ollama",
    reasoning: piModel.reasoning ? "medium" : undefined,
    convertToLlm: (msgs) => msgs as Message[],
    getSteeringMessages: async () => {
      // Inject pending image as a user message so the agent can see it
      if (pendingImageRef.current) {
        const img = pendingImageRef.current;
        pendingImageRef.current = null;
        return [{
          role: "user" as const,
          content: [{ type: "image", data: img.data, mimeType: img.mimeType }],
          timestamp: Date.now(),
        }];
      }
      return [];
    },
  };

  // Run the agent loop
  const abortController = new AbortController();
  const eventStream = agentLoop(
    [userMessage],
    context,
    loopConfig,
    abortController.signal,
    streamSimple,
  );

  // Collect results from the event stream
  let lastImageUrl: string | undefined;
  let lastImageId: string | undefined;
  let lastPrompt: string | undefined;
  let iterationCount = 0;
  let finalText = "";

  try {
    for await (const event of eventStream) {
      if (event.type === "tool_execution_end") {
        const details = (event as any).result?.details;
        if (details) {
          iterationCount = details.iteration ?? iterationCount;
          if (details.lastPrompt) lastPrompt = details.lastPrompt;
          // Extract image info from history
          const history = details.imageHistory as Array<{ imageUrl: string; prompt: string; iteration: number }> | undefined;
          if (history && history.length > 0) {
            const latest = history[history.length - 1];
            lastImageUrl = latest.imageUrl;
            // Extract image ID from URL
            const urlPart = latest.imageUrl.replace("/api/images/", "");
            lastImageId = urlPart.split("/")[0];
          }
        }
      } else if (event.type === "message_update") {
        const ame = (event as any).assistantMessageEvent;
        if (ame?.type === "text_delta") {
          finalText += ame.delta;
        }
      }
    }
  } catch (err: any) {
    console.error(`[autonomous-review] Agent loop error:`, err.message);
    return {
      success: false,
      error: err.message || "Agent loop failed",
      iterations: iterationCount,
    };
  }

  console.log(`[autonomous-review] Agent loop complete. Iterations: ${iterationCount}, image: ${lastImageId}`);

  // Post completion message if chatId is the directions chat
  if (chatId && lastImageUrl) {
    try {
      const { postDirectionProgress } = await import("./chat-poster.js");
      await postDirectionProgress(chatId, direction.id, "complete", {
        description: direction.description,
        type: direction.type,
        imageUrl: lastImageUrl,
      });
    } catch (e) {
      console.error("[autonomous-review] Failed to post completion:", e);
    }
  }

  if (lastImageId && lastImageUrl) {
    return {
      success: true,
      imageId: lastImageId,
      imageUrl: lastImageUrl,
      iterations: iterationCount,
      acceptedAtIteration: iterationCount,
      finalPrompt: lastPrompt || direction.proposedPrompt,
    };
  }

  return {
    success: false,
    error: "Agent loop completed without generating an image",
    iterations: iterationCount,
  };
}

/**
 * Execute a creative direction by generating an image (single-shot, no review).
 * Legacy function kept for backwards compatibility.
 * 
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
