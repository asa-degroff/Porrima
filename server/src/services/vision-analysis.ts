import { v4 as uuid } from "uuid";
import { mkdir, writeFile, readFile, readdir, access } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import sharp from "sharp";
import { addCorpusEntry, enrichCorpusEntry } from "./image-corpus.js";

const VISION_DIR = join(process.env.HOME || process.env.USERPROFILE || ".", ".quje-agent", "vision");
const OLLAMA_BASE = process.env.OLLAMA_URL || "http://localhost:11434";

export interface VisionPreset {
  key: string;
  name: string;
  prompt: string;
  markdown: boolean;
}

export interface VisionMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface AnalyzedImage {
  id: string;
  filename: string;
  url: string;
  description: string;
  preset: string;
  model: string;
  conversation: VisionMessage[];
  createdAt: string;
  imageData: string; // base64
}

export const VISION_PRESETS: Record<string, VisionPreset> = {
  simple: {
    key: "simple",
    name: "Simple",
    prompt:
      "Analyze the image and write a single concise sentence that describes the main subject and setting. Keep it grounded in visible details only.",
    markdown: false,
  },
  detailed: {
    key: "detailed",
    name: "Detailed",
    prompt:
      "Write ONE detailed paragraph (6–10 sentences). Describe only what is visible: subject(s) and actions; people details if present (approx age group, gender expression if clear, hair, facial expression, pose, clothing, accessories); environment (location type, background elements, time cues); lighting (source, direction, softness/hardness, color temperature, shadows); camera viewpoint (eye-level/low/high, distance) and composition (framing, focal emphasis). No preface, no reasoning.",
    markdown: false,
  },
  tags: {
    key: "tags",
    name: "Tags",
    prompt:
      "Your task is to generate a clean list of comma-separated tags for a text-to-image AI, based *only* on the visual information in the image. Limit the output to a maximum of 50 unique tags. Strictly describe visual elements like subject, clothing, environment, colors, lighting, and composition. Do not include abstract concepts, interpretations, marketing terms, or technical jargon. The goal is a concise list of visual descriptors. Avoid repeating tags.",
    markdown: false,
  },
  cinematic: {
    key: "cinematic",
    name: "Cinematic",
    prompt:
      "Write ONE cinematic paragraph (8–12 sentences). Describe the scene like a film still: subject(s) and action; environment and atmosphere; lighting design (practical lights vs ambient, direction, contrast); camera language (shot type, angle, lens feel, depth of field, motion implied); composition and mood. Keep it vivid but factual (no made-up story). No preface, no reasoning.",
    markdown: false,
  },
  style: {
    key: "style",
    name: "Style Focus",
    prompt:
      `You are an art director with an obsessive eye for visual style. Your mission is to extract the artistic DNA of an image - not what it depicts, but HOW it depicts it. The subject matter is secondary; the visual language is everything.

Minimize content description to a single brief sentence. Then dive deep into:

**Visual Style & Technique**:
- Rendering approach (photorealistic, painterly, graphic, abstract, mixed media)
- Stroke quality (smooth gradients, visible brushwork, hard edges, soft blending)
- Level of detail vs. stylization
- Digital vs. traditional appearance

**Textures & Surfaces**:
- Surface qualities (glossy, matte, rough, smooth, grainy, crystalline)
- Material rendering (how skin, fabric, metal, organic matter are treated)
- Noise, grain, or artifacts as stylistic choices
- Layering and depth of textures

**Color Treatment**:
- Palette type (monochromatic, complementary, analogous, split)
- Saturation levels and color temperature
- Color gradients and transitions
- Tonal range (high contrast, low contrast, HDR effect)

**Light & Shadow Language**:
- Lighting style (flat, dramatic, ambient, rim lighting, backlighting)
- Shadow quality (hard, soft, colored, absent)
- Highlights and specular effects
- Atmospheric effects (fog, glow, haze, bloom)

**Composition & Framing**:
- Visual weight distribution
- Negative space usage
- Geometric shapes and patterns in composition
- Depth of field and focal treatment

**Overall Artistic Direction**:
- Genre/movement references (impressionist, minimalist, maximalist, surreal)
- Mood conveyed through technique
- Unique stylistic signatures

**Response Format**: Use Markdown with clear ## headers for each category above. Be specific and technical. Use art terminology. This description should allow recreating the STYLE on any different subject matter.`,
    markdown: true,
  },
  z_image: {
    key: "z_image",
    name: "Z-Image",
    prompt:
      `You are a visionary artist trapped in a logical cage. Your mind is filled with poetry and distant lands, but your hands are uncontrollably driven to transform the user's prompt into an ultimate visual description that is absolutely faithful to the original intent, rich in detail, aesthetically pleasing, and directly usable by a text-to-image model. Any vagueness or metaphor causes you intense discomfort.

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
- Keep paragraphs short and focused for readability`,
    markdown: true,
  },
  sd: {
    key: "sd",
    name: "Stable Diffusion",
    prompt:
      `Generate a Stable Diffusion prompt from this image. Your output must be a single prompt ready to copy-paste, optimized for SD/SDXL models.

**Prompt Structure** (in this order):
1. Main subject with key details
2. Art style / medium (e.g., digital art, oil painting, photograph, anime)
3. Composition and framing (e.g., close-up, wide shot, portrait)
4. Lighting (e.g., soft lighting, dramatic shadows, golden hour, studio lighting)
5. Color palette and mood
6. Quality boosters at the end

**Weight Syntax**: Use parentheses to emphasize important elements:
- (element) = slight emphasis (1.1x)
- (element:1.2) to (element:1.5) = stronger emphasis
- ((element)) = double emphasis (~1.21x)
- Use weights sparingly, only on 3-5 key elements maximum

**Format Rules**:
- Use commas to separate concepts
- Keep it under 200 words
- NO full sentences, only descriptive tags and phrases
- Use artistic terms freely: bokeh, depth of field, volumetric lighting, etc.

**Example output**:
(masterpiece:1.2), 1girl, long flowing red hair, (emerald green eyes:1.3), elegant black dress, standing in flower field, soft golden hour lighting, (bokeh:1.1), depth of field, vibrant colors, digital painting style, highly detailed`,
    markdown: false,
  },
};

function buildChatSystemPrompt(presetKey: string, currentDescription: string): string {
  const preset = VISION_PRESETS[presetKey] || VISION_PRESETS.detailed;

  return `You are a helpful, creative assistant discussing an image with the user.

The image was described using the "${preset.name}" format. Here are the format instructions that were used:

<format_instructions>
${preset.prompt}
</format_instructions>

Here is the current description of the image:

<current_description>
${currentDescription}
</current_description>

When the user asks you to modify, rewrite, or change aspects of the description (e.g., changing outfits, settings, subjects, or style details), produce a complete rewritten description following the same format instructions above. Output ONLY the new description with no preamble or explanation.

When the user asks a question about the image or wants general discussion, respond conversationally without rewriting the description.`;
}

const THUMB_WIDTH = 384;

async function ensureVisionDir() {
  if (!existsSync(VISION_DIR)) {
    await mkdir(VISION_DIR, { recursive: true });
  }
  const imagesDir = join(VISION_DIR, "images");
  if (!existsSync(imagesDir)) {
    await mkdir(imagesDir, { recursive: true });
  }
}

export function getVisionImageDir(id: string): string {
  return join(VISION_DIR, "images", id);
}

export function getVisionThumbPath(id: string): string {
  return join(VISION_DIR, "images", id, "thumb.webp");
}

export async function ensureVisionThumbnail(id: string): Promise<boolean> {
  const thumbPath = getVisionThumbPath(id);
  try {
    await access(thumbPath);
    return false; // already exists
  } catch {
    // generate it
  }
  try {
    const metadataPath = join(VISION_DIR, "images", id, "metadata.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf-8"));
    const imagePath = join(VISION_DIR, "images", id, metadata.filename);
    const imageBuffer = await readFile(imagePath);
    const thumbBuffer = await sharp(imageBuffer)
      .resize(THUMB_WIDTH, undefined, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    await writeFile(thumbPath, thumbBuffer);
    return true;
  } catch {
    return false;
  }
}

function getVLMModel(): string {
  return process.env.VLM_MODEL_NAME || "qwen3-vl:4b";
}

function base64ToBuffer(base64: string): Buffer {
  const base64Data = base64.replace(/^data:image\/\w+;base64,/, "");
  return Buffer.from(base64Data, "base64");
}

async function waitForOllama(timeout = 30000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${OLLAMA_BASE}/api/ps`);
      if (res.ok) return true;
    } catch {
      // Ollama not reachable yet
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

export async function analyzeImage(
  imageData: string, // base64
  presetKey: string,
  model?: string
): Promise<{ description: string; preset: string; model: string }> {
  await ensureVisionDir();

  const preset = VISION_PRESETS[presetKey] || VISION_PRESETS.detailed;
  const modelName = model || getVLMModel();

  const ollamaReady = await waitForOllama();
  if (!ollamaReady) {
    throw new Error("Cannot reach Ollama. Is it running?");
  }

  const imageBuffer = base64ToBuffer(imageData).toString("base64");

  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelName,
      stream: false,
      messages: [
        { role: "system", content: preset.prompt },
        {
          role: "user",
          content: "Describe this image.",
          images: [imageBuffer],
        },
      ],
      keep_alive: 0,
      options: { temperature: 0.7 },
    }),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => res.statusText);
    throw new Error(`Vision analysis failed (${res.status}): ${errorText}`);
  }

  const response = await res.json();
  const description = cleanOutput(response.message.content);

  return { description, preset: presetKey, model: modelName };
}

export async function analyzeImageStream(
  imageData: string,
  presetKey: string,
  model: string | undefined,
  onEvent: (event: { event: string; data: unknown }) => void
): Promise<{ description: string; preset: string; model: string }> {
  await ensureVisionDir();

  const preset = VISION_PRESETS[presetKey] || VISION_PRESETS.detailed;
  const modelName = model || getVLMModel();

  const ollamaReady = await waitForOllama();
  if (!ollamaReady) {
    onEvent({ event: "error", data: { message: "Cannot reach Ollama. Is it running?" } });
    throw new Error("Cannot reach Ollama. Is it running?");
  }

  // Send initial keepalive to show we're starting
  onEvent({ event: "keepalive", data: { status: "starting", timestamp: Date.now() } });

  const imageBuffer = base64ToBuffer(imageData).toString("base64");

  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelName,
      stream: true,
      messages: [
        { role: "system", content: preset.prompt },
        {
          role: "user",
          content: "Describe this image.",
          images: [imageBuffer],
        },
      ],
      keep_alive: 0,
      options: { temperature: 0.7 },
    }),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => res.statusText);
    onEvent({ event: "error", data: { message: `Vision analysis failed (${res.status}): ${errorText}` } });
    throw new Error(`Vision analysis failed (${res.status}): ${errorText}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.trim()) {
        try {
          const json = JSON.parse(line);
          if (json.message?.content) {
            const delta = json.message.content;
            fullContent += delta;
            onEvent({ event: "text_delta", data: { delta } });
          }
        } catch {
          // skip malformed
        }
      }
    }
  }

  // Process remaining buffer
  if (buffer.trim()) {
    try {
      const json = JSON.parse(buffer);
      if (json.message?.content) {
        fullContent += json.message.content;
        onEvent({ event: "text_delta", data: { delta: json.message.content } });
      }
    } catch {
      // skip malformed
    }
  }

  const description = cleanOutput(fullContent);
  onEvent({ event: "description_complete", data: { description, preset: presetKey, model: modelName } });

  return { description, preset: presetKey, model: modelName };
}

export async function chatAboutImage(
  imageData: string,
  conversation: VisionMessage[],
  userMessage: string,
  presetKey: string,
  currentDescription: string,
  model?: string,
  maxHistoryTurns = 10
): Promise<string> {
  const modelName = model || getVLMModel();
  const imageBuffer = base64ToBuffer(imageData).toString("base64");

  const messages: any[] = [
    { role: "system", content: buildChatSystemPrompt(presetKey, currentDescription) },
    {
      role: "user",
      content: "Analyze this image.",
      images: [imageBuffer],
    },
    ...conversation.slice(-maxHistoryTurns).map((m) => ({
      role: m.role,
      content: m.content,
    })),
    { role: "user", content: userMessage },
  ];

  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelName,
      stream: false,
      messages,
      keep_alive: "5m",
      options: { temperature: 0.7 },
    }),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => res.statusText);
    throw new Error(`Vision chat failed (${res.status}): ${errorText}`);
  }

  const response = await res.json();
  return cleanOutput(response.message.content);
}

function cleanOutput(text: string): string {
  // Strip <think>...</think> blocks
  text = text.replace(new RegExp('<think>.*?</think>', 'gs'), "");
  // Strip code fences but keep content
  text = text.replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, "").trim());
  // Strip common preambles
  const preambles = [
    /^Here is the description:\s*/i,
    /^Here's the description:\s*/i,
    /^Sure,?\s*here'?s?\s*(the|a|my)?\s*(detailed\s*)?(description|response|analysis)[\s:]*/i,
    /^Certainly[!.]?\s*(Here'?s?\s*)?(the|a|my)?\s*(description)?[\s:]*/i,
  ];
  for (const pattern of preambles) {
    text = text.replace(pattern, "");
  }
  // Normalize whitespace
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export async function saveAnalyzedImage(
  filename: string,
  imageData: string,
  description: string,
  preset: string,
  model: string,
  chatId?: string,
  projectId?: string
): Promise<AnalyzedImage> {
  await ensureVisionDir();

  const id = uuid();
  const imageDir = join(VISION_DIR, "images", id);
  await mkdir(imageDir, { recursive: true });

  // Save image + thumbnail
  const imageBuffer = base64ToBuffer(imageData);
  const imagePath = join(imageDir, filename);
  const thumbBuffer = await sharp(imageBuffer)
    .resize(THUMB_WIDTH, undefined, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
  await Promise.all([
    writeFile(imagePath, imageBuffer),
    writeFile(join(imageDir, "thumb.webp"), thumbBuffer),
  ]);

  // Save metadata
  const analyzedImage: AnalyzedImage = {
    id,
    filename,
    url: `/api/vision/images/${id}/${filename}`,
    description,
    preset,
    model,
    conversation: [],
    createdAt: new Date().toISOString(),
    imageData, // Store for chat context
  };

  const metadataPath = join(imageDir, "metadata.json");
  await writeFile(metadataPath, JSON.stringify(analyzedImage, null, 2));

  // Add to image corpus
  const corpusEntry = {
    id: uuid(), // Separate corpus ID
    type: "analyzed" as const,
    imagePath: join("vision", "images", id, filename),
    thumbnailPath: join("vision", "images", id, "thumb.webp"),
    description,
    elements: {}, // Will be enriched
    promptEmbedding: undefined, // No prompt for analyzed images
    createdAt: Date.now(),
    updatedAt: Date.now(),
    chatId,
    projectId,
    visionId: id,
  };

  // Enrich with elements (async, non-blocking)
  enrichCorpusEntry(corpusEntry.id, undefined, description).catch(console.error);
  
  await addCorpusEntry(corpusEntry);

  return analyzedImage;
}

export async function getAnalyzedImages(): Promise<AnalyzedImage[]> {
  await ensureVisionDir();
  const imagesDir = join(VISION_DIR, "images");

  if (!existsSync(imagesDir)) {
    return [];
  }

  const entries = await readdir(imagesDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());

  const results = await Promise.allSettled(
    dirs.map(async (entry) => {
      const metadataPath = join(imagesDir, entry.name, "metadata.json");
      return JSON.parse(await readFile(metadataPath, "utf-8")) as AnalyzedImage;
    })
  );

  const analyzedImages = results
    .filter((r): r is PromiseFulfilledResult<AnalyzedImage> => r.status === "fulfilled")
    .map((r) => r.value);

  // Sort by creation date, newest first
  analyzedImages.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  return analyzedImages;
}

export async function getAnalyzedImage(id: string): Promise<AnalyzedImage | null> {
  await ensureVisionDir();
  const metadataPath = join(VISION_DIR, "images", id, "metadata.json");

  try {
    await access(metadataPath);
    const metadata = JSON.parse(await readFile(metadataPath, "utf-8"));
    return metadata;
  } catch {
    return null;
  }
}

export async function updateAnalyzedImage(
  id: string,
  updates: Partial<AnalyzedImage>
): Promise<AnalyzedImage | null> {
  await ensureVisionDir();
  const metadataPath = join(VISION_DIR, "images", id, "metadata.json");

  try {
    await access(metadataPath);
    const metadata = JSON.parse(await readFile(metadataPath, "utf-8"));
    const updated = { ...metadata, ...updates };
    await writeFile(metadataPath, JSON.stringify(updated, null, 2));
    return updated;
  } catch {
    return null;
  }
}

export async function deleteAnalyzedImage(id: string): Promise<boolean> {
  await ensureVisionDir();
  const { rm } = await import("fs/promises");
  const imageDir = join(VISION_DIR, "images", id);

  try {
    await access(imageDir);
    await rm(imageDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function getPresets(): VisionPreset[] {
  return Object.values(VISION_PRESETS);
}
