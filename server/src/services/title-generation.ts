import type { ChatMessage } from "../types.js";
import { discoverAllModels } from "./models.js";
import { getSettings } from "./chat-storage.js";
import { getOllamaUrl } from "./ollama-url.js";

const LLAMACPP_DEFAULT_URL = "http://localhost:8080";
const VLLM_DEFAULT_URL = "http://localhost:8095";
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
    let provider: "ollama" | "llamacpp" | "vllm" = "ollama";
    try {
      const models = await discoverAllModels();
      const found = models.find((m) => m.id === TITLE_MODEL);
      if (found?.provider === "llamacpp" || found?.provider === "vllm") provider = found.provider;
    } catch { /* fall through to default provider */ }

    let title: string | null = null;

    if (provider === "llamacpp" || provider === "vllm") {
      const settings = await getSettings();
      const baseUrl = provider === "vllm"
        ? settings.vllmUrl || VLLM_DEFAULT_URL
        : settings.llamacppUrl || LLAMACPP_DEFAULT_URL;
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
        console.warn(`[title] ${provider} generation failed: HTTP ${res.status}`);
        return null;
      }
      const data = await res.json();
      title = data.choices?.[0]?.message?.content?.trim() ?? null;
    } else {
      const settings = await getSettings();
      const ollamaBase = getOllamaUrl(settings);
      const res = await fetch(`${ollamaBase}/api/chat`, {
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
          keep_alive: "0s",
          options: { num_predict: 30, temperature: 0.3, num_gpu: 0 },
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

/**
 * Regenerate a chat title based on recent messages.
 * Used during compaction to keep titles up-to-date with long-running conversations.
 * Analyzes the last 10 messages (or fewer if chat is shorter) to capture the current topic.
 */
export async function regenerateTitle(
  messages: ChatMessage[]
): Promise<string | null> {
  if (messages.length === 0) return null;

  try {
    // Get the last 10 messages (or all if fewer)
    const recentMessages = messages.slice(-10);
    
    // Build context from recent messages
    const parts: string[] = [];
    for (const m of recentMessages) {
      const role = m.role === "user" ? "User" : "Assistant";
      const content = m.content.slice(0, 200);
      parts.push(`${role}: ${content}`);
    }
    const context = parts.join("\n\n");

    const systemContent =
      "Generate a short title (3-8 words) summarizing this conversation. " +
      "Reply with ONLY the title text. No quotes, no trailing punctuation, no explanation. " +
      "Focus on the current topic being discussed.";

    // Check which provider has the title model
    let provider: "ollama" | "llamacpp" | "vllm" = "ollama";
    try {
      const models = await discoverAllModels();
      const found = models.find((m) => m.id === TITLE_MODEL);
      if (found?.provider === "llamacpp" || found?.provider === "vllm") provider = found.provider;
    } catch { /* fall through to default provider */ }

    let title: string | null = null;

    if (provider === "llamacpp" || provider === "vllm") {
      const settings = await getSettings();
      const baseUrl = provider === "vllm"
        ? settings.vllmUrl || VLLM_DEFAULT_URL
        : settings.llamacppUrl || LLAMACPP_DEFAULT_URL;
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: TITLE_MODEL,
          messages: [
            { role: "system", content: systemContent },
            { role: "user", content: `Recent conversation:\n${context}` },
          ],
          stream: false,
          max_tokens: 30,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        console.warn(`[title] ${provider} regeneration failed: HTTP ${res.status}`);
        return null;
      }
      const data = await res.json();
      title = data.choices?.[0]?.message?.content?.trim() ?? null;
    } else {
      const settings = await getSettings();
      const ollamaBase = getOllamaUrl(settings);
      const res = await fetch(`${ollamaBase}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: TITLE_MODEL,
          messages: [
            { role: "system", content: systemContent },
            { role: "user", content: `Recent conversation:\n${context}` },
          ],
          stream: false,
          think: false,
          keep_alive: "0s",
          options: { num_predict: 30, temperature: 0.3, num_gpu: 0 },
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        console.warn(`[title] Ollama regeneration failed: HTTP ${res.status}`);
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

    console.log(`[title] regenerated: "${title}"`);
    return title;
  } catch (err) {
    console.warn("[title] regeneration failed:", err);
    return null;
  }
}
