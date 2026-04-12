import { streamChat } from "./agent.js";

export interface ExtractedElements {
  [elementType: string]: string[];
}

const ELEMENT_EXTRACTION_PROMPT = `You are an element extraction specialist for visual imagery. Your task is to analyze image descriptions and extract structured elements that can be mixed and matched for creative generation.

Extract elements into these categories (only include categories that have content):
- **themes**: Overarching aesthetic or conceptual themes (e.g., "cyberpunk", "noir", "ethereal", "post-apocalyptic")
- **characters**: Specific figures or entities (e.g., "woman with red hair", "cyborg soldier", "elderly wizard")
- **settings**: Locations and environments (e.g., "neon-lit street", "rainy alley", "crystal cave")
- **concepts**: Abstract ideas or subject matter (e.g., "dystopia", "transhumanism", "solitude")
- **styles**: Visual treatment and technique (e.g., "cinematic lighting", "high contrast", "painterly brushwork")
- **colors**: Dominant color palettes (e.g., "neon blue and magenta", "earth tones", "monochrome")
- **composition**: Framing and spatial arrangement (e.g., "close-up portrait", "wide establishing shot", "dutch angle")
- **lighting**: Light quality and direction (e.g., "rim lighting", "soft diffused", "harsh shadows")
- **textures**: Surface qualities (e.g., "glossy wet surfaces", "rough stone", "metallic sheen")
- **mood**: Emotional atmosphere (e.g., "melancholic", "tense", "serene")

Be specific and concrete. "Woman in red dress" is better than "person". "Neon-lit rainy street at night" is better than "urban setting".

Return ONLY a valid JSON object with element types as keys and arrays of strings as values. No preamble, no explanation.

Example output:
{
  "themes": ["cyberpunk", "neo-noir"],
  "characters": ["woman with silver hair", "street vendor"],
  "settings": ["rainy alley at night", "neon signs"],
  "concepts": ["dystopia", "surveillance"],
  "styles": ["cinematic", "high contrast"],
  "colors": ["neon blue", "magenta", "dark shadows"],
  "composition": ["medium shot", "shallow depth of field"],
  "lighting": ["neon glow", "rim lighting", "wet reflections"],
  "textures": ["wet pavement", "glossy surfaces"],
  "mood": ["melancholic", "mysterious"]
}`;

export async function extractElements(
  description: string,
  prompt?: string,
  modelId?: string
): Promise<ExtractedElements> {
  // For generated images without description, use prompt as description
  const input = prompt && !description
    ? `Image prompt (z-image format): ${prompt}`
    : prompt
    ? `Image prompt: ${prompt}\n\nImage description: ${description}`
    : `Image description: ${description}`;

  try {
    const resolvedModelId = process.env.ELEMENT_EXTRACTION_MODEL || modelId;
    if (!resolvedModelId) {
      console.error("[element-extraction] no model ID provided and ELEMENT_EXTRACTION_MODEL env var not set");
      return {};
    }
    let responseText = "";
    
    await streamChat(
      resolvedModelId!,
      [{ role: "user" as const, content: input, timestamp: Date.now() }],
      ELEMENT_EXTRACTION_PROMPT,
      (event) => {
        if (event.type === "text_delta") {
          responseText += event.delta;
        }
      }
    );
    
    // Parse JSON from response
    const jsonStart = responseText.indexOf("{");
    const jsonEnd = responseText.lastIndexOf("}");
    
    if (jsonStart === -1 || jsonEnd === -1) {
      console.warn("[element-extraction] no JSON found in response");
      return {};
    }
    
    const jsonStr = responseText.substring(jsonStart, jsonEnd + 1);
    const parsed = JSON.parse(jsonStr);
    
    // Validate structure: all values must be string arrays
    const validated: ExtractedElements = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value) && value.every(v => typeof v === "string")) {
        validated[key] = value;
      }
    }
    
    return validated;
  } catch (err) {
    console.error("[element-extraction] extraction failed:", err);
    return {};
  }
}

export async function extractElementsBatch(
  items: Array<{ description: string; prompt?: string }>,
  modelId?: string
): Promise<ExtractedElements[]> {
  const results: ExtractedElements[] = [];
  
  for (const item of items) {
    const elements = await extractElements(item.description, item.prompt, modelId);
    results.push(elements);
  }
  
  return results;
}

// Re-extract elements for an existing entry if description changes
export async function reExtractElements(
  description: string,
  prompt?: string,
  modelId?: string
): Promise<ExtractedElements> {
  return extractElements(description, prompt, modelId);
}
