import type { ChatMessage } from "../types.js";
import { getSettings } from "./chat-storage.js";
import { ensureRouterModelLoaded, normalizeRouterModelId } from "./llama-router-client.js";
import { getDefaultLlamaServerUrl } from "./llama-ports.js";

const DEFAULT_URL = getDefaultLlamaServerUrl("title-generation");
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
    model: normalizeRouterModelId(settings.titleGenerationModelId?.trim() || DEFAULT_MODEL),
  };
}

function postProcess(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let title = raw.trim().replace(/^["']|["']$/g, "").trim().replace(/\.$/, "").trim();
  if (!title) return null;
  // Reject prompt artifacts — the small model can echo role prefixes from the prompt.
  if (/^(User|Assistant)\s*:?\s*$/i.test(title)) return null;
  // Reject missing-input complaints. When the conversation fed to the model is
  // blank (e.g. a tool-loop window with no visible text), the small model does
  // the sensible thing and says so. That is never a real title — discard it so
  // the existing chat title survives instead of being overwritten.
  if (/^(no|empty|missing)\b.{0,24}\b(conversa|input|content|context|prompt|message|provided)\b/i.test(title)) return null;
  if (title.length > 60) title = title.slice(0, 57) + "...";
  return title;
}

/**
 * The user-facing text of a message, for summarization. Tool-loop assistant
 * rows persist `content: ""` — their visible prose lives in `text` segments,
 * and pure tool-call iterations have no prose at all (only `thinking`). Fall
 * back through those so a title prompt never gets an empty line. Mirrors the
 * segment→content precedence used by `visibleAssistantContent` in agent.ts.
 */
function visibleTextForMessage(message: ChatMessage): string {
  const content = (message.content ?? "").trim();
  if (content) return content;
  const fromSegments = (message.segments ?? [])
    .filter((s) => s.type === "text" && s.content)
    .map((s) => s.content)
    .join("")
    .trim();
  if (fromSegments) return fromSegments;
  return (message.thinking ?? "").trim();
}

async function callServer(
  config: ServerConfig,
  systemContent: string,
  userContent: string,
  label: string,
  maxTokens: number = 30
): Promise<string | null> {
  // If the slot is in router mode (--models-dir), preflight /models/load so
  // the requested model is the active one. In single-model mode this returns
  // "not-router" (404) and we fall through to the chat completion as before.
  await ensureRouterModelLoaded(config.baseUrl, config.model);
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
        max_tokens: maxTokens,
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

  const truncatedUser = userMessage.trim().slice(0, 300);
  const truncatedResponse = assistantResponse.trim().slice(0, 500);

  // Don't ask the model to title a conversation that has nothing in it — it
  // will only complain about missing input. A blank first-exchange assistant
  // response (e.g. a pure tool-loop turn) still has the user message, so this
  // only trips when both sides are empty.
  if (!truncatedUser && !truncatedResponse) return null;

  const systemContent =
    "Generate a short title (2-5 words) summarizing this conversation. " +
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
    "Write a brief, one-line summary (15-40 words) of this message. The summary provides context to users who are scanning the conversation. " +
    "The FIRST word of the summary MUST be a verb in the past tense. Write from an impersonal perspective, do not include attribution, just the message content. Always use active voice. " +
    "Reply with ONLY the summary text. No quotes, no prefix, no explanation."; 

  const raw = await callServer(config, systemContent, tailContent, "recap generation", 80);
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

  // Walk the tail collecting messages that carry visible text (up to 10).
  // A fixed last-10 slice is unsafe: during a long tool run the recent rows
  // are `_toolLoopFragment` assistant turns with empty `content`, so a naive
  // slice hands the title model a blank prompt and it replies "No conversation
  // provided". Skipping blanks and expanding backward past them keeps the real
  // recent topic — including the last user message — in the window.
  const parts: string[] = [];
  for (let i = messages.length - 1; i >= 0 && parts.length < 10; i--) {
    const m = messages[i];
    if (m._outOfContext) continue;
    // System rows are memory/context deltas, not conversation content.
    if (m.role === "system") continue;
    const text = visibleTextForMessage(m);
    if (!text) continue;
    const role = m.role === "user" ? "User" : "Assistant";
    parts.unshift(`${role}: ${text.slice(0, 200)}`);
  }

  // Nothing visible to summarize — do not call the model with a blank prompt.
  if (parts.length === 0) return null;
  const context = parts.join("\n\n");

  const systemContent =
    "Generate a short title (2-5 words) summarizing this conversation. " +
    "Reply with ONLY the title text. No quotes, no trailing punctuation, no explanation. " +
    "Focus on the current topic being discussed. Avoid generic descriptions like 'Code Review', focus on the content.";

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
  cycleKind: "synthesis" | "wake" | "automation" | string,
  assistantResponse: string
): Promise<string | null> {
  const config = await getServerConfig();
  if (!config) return null;

  const cycleLabel =
    cycleKind === "wake"
      ? "wake cycle"
      : cycleKind === "synthesis"
        ? "system synthesis"
        : `${cycleKind} automation`;
  const truncatedResponse = assistantResponse.slice(0, 1200);

  const systemContent =
    `Generate a short title (2-5 words) for the latest ${cycleLabel}. ` +
    "Focus on the concrete topic, outcome, or theme. " +
    "Avoid generic titles like 'Daily Synthesis', 'Wake Cycle', or 'Code Review', or 'Type Checks' unless there is no better subject. Focus on the actual substantive content." +
    "Reply with ONLY the title text. No quotes, no trailing punctuation, no explanation.";
  const userContent = `Latest ${cycleLabel} output:\n\n${truncatedResponse}`;

  const title = postProcess(
    await callServer(config, systemContent, userContent, `system ${cycleKind} title generation`)
  );
  if (title) console.log(`[title] system ${cycleKind}: "${title}"`);
  return title;
}
