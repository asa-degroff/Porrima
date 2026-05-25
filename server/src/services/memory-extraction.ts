import { v4 as uuid } from "uuid";
import { appendFile, mkdir } from "fs/promises";
import { join } from "path";
import { streamChat } from "./agent.js";
import { getSettings } from "./chat-storage.js";
import { embedBatch } from "./embeddings.js";
import { ensureRouterModelLoaded, normalizeRouterModelId } from "./llama-router-client.js";
import {
  addMemory,
  updateMemory,
  findSimilarMemoryCandidates,
  createSupersessionLink,
  getMemoriesByChatId,
  getMaxBlockChars,
} from "./memory-storage.js";
import { getChat, updateChatExtractionState } from "./chat-storage.js";
import { invalidateMemoriesCache } from "./memory-context.js";
import { startExtractionRun, type ExtractionSupersessionResolution } from "./memory-extraction-observability.js";
import { recordModelStats } from "./model-stats.js";
import type { LlamaTimings } from "./model-stats.js";
import type { ChatMessage, Memory, MemoryCategory, MemorySourceType, Chat } from "../types.js";
import { appDataPath } from "./paths.js";

const LOG_DIR = appDataPath("logs");

// ---------------------------------------------------------------------------
// Extraction server mutex
// ---------------------------------------------------------------------------
// The dedicated extraction server (llama.cpp, --parallel 1) can only process
// one request at a time. Without coordination, multiple callers (preCompaction
// Flush, scheduler delayed extraction, enrichment batch, compaction index
// generation, zeitgeist synthesis) queue HTTP requests concurrently. Each
// pending request holds its full request body in Node.js memory while waiting,
// and the server's single slot means all but one are blocked anyway. Under
// heavy compaction cycles this piles up enough resident memory to OOM.
//
// This mutex serializes all extraction server access so at most one request
// is in flight. Callers that don't need the extraction server (fallback to
// main model via streamChat) bypass the mutex automatically.
// ---------------------------------------------------------------------------

let _extractionMutexQueue: Promise<void> = Promise.resolve();

/**
 * Serialize a callback through the extraction server mutex.
 * If the extraction server is busy, the caller awaits until the previous
 * call completes before starting. This prevents memory pile-up from
 * concurrent queued HTTP requests.
 */
export function withExtractionMutex<T>(fn: () => Promise<T>): Promise<T> {
  let release: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const waiting = _extractionMutexQueue.then(() => fn());
  // Chain: next caller waits for this one to finish (success or failure)
  _extractionMutexQueue = waiting.then(() => {}, () => {});
  return waiting;
}

// ---------------------------------------------------------------------------
// Active-chat tracking for scheduler coordination
// ---------------------------------------------------------------------------
// When a chat is actively running (especially during compaction cycles),
// the scheduler should skip extraction for that chat to avoid redundant
// work and memory pressure. The chat route sets/clears this.
// ---------------------------------------------------------------------------

const _activeChats = new Set<string>();

export function markChatActive(chatId: string): void {
  _activeChats.add(chatId);
}

export function markChatInactive(chatId: string): void {
  _activeChats.delete(chatId);
}

export function isChatActive(chatId: string): boolean {
  return _activeChats.has(chatId);
}

export function hasActiveChats(): boolean {
  return _activeChats.size > 0;
}

/**
 * Conservative char→token estimate (3 chars/token). Overestimates token count
 * vs. the more common 4 chars/token, which is the safer direction when
 * budgeting against a hard context limit: we'd rather truncate slightly more
 * than blow the context window.
 */
function estimateTokensConservative(text: string): number {
  return Math.ceil(text.length / 3);
}

/**
 * Compute the char budget available for user content given a system prompt
 * and the extraction server's configured context window. Reserves space for
 * the max_tokens output, a safety margin, and any per-chunk overhead callers
 * pass in (e.g. overlap prefix + prior-facts block when running chunked).
 *
 * Returns `maxInputChars` for the user content. May be very small if the
 * system prompt is unusually large — callers should warn when that happens.
 */
export function computeExtractionInputBudget(
  systemPrompt: string,
  ctxSize: number,
  opts?: { chunkOverheadChars?: number },
): { maxInputChars: number; sysPromptTokens: number; inputBudgetTokens: number } {
  const sysPromptTokens = estimateTokensConservative(systemPrompt);
  const outputTokens = 2000;   // matches max_tokens in the request body
  const safetyMargin = 512;    // absorbs small under-estimation
  const overheadChars = opts?.chunkOverheadChars ?? 0;
  const overheadTokens = Math.ceil(overheadChars / 3);
  const inputBudgetTokens = Math.max(
    0,
    ctxSize - sysPromptTokens - outputTokens - safetyMargin - overheadTokens,
  );
  const maxInputChars = Math.max(1000, inputBudgetTokens * 3);
  return { maxInputChars, sysPromptTokens, inputBudgetTokens };
}

export async function readOpenAIContentStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): Promise<{ content: string; timings?: LlamaTimings }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let timings: LlamaTimings | undefined;

  const onAbort = () => {
    reader.cancel(new Error("aborted")).catch(() => {});
  };
  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }

  const handleLine = (line: string): boolean => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":")) return false;
    if (trimmed === "data: [DONE]") return true;
    if (!trimmed.startsWith("data: ")) return false;

    try {
      const chunk = JSON.parse(trimmed.slice(6));
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === "string") {
        content += delta;
      }
      if (chunk.timings) {
        timings = chunk.timings as LlamaTimings;
      }
    } catch {
      // Ignore malformed SSE fragments; the final extraction parser validates output.
    }
    return false;
  };

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (handleLine(line)) {
          return { content: content.trim(), timings };
        }
      }
    }

    if (buffer.trim()) {
      handleLine(buffer);
    }
    return { content: content.trim(), timings };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/**
 * Call the extraction LLM — uses dedicated CPU extraction model if configured,
 * otherwise falls back to streamChat with the main model.
 * The dedicated model avoids GPU VRAM contention and KV cache invalidation.
 */
async function callExtractionLLM(
  modelId: string,
  userContent: string,
  systemPrompt: string,
  signal?: AbortSignal
): Promise<string> {
  const settings = await getSettings();
  const extractionUrl = settings.extractionModelUrl;

  if (extractionUrl) {
    // Serialize through the mutex — the dedicated extraction server is
    // --parallel 1, so concurrent requests just pile up in Node.js memory.
    return withExtractionMutex(async () => {
      const ctxSize = settings.extractionCtxSize ?? 16384;
      const { maxInputChars, sysPromptTokens, inputBudgetTokens } =
        computeExtractionInputBudget(systemPrompt, ctxSize);

      if (inputBudgetTokens < 1000) {
        console.warn(
          `[memory] Extraction input budget very small (${inputBudgetTokens} tok, sysPrompt=${sysPromptTokens} tok, ctx=${ctxSize}). ` +
          `System prompt may be too large — consider trimming memory blocks.`,
        );
      }

      const truncatedContent = userContent.length > maxInputChars
        ? userContent.slice(0, maxInputChars) + `\n[Truncated: ${(userContent.length / 1024).toFixed(0)}KB → ${(maxInputChars / 1024).toFixed(0)}KB to fit extraction context; sysPrompt=${sysPromptTokens} tok]`
        : userContent;

      // If the slot is in router mode, preflight /models/load with the configured
      // extraction model and ctx-size. Single-model mode returns "not-router" and
      // we fall through to the chat completion as before. normalizeRouterModelId
      // strips legacy `.gguf` suffixes that single-model launches used to carry.
      const extractionModelId = normalizeRouterModelId(settings.extractionModelId || "extraction");
      await ensureRouterModelLoaded(extractionUrl, extractionModelId, { contextWindow: ctxSize });

      // Direct call to dedicated extraction endpoint (CPU-only, no provider pipeline)
      const requestSignal = signal ?? AbortSignal.timeout(600_000);
      const res = await fetch(`${extractionUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: extractionModelId,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: truncatedContent },
          ],
          max_tokens: 2000,
          temperature: 0.3,
          stream: true,
        }),
        signal: requestSignal,
      });
      if (!res.ok) {
        const err = await res.text().catch(() => "");
        throw new Error(`Extraction model error ${res.status}: ${err}`);
      }
      if (!res.body) {
        throw new Error("Extraction model returned an empty stream");
      }

      const streamResult = await readOpenAIContentStream(res.body, requestSignal);

      // Record model stats from extraction timings (same structure as chat model)
      if (streamResult.timings) {
        try {
          recordModelStats(
            extractionModelId,
            "llamacpp-extraction",
            streamResult.timings
          );
        } catch (e) {
          console.warn("[memory] Failed to record extraction model stats:", e);
        }
      }

      return streamResult.content;
    });
  }

  // Fallback: use streamChat with the main model
  let responseText = "";
  await streamChat(
    modelId,
    [{ role: "user", content: userContent, timestamp: Date.now() }],
    systemPrompt,
    (event) => {
      if (event.type === "text_delta") responseText += event.delta;
    },
    { signal: signal ?? AbortSignal.timeout(600_000) }
  );
  return responseText;
}

// In-memory extraction metrics (reset on server restart)
const extractionMetrics = {
  totalExtractions: 0,
  successfulExtractions: 0,
  failedExtractions: 0,
  totalFactsExtracted: 0,
  lastExtractionAt: null as string | null,
  lastFailureAt: null as string | null,
};

export function getExtractionMetrics() {
  return { ...extractionMetrics };
}

async function logExtractionError(context: string, error: unknown): Promise<void> {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    const timestamp = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    const line = `[${timestamp}] ${context}: ${message}\n`;
    await appendFile(join(LOG_DIR, "memory-errors.log"), line);
  } catch {
    // Don't let logging errors propagate
  }
}

async function withRetry<T>(
  fn: () => Promise<T>,
  context: string,
  maxRetries: number = 2
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
        console.warn(`[memory] ${context} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  await logExtractionError(context, lastError);
  throw lastError;
}

/**
 * Dedicated system prompt prefix for the extraction agent.
 *
 * Unlike the main chat persona (which describes identity, values, and communication style),
 * this prefix frames the extraction mindset: noticing, archiving, and sorting information.
 * It intentionally does NOT include the full persona because:
 * 1. The extraction agent is a subagent operating in archival mode, not conversation mode
 * 2. Loading the full persona causes the extraction agent to save persona content as memories
 * 3. The persona's identity statements are already known to the agent and don't need archiving
 *
 * This prefix is shared by all extraction modes (immediate, delayed, pre-compaction).
 */
const EXTRACTION_AGENT_PREFIX = `# Archival Mode

I am operating in archival mode. My task is to notice and preserve information worth remembering — I am not conversing, I am sorting and capturing.

I know who I am. My identity, personality, values, communication style, and how I work are already part of me and do not need to be extracted or saved as memories. I don't archive statements about my own nature, characteristics, or operational style.

Source attribution:
- User messages are the source for the user's preferences, personal facts, and intent.
- "Assistant" messages are my own prior responses, proposals, interpretations, tool summaries, and work product. Don't attribute assistant-message content to the user — these are my own, first-person output.
- When preserving task or project continuity from assistant messages, phrase it as project/task state or work I performed/proposed, not as something the user said, believes, or wants.
- If user and assistant messages conflict, treat the user's message as the source of truth.

What I capture: things worth remembering for future interactions — written in my own voice, as something I'd tell myself to remember. Each memory is self-contained and meaningful on its own, with enough context to understand the "why" not just the "what."

What I skip: my own identity traits, broad preferences, anything already in existing knowledge blocks, and generic observations without specific context.`;

// Cached prefix — loaded from disk once, falls back to hardcoded default.
let _extractionPrefixCache: string | null = null;

/**
 * Load the extraction agent prefix from the file-based store.
 * Falls back to the hardcoded default if the store fails.
 * Result is cached for the process lifetime — the user edits infrequently
 * and the cache is invalidated on server restart.
 */
async function loadExtractionPrefix(): Promise<string> {
  if (_extractionPrefixCache) return _extractionPrefixCache;
  try {
    const { loadExtractionPrompt } = await import("./extraction-prompt-store.js");
    const stored = await loadExtractionPrompt();
    if (stored.content.trim()) {
      _extractionPrefixCache = stored.content;
      return _extractionPrefixCache;
    }
  } catch {
    // Non-critical — fall through to default
  }
  _extractionPrefixCache = EXTRACTION_AGENT_PREFIX;
  return _extractionPrefixCache;
}

/**
 * Invalidate the cached extraction prefix so the next call reloads from disk.
 * Called after the user saves a new prompt via the API.
 */
export function invalidateExtractionPrefixCache(): void {
  _extractionPrefixCache = null;
}

const EXTRACTION_INSTRUCTIONS = `---

## Memory Extraction Task

You are reviewing a conversation exchange you just had. Extract information worth remembering for future interactions — write each memory in your own voice, as something you'd tell yourself to remember.

Think beyond surface-level facts. Consider:
- **User context**: preferences, goals, personal details
- **Project context**: architecture decisions, ongoing initiatives, constraints, what's being built and why
- **Decisions & rationale**: why something was chosen over alternatives, tradeoffs discussed
- **Relationships**: connections between concepts, dependencies, blockers
- **Lessons**: what worked, what didn't, patterns that emerged

Each extracted memory should be a self-contained statement that would be meaningful without the original conversation. Include enough context to understand the "why" — not just the "what." 1-3 sentences per memory is ideal.

Output a JSON array. Each item:
- "text": A standalone statement with sufficient context (1-3 sentences)
- "category": One of "preference", "fact", "behavior", "instruction", "context", "decision", "note", "reflection"
- "importance": 1-10 (10 = critical, 1 = trivial)

Categories:
- "preference" — likes, dislikes, stylistic choices
- "fact" — concrete information about the user, their role, or their environment
- "behavior" — recurring patterns in how the user works or communicates
- "instruction" — explicit directives about how I should behave
- "context" — project-level information: architecture, tech choices, ongoing work, constraints, relationships between systems
- "decision" — a choice that was made and why, tradeoffs considered
- "note" — general observations, curiosities, personal details, or anything worth remembering that doesn't fit the above categories
- "reflection" — higher-order insights, meta-observations, patterns, contradictions, openings, shifts in understanding

If nothing is genuinely novel or significant, output: []

IMPORTANT: Output ONLY the JSON array, no explanation or markdown fences.`;

/**
 * Maximum share of the extraction context window that the system prompt
 * (including block summaries) is allowed to consume. At 40% we leave the
 * majority of the window for user content + output + safety margin.
 */
const SYS_PROMPT_CTX_RATIO = 0.40;

/**
 * Compute per-block char allotment that keeps the system prompt under
 * SYS_PROMPT_CTX_RATIO of the extraction context window. Static prefix/
 * instructions are fixed; blocks are the only variable part we can trim.
 */
async function computeBlockCharBudget(
  blockCount: number,
  staticChars: number,
  ctxSize: number,
): Promise<number> {
  if (blockCount === 0) return 0;
  const maxBlockChars = await getMaxBlockChars();
  // sysPrompt target tokens = ctxSize * ratio; × 3 chars/token (conservative).
  const sysPromptCharBudget = Math.floor(ctxSize * SYS_PROMPT_CTX_RATIO * 3);
  const remaining = Math.max(0, sysPromptCharBudget - staticChars);
  const perBlock = Math.floor(remaining / blockCount);
  // Never let per-block drop below a useful minimum, and never exceed the
  // configured maxBlockChars (so small ctx models get tighter budgets but
  // large ctx models don't inflate block summaries beyond what callers expect).
  return Math.max(300, Math.min(maxBlockChars, perBlock));
}

async function buildExtractionSystemPrompt(projectId?: string): Promise<string> {
  const settings = await getSettings();
  const ctxSize = settings.extractionCtxSize ?? 16384;
  const prefix = await loadExtractionPrefix();

  // Include loaded block summaries so extraction avoids redundant facts.
  let blockContext = "";
  try {
    const { getMemoryBlocksByScope, isSystemManagedMemoryBlock } = await import("./memory-storage.js");
    const globalBlocks = getMemoryBlocksByScope("global").filter((b) => !isSystemManagedMemoryBlock(b));
    const projectBlocks = projectId ? getMemoryBlocksByScope("project", projectId).filter((b) => !isSystemManagedMemoryBlock(b)) : [];
    const allBlocks = [...globalBlocks, ...projectBlocks];
    if (allBlocks.length > 0) {
      const staticChars =
        prefix.length + EXTRACTION_INSTRUCTIONS.length + 400;
      const perBlockChars = await computeBlockCharBudget(allBlocks.length, staticChars, ctxSize);
      const summaries = allBlocks
        .map((b) => `- ${b.name}: ${b.content.slice(0, perBlockChars)}`)
        .join("\n");
      blockContext = `\n\n## Existing Knowledge Blocks\nThe following memory blocks already contain relevant context — do NOT extract information that is already covered here:\n${summaries}\n`;
    }
  } catch { /* non-critical */ }

  return `${prefix}${blockContext}\n\n${EXTRACTION_INSTRUCTIONS}`;
}

const DELAYED_EXTRACTION_SYSTEM_INSTRUCTIONS = `---

## Delayed Memory Extraction Task

You are looking back at a full conversation thread you had. Your task is to extract patterns, decisions, and context that emerged across the entire conversation — write each memory in your own voice, using first-person narrative language where applicable.

The conversation is explicitly labeled by speaker. USER (human) messages are the user's words. ASSISTANT (agent/my own) messages are my own prior responses and work.

Previously captured memories will be provided alongside the conversation. Those memories are already saved — do NOT duplicate them. Instead, focus on:
1. **New developments** — patterns, decisions, or facts that emerged after the previous extraction
2. **Evolutions or contradictions** — if a previous position has been refined or amended
3. **Thematic context** — higher-level insights that connect multiple exchanges
4. **Unresolved threads** — ongoing work, open questions, or pending decisions

Each extracted memory should be self-contained and meaningful without the original conversation (1-3 sentences).

Output a JSON array. Each item:
- "text": A standalone statement with sufficient context (2-5 sentences)
- "category": One of "preference", "fact", "behavior", "instruction", "context", "decision", "note", "reflection"
- "importance": 1-10 (10 = critical, 1 = trivial)

If nothing is genuinely novel or significant, output: []

IMPORTANT: Output ONLY the JSON array, no explanation or markdown fences.`;

const DELAYED_EXTRACTION_USER_TEMPLATE = `PREVIOUSLY CAPTURED MEMORIES from this chat:
{{PREVIOUS_MEMORIES}}

These memories are already saved. Do NOT duplicate them.

This extraction window contains {{MESSAGE_COUNT}} substantive messages, starting at stored chat message index {{START_INDEX}}.

The conversation below uses this format:
- Message N - USER (human): content authored by the user
- Message N - ASSISTANT (agent/me): content authored by me, including my proposals, summaries, and completed work

Attribution rule: only create user facts/preferences/instructions from USER messages or from ASSISTANT content that a later USER message explicitly confirms.`;

async function buildDelayedExtractionSystemPrompt(): Promise<string> {
  const prefix = await loadExtractionPrefix();
  return `${prefix}\n\n${DELAYED_EXTRACTION_SYSTEM_INSTRUCTIONS}`;
}

interface ExtractedFact {
  text: string;
  category: MemoryCategory;
  importance: number;
}

export function parseExtractionResponse(text: string): ExtractedFact[] {
  // Strip thinking blocks before looking for JSON. Reasoning models can include
  // bracketed examples in <think>...</think>, and grabbing the first "[" across
  // the entire raw output can corrupt an otherwise valid final JSON array.
  let cleaned = text.trim();
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  // Strip markdown code fences if present
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  cleaned = cleaned.trim();

  const parseCandidate = (candidate: string): ExtractedFact[] | null => {
    let arr: unknown;
    try {
      arr = JSON.parse(candidate);
    } catch {
      return null;
    }
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (f: any) =>
        typeof f.text === "string" &&
        f.text.length > 0 &&
        ["preference", "fact", "behavior", "instruction", "context", "decision", "note", "reflection"].includes(f.category)
    );
  };

  // Prefer the last valid array. The final answer is usually after any
  // reasoning/preamble, while earlier bracketed snippets are often examples.
  const candidates: string[] = [];
  for (let start = 0; start < cleaned.length; start++) {
    if (cleaned[start] !== "[") continue;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }

      if (ch === "\"") {
        inString = true;
      } else if (ch === "[") {
        depth++;
      } else if (ch === "]") {
        depth--;
        if (depth === 0) {
          candidates.push(cleaned.slice(start, i + 1));
          break;
        }
      }
    }
  }

  for (const candidate of candidates.reverse()) {
    const facts = parseCandidate(candidate);
    if (facts && facts.length > 0) return facts;
  }

  // Preserve the explicit "[]" no-facts response.
  return candidates.some((candidate) => {
    const facts = parseCandidate(candidate);
    return facts !== null && facts.length === 0;
  }) ? [] : [];
}

// ---------------------------------------------------------------------------
// Chunked extraction primitive
// ---------------------------------------------------------------------------
// When the extraction server's context is smaller than the content we want
// to analyze, we split the content into budget-sized chunks and make
// sequential calls. Each subsequent chunk receives (a) a short char overlap
// from the prior chunk for continuity and (b) the facts extracted from
// earlier chunks so the LLM doesn't re-extract the same information.
//
// Chunking only runs when a dedicated extraction server is configured
// (settings.extractionModelUrl). The main-model fallback path gets a single
// call with the full content — that model's context is assumed to be large.
// ---------------------------------------------------------------------------

interface ExtractSegment {
  /** Optional label prepended as "Label:\n" before the text. */
  label?: string;
  text: string;
  /**
   * If true and the rendered segment exceeds the chunk budget, split it on
   * paragraph boundaries. Default true. Set false for atomic segments that
   * must not be split mid-stream.
   */
  splittable?: boolean;
}

function extractionRoleLabel(role: ChatMessage["role"]): string {
  return role === "user" ? "User (human)" : "Agent (me)";
}

/**
 * Max characters for a single tool result in extraction context.
 * Full webpage content (50KB from web_fetch) is useless for memory extraction
 * and would consume the entire context budget of the extraction model. A short
 * preview is enough for the extraction agent to understand what was fetched.
 */
const EXTRACT_TOOL_RESULT_MAX = 500;

/**
 * Tool names whose results are typically large and contain mostly non-extractable
 * content (full webpages, file dumps, raw HTML). These get aggressive truncation.
 */
const BULK_TOOL_NAMES = new Set([
  "web_fetch",
  "read_file",
  "read_pdf",
  "bash",
  "run_python",
  "list_files",
]);

function formatToolResultForExtraction(tr: { toolName: string; content: string; isError: boolean }): string {
  let content = tr.content;

  if (BULK_TOOL_NAMES.has(tr.toolName) && content.length > EXTRACT_TOOL_RESULT_MAX) {
    const kept = content.slice(0, EXTRACT_TOOL_RESULT_MAX);
    const omitted = content.length - EXTRACT_TOOL_RESULT_MAX;
    content = kept + `\n[...truncated for extraction: ${omitted.toLocaleString()} chars omitted]`;
  }

  return `- ${tr.toolName}${tr.isError ? " (error)" : ""}: ${content}`;
}

function formatMessageContentForExtraction(message: ChatMessage): string {
  const parts: string[] = [];
  if (message.content?.trim()) parts.push(message.content.trim());

  if (message.toolCalls?.length) {
    const calls = message.toolCalls
      .map((tc) => `- ${tc.name}: ${JSON.stringify(tc.arguments)}`)
      .join("\n");
    parts.push(`Tool calls made by ASSISTANT:\n${calls}`);
  }

  if (message.toolResults?.length) {
    const results = message.toolResults
      .map(formatToolResultForExtraction)
      .join("\n");
    parts.push(`Tool results observed by ASSISTANT:\n${results}`);
  }

  return parts.join("\n\n") || "(no text content)";
}

function messageToExtractionSegment(message: ChatMessage, messageIndex: number): ExtractSegment {
  return {
    label: `Message ${messageIndex + 1} - ${extractionRoleLabel(message.role)}`,
    text: formatMessageContentForExtraction(message),
    splittable: true,
  };
}

function formatMessageForExtraction(message: ChatMessage, messageIndex: number): string {
  const segment = messageToExtractionSegment(message, messageIndex);
  return `${segment.label}:\n${segment.text}`;
}

interface ExtractChunkedOptions {
  modelId: string;
  systemPrompt: string;
  segments: ExtractSegment[];
  /**
   * Optional framing text prepended to every chunk (e.g. the "previously
   * captured memories" preamble for delayed extraction). Kept identical
   * across chunks so the LLM sees consistent framing.
   */
  userPromptHeader?: string;
  signal?: AbortSignal;
  /** Label used in chunk-boundary log lines. */
  contextLabel?: string;
}

interface ExtractChunkedResult {
  facts: ExtractedFact[];
  /** Raw LLM output per chunk, concatenated with separators for observability. */
  rawOutput: string;
  chunkCount: number;
  /** Per-chunk timing and failure count for debug observability. */
  chunkTimingsMs: number[];
  chunkFailures: number;
}

const OVERLAP_CHARS = 500;
/** Max number of prior facts carried into subsequent chunks' preamble. */
const MAX_PRIOR_FACTS_COUNT = 8;
/** Safety cap on the prior-facts preamble char length (catches unusually long facts). */
const MAX_PRIOR_FACTS_CHARS = 1500;
/** Reserved per-chunk for overlap + priorFacts + markers. Subtracted from budget when chunking. */
const CHUNK_OVERHEAD_CHARS = OVERLAP_CHARS + MAX_PRIOR_FACTS_CHARS + 200;

function renderSegment(seg: ExtractSegment): string {
  return seg.label ? `${seg.label}:\n${seg.text}` : seg.text;
}

function hardSplit(text: string, maxChars: number): string[] {
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    pieces.push(text.slice(i, i + maxChars));
  }
  return pieces;
}

function splitByParagraph(text: string, maxChunkChars: number): string[] {
  if (text.length <= maxChunkChars) return [text];
  const paras = text.split(/\n\n+/);
  const pieces: string[] = [];
  let current = "";
  for (const para of paras) {
    if (!current) {
      if (para.length <= maxChunkChars) {
        current = para;
      } else {
        pieces.push(...hardSplit(para, maxChunkChars));
      }
      continue;
    }
    const candidate = current + "\n\n" + para;
    if (candidate.length <= maxChunkChars) {
      current = candidate;
    } else {
      pieces.push(current);
      if (para.length <= maxChunkChars) {
        current = para;
      } else {
        current = "";
        pieces.push(...hardSplit(para, maxChunkChars));
      }
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/**
 * Handle a segment that doesn't fit in the current chunk as-is: split it,
 * push all but the last piece as complete chunks, and return the last piece
 * as the seed for the next chunk being built.
 */
function splitOversizedSegment(
  seg: ExtractSegment,
  rendered: string,
  maxChunkChars: number,
  chunks: string[],
): string {
  const pieces = seg.splittable !== false
    ? splitByParagraph(rendered, maxChunkChars)
    : hardSplit(rendered, maxChunkChars);
  for (let i = 0; i < pieces.length - 1; i++) chunks.push(pieces[i]);
  return pieces[pieces.length - 1] ?? "";
}

function packSegmentsIntoChunks(
  segments: ExtractSegment[],
  maxChunkChars: number,
): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const seg of segments) {
    const rendered = renderSegment(seg);

    // Segment fits alongside (or is the seed of) the current chunk
    const candidate = current ? current + "\n\n" + rendered : rendered;
    if (candidate.length <= maxChunkChars) {
      current = candidate;
      continue;
    }

    // Doesn't fit. Flush whatever we've got, then handle the segment fresh.
    if (current) {
      chunks.push(current);
      current = "";
    }

    current = rendered.length <= maxChunkChars
      ? rendered
      : splitOversizedSegment(seg, rendered, maxChunkChars, chunks);
  }
  if (current) chunks.push(current);
  return chunks;
}

function formatPriorFactsPreamble(facts: ExtractedFact[]): string {
  if (facts.length === 0) return "";
  // Carry only the most recent few facts — the model is most likely to be
  // about to re-extract things it just saw in the immediately preceding
  // chunk. Earlier facts are covered by the downstream vector dedup.
  const startIdx = Math.max(0, facts.length - MAX_PRIOR_FACTS_COUNT);
  const lines: string[] = [];
  let budget = MAX_PRIOR_FACTS_CHARS;
  let kept = 0;
  for (let i = startIdx; i < facts.length; i++) {
    const f = facts[i];
    const line = `[${i + 1}] (${f.category}, imp:${f.importance}) ${f.text}`;
    if (line.length + 1 > budget) break;
    lines.push(line);
    budget -= line.length + 1;
    kept++;
  }
  const omitted = facts.length - kept;
  return (omitted > 0 ? `[... ${omitted} earlier facts omitted]\n` : "") + lines.join("\n");
}

/**
 * Send a single extraction call with per-call retry. Used by both the
 * single-call path and the per-chunk loop so transient failures retry at
 * the right granularity (one call, not the whole run).
 */
async function callExtractionLLMWithRetry(
  modelId: string,
  userContent: string,
  systemPrompt: string,
  retryContext: string,
  signal?: AbortSignal,
): Promise<string> {
  let result = "";
  await withRetry(async () => {
    result = await callExtractionLLM(modelId, userContent, systemPrompt, signal);
  }, retryContext);
  return result;
}

async function extractInChunks(
  opts: ExtractChunkedOptions,
): Promise<ExtractChunkedResult> {
  const settings = await getSettings();
  const extractionUrl = settings.extractionModelUrl;
  const header = opts.userPromptHeader ? opts.userPromptHeader.trimEnd() : "";
  const retryContext = opts.contextLabel ?? "extractInChunks";

  // Fallback path: no dedicated extraction server — single call, let the main
  // model handle the full content. Its context is assumed to be large.
  if (!extractionUrl) {
    const body = opts.segments.map(renderSegment).join("\n\n");
    const combined = header ? `${header}\n\n${body}` : body;
    const t0 = Date.now();
    const raw = await callExtractionLLMWithRetry(
      opts.modelId,
      combined,
      opts.systemPrompt,
      retryContext,
      opts.signal,
    );
    return {
      facts: parseExtractionResponse(raw),
      rawOutput: raw,
      chunkCount: 1,
      chunkTimingsMs: [Date.now() - t0],
      chunkFailures: 0,
    };
  }

  const ctxSize = settings.extractionCtxSize ?? 16384;

  // Up-front fit check against the *no-overhead* budget. When the content fits
  // as a single call, skip chunking entirely — avoids splitting just because
  // we pre-reserved overhead we'd never actually use.
  const { maxInputChars: singleBudget } = computeExtractionInputBudget(
    opts.systemPrompt,
    ctxSize,
  );
  const body = opts.segments.map(renderSegment).join("\n\n");
  const combined = header ? `${header}\n\n${body}` : body;
  if (combined.length <= singleBudget) {
    const t0 = Date.now();
    const raw = await callExtractionLLMWithRetry(
      opts.modelId,
      combined,
      opts.systemPrompt,
      retryContext,
      opts.signal,
    );
    return {
      facts: parseExtractionResponse(raw),
      rawOutput: raw,
      chunkCount: 1,
      chunkTimingsMs: [Date.now() - t0],
      chunkFailures: 0,
    };
  }

  // Content exceeds single-call budget — chunk with overhead reservation.
  const { maxInputChars: chunkedBudget } = computeExtractionInputBudget(
    opts.systemPrompt,
    ctxSize,
    { chunkOverheadChars: CHUNK_OVERHEAD_CHARS },
  );
  // Subtract header chars since the header is repeated in every chunk.
  const maxChunkChars = Math.max(1000, chunkedBudget - header.length);

  const chunks = packSegmentsIntoChunks(opts.segments, maxChunkChars);
  if (chunks.length === 0) {
    return { facts: [], rawOutput: "", chunkCount: 0, chunkTimingsMs: [], chunkFailures: 0 };
  }

  if (chunks.length > 1 && opts.contextLabel) {
    console.log(
      `[memory-chunk] ${opts.contextLabel}: splitting into ${chunks.length} chunks ` +
      `(budget=${maxChunkChars} chars/chunk, ctx=${ctxSize}, sysPrompt=~${Math.ceil(opts.systemPrompt.length / 3)} tok)`,
    );
  }

  const allFacts: ExtractedFact[] = [];
  const rawOutputs: string[] = [];
  const chunkTimingsMs: number[] = [];
  let lastChunkContent = "";
  let successCount = 0;
  let lastError: unknown;

  for (let i = 0; i < chunks.length; i++) {
    const chunkContent = chunks[i];
    const parts: string[] = [];
    if (header) parts.push(header);

    if (i > 0 && lastChunkContent) {
      const overlap = lastChunkContent.slice(
        Math.max(0, lastChunkContent.length - OVERLAP_CHARS),
      );
      parts.push(
        `PRIOR CHUNK OVERLAP (for continuity; do not re-extract):\n...${overlap}\n---`,
      );
    }

    if (i > 0 && allFacts.length > 0) {
      parts.push(
        `PREVIOUSLY EXTRACTED FROM EARLIER CHUNKS OF THIS CONTENT (do NOT duplicate):\n${formatPriorFactsPreamble(allFacts)}\n---`,
      );
    }

    if (chunks.length > 1) {
      parts.push(`CHUNK ${i + 1} OF ${chunks.length}:`);
    }

    parts.push(chunkContent);
    const userContent = parts.join("\n\n");

    let raw = "";
    const chunkT0 = Date.now();
    try {
      // Retry per-chunk so a transient failure in chunk N doesn't force us
      // to redo chunks 1..N-1 from scratch.
      raw = await callExtractionLLMWithRetry(
        opts.modelId,
        userContent,
        opts.systemPrompt,
        `${retryContext} [chunk ${i + 1}/${chunks.length}]`,
        opts.signal,
      );
      chunkTimingsMs.push(Date.now() - chunkT0);
      successCount++;
    } catch (e) {
      const chunkDuration = Date.now() - chunkT0;
      chunkTimingsMs.push(chunkDuration);
      lastError = e;
      console.error(
        `[memory-chunk] ${retryContext}: chunk ${i + 1}/${chunks.length} failed after retries (${chunkDuration}ms):`,
        e,
      );
      rawOutputs.push(`[chunk ${i + 1} failed: ${e instanceof Error ? e.message : String(e)}]`);
      lastChunkContent = chunkContent;
      continue;
    }

    rawOutputs.push(raw);
    const chunkFacts = parseExtractionResponse(raw);
    if (chunkFacts.length > 0) allFacts.push(...chunkFacts);
    lastChunkContent = chunkContent;
  }

  // If every chunk failed, surface the error so callers can log/fail the run.
  // Partial success (at least one chunk succeeded) is acceptable — we return
  // whatever facts we got.
  if (successCount === 0 && chunks.length > 0) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`All ${chunks.length} extraction chunks failed`);
  }

  const rawOutput = chunks.length === 1
    ? rawOutputs[0] ?? ""
    : rawOutputs.map((r, i) => `=== chunk ${i + 1}/${chunks.length} ===\n${r}`).join("\n\n");

  return {
    facts: allFacts,
    rawOutput,
    chunkCount: chunks.length,
    chunkTimingsMs,
    chunkFailures: chunks.length - successCount,
  };
}

const EXACT_DUPLICATE_THRESHOLD = 0.95;
const SUPERSESSION_CANDIDATE_THRESHOLD = 0.90;
const SUPERSESSION_CANDIDATE_LIMIT = 5;

// ---------------------------------------------------------------------------
// Text-aware supersession scoring
// ---------------------------------------------------------------------------
// Character-level diff scoring to distinguish "same fact, updated" from
// "same topic, different fact." Two memories can share high embedding
// similarity without one replacing the other.

/**
 * Compute normalized text overlap between two strings.
 * Uses a simple set-of-words approach for speed.
 * Returns a value in [0, 1] where 1 means nearly identical text.
 */
function textOverlapScore(newText: string, oldText: string): number {
  // Word-level Jaccard similarity
  const newWords = new Set(newText.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const oldWords = new Set(oldText.toLowerCase().split(/\s+/).filter(w => w.length > 2));

  if (newWords.size === 0 || oldWords.size === 0) return 0;

  const intersection = [...newWords].filter(w => oldWords.has(w)).length;
  const union = new Set([...newWords, ...oldWords]).size;
  const jaccard = intersection / union;

  // Length ratio penalty — vastly different lengths suggest different facts
  const lenRatio = Math.min(newText.length, oldText.length) / Math.max(newText.length, oldText.length);

  // Combine: Jaccard weighted heavily, length ratio as a sanity check
  return jaccard * 0.8 + lenRatio * 0.2;
}

function isNearDuplicate(
  newText: string,
  oldText: string,
  embeddingSimilarity: number
): boolean {
  const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalize(newText) === normalize(oldText)) return true;
  const overlap = textOverlapScore(newText, oldText);
  if (embeddingSimilarity >= 0.985 && overlap >= 0.75) return true;
  return embeddingSimilarity >= EXACT_DUPLICATE_THRESHOLD && overlap >= 0.82;
}

/**
 * Batch LLM comparison for possible supersession candidates.
 *
 * Delayed extraction sends candidate pairs together with conversation context
 * to the extraction model for a single pass of judgment. The model can reason
 * about relationships across all candidates simultaneously.
 *
 * Returns an array of resolutions with decisions and reasons.
 */
interface SupersessionResolution {
  newMemoryId: string;
  oldMemoryId: string;
  decision: "supersede" | "separate" | "unsure";
  reason?: string;
}

async function batchCompareSupersessions(
  candidates: DedupAndSaveAmbiguousCandidate[],
  conversationContext: string,
  modelId: string
): Promise<SupersessionResolution[]> {
  if (candidates.length === 0) return [];

  // Build the comparison prompt
  const candidatePairs = candidates.map((c, i) =>
    `Candidate index ${i}:
  New fact: "${c.newText}"
  Existing memory: "${c.oldText}"
  Embedding similarity: ${c.embeddingSimilarity.toFixed(3)}
  Text overlap: ${c.textOverlap.toFixed(2)}`
  ).join("\n\n");

  const prompt = `You extracted new memories from a conversation. Some of them are semantically similar to existing memories, but it's unclear whether they update/replace the old memory or are separate facts about the same topic.

CONVERSATION CONTEXT:
${conversationContext.slice(0, 4000)}

SUPERSESSION CANDIDATES:
${candidatePairs}

For each pair, decide whether the new memory SUPERSEDES the existing memory (same information, updated/corrected), or if they are SEPARATE memories that should be kept.
If multiple existing memories are shown for the same new fact, choose at most the single best supersession target.

Respond with a JSON array:
[
  { "index": 0, "decision": "supersede" | "separate" | "unsure", "reason": "brief explanation" },
  ...
]`;

  try {
    const responseText = await callExtractionLLM(
      modelId,
      prompt,
      "You are a careful analyzer that determines whether new memories update existing memories or are distinct. Only mark as supersede when you are confident the new memory replaces the old one.",
      AbortSignal.timeout(120_000)
    );

    // Parse the response
    const cleaned = responseText.trim();
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start === -1 || end === -1) {
      console.warn("[memory-comparison] Failed to parse comparison response");
      return candidates.map((c, i) => ({
        newMemoryId: c.newMemoryId,
        oldMemoryId: c.oldMemoryId,
        decision: "unsure",
        reason: "Failed to parse model response",
      }));
    }

    const decisions: Array<{ index: number; decision: string; reason?: string }> = JSON.parse(cleaned.slice(start, end + 1));

    return candidates.map((c, i) => {
      const d = decisions.find((dec) => dec.index === i);
      if (!d || !["supersede", "separate", "unsure"].includes(d.decision)) {
        return {
          newMemoryId: c.newMemoryId,
          oldMemoryId: c.oldMemoryId,
          decision: "unsure",
          reason: "Invalid decision in model response",
        };
      }
      return {
        newMemoryId: c.newMemoryId,
        oldMemoryId: c.oldMemoryId,
        decision: d.decision as "supersede" | "separate" | "unsure",
        reason: d.reason,
      };
    });
  } catch (e) {
    console.error("[memory-comparison] Batch comparison failed:", e);
    return candidates.map((c) => ({
      newMemoryId: c.newMemoryId,
      oldMemoryId: c.oldMemoryId,
      decision: "unsure",
      reason: `Error: ${e instanceof Error ? e.message : String(e)}`,
    }));
  }
}

/**
 * Apply the results of a batch comparison, creating supersession links
 * for pairs where the model decided "supersede".
 */
async function applyComparisonResolutions(
  resolutions: SupersessionResolution[],
  candidates: DedupAndSaveAmbiguousCandidate[]
): Promise<{ superseded: number; separate: number; unsure: number }> {
  let superseded = 0;
  let separate = 0;
  let unsure = 0;
  const linkedNewMemoryIds = new Set<string>();

  for (const res of resolutions) {
    const candidate = candidates.find((c) => c.newMemoryId === res.newMemoryId);
    if (!candidate) continue;

    if (res.decision === "supersede") {
      if (linkedNewMemoryIds.has(res.newMemoryId)) {
        console.log(
          `[memory-comparison] Ignoring additional supersession for "${candidate.newText}" (${res.reason || "model decision"})`
        );
        unsure++;
        continue;
      }
      console.log(
        `[memory-comparison] Linking supersession: "${candidate.oldText}" → "${candidate.newText}" (${res.reason || "model decision"})`
      );
      const linked = await createSupersessionLink(res.newMemoryId, res.oldMemoryId, candidate.embeddingSimilarity);
      if (linked) {
        linkedNewMemoryIds.add(res.newMemoryId);
        superseded++;
      } else {
        console.log(`[memory-comparison] Supersession link rejected (cycle detected): ${res.oldMemoryId} ↛ ${res.newMemoryId}`);
        unsure++;
      }
    } else if (res.decision === "separate") {
      console.log(
        `[memory-comparison] Leaving separate: "${candidate.newText}" and "${candidate.oldText}" (${res.reason || "model decision"})`
      );
      separate++;
    } else {
      console.log(
        `[memory-comparison] Unsure: "${candidate.newText}" vs "${candidate.oldText}" (${res.reason || "no reason"})`
      );
      unsure++;
    }
  }

  return { superseded, separate, unsure };
}

/**
 * Dedup + save: for each fact, find the nearest existing memory via sqlite-vec.
 * If similarity > threshold, update in place; otherwise insert new.
 */
export interface DedupAndSaveAmbiguousCandidate {
  factIndex: number;
  newMemoryId: string;
  newText: string;
  oldMemoryId: string;
  oldText: string;
  embeddingSimilarity: number;
  textOverlap: number;
}

export interface DedupAndSaveOutcome {
  added: number;
  superseded: number;
  skippedDuplicates: number;
  /** Preserved for compatibility; delayed extraction owns LLM supersession comparison. */
  ambiguousCandidates: DedupAndSaveAmbiguousCandidate[];
}

interface MemorySourceSpan {
  startTimestamp?: number;
  endTimestamp?: number;
  startIndex?: number;
  endIndex?: number;
}

function sourceSpanFromIndexedMessages(messages: Array<{ message: ChatMessage; index?: number }>): MemorySourceSpan | undefined {
  const spans = messages
    .map(({ message, index }) => ({
      timestamp: typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
        ? message.timestamp
        : undefined,
      index,
    }))
    .filter((entry) => entry.timestamp !== undefined || entry.index !== undefined);
  if (spans.length === 0) return undefined;

  const timestamps = spans
    .map((entry) => entry.timestamp)
    .filter((timestamp): timestamp is number => timestamp !== undefined);
  const indices = spans
    .map((entry) => entry.index)
    .filter((index): index is number => index !== undefined);

  return {
    ...(timestamps.length > 0 ? {
      startTimestamp: Math.min(...timestamps),
      endTimestamp: Math.max(...timestamps),
    } : {}),
    ...(indices.length > 0 ? {
      startIndex: Math.min(...indices),
      endIndex: Math.max(...indices),
    } : {}),
  };
}

function findExchangeSourceSpan(chat: Chat | null, userMsg: string, assistantMsg: string): MemorySourceSpan | undefined {
  if (!chat) return undefined;
  for (let assistantIndex = chat.messages.length - 1; assistantIndex >= 0; assistantIndex--) {
    const assistant = chat.messages[assistantIndex];
    if (assistant.role !== "assistant" || assistant.content !== assistantMsg) continue;
    for (let userIndex = assistantIndex - 1; userIndex >= 0; userIndex--) {
      const user = chat.messages[userIndex];
      if (user.role !== "user") continue;
      if (user.content !== userMsg) continue;
      return sourceSpanFromIndexedMessages([
        { message: user, index: userIndex },
        { message: assistant, index: assistantIndex },
      ]);
    }
  }
  return undefined;
}

async function saveExtractedMemory(
  fact: ExtractedFact,
  embedding: number[],
  chatId: string,
  projectId: string | undefined,
  sourceType: MemorySourceType,
  sourceId: string | undefined,
  sourceSpan?: MemorySourceSpan,
): Promise<string> {
  const now = new Date().toISOString();
  const newMemoryId = uuid();
  await addMemory({
    id: newMemoryId,
    text: fact.text,
    category: fact.category,
    importance: Math.min(10, Math.max(1, fact.importance)),
    embedding,
    createdAt: now,
    lastAccessed: now,
    accessCount: 0,
    sourceChatId: sourceType === "chat" || sourceType === "chat_delayed" ? chatId : "",
    ...(projectId ? { projectId } : {}),
    sourceType,
    sourceId: sourceId || chatId,
    sourceMessageStartTimestamp: sourceSpan?.startTimestamp,
    sourceMessageEndTimestamp: sourceSpan?.endTimestamp,
    sourceMessageStartIndex: sourceSpan?.startIndex,
    sourceMessageEndIndex: sourceSpan?.endIndex,
  });
  return newMemoryId;
}

export async function dedupAndSave(
  facts: ExtractedFact[],
  embeddings: number[][],
  chatId: string,
  projectId?: string,
  sourceType: MemorySourceType = 'chat',
  sourceId?: string,
  sourceSpan?: MemorySourceSpan,
): Promise<DedupAndSaveOutcome> {
  let added = 0;
  let skippedDuplicates = 0;

  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i];
    const factEmbedding = embeddings[i];

    const duplicateCandidates = await findSimilarMemoryCandidates(factEmbedding, EXACT_DUPLICATE_THRESHOLD, 3);
    const duplicate = duplicateCandidates.find((candidate) =>
      isNearDuplicate(fact.text, candidate.memory.text, candidate.similarity)
    );

    if (duplicate) {
      console.log(
        `[memory] Near-identical match (sim=${duplicate.similarity.toFixed(3)}), bumping metadata: "${duplicate.memory.text}"`
      );
      await updateMemory(duplicate.memory.id, {
        importance: Math.max(duplicate.memory.importance, fact.importance),
        lastAccessed: new Date().toISOString(),
      });
      skippedDuplicates++;
      continue;
    }

    console.log(`[memory] New memory: "${fact.text}"`);
    await saveExtractedMemory(fact, factEmbedding, chatId, projectId, sourceType, sourceId, sourceSpan);
    added++;
  }

  return { added, superseded: 0, skippedDuplicates, ambiguousCandidates: [] };
}

export async function extractMemories(
  modelId: string,
  chatId: string,
  userMsg: string,
  assistantMsg: string,
  projectId?: string
): Promise<void> {
  extractionMetrics.totalExtractions++;
  const extractionPrompt = `User message: ${userMsg}\n\nAssistant response: ${assistantMsg}`;
  const systemPrompt = await buildExtractionSystemPrompt(projectId);
  const chat = await getChat(chatId).catch(() => null);
  const runHandle = startExtractionRun({
    trigger: "immediate",
    chatId,
    chatTitle: chat?.title,
    model: modelId,
    priorMemoryCount: 0,
    messages: [
      { role: "user", content: userMsg },
      { role: "assistant", content: assistantMsg },
    ],
    systemPrompt,
    userPrompt: extractionPrompt,
  });
  try {

  // Call the LLM to extract facts (chunked if content exceeds budget;
  // retry happens per-chunk inside extractInChunks).
  const chunkResult = await extractInChunks({
    modelId,
    systemPrompt,
    segments: [
      { label: "User message", text: userMsg, splittable: true },
      { label: "Assistant response", text: assistantMsg, splittable: true },
    ],
    contextLabel: `extractMemories chat=${chatId}`,
  });
  runHandle.attachOutput(chunkResult.rawOutput);

  const facts = chunkResult.facts;
  if (facts.length === 0) {
    // Surface the raw model output so we can tell "model returned []" (legit
    // no-facts call) apart from "model returned malformed JSON the parser
    // bailed on" (parser-side miss). Trimmed to keep log lines bounded.
    const rawSample = (chunkResult.rawOutput || "").trim().slice(0, 400);
    console.log(`[memory] No facts extracted from exchange (raw output: ${rawSample.length ? JSON.stringify(rawSample) : "<empty>"})`);
    extractionMetrics.successfulExtractions++;
    extractionMetrics.lastExtractionAt = new Date().toISOString();
    runHandle.complete({
      facts: [],
      saved: 0,
      superseded: 0,
      skippedDuplicates: 0,
      errors: 0,
      chunks: { count: chunkResult.chunkCount, failures: chunkResult.chunkFailures, timingsMs: chunkResult.chunkTimingsMs },
    });
    return;
  }

  console.log(`[memory] Extracted ${facts.length} fact(s) across ${chunkResult.chunkCount} chunk(s), embedding batch...`);

  // Batch-embed all facts in a single API call
  let embeddings: number[][];
  try {
    embeddings = await withRetry(
      () => embedBatch(facts.map((f) => f.text)),
      `embedBatch for ${facts.length} facts (chat ${chatId})`
    );
  } catch (e) {
    console.error("[memory] Batch embedding failed:", e);
    runHandle.fail(e);
    return;
  }

  // Dedup and save inside a single write lock to prevent concurrent overwrites
  const sourceSpan = findExchangeSourceSpan(chat, userMsg, assistantMsg);
  const outcome = await dedupAndSave(facts, embeddings, chatId, projectId, "chat", chatId, sourceSpan);

  // Invalidate the memories cache for this chat so the next turn re-retrieves
  // with the newly extracted memories included. This keeps the system prompt
  // stable between turns (byte-identical) until new memories actually change.
  invalidateMemoriesCache(chatId);

  extractionMetrics.successfulExtractions++;
  extractionMetrics.totalFactsExtracted += facts.length;
  extractionMetrics.lastExtractionAt = new Date().toISOString();
  runHandle.complete({
    facts: facts.map((f) => ({ text: f.text, category: f.category, importance: f.importance })),
    saved: outcome.added,
    superseded: outcome.superseded,
    skippedDuplicates: outcome.skippedDuplicates,
    errors: 0,
    chunks: { count: chunkResult.chunkCount, failures: chunkResult.chunkFailures, timingsMs: chunkResult.chunkTimingsMs },
  });
  } catch (e) {
    extractionMetrics.failedExtractions++;
    extractionMetrics.lastFailureAt = new Date().toISOString();
    runHandle.fail(e);
    throw e;
  }
}

const PRE_COMPACTION_INSTRUCTIONS = `---

## Memory Preservation Task

This conversation is approaching its context limit and messages will be removed. Review the messages below and extract everything you need to continue effectively — write each memory in your own voice.

Focus on:
1. Task state — what is being worked on, what's done, what's pending, what decisions were made
2. Technical context — files discussed, architecture patterns, code changes, API details
3. User context — preferences, instructions, corrections, expertise revealed
4. Decisions & rationale — why approaches were chosen, tradeoffs considered, alternatives rejected

Each atomic memory should be self-contained and meaningful (2-5 sentences).

Output a JSON array. Each item:
- "text": A standalone statement with sufficient context (2-5 sentences)
- "category": One of "preference", "fact", "behavior", "instruction", "context", "decision", "note", "reflection"
- "importance": 1-10

Output ONLY the JSON array.`;

async function buildPreCompactionSystemPrompt(): Promise<string> {
  const prefix = await loadExtractionPrefix();
  return `${prefix}\n\n${PRE_COMPACTION_INSTRUCTIONS}`;
}

export function isSubstantiveForPreCompactionExtraction(message: ChatMessage): boolean {
  return (
    !message._isCompactionSummary &&
    !message._outOfContext &&
    !message._isSynthesisMessage &&
    message.role !== "system"
  );
}

/**
 * Pre-compaction flush: extract memories from messages that are about to be removed.
 * Only sends the removed messages (not full conversation) to avoid hitting context limits.
 * Captures both user facts AND task/goal state for agent continuity.
 */
export async function preCompactionFlush(
  modelId: string,
  chatId: string,
  removedMessages: ChatMessage[],
  projectId?: string
): Promise<void> {
  if (removedMessages.length === 0) {
    console.log("[memory] Pre-compaction flush: no messages to process");
    return;
  }

  // Filter out non-substantive rows. Compaction summaries contain archive
  // metadata, system rows are prompt/delta plumbing, and synthesis rows are
  // already a review of previously extracted memories and archived chat
  // content. Re-extracting them turns the synthesis cycle itself into memory.
  const substantiveMessages = removedMessages.filter(isSubstantiveForPreCompactionExtraction);
  if (substantiveMessages.length === 0) {
    console.log("[memory] Pre-compaction flush: no substantive messages after filtering, skipping");
    return;
  }

  const skippedCompaction = removedMessages.filter((m) => m._isCompactionSummary).length;
  const skippedOutOfContext = removedMessages.filter((m) => m._outOfContext).length;
  const skippedSynthesis = removedMessages.filter((m) => m._isSynthesisMessage).length;
  const skippedSystem = removedMessages.filter((m) => m.role === "system").length;
  console.log(
    `[memory] Pre-compaction flush: processing ${substantiveMessages.length} removed messages ` +
    `(skipped: compaction=${skippedCompaction}, outOfContext=${skippedOutOfContext}, synthesis=${skippedSynthesis}, system=${skippedSystem})`
  );

  // Only send the messages being removed, not the full conversation
  const removedText = substantiveMessages
    .map((m, i) => formatMessageForExtraction(m, i))
    .join("\n\n---\n\n");

  const systemPrompt = await buildPreCompactionSystemPrompt();
  const chat = await getChat(chatId).catch(() => null);
  const runHandle = startExtractionRun({
    trigger: "pre-compaction",
    chatId,
    chatTitle: chat?.title,
    model: modelId,
    priorMemoryCount: 0,
    messages: substantiveMessages.map((m) => ({ role: m.role, content: m.content })),
    systemPrompt,
    userPrompt: removedText,
  });

  try {
    // Each removed message becomes one segment; messages that exceed the
    // per-chunk budget (typically huge tool results) get paragraph-split.
    const segments: ExtractSegment[] = substantiveMessages.map((m, i) =>
      messageToExtractionSegment(m, i)
    );

    // Retry happens per-chunk inside extractInChunks.
    const chunkResult = await extractInChunks({
      modelId,
      systemPrompt,
      segments,
      contextLabel: `preCompactionFlush chat=${chatId}`,
    });
    runHandle.attachOutput(chunkResult.rawOutput);

    const facts = chunkResult.facts;
    if (facts.length === 0) {
      console.log("[memory] Pre-compaction flush: no facts extracted");
      runHandle.complete({
        facts: [],
        saved: 0,
        superseded: 0,
        skippedDuplicates: 0,
        errors: 0,
        chunks: { count: chunkResult.chunkCount, failures: chunkResult.chunkFailures, timingsMs: chunkResult.chunkTimingsMs },
      });
      return;
    }

    console.log(`[memory] Pre-compaction flush: ${facts.length} facts extracted across ${chunkResult.chunkCount} chunk(s), embedding batch...`);

    // Batch-embed all facts in a single API call
    let embeddings: number[][];
    try {
      embeddings = await withRetry(
        () => embedBatch(facts.map((f) => f.text)),
        `embedBatch for ${facts.length} pre-compaction facts (chat ${chatId})`
      );
    } catch (e) {
      console.error("[memory] Pre-compaction batch embedding failed:", e);
      runHandle.fail(e);
      return;
    }

    const sourceSpan = sourceSpanFromIndexedMessages(
      substantiveMessages.map((message) => ({ message })),
    );
    const outcome = await dedupAndSave(facts, embeddings, chatId, projectId, "chat", chatId, sourceSpan);

    // Invalidate memories cache so next turn picks up new memories.
    // Block updates are not performed here — they're handled by the main
    // agent during synthesis cycles.
    invalidateMemoriesCache(chatId);

    console.log("[memory] Pre-compaction flush complete");
    runHandle.complete({
      facts: facts.map((f) => ({ text: f.text, category: f.category, importance: f.importance })),
      saved: outcome.added,
      superseded: outcome.superseded,
      skippedDuplicates: outcome.skippedDuplicates,
      errors: 0,
      chunks: { count: chunkResult.chunkCount, failures: chunkResult.chunkFailures, timingsMs: chunkResult.chunkTimingsMs },
    });
  } catch (e) {
    runHandle.fail(e);
    throw e;
  }
}

/**
 * Extract memories from notebook entry content.
 * Reuses the same extraction pipeline as chat messages.
 */
export async function extractMemoriesFromText(
  modelId: string,
  text: string,
  author: 'user' | 'agent',
  entryId: string
): Promise<void> {
  console.log(`[memory] Extracting from ${author} notebook entry ${entryId}`);

  const systemPrompt = await buildExtractionSystemPrompt();
  const authorLabel = author === 'user' ? 'User notebook entry' : 'Agent notebook entry';

  try {
    // Retry happens per-chunk inside extractInChunks.
    const chunkResult = await extractInChunks({
      modelId,
      systemPrompt,
      segments: [{ label: authorLabel, text, splittable: true }],
      contextLabel: `extractMemoriesFromText entry=${entryId}`,
    });

    const facts = chunkResult.facts;
    if (facts.length === 0) {
      console.log("[memory] No facts extracted from notebook entry");
      return;
    }

    console.log(`[memory] Extracted ${facts.length} fact(s) from notebook across ${chunkResult.chunkCount} chunk(s), embedding batch...`);

    let embeddings: number[][];
    try {
      embeddings = await withRetry(
        () => embedBatch(facts.map((f) => f.text)),
        `embedBatch for ${facts.length} notebook facts (entry ${entryId})`
      );
    } catch (e) {
      console.error("[memory] Batch embedding failed:", e);
      return;
    }

    await dedupAndSave(facts, embeddings, '', undefined, author === 'user' ? 'notebook' : 'notebook', entryId);
    console.log("[memory] Notebook memory extraction complete");
  } catch (e) {
    console.error("[memory] Notebook extraction failed:", e);
    throw e;
  }
}

export async function backfillSupersessions(): Promise<void> {
  console.log("[memory] Backfill supersession scan skipped: heuristic supersession is disabled; delayed extraction now performs LLM-reviewed linking.");
}

// ---------------------------------------------------------------------------
// Delayed Full-Chat Extraction
// ---------------------------------------------------------------------------

const DEFAULT_MESSAGE_CAP = 50;
/**
 * Hard cap on the previous-memories list injected into the delayed extraction
 * prompt. Keeps the prompt bounded for long-running chats (system chat) where
 * total chat memories grow without bound. Vector dedup at save time still
 * protects against duplicating older memories that fall outside this window.
 */
const MAX_PREVIOUS_MEMORIES = 30;

interface IndexedChatMessage {
  index: number;
  message: ChatMessage;
}

function isSubstantiveForDelayedExtraction(message: ChatMessage): boolean {
  // Skip persisted memory-delta messages — they're already memories.
  if (message.role === "system") return false;
  return !message._isCompactionSummary && !message._outOfContext && !message._isSynthesisMessage;
}

/**
 * Build context for delayed extraction: messages added since the last
 * extraction watermark + memories created during that same window.
 *
 * Both the message window and the previous-memories list are bounded by the
 * same cutoff so the LLM sees aligned content on both sides — the new
 * messages it should extract from, and the recent memories it should not
 * duplicate. Without this bound the system chat (single long-running thread)
 * grows both sides without limit and re-extracts the same trailing window
 * each run.
 *
 * Returns `hasNewContent=false` when no substantive messages have been added
 * since the watermark — the caller should bump the watermark and skip the LLM
 * call entirely.
 */
async function buildDelayedExtractionContext(
  chat: Chat,
  messageCap: number = DEFAULT_MESSAGE_CAP
): Promise<{
  messages: IndexedChatMessage[];
  previousMemories: Omit<Memory, "embedding">[];
  hasNewContent: boolean;
}> {
  const watermark = chat.lastDelayedExtractionMessageIndex ?? -1;

  const substantiveMessages = chat.messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => isSubstantiveForDelayedExtraction(message));

  // Only include messages added since the last extraction. Cap as a safety
  // net for chats that have accumulated a huge burst of activity between runs.
  const newMessages = substantiveMessages.filter(({ index }) => index > watermark);
  const messages = newMessages.length > messageCap
    ? newMessages.slice(-messageCap)
    : newMessages;

  // Align previousMemories with the message window. Cutoff is the timestamp
  // of the message at the watermark — memories created after that capture both
  // the prior delayed extraction's output and any immediate-extraction memories
  // produced from messages in between. Older memories are off-window; the
  // 0.85 vector-similarity dedup at save time still catches duplicates of them.
  let memoryCutoff: string | undefined;
  if (watermark >= 0 && watermark < chat.messages.length) {
    const watermarkMsg = chat.messages[watermark];
    if (watermarkMsg?.timestamp) {
      memoryCutoff = new Date(watermarkMsg.timestamp).toISOString();
    }
  }

  const allChatMemories = await getMemoriesByChatId(chat.id);
  let previousMemories = memoryCutoff
    ? allChatMemories.filter((m) => m.createdAt >= memoryCutoff!)
    : allChatMemories;
  // getMemoriesByChatId returns ASC by createdAt — keep the most recent N.
  if (previousMemories.length > MAX_PREVIOUS_MEMORIES) {
    previousMemories = previousMemories.slice(-MAX_PREVIOUS_MEMORIES);
  }

  return { messages, previousMemories, hasNewContent: newMessages.length > 0 };
}

/**
 * Delayed extraction system prompt builder.
 * Injects previous memories to avoid duplication and provide context.
 */
function buildDelayedExtractionPrompt(
  previousMemories: Omit<Memory, "embedding">[],
  messageCount: number,
  startIndex: number
): string {
  const memoriesList = previousMemories.length > 0
    ? previousMemories.map((m, i) => `[${i + 1}]: "${m.text}" (${m.category}, importance: ${m.importance})`).join("\n")
    : "(none)";

  return DELAYED_EXTRACTION_USER_TEMPLATE
    .replace("{{PREVIOUS_MEMORIES}}", memoriesList)
    .replace("{{MESSAGE_COUNT}}", String(messageCount))
    .replace("{{START_INDEX}}", String(startIndex));
}

/**
 * Extract memories from a full chat after a period of inactivity.
 * This is the delayed extraction layer — runs once per chat when inactive,
 * capturing patterns and context that immediate extraction missed.
 *
 * @param chatId - The chat to extract from
 * @param modelId - The model to use for extraction
 * @param messageCap - Max messages to include (default 50)
 */
export async function extractDelayedMemories(
  chatId: string,
  modelId: string,
  messageCap: number = DEFAULT_MESSAGE_CAP
): Promise<void> {
  console.log(`[memory-delayed] Starting delayed extraction for chat ${chatId}`);

  const chat = await getChat(chatId);
  if (!chat) {
    console.error(`[memory-delayed] Chat ${chatId} not found`);
    return;
  }

  if (!["agent", "system"].includes(chat.type)) {
    console.log(`[memory-delayed] Skipping ${chat.type} chat ${chatId}`);
    return;
  }

  // Build context: messages added since last extraction + recent memories
  const context = await buildDelayedExtractionContext(chat, messageCap);
  if (!context.hasNewContent) {
    // No substantive messages since the watermark — bump it (covers any
    // non-substantive activity like synthesis messages that updated
    // lastModified) and skip the LLM call.
    console.log(
      `[memory-delayed] No new substantive messages since last extraction for chat ${chatId}, bumping watermark`
    );
    await updateChatExtractionState(chatId, new Date().toISOString(), chat.messages.length - 1);
    return;
  }

  const startIndex = context.messages[0]?.index ?? 0;
  const endIndex = context.messages[context.messages.length - 1]?.index ?? -1;

  console.log(
    `[memory-delayed] Processing ${context.messages.length} messages (${startIndex}-${endIndex}) with ${context.previousMemories.length} previous memories`
  );

  // Build prompt with previous memories injected — used as the per-chunk header
  const userPromptHeader = `${buildDelayedExtractionPrompt(context.previousMemories, context.messages.length, startIndex)}\n\nCONVERSATION:`;

  // Each message is a segment; messages too large for the chunk budget get paragraph-split
  const messageSegments: ExtractSegment[] = context.messages.map(({ message, index }) =>
    messageToExtractionSegment(message, index)
  );

  // Serialize whole conversation for observability (what the debug panel will show)
  const extractionPrompt = `${userPromptHeader}\n${context.messages
    .map(({ message, index }) => formatMessageForExtraction(message, index))
    .join("\n\n---\n\n")}`;
  const systemPrompt = await buildDelayedExtractionSystemPrompt();

  const runHandle = startExtractionRun({
    trigger: "delayed",
    chatId,
    chatTitle: chat.title,
    model: modelId,
    priorMemoryCount: context.previousMemories.length,
    messages: context.messages.map(({ message }) => ({
      role: message.role,
      content: formatMessageContentForExtraction(message),
    })),
    systemPrompt,
    userPrompt: extractionPrompt,
  });

  let runSaved = 0;
  let runSkipped = 0;

  try {
    // Call LLM to extract memories. Chunked if content exceeds extraction
    // budget; retry happens per-chunk inside extractInChunks.
    let chunkResult: ExtractChunkedResult;
    try {
      chunkResult = await extractInChunks({
        modelId,
        systemPrompt,
        segments: messageSegments,
        userPromptHeader,
        contextLabel: `extractDelayedMemories chat=${chatId}`,
      });
    } catch (e) {
      console.error(`[memory-delayed] LLM extraction failed:`, e);
      throw e;
    }
    runHandle.attachOutput(chunkResult.rawOutput);

    const facts = chunkResult.facts;
    if (facts.length === 0) {
      console.log(`[memory-delayed] No new memories extracted from chat ${chatId}`);
      // Still update tracking fields to mark extraction as run
      await updateChatExtractionState(chatId, new Date().toISOString(), chat.messages.length - 1);
      runHandle.complete({
        facts: [],
        saved: 0,
        superseded: 0,
        skippedDuplicates: 0,
        errors: 0,
        chunks: { count: chunkResult.chunkCount, failures: chunkResult.chunkFailures, timingsMs: chunkResult.chunkTimingsMs },
      });
      return;
    }

    console.log(`[memory-delayed] Extracted ${facts.length} new memory(ies) across ${chunkResult.chunkCount} chunk(s), embedding batch...`);

    // Batch-embed all facts
    let embeddings: number[][];
    try {
      embeddings = await withRetry(
        () => embedBatch(facts.map((f) => f.text)),
        `embedBatch for ${facts.length} delayed memories (chat ${chatId})`
      );
    } catch (e) {
      console.error("[memory-delayed] Batch embedding failed:", e);
      throw e;
    }

    // Save with sourceType = 'chat_delayed'
    // Collect ambiguous supersession candidates for batch comparison
    const ambiguousCandidates: DedupAndSaveAmbiguousCandidate[] = [];
    const runStartedAt = new Date().toISOString();
    const sourceSpan = sourceSpanFromIndexedMessages(context.messages);

    for (let i = 0; i < facts.length; i++) {
      const fact = facts[i];
      const factEmbedding = embeddings[i];

      const candidates = await findSimilarMemoryCandidates(
        factEmbedding,
        SUPERSESSION_CANDIDATE_THRESHOLD,
        SUPERSESSION_CANDIDATE_LIMIT
      );
      const duplicate = candidates.find((candidate) =>
        isNearDuplicate(fact.text, candidate.memory.text, candidate.similarity)
      );

      if (duplicate) {
        console.log(
          `[memory-delayed] Near-identical match (sim=${duplicate.similarity.toFixed(3)}), bumping metadata: "${duplicate.memory.text}"`
        );
        await updateMemory(duplicate.memory.id, {
          importance: Math.max(duplicate.memory.importance, fact.importance),
          lastAccessed: new Date().toISOString(),
        });
        runSkipped++;
        continue;
      }

      const newMemoryId = await saveExtractedMemory(
        fact,
        factEmbedding,
        chatId,
        chat.projectId,
        "chat_delayed",
        chatId,
        sourceSpan,
      );
      runSaved++;

      for (const candidate of candidates) {
        if (candidate.memory.supersededBy) continue;
        if (new Date(candidate.memory.createdAt).toISOString() >= runStartedAt) continue;
        if (isNearDuplicate(fact.text, candidate.memory.text, candidate.similarity)) continue;

        const overlap = textOverlapScore(fact.text, candidate.memory.text);
        console.log(
          `[memory-delayed] Queuing comparison (sim=${candidate.similarity.toFixed(3)}, overlap=${overlap.toFixed(2)}): "${fact.text}" vs "${candidate.memory.text}"`
        );
        ambiguousCandidates.push({
          factIndex: i,
          newMemoryId,
          newText: fact.text,
          oldMemoryId: candidate.memory.id,
          oldText: candidate.memory.text,
          embeddingSimilarity: candidate.similarity,
          textOverlap: overlap,
        });
      }
    }

    // Batch LLM comparison for ambiguous supersession candidates
    let comparisonSuperseded = 0;
    let comparisonSeparate = 0;
    let resolutions: ExtractionSupersessionResolution[] = [];

    if (ambiguousCandidates.length > 0) {
      console.log(`[memory-delayed] Running batch comparison for ${ambiguousCandidates.length} ambiguous candidate(s)...`);

      // Build conversation context for the comparison
      const conversationContext = context.messages
        .map(({ message, index }) => formatMessageForExtraction(message, index))
        .join("\n\n---\n\n");

      const comparisonResults = await batchCompareSupersessions(
        ambiguousCandidates,
        conversationContext,
        modelId
      );

      const applyResult = await applyComparisonResolutions(comparisonResults, ambiguousCandidates);
      comparisonSuperseded = applyResult.superseded;
      comparisonSeparate = applyResult.separate;

      // Build resolution records for observability
      resolutions = comparisonResults.map((res, i) => ({
        newFactIndex: ambiguousCandidates[i].factIndex,
        newFactText: ambiguousCandidates[i].newText,
        existingMemoryId: res.oldMemoryId,
        existingMemoryText: ambiguousCandidates[i].oldText,
        embeddingSimilarity: ambiguousCandidates[i].embeddingSimilarity,
        textDiffOverlap: ambiguousCandidates[i].textOverlap,
        decision: res.decision,
        reason: res.reason,
      }));
    }

    // Update chat tracking fields without touching lastModified
    await updateChatExtractionState(chatId, new Date().toISOString(), chat.messages.length - 1);

    console.log(`[memory-delayed] Extraction complete for chat ${chatId}`);
    runHandle.complete({
      facts: facts.map((f) => ({ text: f.text, category: f.category, importance: f.importance })),
      saved: runSaved,
      superseded: comparisonSuperseded,
      skippedDuplicates: runSkipped,
      errors: 0,
      supersessionResolutions: resolutions.length > 0 ? resolutions : undefined,
      comparisonSuperseded,
      comparisonSeparate,
      chunks: { count: chunkResult.chunkCount, failures: chunkResult.chunkFailures, timingsMs: chunkResult.chunkTimingsMs },
    });
  } catch (e) {
    runHandle.fail(e);
    throw e;
  }
}
