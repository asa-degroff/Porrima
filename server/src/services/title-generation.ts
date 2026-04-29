import type { ChatMessage } from "../types.js";
import { getSettings } from "./chat-storage.js";

const DEFAULT_URL = "http://localhost:8085";
const DEFAULT_MODEL = "qwen3.5-0.8b";

interface ServerConfig {
  baseUrl: string;
  model: string;
}

async function getServerConfig(): Promise<ServerConfig | null> {
  const settings = await getSettings();
  if (settings.titleGenerationEnabled === false) return null;
  return {
    baseUrl: (settings.titleGenerationUrl?.trim() || DEFAULT_URL).replace(/\/+$/, ""),
    model: settings.titleGenerationModelId?.trim() || DEFAULT_MODEL,
  };
}

function postProcess(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let title = raw.trim().replace(/^["']|["']$/g, "").trim().replace(/\.$/, "").trim();
  if (!title) return null;
  if (title.length > 60) title = title.slice(0, 57) + "...";
  return title;
}

async function callServer(
  config: ServerConfig,
  systemContent: string,
  userContent: string,
  label: string
): Promise<string | null> {
  try {
    const res = await fetch(`${config.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
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
      console.warn(`[title] ${label} failed: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    console.warn(`[title] ${label} failed:`, err);
    return null;
  }
}

/**
 * Generate a short chat title using the dedicated title-generation llama.cpp server.
 * Returns null on any error (server down, model not loaded, disabled in settings).
 */
export async function generateTitle(
  userMessage: string,
  assistantResponse: string
): Promise<string | null> {
  const config = await getServerConfig();
  if (!config) return null;

  const truncatedUser = userMessage.slice(0, 300);
  const truncatedResponse = assistantResponse.slice(0, 500);

  const systemContent =
    "Generate a short title (3-8 words) summarizing this conversation. " +
    "Reply with ONLY the title text. No quotes, no trailing punctuation, no explanation.";
  const userContent = `User: ${truncatedUser}\n\nAssistant: ${truncatedResponse}`;

  const title = postProcess(await callServer(config, systemContent, userContent, "generation"));
  if (title) console.log(`[title] generated: "${title}"`);
  return title;
}

/** Minimum assistant content length (characters) to trigger recap generation */
export const RECAP_THRESHOLD = 1500;

/**
 * Generate a brief recap of what was done in a single assistant message.
 * Feeds the tail of the message content to capture conclusion/outcome.
 * Returns null on any error.
 */
export async function generateRecap(assistantContent: string): Promise<string | null> {
  const config = await getServerConfig();
  if (!config) return null;

  // Feed the last ~1500 characters — captures the conclusion and concrete outcome
  const tailContent = assistantContent.slice(-1500);

  const systemContent =
    "Write a brief, one-line objective summary (15-40 words) of what was done in this message. " +
    "Focus on concrete actions and outcomes. Write from an impersonal, immersive perspective, just the message content. " +
    "Reply with ONLY the summary text. No quotes, no prefix, no explanation.";

  const raw = await callServer(config, systemContent, tailContent, "recap generation");
  const recap = postProcessRecap(raw);
  if (recap) console.log(`[recap] generated: "${recap}"`);
  return recap;
}

function postProcessRecap(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let text = raw.trim().replace(/^["']|["']$/g, "").trim();
  if (!text) return null;
  // For recaps, allow longer than titles but cap to prevent runaways
  if (text.length > 400) text = text.slice(0, 397) + "...";
  return text;
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

  const config = await getServerConfig();
  if (!config) return null;

  const recentMessages = messages.slice(-10);
  const parts: string[] = [];
  for (const m of recentMessages) {
    const role = m.role === "user" ? "User" : "Assistant";
    parts.push(`${role}: ${m.content.slice(0, 200)}`);
  }
  const context = parts.join("\n\n");

  const systemContent =
    "Generate a short title (3-8 words) summarizing this conversation. " +
    "Reply with ONLY the title text. No quotes, no trailing punctuation, no explanation. " +
    "Focus on the current topic being discussed.";

  const title = postProcess(
    await callServer(config, systemContent, `Recent conversation:\n${context}`, "regeneration")
  );
  if (title) console.log(`[title] regenerated: "${title}"`);
  return title;
}

/**
 * Generate a sidebar title for the system chat after a synthesis or wake cycle.
 * Unlike normal chat title generation, this focuses on the assistant's latest
 * cycle output rather than the synthetic trigger message, which can be a large
 * context package with generic headings.
 */
export async function generateSystemCycleTitle(
  cycleKind: "synthesis" | "wake",
  assistantResponse: string
): Promise<string | null> {
  const config = await getServerConfig();
  if (!config) return null;

  const cycleLabel = cycleKind === "wake" ? "wake cycle" : "system synthesis";
  const truncatedResponse = assistantResponse.slice(0, 1200);

  const systemContent =
    `Generate a short sidebar title (3-8 words) for the latest ${cycleLabel}. ` +
    "Focus on the concrete topic, outcome, or theme. " +
    "Avoid generic titles like 'Daily Synthesis' or 'Wake Cycle' unless there is no better subject. " +
    "Reply with ONLY the title text. No quotes, no trailing punctuation, no explanation.";
  const userContent = `Latest ${cycleLabel} output:\n\n${truncatedResponse}`;

  const title = postProcess(
    await callServer(config, systemContent, userContent, `system ${cycleKind} title generation`)
  );
  if (title) console.log(`[title] system ${cycleKind}: "${title}"`);
  return title;
}
