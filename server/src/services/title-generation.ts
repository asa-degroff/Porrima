const OLLAMA_BASE = "http://localhost:11434";
const TITLE_MODEL = "qwen3.5:0.8b";

/**
 * Generate a short chat title using a small LLM.
 * Uses Ollama's native API with thinking disabled for fast, direct output.
 * Falls back to null on any error (model not pulled, Ollama down, etc.).
 */
export async function generateTitle(
  userMessage: string,
  assistantResponse: string
): Promise<string | null> {
  try {
    const truncatedUser = userMessage.slice(0, 300);
    const truncatedResponse = assistantResponse.slice(0, 500);

    const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: TITLE_MODEL,
        messages: [
          {
            role: "system",
            content:
              "Generate a short title (3-8 words) summarizing this conversation. " +
              "Reply with ONLY the title text. No quotes, no trailing punctuation, no explanation.",
          },
          {
            role: "user",
            content: `User: ${truncatedUser}\n\nAssistant: ${truncatedResponse}`,
          },
        ],
        stream: false,
        think: false,
        options: { num_predict: 30, temperature: 0.3 },
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.warn(`[title] generation failed: HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    let title: string = data.message?.content?.trim() ?? "";

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
