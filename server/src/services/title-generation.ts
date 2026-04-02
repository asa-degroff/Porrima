import { discoverAllModels } from "./models.js";
import { getSettings } from "./chat-storage.js";

const OLLAMA_BASE = "http://localhost:11434";
const LLAMACPP_DEFAULT_URL = "http://localhost:8080";
const TITLE_MODEL = "qwen3.5:0.8b";

/**
 * Generate a short chat title using a small LLM.
 * Tries Ollama first (native API), falls back to llama.cpp (OpenAI-compat) if available.
 * Falls back to null on any error (model not pulled, providers down, etc.).
 */
export async function generateTitle(
  userMessage: string,
  assistantResponse: string
): Promise<string | null> {
  try {
    const truncatedUser = userMessage.slice(0, 300);
    const truncatedResponse = assistantResponse.slice(0, 500);

    const systemContent =
      "Generate a short title (3-8 words) summarizing this conversation. " +
      "Reply with ONLY the title text. No quotes, no trailing punctuation, no explanation.";
    const userContent = `User: ${truncatedUser}\n\nAssistant: ${truncatedResponse}`;

    // Check which provider has the title model
    let provider: "ollama" | "llamacpp" = "ollama";
    try {
      const models = await discoverAllModels();
      const found = models.find((m) => m.id === TITLE_MODEL);
      if (found?.provider) provider = found.provider;
    } catch { /* fall through to default provider */ }

    let title: string | null = null;

    if (provider === "llamacpp") {
      const settings = await getSettings();
      const baseUrl = settings.llamacppUrl || LLAMACPP_DEFAULT_URL;
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: TITLE_MODEL,
          messages: [
            { role: "system", content: systemContent },
            { role: "user", content: userContent },
          ],
          stream: false,
          max_tokens: 30,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        console.warn(`[title] llama.cpp generation failed: HTTP ${res.status}`);
        return null;
      }
      const data = await res.json();
      title = data.choices?.[0]?.message?.content?.trim() ?? null;
    } else {
      const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: TITLE_MODEL,
          messages: [
            { role: "system", content: systemContent },
            { role: "user", content: userContent },
          ],
          stream: false,
          think: false,
          options: { num_predict: 30, temperature: 0.3 },
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        console.warn(`[title] Ollama generation failed: HTTP ${res.status}`);
        return null;
      }
      const data = await res.json();
      title = data.message?.content?.trim() ?? null;
    }

    if (!title) return null;

    // Remove surrounding quotes if present
    title = title.replace(/^["']|["']$/g, "").trim();
    // Remove trailing period
    title = title.replace(/\.$/, "").trim();

    if (!title) return null;

    // Truncate to reasonable length
    if (title.length > 60) {
      title = title.slice(0, 57) + "...";
    }

    console.log(`[title] generated: "${title}"`);
    return title;
  } catch (err) {
    console.warn("[title] generation failed:", err);
    return null;
  }
}
