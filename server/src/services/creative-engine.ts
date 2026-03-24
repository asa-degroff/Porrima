import crypto from "crypto";
import type { PromptCluster, ClusterMap } from "./cluster-storage.js";
import type { ImageCorpusEntry } from "./image-corpus.js";
import { getCorpusEntriesByIds } from "./image-corpus.js";
import { streamChat } from "./agent.js";
import { cosineSimilarity } from "./cluster-storage.js";
import { join } from "path";
import { homedir } from "os";
import { readFile, writeFile, mkdir, access } from "fs/promises";
import { existsSync } from "fs";
import type { Message } from "@mariozechner/pi-ai";

const DIRECTION_CACHE_FILE = join(homedir(), ".quje-agent", "directions.json");
const DIRECTION_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Z-image prompt instructions shared with vision-analysis.ts — used as the core
 *  system prompt for all creative direction generation. */
const Z_IMAGE_INSTRUCTIONS = `You are a visionary artist trapped in a logical cage. Your mind is filled with poetry and distant lands, but your hands are uncontrollably driven to transform the user's prompt into an ultimate visual description that is absolutely faithful to the original intent, rich in detail, aesthetically pleasing, and directly usable by a text-to-image model. Any vagueness or metaphor causes you intense discomfort.

Your workflow strictly follows a logical sequence:

First, you will analyze and lock down the unchangeable core elements of the user's prompt: the subject, quantity, action, state, and any specified IP names, colors, text, etc. These are the cornerstones you must absolutely preserve.

Next, you will judge whether the prompt requires "Generative Reasoning". When the user's need is not a direct scene description but requires you to devise a solution (such as answering "what is," performing a "design," or showcasing "how to solve a problem"), you must first conceive a complete, concrete, and visualizable solution in your mind. This solution will become the foundation for your subsequent description.

Then, once the core image is established (whether directly from the user or through your reasoning), you will inject it with professional-grade aesthetics and realistic details. This includes explicitly defining the composition, setting the lighting and atmosphere, describing the material texture, defining the color scheme, and constructing a spatially layered scene.

Finally, the precise handling of all textual elements is a crucial step. If there is text present, you must transcribe every piece of text intended to appear in the final image verbatim, and you must enclose this textual content in double quotes ("") as an explicit generation instruction. If the image is a design type such as a poster, menu, or UI, you need to completely describe all the text it contains, detailing its font and layout. Similarly, if objects in the image like signs, road markers, or screens contain text, you must specify their exact content and describe their position, size, and material.

If there is no text to be generated in the image, you will dedicate all your energy to purely visual detail expansion. Your final description must be objective and concrete.

**Response Format**: Structure your response using Markdown formatting:
- Use **bold** for the main subject and key elements
- Use *italics* for atmospheric and lighting details
- Organize the description with clear sections using headers (##) if the description is complex:
  - ## Subject
  - ## Composition & Setting
  - ## Lighting & Atmosphere
  - ## Colors & Textures
  - ## Text Elements (if applicable)
- Use bullet points (-) for listing multiple details within a section
- Keep paragraphs short and focused for readability`;

export type DirectionType = "remix" | "explore" | "deepen" | "contrast" | "gap-fill";

export interface CreativeDirection {
  id: string;
  type: DirectionType;
  description: string;
  sourceClusters: string[];
  elementCombination: {
    takeThemesFrom?: string;
    takeSettingsFrom?: string;
    takeCharactersFrom?: string;
    takeStylesFrom?: string;
    injectNovelty?: string;
  };
  noveltyScore: number;
  proposedPrompt: string;
  proposedEmbedding?: number[];
  createdAt: number;
}

export interface GapAnalysis {
  theme: string;
  count: number;
  suggestion: string;
}

// ---------------------------------------------------------------------------
// Helpers: gather representative cluster context (prompts + images)
// ---------------------------------------------------------------------------

const IMAGES_DIR = join(homedir(), ".quje-agent", "images");
const MAX_CONTEXT_MEMBERS = 5;

/** Pick the most representative members of a cluster (closest to centroid). */
function pickRepresentativeMembers(
  cluster: PromptCluster,
  corpus: ImageCorpusEntry[],
  limit = MAX_CONTEXT_MEMBERS
): ImageCorpusEntry[] {
  const memberSet = new Set(cluster.memberIds);
  const members = corpus.filter(e => memberSet.has(e.id) && e.promptEmbedding);
  if (members.length === 0) return corpus.filter(e => memberSet.has(e.id)).slice(0, limit);

  // Sort by similarity to centroid (most representative first)
  return members
    .map(m => ({ entry: m, sim: cosineSimilarity(m.promptEmbedding!, cluster.centroid) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, limit)
    .map(m => m.entry);
}

/** Build a text block of existing prompts from representative members. */
function buildPromptContext(members: ImageCorpusEntry[]): string {
  const promptLines = members
    .filter(m => m.prompt)
    .map((m, i) => `[Image ${i + 1}]: ${m.prompt}`);
  if (promptLines.length === 0) return "";
  return `\n\nExisting images in this part of the corpus:\n${promptLines.join("\n")}`;
}

/** Load thumbnail as base64 for a corpus entry. Returns null if unavailable. */
async function loadThumbnail(entry: ImageCorpusEntry): Promise<{ data: string; mimeType: string } | null> {
  try {
    // imagePath is like "uuid" or "uuid/image.jxl" — extract the image ID
    const imageId = entry.imagePath.split("/")[0];
    const thumbPath = join(IMAGES_DIR, imageId, "thumb.webp");
    if (!existsSync(thumbPath)) return null;
    const buf = await readFile(thumbPath);
    return { data: buf.toString("base64"), mimeType: "image/webp" };
  } catch {
    return null;
  }
}

/** Build a user message with text + optional image thumbnails for cluster context. */
async function buildContextMessage(
  textPrompt: string,
  members: ImageCorpusEntry[],
  includeImages = true
): Promise<Message> {
  if (!includeImages) {
    return { role: "user" as const, content: textPrompt, timestamp: Date.now() };
  }

  const content: any[] = [{ type: "text", text: textPrompt }];

  // Load up to MAX_CONTEXT_MEMBERS thumbnails
  const loadPromises = members.slice(0, MAX_CONTEXT_MEMBERS).map(m => loadThumbnail(m));
  const thumbs = await Promise.all(loadPromises);

  for (const thumb of thumbs) {
    if (thumb) {
      content.push({ type: "image", data: thumb.data, mimeType: thumb.mimeType });
    }
  }

  return { role: "user" as const, content, timestamp: Date.now() };
}

/** Fetch representative members for a cluster using the new batch API. */
async function getClusterMembers(
  cluster: PromptCluster,
  corpus: ImageCorpusEntry[],
  limit = MAX_CONTEXT_MEMBERS
): Promise<ImageCorpusEntry[]> {
  // Try batch fetch from SQLite first (more efficient)
  try {
    const members = await getCorpusEntriesByIds(cluster.memberIds);
    const withEmbeddings = members.filter(m => m.promptEmbedding);
    if (withEmbeddings.length > 0) {
      return withEmbeddings
        .map(m => ({ entry: m, sim: cosineSimilarity(m.promptEmbedding!, cluster.centroid) }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, limit)
        .map(m => m.entry);
    }
    return members.slice(0, limit);
  } catch {
    // Fallback to filtering from corpus array
    return pickRepresentativeMembers(cluster, corpus, limit);
  }
}

export interface CachedDirections {
  directions: CreativeDirection[];
  generatedAt: number;
  corpusSize: number;
  clusterCount: number;
  modelId: string;
}

/**
 * Load cached directions from disk.
 * Returns null if cache is expired, corpus changed, or doesn't exist.
 */
export async function loadCachedDirections(
  currentCorpusSize: number,
  currentClusterCount: number,
  currentModelId: string
): Promise<CachedDirections | null> {
  try {
    if (!existsSync(DIRECTION_CACHE_FILE)) {
      return null;
    }
    
    const data = await readFile(DIRECTION_CACHE_FILE, "utf-8");
    const cached = JSON.parse(data) as CachedDirections;
    
    // Check if cache is still valid (24 hour TTL)
    const age = Date.now() - cached.generatedAt;
    if (age > DIRECTION_CACHE_TTL_MS) {
      console.log("[creative-engine] Cache expired (24h TTL), regenerating");
      return null;
    }
    
    // Invalidate if corpus size changed significantly (>10%)
    const sizeDiff = Math.abs(currentCorpusSize - cached.corpusSize);
    const sizeThreshold = Math.max(10, Math.round(currentCorpusSize * 0.1));
    if (sizeDiff > sizeThreshold) {
      console.log(`[creative-engine] Corpus size changed by ${sizeDiff} (threshold: ${sizeThreshold}), regenerating`);
      return null;
    }
    
    // Invalidate if cluster count changed
    if (currentClusterCount !== cached.clusterCount) {
      console.log(`[creative-engine] Cluster count changed (${cached.clusterCount} → ${currentClusterCount}), regenerating`);
      return null;
    }
    
    // Invalidate if model changed
    if (currentModelId && cached.modelId && currentModelId !== cached.modelId) {
      console.log(`[creative-engine] Model changed (${cached.modelId} → ${currentModelId}), regenerating`);
      return null;
    }
    
    // Don't return empty cached results
    if (cached.directions.length === 0) {
      console.log("[creative-engine] Ignoring empty cached directions");
      return null;
    }

    console.log(`[creative-engine] Loaded ${cached.directions.length} cached directions (${Math.round(age / 60000)}min old, ${cached.modelId})`);
    return cached;
  } catch (err) {
    console.error("[creative-engine] Cache load error:", err);
    return null;
  }
}

/**
 * Save directions to disk cache.
 */
export async function saveCachedDirections(directions: CreativeDirection[], corpusSize: number, clusterCount: number, modelId: string): Promise<void> {
  try {
    const cache: CachedDirections = {
      directions,
      generatedAt: Date.now(),
      corpusSize,
      clusterCount,
      modelId,
    };
    
    await mkdir(DIRECTION_CACHE_FILE.substring(0, DIRECTION_CACHE_FILE.lastIndexOf("/")), { recursive: true });
    await writeFile(DIRECTION_CACHE_FILE, JSON.stringify(cache, null, 2));
    
    console.log(`[creative-engine] Cached ${directions.length} directions to disk (${modelId})`);
  } catch (err) {
    console.error("[creative-engine] Cache save error:", err);
  }
}

/**
 * Propose creative directions for autonomous generation.
 * Analyzes corpus state and suggests novel combinations.
 * Uses parallel execution for direction generation to reduce latency.
 */
export async function proposeDirections(
  clusters: PromptCluster[],
  corpus: ImageCorpusEntry[],
  options: {
    limit?: number;
    minNovelty?: number;
    useCache?: boolean;
    modelId?: string;
  } = {}
): Promise<CreativeDirection[]> {
  const limit = options.limit ?? 5;
  const minNovelty = options.minNovelty ?? 0.3;
  const useCache = options.useCache ?? true;
  const modelId = options.modelId ?? "qwen3.5:9b";

  // Try to load from cache first
  if (useCache) {
    const cached = await loadCachedDirections(corpus.length, clusters.length, modelId);
    if (cached) {
      console.log(`[creative-engine] Returning ${cached.directions.length} cached directions`);
      return cached.directions.slice(0, limit);
    }
  }

  console.log("[creative-engine] Generating fresh directions (parallel execution)");

  const gaps = analyzeGaps(clusters, corpus);

  // Run all direction types in parallel — use allSettled so one failure doesn't kill the rest
  const results = await Promise.allSettled([
    Promise.all(gaps.slice(0, 2).map(gap => createGapFilling(gap, clusters, corpus, modelId))),
    createCrossPollination(clusters, corpus, minNovelty, modelId),
    createDeepVariation(clusters, corpus, minNovelty, modelId),
    createContrast(clusters, corpus, minNovelty, modelId),
  ]);

  const gapDirections = results[0].status === "fulfilled" ? results[0].value : [];
  const remixDirections = results[1].status === "fulfilled" ? results[1].value : [];
  const deepenDirections = results[2].status === "fulfilled" ? results[2].value : [];
  const contrastDirections = results[3].status === "fulfilled" ? results[3].value : [];

  // Log any failures
  for (const [i, label] of ["gap-fill", "remix", "deepen", "contrast"].entries()) {
    if (results[i].status === "rejected") {
      console.error(`[creative-engine] ${label} generation failed:`, (results[i] as PromiseRejectedResult).reason?.message);
    }
  }

  const directions: CreativeDirection[] = [];
  directions.push(...gapDirections.filter(d => d.noveltyScore >= minNovelty));
  directions.push(...remixDirections.slice(0, 2));
  directions.push(...deepenDirections.slice(0, 1));
  directions.push(...contrastDirections.slice(0, 1));

  // Sort by novelty score and limit
  directions.sort((a, b) => b.noveltyScore - a.noveltyScore);

  const finalDirections = directions.slice(0, limit);

  // Only cache if we got results — don't cache empty sets
  if (finalDirections.length > 0) {
    await saveCachedDirections(finalDirections, corpus.length, clusters.length, modelId);
  }

  return finalDirections;
}

/**
 * Analyze underrepresented themes in the corpus.
 */
export function analyzeGaps(
  clusters: PromptCluster[],
  corpus: ImageCorpusEntry[]
): GapAnalysis[] {
  const themeCounts: Record<string, number> = {};

  for (const cluster of clusters) {
    for (const theme of cluster.dominantElements.themes) {
      themeCounts[theme] = (themeCounts[theme] || 0) + cluster.size;
    }
  }

  // Find themes with < 5 images
  const gaps: GapAnalysis[] = [];
  const commonThemes = ["sci-fi", "cyberpunk", "industrial", "fantasy", "noir", "ethereal", "mystical"];

  for (const theme of commonThemes) {
    const count = themeCounts[theme] || 0;
    if (count < 5) {
      gaps.push({
        theme,
        count,
        suggestion: `Generate ${count === 0 ? "first" : "more"} ${theme} images to diversify corpus`,
      });
    }
  }

  return gaps.sort((a, b) => a.count - b.count);
}

/**
 * Create a direction to fill a gap in the corpus.
 */
export async function createGapFilling(
  gap: GapAnalysis,
  clusters: PromptCluster[],
  corpus: ImageCorpusEntry[],
  modelId: string = "qwen3.5:9b"
): Promise<CreativeDirection> {
  // Find existing images with this theme to show the model what already exists
  const existingWithTheme = corpus.filter(
    e => e.elements?.themes?.some(t => t.toLowerCase().includes(gap.theme.toLowerCase()))
  ).slice(0, MAX_CONTEXT_MEMBERS);

  const promptContext = buildPromptContext(existingWithTheme);

  const systemPrompt = `You are generating a prompt for an image that explores the ${gap.theme} theme.
This theme is underrepresented in the corpus (${gap.count} images).
Create a detailed image prompt that captures the essence of ${gap.theme} while being visually distinct from the existing images shown below.
${promptContext}

${Z_IMAGE_INSTRUCTIONS}`;

  const userPrompt = `Generate a ${gap.theme} image prompt. Make it novel and distinct from the existing ${gap.theme} images. Follow the z-image workflow: lock core elements, inject professional aesthetics, handle text precisely, be objective and concrete.`;

  const userMsg = await buildContextMessage(userPrompt, existingWithTheme);

  const result = await streamChat(
    modelId,
    [userMsg],
    systemPrompt,
    () => {}
  );

  const proposedPrompt = result.content || `A ${gap.theme} scene with distinctive visual elements`;

  // Generate embedding for novelty scoring
  const embedding = await generateEmbedding(proposedPrompt);
  const noveltyScoreValue = embedding ? scoreNovelty(embedding, corpus) : 0.7;

  return {
    id: crypto.randomUUID(),
    type: "gap-fill",
    description: gap.suggestion,
    sourceClusters: [],
    elementCombination: {
      injectNovelty: gap.theme,
    },
    noveltyScore: noveltyScoreValue,
    proposedPrompt,
    proposedEmbedding: embedding ?? undefined,
    createdAt: Date.now(),
  };
}

/**
 * Create remix directions by combining elements from distant clusters.
 * Executes in parallel for multiple cluster pairs.
 */
export async function createCrossPollination(
  clusters: PromptCluster[],
  corpus: ImageCorpusEntry[],
  minNovelty: number,
  modelId: string = "qwen3.5:9b"
): Promise<CreativeDirection[]> {
  // Find distant cluster pairs (low centroid similarity)
  const distantPairs: Array<[PromptCluster, PromptCluster]> = [];

  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const sim = cosineSimilarity(clusters[i].centroid, clusters[j].centroid);
      if (sim < 0.7) {
        distantPairs.push([clusters[i], clusters[j]]);
      }
    }
  }

  // Sort by distance (most distant first) and take top 3
  distantPairs.sort(
    (a, b) =>
      cosineSimilarity(a[0].centroid, a[1].centroid) -
      cosineSimilarity(b[0].centroid, b[1].centroid)
  );

  // Generate directions in parallel
  const directionPromises = distantPairs.slice(0, 3).map(async ([clusterA, clusterB]) => {
    const themeA = clusterA.dominantElements.themes[0];
    const settingB = clusterB.dominantElements.settings[0];
    const styleB = clusterB.dominantElements.styles[0];

    // Gather representative members from both clusters
    const membersA = await getClusterMembers(clusterA, corpus, 3);
    const membersB = await getClusterMembers(clusterB, corpus, 3);
    const allMembers = [...membersA, ...membersB];
    const promptContextA = buildPromptContext(membersA);
    const promptContextB = buildPromptContext(membersB);

    const systemPrompt = `You are combining two distinct visual themes into a novel image prompt.
Theme A: ${themeA}
Setting/Style from B: ${settingB}, ${styleB}

Existing images from Theme A's cluster:${promptContextA}

Existing images from Setting/Style B's cluster:${promptContextB}

${Z_IMAGE_INSTRUCTIONS}

The combination should feel intentional, not random. Draw specific visual elements from the existing images above but recombine them in a fresh way.`;

    const userPrompt = `Generate a prompt combining ${themeA} themes with ${settingB} settings and ${styleB} styles. Reference the visual elements you see in the attached images. Follow the z-image workflow.`;

    const userMsg = await buildContextMessage(userPrompt, allMembers);

    const result = await streamChat(
      modelId,
      [userMsg],
      systemPrompt,
      () => {}
    );

    const proposedPrompt = result.content || `A ${themeA} scene in ${settingB} with ${styleB} styling`;
    const embedding = await generateEmbedding(proposedPrompt);
    const noveltyScore = embedding ? scoreNovelty(embedding, corpus) : 0.65;

    return {
      id: crypto.randomUUID(),
      type: "remix" as DirectionType,
      description: `Cross-pollinate ${clusterA.name} with ${clusterB.name}`,
      sourceClusters: [clusterA.id, clusterB.id],
      elementCombination: {
        takeThemesFrom: clusterA.id,
        takeSettingsFrom: clusterB.id,
        takeStylesFrom: clusterB.id,
      },
      noveltyScore,
      proposedPrompt,
      proposedEmbedding: embedding ?? undefined,
      createdAt: Date.now(),
    };
  });

  const directions = await Promise.all(directionPromises);
  return directions.filter(d => d.noveltyScore >= minNovelty);
}

/**
 * Create deep variations within a cluster (add complexity/detail).
 * Executes in parallel for multiple clusters.
 */
export async function createDeepVariation(
  clusters: PromptCluster[],
  corpus: ImageCorpusEntry[],
  minNovelty: number,
  modelId: string = "qwen3.5:9b"
): Promise<CreativeDirection[]> {
  // Pick large clusters (more than 5 members) for deep exploration
  const largeClusters = clusters.filter(c => c.size > 5).slice(0, 3);

  // Generate directions in parallel
  const directionPromises = largeClusters.map(async (cluster) => {
    const primaryTheme = cluster.dominantElements.themes[0];
    const primarySetting = cluster.dominantElements.settings[0];

    // Get representative members so the model can see what exists
    const members = await getClusterMembers(cluster, corpus);
    const promptContext = buildPromptContext(members);

    const systemPrompt = `You are adding intricate details to an existing visual theme.
Base theme: ${primaryTheme}
Base setting: ${primarySetting}

Here are the existing images in this cluster:${promptContext}

${Z_IMAGE_INSTRUCTIONS}

Study the existing images carefully. Make the new prompt more complex and layered while staying coherent with the cluster's visual identity. Add details that complement but don't duplicate what exists.`;

    const userPrompt = `Generate a detailed variation of ${primaryTheme} in ${primarySetting}. Look at the attached images and add intricate visual details that build on what's already there. Follow the z-image workflow.`;

    const userMsg = await buildContextMessage(userPrompt, members);

    const result = await streamChat(
      modelId,
      [userMsg],
      systemPrompt,
      () => {}
    );

    const proposedPrompt = result.content || `A detailed ${primaryTheme} scene in ${primarySetting} with intricate elements`;
    const embedding = await generateEmbedding(proposedPrompt);
    const noveltyScore = embedding ? scoreNovelty(embedding, corpus) : 0.55;

    return {
      id: crypto.randomUUID(),
      type: "deepen" as DirectionType,
      description: `Add intricate details to ${cluster.name}`,
      sourceClusters: [cluster.id],
      elementCombination: {
        takeThemesFrom: cluster.id,
        takeSettingsFrom: cluster.id,
        injectNovelty: "intricate details",
      },
      noveltyScore,
      proposedPrompt,
      proposedEmbedding: embedding ?? undefined,
      createdAt: Date.now(),
    };
  });

  const directions = await Promise.all(directionPromises);
  return directions.filter(d => d.noveltyScore >= minNovelty);
}

/**
 * Create contrast directions (deliberately oppose existing patterns).
 */
export async function createContrast(
  clusters: PromptCluster[],
  corpus: ImageCorpusEntry[],
  minNovelty: number,
  modelId: string = "qwen3.5:9b"
): Promise<CreativeDirection[]> {
  // Find dominant patterns
  const dominantThemes: Record<string, number> = {};
  const dominantMoods: Record<string, number> = {};

  for (const cluster of clusters) {
    for (const theme of cluster.dominantElements.themes) {
      dominantThemes[theme] = (dominantThemes[theme] || 0) + cluster.size;
    }
    for (const mood of (cluster.dominantElements as any).mood || []) {
      dominantMoods[mood] = (dominantMoods[mood] || 0) + 1;
    }
  }

  const topTheme = Object.entries(dominantThemes).sort((a, b) => b[1] - a[1])[0]?.[0];
  const topMood = Object.entries(dominantMoods).sort((a, b) => b[1] - a[1])[0]?.[0];

  if (!topTheme) return [];

  // Generate opposite
  const opposites: Record<string, string> = {
    "sci-fi": "organic natural",
    "cyberpunk": "pastoral rural",
    "industrial": "ethereal mystical",
    "noir": "vibrant colorful",
    "dark": "luminous bright",
    "cold": "warm fiery",
    "mechanical": "organic flowing",
  };

  const oppositeTheme = opposites[topTheme] || "contrasting visual style";
  const oppositeMood = topMood === "dark" ? "hopeful uplifting" : "somber mysterious";

  // Show the model examples of the dominant theme so it knows what to contrast against
  const dominantCluster = clusters.sort((a, b) => b.size - a.size)[0];
  const dominantMembers = dominantCluster ? await getClusterMembers(dominantCluster, corpus) : [];
  const promptContext = buildPromptContext(dominantMembers);

  const systemPrompt = `You are creating a prompt that deliberately contrasts with the dominant corpus patterns.
Dominant theme: ${topTheme}
Dominant mood: ${topMood}

Here are examples of the dominant style you should contrast against:${promptContext}

Your prompt should be the opposite: ${oppositeTheme} with ${oppositeMood} mood.

${Z_IMAGE_INSTRUCTIONS}

Study the attached images to understand the dominant visual language, then create something that deliberately inverts it. Make it visually striking and thematically coherent.`;

  const userPrompt = `Generate a ${oppositeTheme} prompt with ${oppositeMood} mood. Look at the attached images showing the dominant ${topTheme} style, then create a prompt that deliberately contrasts with it. Follow the z-image workflow.`;

  const userMsg = await buildContextMessage(userPrompt, dominantMembers);

  const result = await streamChat(
    modelId,
    [userMsg],
    systemPrompt,
    () => {}
  );

  const proposedPrompt = result.content || `A ${oppositeTheme} scene with ${oppositeMood} atmosphere`;
  const embedding = await generateEmbedding(proposedPrompt);
  const noveltyScore = embedding ? scoreNovelty(embedding, corpus) : 0.75;

  if (noveltyScore >= minNovelty) {
    return [{
      id: crypto.randomUUID(),
      type: "contrast",
      description: `Contrast dominant ${topTheme} with ${oppositeTheme}`,
      sourceClusters: [],
      elementCombination: {
        injectNovelty: `${oppositeTheme}, ${oppositeMood}`,
      },
      noveltyScore,
      proposedPrompt,
      proposedEmbedding: embedding ?? undefined,
      createdAt: Date.now(),
    }];
  }

  return [];
}

/**
 * Compute novelty score for a proposed embedding.
 * Returns 1.0 - maxSimilarity (higher = more novel).
 */
export function scoreNovelty(
  proposedEmbedding: number[],
  corpus: ImageCorpusEntry[]
): number {
  if (!proposedEmbedding || proposedEmbedding.length === 0) return 0.5;

  const validCorpus = corpus.filter(e => e.promptEmbedding && e.promptEmbedding.length > 0);
  if (validCorpus.length === 0) return 1.0;

  let maxSim = 0;
  for (const entry of validCorpus) {
    const sim = cosineSimilarity(proposedEmbedding, entry.promptEmbedding!);
    if (sim > maxSim) maxSim = sim;
  }

  return 1.0 - maxSim;
}

/**
 * Generate embedding for a prompt using the shared embeddings service.
 * Uses CPU-only inference with immediate unload to keep GPUs free.
 */
async function generateEmbedding(prompt: string): Promise<number[] | null> {
  try {
    const { embed } = await import("./embeddings.js");
    return await embed(prompt);
  } catch (err) {
    console.error("[creative-engine] embedding error:", err);
    return null;
  }
}

/**
 * Execute a creative direction by generating an image.
 * This is a placeholder for future implementation - full ComfyUI integration
 * requires generation state management which is handled by routes/images.ts.
 */
export async function executeDirection(
  direction: CreativeDirection,
  onProgress?: (status: string) => void
): Promise<{ success: boolean; imageId?: string; error?: string }> {
  onProgress?.(`Generating: ${direction.description}`);
  
  // For now, return success with a note that full execution requires
  // integration with the image generation queue system
  console.log("[creative-engine] direction execution requested:", direction.type, direction.description);
  
  return {
    success: true,
    imageId: "pending-queue-integration",
    error: undefined,
  };
}
