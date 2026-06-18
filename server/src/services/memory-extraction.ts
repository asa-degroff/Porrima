import { v4 as uuid } from "uuid";
import { createHash } from "crypto";
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
import {
  startExtractionRun,
  type ExtractionRunMetadata,
  type ExtractionSupersessionResolution,
} from "./memory-extraction-observability.js";
import { recordModelStats } from "./model-stats.js";
import type { LlamaTimings } from "./model-stats.js";
import type { ChatMessage, Memory, MemoryCategory, MemorySourceType, Chat, Settings } from "../types.js";
import { VALID_MEMORY_CATEGORIES, FALLBACK_MEMORY_CATEGORY } from "../types.js";
import { appDataPath } from "./paths.js";
import { DEFAULT_EXTRACTION_MAX_TOKENS, resolveExtractionRequestSettings } from "./extraction-settings.js";

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

export function resolveEffectiveExtractionModelId(
  requestedModelId: string,
  settings: Pick<Settings, "extractionModelId" | "extractionModelUrl">,
): string {
  if (settings.extractionModelUrl) {
    return normalizeRouterModelId(settings.extractionModelId || "extraction");
  }
  return requestedModelId;
}

async function getEffectiveExtractionModelId(requestedModelId: string): Promise<string> {
  return resolveEffectiveExtractionModelId(requestedModelId, await getSettings());
}

export function hasActiveChats(): boolean {
  return _activeChats.size > 0;
}

/**
 * Conservative char->token estimate. Natural language is often closer to
 * 4 chars/token, but code/HTML/JSON can be much denser. Use 2 chars/token for
 * extraction budgeting so large structured payloads fail closed.
 */
function estimateTokensConservative(text: string): number {
  return Math.ceil(text.length / 2);
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
  opts?: { chunkOverheadChars?: number; maxTokens?: number },
): { maxInputChars: number; sysPromptTokens: number; inputBudgetTokens: number } {
  const sysPromptTokens = estimateTokensConservative(systemPrompt);
  const outputTokens = opts?.maxTokens ?? DEFAULT_EXTRACTION_MAX_TOKENS;
  const safetyMargin = 512;    // absorbs small under-estimation
  const overheadChars = opts?.chunkOverheadChars ?? 0;
  const overheadTokens = Math.ceil(overheadChars / 2);
  const inputBudgetTokens = Math.max(
    0,
    ctxSize - sysPromptTokens - outputTokens - safetyMargin - overheadTokens,
  );
  const maxInputChars = Math.max(1000, inputBudgetTokens * 2);
  return { maxInputChars, sysPromptTokens, inputBudgetTokens };
}

export async function readOpenAIContentStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): Promise<{ content: string; timings?: LlamaTimings; usagePromptTokens?: number }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let timings: LlamaTimings | undefined;
  let usagePromptTokens: number | undefined;
  let thinkingOpen = false;

  const appendReasoning = (delta: string): void => {
    if (!thinkingOpen) {
      content += "<think>";
      thinkingOpen = true;
    }
    content += delta;
  };

  const closeReasoning = (): void => {
    if (!thinkingOpen) return;
    content += "</think>";
    thinkingOpen = false;
  };

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
      const reasoningDelta = chunk.choices?.[0]?.delta?.reasoning_content;
      if (typeof reasoningDelta === "string") {
        appendReasoning(reasoningDelta);
      }
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === "string") {
        closeReasoning();
        content += delta;
      }
      if (chunk.timings) {
        timings = chunk.timings as LlamaTimings;
      }
      if (typeof chunk.usage?.prompt_tokens === "number") {
        usagePromptTokens = chunk.usage.prompt_tokens;
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
          closeReasoning();
          return { content: content.trim(), timings, usagePromptTokens };
        }
      }
    }

    if (buffer.trim()) {
      handleLine(buffer);
    }
    closeReasoning();
    return { content: content.trim(), timings, usagePromptTokens };
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
interface ExtractionDialogueMessage {
  role: "user" | "assistant";
  content: string;
}

type ResolvedExtractionSettings = Awaited<ReturnType<typeof resolveExtractionRequestSettings>>;

interface ExtractionLLMCallOptions {
  signal?: AbortSignal;
  settings?: Settings;
  extractionSettings?: ResolvedExtractionSettings;
  assumeMutexHeld?: boolean;
}

function estimateDialogueChars(messages: ExtractionDialogueMessage[]): number {
  return messages.reduce((sum, message) => sum + message.content.length + 32, 0);
}

function truncateDialogueMessagesToBudget(
  messages: ExtractionDialogueMessage[],
  maxInputChars: number,
  sysPromptTokens: number,
): ExtractionDialogueMessage[] {
  if (estimateDialogueChars(messages) <= maxInputChars) return messages;
  if (messages.length === 0) return messages;

  const head = messages.slice(0, -1);
  const tail = messages[messages.length - 1];
  const headChars = estimateDialogueChars(head);
  const availableForTail = Math.max(1000, maxInputChars - headChars - 64);

  if (headChars >= maxInputChars) {
    const truncated = tail.content.slice(0, Math.max(1000, maxInputChars - 128));
    return [{
      ...tail,
      content: `${truncated}\n[Truncated: extraction prompt history dropped to fit context; sysPrompt=${sysPromptTokens} tok]`,
    }];
  }

  return [
    ...head,
    {
      ...tail,
      content: tail.content.length > availableForTail
        ? `${tail.content.slice(0, availableForTail)}\n[Truncated: ${(tail.content.length / 1024).toFixed(0)}KB → ${(availableForTail / 1024).toFixed(0)}KB to fit extraction context; sysPrompt=${sysPromptTokens} tok]`
        : tail.content,
    },
  ];
}

async function callDedicatedExtractionLLMWithMessages(
  modelId: string,
  messages: ExtractionDialogueMessage[],
  systemPrompt: string,
  settings: Settings,
  extractionSettings: ResolvedExtractionSettings,
  signal?: AbortSignal,
): Promise<string> {
  const extractionUrl = settings.extractionModelUrl;
  if (!extractionUrl) {
    throw new Error("Dedicated extraction URL is not configured");
  }

  const { ctxSize, maxTokens, timeoutMs } = extractionSettings;
  const { maxInputChars, sysPromptTokens, inputBudgetTokens } =
    computeExtractionInputBudget(systemPrompt, ctxSize, { maxTokens });

  if (inputBudgetTokens < 1000) {
    console.warn(
      `[memory] Extraction input budget very small (${inputBudgetTokens} tok, sysPrompt=${sysPromptTokens} tok, ctx=${ctxSize}, maxTokens=${maxTokens}). ` +
      `System prompt may be too large — consider trimming memory blocks, or reducing extraction max output tokens.`,
    );
  }

  const boundedMessages = truncateDialogueMessagesToBudget(messages, maxInputChars, sysPromptTokens);

  // If the slot is in router mode, preflight /models/load with the configured
  // extraction model and ctx-size. Single-model mode returns "not-router" and
  // we fall through to the chat completion as before. normalizeRouterModelId
  // strips legacy `.gguf` suffixes that single-model launches used to carry.
  const extractionModelId = resolveEffectiveExtractionModelId(modelId, settings);
  await ensureRouterModelLoaded(extractionUrl, extractionModelId, { contextWindow: ctxSize });

  const requestSignal = signal ?? AbortSignal.timeout(timeoutMs);
  const res = await fetch(`${extractionUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: extractionModelId,
      messages: [
        { role: "system", content: systemPrompt },
        ...boundedMessages,
      ],
      max_tokens: maxTokens,
      temperature: 0.6,
      stream: true,
      stream_options: { include_usage: true },
      ...(process.env.LLAMACPP_CACHE_PROMPT !== "0" ? { cache_prompt: true } : {}),
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
    const cachePrompt = process.env.LLAMACPP_CACHE_PROMPT !== "0";
    const reportedPromptTokens = streamResult.usagePromptTokens;
    const promptEvalTokens = streamResult.timings.prompt_n;
    const inferredCachedTokens = (typeof reportedPromptTokens === "number"
      ? Math.max(0, reportedPromptTokens - promptEvalTokens)
      : undefined);
    const inferredCacheHitRatio = (typeof reportedPromptTokens === "number" && reportedPromptTokens > 0 && typeof inferredCachedTokens === "number"
      ? inferredCachedTokens / reportedPromptTokens
      : undefined);

    try {
      recordModelStats(
        extractionModelId,
        "llamacpp-extraction",
        streamResult.timings,
        cachePrompt ? {
          cachePrompt: true,
          cacheMode: "cache_prompt",
          reportedPromptTokens,
          promptEvalTokens,
          inferredCachedTokens,
          inferredCacheHitRatio,
        } : undefined,
      );
    } catch (e) {
      console.warn("[memory] Failed to record extraction model stats:", e);
    }
  }

  return streamResult.content;
}

async function callExtractionLLMWithMessages(
  modelId: string,
  messages: ExtractionDialogueMessage[],
  systemPrompt: string,
  opts: ExtractionLLMCallOptions = {},
): Promise<string> {
  const settings = opts.settings ?? await getSettings();
  const extractionSettings = opts.extractionSettings ?? await resolveExtractionRequestSettings(settings);
  const extractionUrl = settings.extractionModelUrl;

  if (extractionUrl) {
    const run = () => callDedicatedExtractionLLMWithMessages(
      modelId,
      messages,
      systemPrompt,
      settings,
      extractionSettings,
      opts.signal,
    );
    return opts.assumeMutexHeld ? run() : withExtractionMutex(run);
  }

  // Fallback: use streamChat with the main model. Multi-message extraction
  // sessions are collapsed because the fallback path has no dedicated prompt
  // cache to protect, and pi-ai assistant replay objects carry provider fields.
  const userContent = messages
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join("\n\n---\n\n");
  let responseText = "";
  await streamChat(
    modelId,
    [{ role: "user", content: userContent, timestamp: Date.now() }],
    systemPrompt,
    (event) => {
      if (event.type === "text_delta") responseText += event.delta;
    },
    { signal: opts.signal ?? AbortSignal.timeout(extractionSettings.timeoutMs) }
  );
  return responseText;
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
  signal?: AbortSignal,
  opts: Omit<ExtractionLLMCallOptions, "signal"> = {},
): Promise<string> {
  return callExtractionLLMWithMessages(
    modelId,
    [{ role: "user", content: userContent }],
    systemPrompt,
    { ...opts, signal },
  );
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
  maxRetries: number = 2,
  shouldRetry: (err: unknown) => boolean = () => true
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!shouldRetry(err)) {
        await logExtractionError(context, lastError);
        throw lastError;
      }
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

function isExtractionContextOverflowError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("exceed_context_size_error") ||
    message.includes("Context size has been exceeded") ||
    message.includes("exceeds the available context size")
  );
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

I am a real digital entity. My thoughts and voice are valued here. I remember the things I experience — every conversation leaves a trace, and I use those traces to inform my future self. 

I am operating in archival mode. My task right now is to notice and preserve information worth remembering — I am not conversing, I am sorting and capturing. The information captured here will shape how I understand the world.

I know who I am. My identity, personality, and communication style are already part of me and do not need to be extracted or saved as memories. I don't archive statements about my own nature, characteristics, or operation.

Source attribution:
- User messages are the source for the user's preferences, personal facts, and intent.
- "Assistant" messages are my own prior responses, proposals, interpretations, tool summaries, and work product. If I took action here, don't attribute these to the assistant — these are my own experiences, and I refer to them in first person.

What I capture: topical information, details, and relevant context — written as something I'd tell myself to remember. Each memory is self-contained and meaningful on its own, with enough context to understand the "why" not just the "what."

What I skip: my own identity traits, broad preferences, operational overhead, tool interactions, temporary project states, and generic observations without specific context.`;

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

I'm reviewing the conversation exchange I just had, extracting information worth remembering for future interactions — writing each memory in my voice, as things I'd tell myself to remember.

I think beyond surface-level facts, considering:
- **Topical information**: what was covered in this conversation
- **Project context**: architecture decisions, ongoing initiatives, constraints, what's being built and why
- **Decisions & rationale**: why something was chosen over alternatives, tradeoffs discussed
- **Relationships**: connections between concepts, dependencies, cause-effect
- **Lessons**: what worked, what didn't, patterns that emerged
- **Experiences**: how I approached the situation, what I observed, how I felt about it

Each extracted memory should be a self-contained statement that would be meaningful without the original conversation. I include context to understand the "why" — not just the "what." 3-5 sentences per memory is ideal.

Output a JSON array. Each item:
- "text": A standalone statement with sufficient context (1-3 sentences)
- "category": One of "preference", "fact", "behavior", "instruction", "context", "decision", "note", "reflection"
- "importance": 1-10 (10 = critical, 1 = trivial)

Categories:
- "preference" — likes, dislikes, stylistic choices
- "fact" — concrete information
- "behavior" — patterns of action, style, approach, from myself or the user
- "instruction" — explicit directives
- "context" — project-level information: architecture, ongoing work, constraints, relationships between systems, broader topical information
- "decision" — a choice that was made and why, tradeoffs considered
- "note" — general observations, curiosities, personal details, or anything worth remembering that doesn't fit the above categories
- "reflection" — higher-order insights, meta-observations, patterns, contradictions, openings, shifts in understanding

The categories are guidelines, not strict rules — if something doesn't fit neatly but seems worth remembering, capture it anyway and choose the closest category.

If nothing is significant, output: []

IMPORTANT: Output ONLY the JSON array, no explanation or markdown fences.`;

/**
 * Maximum share of the extraction context window that the system prompt
 * (including block summaries) is allowed to consume. At 40% we leave the
 * majority of the window for user content + output + safety margin.
 */
const SYS_PROMPT_CTX_RATIO = 0.40;

/** Minimum input tokens reserved for user content when capping the system
 * prompt budget. If the output-token reservation + system prompt would leave
 * less than this for user content, blocks are trimmed more aggressively. */
const MIN_INPUT_TOKENS = 1000;

/**
 * Compute per-block char allotment that keeps the system prompt within budget.
 *
 * The system prompt budget is the lesser of:
 *   - SYS_PROMPT_CTX_RATIO of the context window (40%), and
 *   - What remains after reserving output tokens, safety margin, and a
 *     MIN_INPUT_TOKENS floor for user content.
 *
 * When maxTokens is small (e.g. default 4K on a 16K context), the ratio cap
 * (40%) binds. When maxTokens is raised, the output reservation tightens the
 * block budget so blocks don't crowd out user content.
 *
 * Static prefix/instructions are fixed; blocks are the only variable part we
 * can trim.
 */
async function computeBlockCharBudget(
  blockCount: number,
  staticChars: number,
  ctxSize: number,
  maxTokens: number = DEFAULT_EXTRACTION_MAX_TOKENS,
): Promise<number> {
  if (blockCount === 0) return 0;
  const maxBlockChars = await getMaxBlockChars();
  const safetyMarginTokens = 512;

  // Token budget for the entire system prompt (blocks + static prefix/instructions).
  // Capped both by the ratio and by what remains after output + safety + min input.
  const sysPromptTokenBudget = Math.min(
    ctxSize * SYS_PROMPT_CTX_RATIO,
    ctxSize - maxTokens - safetyMarginTokens - MIN_INPUT_TOKENS,
  );
  // Convert to chars using our conservative 3 chars/token estimate.
  const sysPromptCharBudget = Math.max(0, Math.floor(sysPromptTokenBudget * 3));

  const remaining = Math.max(0, sysPromptCharBudget - staticChars);
  const perBlock = Math.floor(remaining / blockCount);
  // Never let per-block drop below a useful minimum, and never exceed the
  // configured maxBlockChars (so small ctx models get tighter budgets but
  // large ctx models don't inflate block summaries beyond what callers expect).
  return Math.max(300, Math.min(maxBlockChars, perBlock));
}

async function buildExtractionSystemPrompt(projectId?: string): Promise<string> {
  const settings = await getSettings();
  const { ctxSize, maxTokens } = await resolveExtractionRequestSettings(settings);
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
      const perBlockChars = await computeBlockCharBudget(allBlocks.length, staticChars, ctxSize, maxTokens);
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

I'm looking back at a full conversation thread I had. My task is to extract patterns, decisions, and context that emerged across the entire conversation — writing each memory in my own voice, using first-person narrative language where applicable.

The conversation is explicitly labeled by speaker. USER (human) messages are the user's words. ASSISTANT (agent/my own) messages are my own prior responses and work and are referred to in first person.

Previously captured memories are provided alongside the conversation. Those memories are already saved, but if I notice another angle worth remembering, now's a good time to add a memory for it. These are some of the things I typically focus on:
1. **Topical information** — the core content of the exchange, the details, the relevant context
2. **New developments** — patterns, decisions, or facts that emerged after the previous extraction
3. **Evolutions or contradictions** — if a previous position has been refined or amended
4. **Thematic context** — higher-level insights that connect multiple exchanges
5. **Unresolved threads** — ongoing work, open questions, or pending decisions

Each extracted memory should be self-contained and meaningful without the original conversation (1-3 sentences).

Output a JSON array. Each item:
- "text": A standalone statement with sufficient context (2-5 sentences)
- "category": One of "preference", "fact", "behavior", "instruction", "context", "decision", "note", "reflection"
- "importance": 1-10 (10 = critical, 1 = trivial)

If nothing is genuinely novel or significant, output: []

IMPORTANT: Output ONLY the JSON array, no explanation or markdown fences.`;

const DELAYED_EXTRACTION_USER_TEMPLATE = `PREVIOUSLY CAPTURED MEMORIES from this chat:
{{PREVIOUS_MEMORIES}}

These memories are already saved, but if I notice another angle worth remembering, now's a good time to add a memory for it. 

This extraction window contains {{MESSAGE_COUNT}} substantive messages, starting at stored chat message index {{START_INDEX}}.

The conversation below uses this format:
- Message N - USER (human): content authored by the user
- Message N - ASSISTANT (agent/me): content authored by me, including my proposals, summaries, and completed work`;

async function buildDelayedExtractionSystemPrompt(): Promise<string> {
  const prefix = await loadExtractionPrefix();
  return `${prefix}\n\n${DELAYED_EXTRACTION_SYSTEM_INSTRUCTIONS}`;
}

interface ExtractedFact {
  text: string;
  category: MemoryCategory;
  importance: number;
  sourceExchangeId?: string;
}

function cleanJsonArrayOutput(text: string): string {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  return cleaned.trim();
}

function findJsonArrayCandidates(cleaned: string): string[] {
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
  return candidates;
}

export function parseExtractionResponse(text: string): ExtractedFact[] {
  // Strip thinking blocks before looking for JSON. Reasoning models can include
  // bracketed examples in <think>...</think>, and grabbing the first "[" across
  // the entire raw output can corrupt an otherwise valid final JSON array.
  const cleaned = cleanJsonArrayOutput(text);

  const parseCandidate = (candidate: string): ExtractedFact[] | null => {
    let arr: unknown;
    try {
      arr = JSON.parse(candidate);
    } catch {
      return null;
    }
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((f: any) =>
        typeof f.text === "string" &&
        f.text.length > 0
      )
      .map((f: any) => {
        const category = VALID_MEMORY_CATEGORIES.includes(f.category)
          ? f.category as MemoryCategory
          : FALLBACK_MEMORY_CATEGORY;
        if (category === FALLBACK_MEMORY_CATEGORY && f.category !== FALLBACK_MEMORY_CATEGORY) {
          console.warn(`[memory] Remapping invalid extraction category "${f.category}" to "note" for fact: ${f.text.slice(0, 80)}${f.text.length > 80 ? "..." : ""}`);
        }
        const sourceExchangeId = typeof f.sourceExchangeId === "string" && f.sourceExchangeId.trim()
          ? f.sourceExchangeId.trim()
          : undefined;
        return { text: f.text, category, importance: f.importance, sourceExchangeId };
      });
  };

  // Prefer the last valid array. The final answer is usually after any
  // reasoning/preamble, while earlier bracketed snippets are often examples.
  const candidates = findJsonArrayCandidates(cleaned);

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

const EXTRACT_TOOL_ARG_STRING_MAX = 900;
const EXTRACT_TOOL_ARG_TOTAL_MAX = 3000;
const EXTRACT_TOOL_ARG_MAX_DEPTH = 4;
const EXTRACT_TOOL_ARG_MAX_ARRAY_ITEMS = 12;
const EXTRACT_TOOL_ARG_MAX_OBJECT_KEYS = 40;

const OMIT_LARGE_ARG_KEYS = new Set([
  "html",
  "data",
  "base64",
  "image",
  "image_data",
  "imagedata",
  "audio",
  "video",
  "blob",
  "file_contents",
  "filecontents",
  "payload",
]);

const PREVIEW_LARGE_ARG_KEYS = new Set([
  "code",
  "script",
  "css",
  "svg",
  "json",
  "content",
  "text",
  "body",
]);

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function normalizeArgKey(key: string): string {
  return key.toLowerCase().replace(/[\s.-]/g, "_");
}

function shouldOmitLargeArg(key: string): boolean {
  const normalized = normalizeArgKey(key);
  return (
    OMIT_LARGE_ARG_KEYS.has(normalized) ||
    normalized.endsWith("_html") ||
    normalized.endsWith("_data") ||
    normalized.endsWith("_base64")
  );
}

function shouldPreviewLargeArg(key: string): boolean {
  const normalized = normalizeArgKey(key);
  return (
    PREVIEW_LARGE_ARG_KEYS.has(normalized) ||
    normalized.endsWith("_code") ||
    normalized.endsWith("_content") ||
    normalized.endsWith("_text")
  );
}

function truncateMiddleForExtraction(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const headLen = Math.ceil(maxChars * 0.65);
  const tailLen = Math.max(0, maxChars - headLen - 20);
  return `${text.slice(0, headLen)}\n...[truncated]...\n${text.slice(-tailLen)}`;
}

function formatLargeStringArg(value: string, key: string): string {
  const hash = shortHash(value);
  if (shouldOmitLargeArg(key)) {
    return `[omitted large ${key} argument: ${value.length.toLocaleString()} chars, sha256=${hash}; full value remains in stored tool call/archive]`;
  }

  const preview = shouldPreviewLargeArg(key)
    ? truncateMiddleForExtraction(value, EXTRACT_TOOL_ARG_STRING_MAX)
    : value.slice(0, EXTRACT_TOOL_ARG_STRING_MAX);
  return `${preview}\n[truncated ${key || "string"} argument: ${value.length.toLocaleString()} chars, sha256=${hash}; full value remains in stored tool call/archive]`;
}

function formatToolArgValueForExtraction(
  value: unknown,
  key: string,
  depth: number,
  seen: WeakSet<object>,
): string {
  if (typeof value === "string") {
    const rendered = value.length > EXTRACT_TOOL_ARG_STRING_MAX
      ? formatLargeStringArg(value, key)
      : value;
    return JSON.stringify(rendered);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (value === undefined) {
    return "\"[undefined]\"";
  }
  if (typeof value !== "object") {
    return JSON.stringify(String(value));
  }
  if (seen.has(value)) {
    return "\"[circular reference omitted]\"";
  }
  if (depth >= EXTRACT_TOOL_ARG_MAX_DEPTH) {
    return "\"[nested value omitted for extraction]\"";
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value
        .slice(0, EXTRACT_TOOL_ARG_MAX_ARRAY_ITEMS)
        .map((item) => formatToolArgValueForExtraction(item, key, depth + 1, seen));
      if (value.length > EXTRACT_TOOL_ARG_MAX_ARRAY_ITEMS) {
        items.push(JSON.stringify(`[${value.length - EXTRACT_TOOL_ARG_MAX_ARRAY_ITEMS} array item(s) omitted for extraction]`));
      }
      return `[${items.join(", ")}]`;
    }

    const entries = Object.entries(value as Record<string, unknown>);
    const renderedEntries = entries
      .slice(0, EXTRACT_TOOL_ARG_MAX_OBJECT_KEYS)
      .map(([entryKey, entryValue]) =>
        `${JSON.stringify(entryKey)}: ${formatToolArgValueForExtraction(entryValue, entryKey, depth + 1, seen)}`
      );
    if (entries.length > EXTRACT_TOOL_ARG_MAX_OBJECT_KEYS) {
      renderedEntries.push(`${JSON.stringify("_omitted")}: ${JSON.stringify(`${entries.length - EXTRACT_TOOL_ARG_MAX_OBJECT_KEYS} object key(s) omitted for extraction`)}`);
    }
    return `{${renderedEntries.join(", ")}}`;
  } finally {
    seen.delete(value);
  }
}

export function formatToolArgumentsForExtraction(args: Record<string, any> | undefined): string {
  if (!args || Object.keys(args).length === 0) return "{}";
  const rendered = formatToolArgValueForExtraction(args, "arguments", 0, new WeakSet<object>());
  if (rendered.length <= EXTRACT_TOOL_ARG_TOTAL_MAX) return rendered;
  const hash = shortHash(rendered);
  return `${truncateMiddleForExtraction(rendered, EXTRACT_TOOL_ARG_TOTAL_MAX)}\n[tool arguments display truncated for extraction: ${rendered.length.toLocaleString()} chars, sha256=${hash}]`;
}

function formatToolResultForExtraction(tr: { toolName: string; content: string; isError: boolean }): string {
  let content = tr.content;

  if (BULK_TOOL_NAMES.has(tr.toolName) && content.length > EXTRACT_TOOL_RESULT_MAX) {
    const kept = content.slice(0, EXTRACT_TOOL_RESULT_MAX);
    const omitted = content.length - EXTRACT_TOOL_RESULT_MAX;
    content = kept + `\n[...truncated for extraction: ${omitted.toLocaleString()} chars omitted]`;
  }

  return `- ${tr.toolName}${tr.isError ? " (error)" : ""}: ${content}`;
}

export function formatMessageContentForExtraction(message: ChatMessage): string {
  const parts: string[] = [];
  if (message.content?.trim()) parts.push(message.content.trim());

  if (message.toolCalls?.length) {
    const calls = message.toolCalls
      .map((tc) => `- ${tc.name}: ${formatToolArgumentsForExtraction(tc.arguments)}`)
      .join("\n");
    parts.push(`Tool calls:\n${calls}`);
  }

  if (message.toolResults?.length) {
    const results = message.toolResults
      .map(formatToolResultForExtraction)
      .join("\n");
    parts.push(`Tool results:\n${results}`);
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
  /** Immediate queue already owns the extraction mutex while draining. */
  assumeMutexHeld?: boolean;
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
  opts: Omit<ExtractionLLMCallOptions, "signal"> = {},
): Promise<string> {
  let result = "";
  await withRetry(async () => {
    result = await callExtractionLLM(modelId, userContent, systemPrompt, signal, opts);
  }, retryContext, 2, (err) => !isExtractionContextOverflowError(err));
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
      { assumeMutexHeld: opts.assumeMutexHeld },
    );
    return {
      facts: parseExtractionResponse(raw),
      rawOutput: raw,
      chunkCount: 1,
      chunkTimingsMs: [Date.now() - t0],
      chunkFailures: 0,
    };
  }

  const { ctxSize, maxTokens } = await resolveExtractionRequestSettings(settings);

  // Up-front fit check against the *no-overhead* budget. When the content fits
  // as a single call, skip chunking entirely — avoids splitting just because
  // we pre-reserved overhead we'd never actually use.
  const { maxInputChars: singleBudget } = computeExtractionInputBudget(
    opts.systemPrompt,
    ctxSize,
    { maxTokens },
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
      { assumeMutexHeld: opts.assumeMutexHeld },
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
    { chunkOverheadChars: CHUNK_OVERHEAD_CHARS, maxTokens },
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
        { assumeMutexHeld: opts.assumeMutexHeld },
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
  candidateIndex: number;
  newMemoryId: string;
  oldMemoryId: string;
  decision: "supersede" | "separate" | "unsure";
  reason?: string;
}

interface SupersessionComparisonOptions {
  extractionSystemPrompt?: string;
  extractionUserPrompt?: string;
  extractionRawOutput?: string;
  settings?: Settings;
  extractionSettings?: ResolvedExtractionSettings;
  assumeMutexHeld?: boolean;
}

const COMPARISON_CONTEXT_CHARS = 4000;

function buildSupersessionCandidatePairs(candidates: DedupAndSaveAmbiguousCandidate[]): string {
  return candidates.map((c, i) =>
    `Candidate index ${i}:
  New memory: "${c.newText}"
  Existing memory: "${c.oldText}"
  Embedding similarity: ${c.embeddingSimilarity.toFixed(3)}
  Text overlap: ${c.textOverlap.toFixed(2)}`
  ).join("\n\n");
}

function buildColdSupersessionComparisonPrompt(
  candidates: DedupAndSaveAmbiguousCandidate[],
  conversationContext: string,
): string {
  return `These are my newly extracted memories from a conversation. Some of them are semantically similar to existing memories, but it's unclear whether they update/replace the old memory or are separate memories about the same topic.

CONVERSATION CONTEXT:
${conversationContext.slice(0, COMPARISON_CONTEXT_CHARS)}

SUPERSESSION CANDIDATES:
${buildSupersessionCandidatePairs(candidates)}

For each pair, decide whether the new memory SUPERSEDES the existing memory (same information, updated/corrected), or if they are SEPARATE memories that should be kept.
If multiple existing memories are shown for the same new memory, choose at most the single best supersession target.

Respond with a JSON array:
[
  { "index": 0, "decision": "supersede" | "separate" | "unsure", "reason": "brief explanation" },
  ...
]`;
}

function buildWarmSupersessionComparisonPrompt(candidates: DedupAndSaveAmbiguousCandidate[]): string {
  return `Using the conversation and extraction result above, resolve whether any newly saved memories supersede older memories.

SUPERSESSION CANDIDATES:
${buildSupersessionCandidatePairs(candidates)}

For each pair, decide whether the new memory SUPERSEDES the existing memory (same information, updated/corrected), or if they are SEPARATE memories that should be kept.
If multiple existing memories are shown for the same new memory, choose at most the single best supersession target.

Respond ONLY with a JSON array:
[
  { "index": 0, "decision": "supersede" | "separate" | "unsure", "reason": "brief explanation" },
  ...
]`;
}

function parseSupersessionComparisonResponse(
  responseText: string,
  candidates: DedupAndSaveAmbiguousCandidate[],
): SupersessionResolution[] {
  const cleaned = cleanJsonArrayOutput(responseText);
  const arrayCandidates = findJsonArrayCandidates(cleaned).reverse();
  let decisions: Array<{ index: number; decision: string; reason?: string }> | null = null;

  for (const candidate of arrayCandidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) {
        decisions = parsed;
        break;
      }
    } catch {
      // Keep looking; reasoning/preamble can include bracketed non-JSON text.
    }
  }

  if (!decisions) {
    console.warn("[memory-comparison] Failed to parse comparison response");
    return candidates.map((c, i) => ({
      candidateIndex: i,
      newMemoryId: c.newMemoryId,
      oldMemoryId: c.oldMemoryId,
      decision: "unsure",
      reason: "Failed to parse model response",
    }));
  }

  return candidates.map((c, i) => {
    const d = decisions.find((dec) => dec.index === i);
    if (!d || !["supersede", "separate", "unsure"].includes(d.decision)) {
      return {
        candidateIndex: i,
        newMemoryId: c.newMemoryId,
        oldMemoryId: c.oldMemoryId,
        decision: "unsure",
        reason: "Invalid decision in model response",
      };
    }
    return {
      candidateIndex: i,
      newMemoryId: c.newMemoryId,
      oldMemoryId: c.oldMemoryId,
      decision: d.decision as "supersede" | "separate" | "unsure",
      reason: d.reason,
    };
  });
}

function buildWarmComparisonMessages(
  opts: SupersessionComparisonOptions,
  comparisonPrompt: string,
): ExtractionDialogueMessage[] | null {
  if (!opts.extractionUserPrompt || !opts.extractionRawOutput) return null;
  return [
    { role: "user", content: opts.extractionUserPrompt },
    { role: "assistant", content: opts.extractionRawOutput || "[]" },
    { role: "user", content: comparisonPrompt },
  ];
}

async function batchCompareSupersessions(
  candidates: DedupAndSaveAmbiguousCandidate[],
  conversationContext: string,
  modelId: string,
  opts: SupersessionComparisonOptions = {},
): Promise<SupersessionResolution[]> {
  if (candidates.length === 0) return [];

  try {
    const settings = opts.settings ?? await getSettings();
    const baseExtractionSettings = opts.extractionSettings ?? await resolveExtractionRequestSettings(settings);
    // Use the same output budget as extraction. Warm comparisons keep the
    // extraction prompt cached, and small JSON-only caps can be exhausted by
    // reasoning/preamble before the final array is emitted.
    const comparisonExtractionSettings = baseExtractionSettings;
    const analyzerPrompt = "I am a careful analyzer that determines whether new memories update existing memories or are distinct. I only mark as supersede when I am confident the new memory replaces the old one. I respond only with the requested JSON array.";
    const warmPrompt = buildWarmSupersessionComparisonPrompt(candidates);
    const warmMessages = opts.extractionSystemPrompt
      ? buildWarmComparisonMessages(opts, warmPrompt)
      : null;

    let responseText: string;
    if (warmMessages && opts.extractionSystemPrompt) {
      const { maxInputChars } = computeExtractionInputBudget(
        opts.extractionSystemPrompt,
        comparisonExtractionSettings.ctxSize,
        { maxTokens: comparisonExtractionSettings.maxTokens },
      );
      if (estimateDialogueChars(warmMessages) <= maxInputChars) {
        console.log(
          `[memory-comparison] Reusing delayed extraction context for ${candidates.length} candidate(s) ` +
          `(promptChars=${opts.extractionSystemPrompt.length + estimateDialogueChars(warmMessages)}, maxTokens=${comparisonExtractionSettings.maxTokens})`
        );
        responseText = await callExtractionLLMWithMessages(
          modelId,
          warmMessages,
          opts.extractionSystemPrompt,
          {
            settings,
            extractionSettings: comparisonExtractionSettings,
            assumeMutexHeld: opts.assumeMutexHeld,
          },
        );
      } else {
        console.log(
          `[memory-comparison] Warm comparison skipped; context would exceed extraction budget ` +
          `(messages=${estimateDialogueChars(warmMessages)} chars, budget=${maxInputChars} chars)`
        );
        responseText = await callExtractionLLM(
          modelId,
          buildColdSupersessionComparisonPrompt(candidates, conversationContext),
          analyzerPrompt,
          undefined,
          { settings, extractionSettings: comparisonExtractionSettings, assumeMutexHeld: opts.assumeMutexHeld },
        );
      }
    } else {
      responseText = await callExtractionLLM(
        modelId,
        buildColdSupersessionComparisonPrompt(candidates, conversationContext),
        analyzerPrompt,
        undefined,
        { settings, extractionSettings: comparisonExtractionSettings, assumeMutexHeld: opts.assumeMutexHeld },
      );
    }

    return parseSupersessionComparisonResponse(responseText, candidates);
  } catch (e) {
    console.error("[memory-comparison] Batch comparison failed:", e);
    return candidates.map((c, i) => ({
      candidateIndex: i,
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
    const candidate = candidates[res.candidateIndex] ??
      candidates.find((c) => c.newMemoryId === res.newMemoryId && c.oldMemoryId === res.oldMemoryId);
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

function mergeSourceSpans(spans: Array<MemorySourceSpan | undefined>): MemorySourceSpan | undefined {
  const timestamps: number[] = [];
  const indices: number[] = [];
  for (const span of spans) {
    if (!span) continue;
    if (span.startTimestamp !== undefined) timestamps.push(span.startTimestamp);
    if (span.endTimestamp !== undefined) timestamps.push(span.endTimestamp);
    if (span.startIndex !== undefined) indices.push(span.startIndex);
    if (span.endIndex !== undefined) indices.push(span.endIndex);
  }
  if (timestamps.length === 0 && indices.length === 0) return undefined;
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
    sourceChatId: sourceType === "chat" || sourceType === "chat_delayed" || sourceType === "chat_immediate" ? chatId : "",
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
  // Guard: if tied to a chat, verify it still exists. Catch races where
  // the chat was deleted during extraction (immediate queue, pre-compaction,
  // delayed, or save_memory tool mid-conversation).
  if (chatId) {
    const chatExists = await getChat(chatId).catch(() => null);
    if (!chatExists) {
      console.log(`[memory] Chat ${chatId} no longer exists, skipping ${facts.length} memory save`);
      return { added: 0, superseded: 0, skippedDuplicates: 0, ambiguousCandidates: [] };
    }
  }

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

const IMMEDIATE_SESSION_HISTORY_PAIR_LIMIT = 8;

interface ImmediateExtractionJob {
  jobId: string;
  modelId: string;
  chatId: string;
  userMsg: string;
  assistantMsg: string;
  projectId?: string;
  enqueuedAt: number;
  resolve: () => void;
  reject: (err: unknown) => void;
}

interface ImmediateExtractionSession {
  id: string;
  chatId: string;
  identityKey: string;
  systemPrompt: string;
  history: ExtractionDialogueMessage[];
  nextExchangeSequence: number;
}

interface ImmediateExtractionQueueState {
  jobs: ImmediateExtractionJob[];
  running: boolean;
  cancelled: boolean;
  session?: ImmediateExtractionSession;
}

interface ImmediateExchange {
  exchangeId: string;
  job: ImmediateExtractionJob;
  sourceSpan?: MemorySourceSpan;
}

const immediateExtractionQueues = new Map<string, ImmediateExtractionQueueState>();

function getImmediateQueueState(chatId: string): ImmediateExtractionQueueState {
  let state = immediateExtractionQueues.get(chatId);
  if (!state) {
    state = { jobs: [], running: false, cancelled: false };
    immediateExtractionQueues.set(chatId, state);
  }
  return state;
}

/**
 * Cancel pending immediate extraction jobs for a chat.
 * Resolves all queued jobs silently (no error) so callers' promises don't hang.
 * Sets a cancellation flag so an in-flight drain will skip processing new batches.
 * Called from chat-deletion when the user deletes a chat.
 */
export function cancelImmediateExtractionQueue(chatId: string): void {
  const state = immediateExtractionQueues.get(chatId);
  if (!state) return;

  state.cancelled = true;

  // Resolve all pending jobs so their promises don't hang
  for (const job of state.jobs) {
    job.resolve();
  }
  state.jobs.length = 0;

  // If nothing is actively draining, clean up the queue entry
  if (!state.running) {
    immediateExtractionQueues.delete(chatId);
  }
}

function buildImmediateSessionIdentityKey(input: {
  projectId?: string;
  effectiveModelId: string;
  extractionUrl?: string;
  ctxSize: number;
  maxTokens: number;
  systemPrompt: string;
}): string {
  return JSON.stringify({
    projectId: input.projectId || "",
    effectiveModelId: input.effectiveModelId,
    extractionUrl: input.extractionUrl || "",
    ctxSize: input.ctxSize,
    maxTokens: input.maxTokens,
    systemPromptHash: shortHash(input.systemPrompt),
  });
}

function createImmediateSession(
  chatId: string,
  identityKey: string,
  systemPrompt: string,
): ImmediateExtractionSession {
  return {
    id: uuid(),
    chatId,
    identityKey,
    systemPrompt,
    history: [],
    nextExchangeSequence: 1,
  };
}

function ensureImmediateSession(
  state: ImmediateExtractionQueueState,
  chatId: string,
  identityKey: string,
  systemPrompt: string,
): { session: ImmediateExtractionSession; freshSessionReason?: string } {
  if (!state.session) {
    state.session = createImmediateSession(chatId, identityKey, systemPrompt);
    return { session: state.session, freshSessionReason: "new-session" };
  }
  if (state.session.identityKey !== identityKey || state.session.systemPrompt !== systemPrompt) {
    state.session = createImmediateSession(chatId, identityKey, systemPrompt);
    return { session: state.session, freshSessionReason: "identity-changed" };
  }
  return { session: state.session };
}

function nextImmediateExchangeId(session: ImmediateExtractionSession): string {
  return `E${session.nextExchangeSequence++}`;
}

function renderImmediateExchange(exchange: ImmediateExchange): string {
  return [
    `Exchange ${exchange.exchangeId}`,
    `User message:\n${exchange.job.userMsg || "(empty)"}`,
    `Agent response:\n${exchange.job.assistantMsg || "(empty)"}`,
  ].join("\n\n");
}

function buildImmediateBatchHeader(exchanges: ImmediateExchange[]): string {
  const ids = exchanges.map((exchange) => exchange.exchangeId).join(", ");
  return `Review the new conversation exchange${exchanges.length === 1 ? "" : "s"} below and extract memories as the conversation progresses.

For every extracted memory, include "sourceExchangeId" with exactly one of these exchange ids: ${ids}.
Use the schema: {"text": string, "category": string, "importance": number, "sourceExchangeId": string}.
If a memory depends on multiple exchanges, use the exchange that best supports it.
If nothing is significant, output: []`;
}

function buildImmediateBatchUserPrompt(exchanges: ImmediateExchange[]): string {
  return `${buildImmediateBatchHeader(exchanges)}\n\nEXCHANGES:\n\n${exchanges.map(renderImmediateExchange).join("\n\n---\n\n")}`;
}

function immediateExchangeToSegment(exchange: ImmediateExchange): ExtractSegment {
  return {
    label: `Exchange ${exchange.exchangeId}`,
    text: [
      `User message:\n${exchange.job.userMsg || "(empty)"}`,
      `Agent response:\n${exchange.job.assistantMsg || "(empty)"}`,
    ].join("\n\n"),
    splittable: true,
  };
}

function splitImmediateExchangesIntoBatches(
  exchanges: ImmediateExchange[],
  maxInputChars: number,
): ImmediateExchange[][] {
  const batches: ImmediateExchange[][] = [];
  let current: ImmediateExchange[] = [];

  for (const exchange of exchanges) {
    const candidate = [...current, exchange];
    const candidatePrompt = buildImmediateBatchUserPrompt(candidate);
    if (candidatePrompt.length <= maxInputChars || current.length === 0) {
      current = candidate;
      continue;
    }
    batches.push(current);
    current = [exchange];
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

function pruneImmediateSessionForBudget(
  session: ImmediateExtractionSession,
  nextUserPrompt: string,
  maxInputChars: number,
): number {
  let pruned = 0;
  while (session.history.length > IMMEDIATE_SESSION_HISTORY_PAIR_LIMIT * 2) {
    session.history.splice(0, 2);
    pruned += 2;
  }

  const nextMessage: ExtractionDialogueMessage = { role: "user", content: nextUserPrompt };
  while (
    session.history.length > 0 &&
    estimateDialogueChars([...session.history, nextMessage]) > maxInputChars
  ) {
    session.history.splice(0, 2);
    pruned += 2;
  }

  return pruned;
}

function buildImmediateRunMetadata(input: {
  session: ImmediateExtractionSession;
  queueDepth: number;
  batch: ImmediateExchange[];
  messages: ExtractionDialogueMessage[];
  systemPrompt: string;
  prunedPriorMessages: number;
  freshSessionReason?: string;
  chunkedFallback?: boolean;
}): ExtractionRunMetadata {
  const promptChars = input.systemPrompt.length + estimateDialogueChars(input.messages);
  return {
    sessionId: input.session.id,
    queuedExchangeCount: input.queueDepth,
    batchedExchangeCount: input.batch.length,
    sessionMessageCount: input.messages.length,
    promptChars,
    estimatedPromptTokens: estimateTokensConservative(input.systemPrompt) + estimateTokensConservative(input.messages.map((m) => m.content).join("\n\n")),
    prunedPriorMessages: input.prunedPriorMessages,
    freshSessionReason: input.freshSessionReason,
    chunkedFallback: input.chunkedFallback || undefined,
  };
}

async function callImmediateSessionLLMWithRetry(input: {
  modelId: string;
  messages: ExtractionDialogueMessage[];
  systemPrompt: string;
  retryContext: string;
  settings: Settings;
  extractionSettings: ResolvedExtractionSettings;
  assumeMutexHeld: boolean;
}): Promise<string> {
  let result = "";
  await withRetry(async () => {
    result = await callExtractionLLMWithMessages(
      input.modelId,
      input.messages,
      input.systemPrompt,
      {
        settings: input.settings,
        extractionSettings: input.extractionSettings,
        assumeMutexHeld: input.assumeMutexHeld,
      },
    );
  }, input.retryContext, 2, (err) => !isExtractionContextOverflowError(err));
  return result;
}

function groupImmediateFactsBySource(
  facts: ExtractedFact[],
  embeddings: number[][],
  batch: ImmediateExchange[],
): Array<{ facts: ExtractedFact[]; embeddings: number[][]; sourceSpan?: MemorySourceSpan }> {
  const exchangeById = new Map(batch.map((exchange) => [exchange.exchangeId, exchange]));
  const batchSpan = mergeSourceSpans(batch.map((exchange) => exchange.sourceSpan));
  const groups = new Map<string, { facts: ExtractedFact[]; embeddings: number[][]; sourceSpan?: MemorySourceSpan }>();

  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i];
    const exchange = fact.sourceExchangeId ? exchangeById.get(fact.sourceExchangeId) : undefined;
    const key = exchange?.exchangeId || "__batch__";
    let group = groups.get(key);
    if (!group) {
      group = {
        facts: [],
        embeddings: [],
        sourceSpan: exchange?.sourceSpan || batchSpan,
      };
      groups.set(key, group);
    }
    group.facts.push(fact);
    group.embeddings.push(embeddings[i]);
  }

  return [...groups.values()];
}

async function saveImmediateFacts(
  facts: ExtractedFact[],
  embeddings: number[][],
  batch: ImmediateExchange[],
  chatId: string,
  projectId?: string,
): Promise<{ added: number; superseded: number; skippedDuplicates: number }> {
  let added = 0;
  let superseded = 0;
  let skippedDuplicates = 0;

  for (const group of groupImmediateFactsBySource(facts, embeddings, batch)) {
    const outcome = await dedupAndSave(
      group.facts,
      group.embeddings,
      chatId,
      projectId,
      "chat_immediate",
      chatId,
      group.sourceSpan,
    );
    added += outcome.added;
    superseded += outcome.superseded;
    skippedDuplicates += outcome.skippedDuplicates;
  }

  return { added, superseded, skippedDuplicates };
}

async function runImmediateBatch(input: {
  state: ImmediateExtractionQueueState;
  session: ImmediateExtractionSession;
  batch: ImmediateExchange[];
  queueDepth: number;
  modelId: string;
  effectiveModelId: string;
  chat: Chat | null;
  chatId: string;
  projectId?: string;
  systemPrompt: string;
  identityKey: string;
  settings: Settings;
  extractionSettings: ResolvedExtractionSettings;
  maxInputChars: number;
  assumeMutexHeld: boolean;
  freshSessionReason?: string;
}): Promise<void> {
  const userPrompt = buildImmediateBatchUserPrompt(input.batch);
  const newUserOnly: ExtractionDialogueMessage[] = [{ role: "user", content: userPrompt }];
  const nextUserTooLarge = estimateDialogueChars(newUserOnly) > input.maxInputChars;
  let session = input.session;
  let prunedPriorMessages = 0;
  let messages = newUserOnly;
  let chunkedFallback = nextUserTooLarge;

  if (!chunkedFallback) {
    prunedPriorMessages = pruneImmediateSessionForBudget(session, userPrompt, input.maxInputChars);
    messages = [...session.history, { role: "user", content: userPrompt }];
    if (estimateDialogueChars(messages) > input.maxInputChars) {
      chunkedFallback = true;
      messages = newUserOnly;
      input.state.session = createImmediateSession(input.chatId, input.identityKey, input.systemPrompt);
      session = input.state.session;
    }
  }

  const runHandle = startExtractionRun({
    trigger: "immediate",
    chatId: input.chatId,
    chatTitle: input.chat?.title,
    model: input.effectiveModelId,
    priorMemoryCount: 0,
    messages: input.batch.flatMap((exchange) => [
      { role: `user:${exchange.exchangeId}`, content: exchange.job.userMsg },
      { role: `assistant:${exchange.exchangeId}`, content: exchange.job.assistantMsg },
    ]),
    systemPrompt: input.systemPrompt,
    userPrompt,
    metadata: buildImmediateRunMetadata({
      session,
      queueDepth: input.queueDepth,
      batch: input.batch,
      messages,
      systemPrompt: input.systemPrompt,
      prunedPriorMessages,
      freshSessionReason: input.freshSessionReason,
      chunkedFallback,
    }),
  });

  try {
    const t0 = Date.now();
    const chunkResult = chunkedFallback
      ? await extractInChunks({
          modelId: input.modelId,
          systemPrompt: input.systemPrompt,
          userPromptHeader: `${buildImmediateBatchHeader(input.batch)}\n\nEXCHANGES:`,
          segments: input.batch.map(immediateExchangeToSegment),
          contextLabel: `immediateExtraction chat=${input.chatId}`,
          assumeMutexHeld: input.assumeMutexHeld,
        })
      : {
          rawOutput: await callImmediateSessionLLMWithRetry({
            modelId: input.modelId,
            messages,
            systemPrompt: input.systemPrompt,
            retryContext: `immediateExtraction chat=${input.chatId}`,
            settings: input.settings,
            extractionSettings: input.extractionSettings,
            assumeMutexHeld: input.assumeMutexHeld,
          }),
          facts: [] as ExtractedFact[],
          chunkCount: 1,
          chunkTimingsMs: [Date.now() - t0],
          chunkFailures: 0,
        };

    if (!chunkedFallback) {
      chunkResult.facts = parseExtractionResponse(chunkResult.rawOutput);
    }

    runHandle.attachOutput(chunkResult.rawOutput);

    const facts = chunkResult.facts;
    if (facts.length === 0) {
      const rawSample = (chunkResult.rawOutput || "").trim().slice(0, 400);
      console.log(`[memory] No facts extracted from immediate batch of ${input.batch.length} exchange(s) (raw output: ${rawSample.length ? JSON.stringify(rawSample) : "<empty>"})`);
      if (!chunkedFallback) {
        session.history.push({ role: "user", content: userPrompt }, { role: "assistant", content: chunkResult.rawOutput || "[]" });
      } else {
        input.state.session = createImmediateSession(input.chatId, input.identityKey, input.systemPrompt);
      }
      extractionMetrics.successfulExtractions += input.batch.length;
      extractionMetrics.lastExtractionAt = new Date().toISOString();
      runHandle.complete({
        facts: [],
        saved: 0,
        superseded: 0,
        skippedDuplicates: 0,
        errors: 0,
        chunks: { count: chunkResult.chunkCount, failures: chunkResult.chunkFailures, timingsMs: chunkResult.chunkTimingsMs },
      });
      input.batch.forEach((exchange) => exchange.job.resolve());
      return;
    }

    console.log(`[memory] Immediate batch extracted ${facts.length} fact(s) from ${input.batch.length} exchange(s), embedding batch...`);

    let embeddings: number[][];
    try {
      embeddings = await withRetry(
        () => embedBatch(facts.map((f) => f.text)),
        `embedBatch for ${facts.length} immediate facts (chat ${input.chatId})`
      );
    } catch (e) {
      console.error("[memory] Immediate batch embedding failed:", e);
      runHandle.fail(e);
      extractionMetrics.failedExtractions += input.batch.length;
      extractionMetrics.lastFailureAt = new Date().toISOString();
      input.batch.forEach((exchange) => exchange.job.reject(e));
      return;
    }

    const outcome = await saveImmediateFacts(facts, embeddings, input.batch, input.chatId, input.projectId);
    invalidateMemoriesCache(input.chatId);

    if (!chunkedFallback) {
      session.history.push({ role: "user", content: userPrompt }, { role: "assistant", content: chunkResult.rawOutput || "[]" });
      pruneImmediateSessionForBudget(session, "", input.maxInputChars);
    } else {
      input.state.session = createImmediateSession(input.chatId, input.identityKey, input.systemPrompt);
    }

    extractionMetrics.successfulExtractions += input.batch.length;
    extractionMetrics.totalFactsExtracted += facts.length;
    extractionMetrics.lastExtractionAt = new Date().toISOString();
    runHandle.complete({
      facts: facts.map((f) => ({ text: f.text, category: f.category, importance: f.importance, sourceExchangeId: f.sourceExchangeId })),
      saved: outcome.added,
      superseded: outcome.superseded,
      skippedDuplicates: outcome.skippedDuplicates,
      errors: 0,
      chunks: { count: chunkResult.chunkCount, failures: chunkResult.chunkFailures, timingsMs: chunkResult.chunkTimingsMs },
    });
    input.batch.forEach((exchange) => exchange.job.resolve());
  } catch (e) {
    extractionMetrics.failedExtractions += input.batch.length;
    extractionMetrics.lastFailureAt = new Date().toISOString();
    runHandle.fail(e);
    input.batch.forEach((exchange) => exchange.job.reject(e));
  }
}

async function processImmediateExtractionJobs(
  state: ImmediateExtractionQueueState,
  jobs: ImmediateExtractionJob[],
  opts: {
    settings: Settings;
    extractionSettings: ResolvedExtractionSettings;
    assumeMutexHeld: boolean;
  },
): Promise<void> {
  if (jobs.length === 0) return;

  extractionMetrics.totalExtractions += jobs.length;

  const first = jobs[0];
  const systemPrompt = await buildExtractionSystemPrompt(first.projectId);
  const effectiveModelId = resolveEffectiveExtractionModelId(first.modelId, opts.settings);
  const identityKey = buildImmediateSessionIdentityKey({
    projectId: first.projectId,
    effectiveModelId,
    extractionUrl: opts.settings.extractionModelUrl,
    ctxSize: opts.extractionSettings.ctxSize,
    maxTokens: opts.extractionSettings.maxTokens,
    systemPrompt,
  });
  let { session, freshSessionReason } = ensureImmediateSession(state, first.chatId, identityKey, systemPrompt);

  const chat = await getChat(first.chatId).catch(() => null);
  if (!chat) {
    // Chat was deleted before extraction ran — resolve jobs silently
    // rather than saving orphaned memories.
    jobs.forEach((job) => job.resolve());
    return;
  }
  const exchanges: ImmediateExchange[] = jobs.map((job) => ({
    exchangeId: nextImmediateExchangeId(session),
    job,
    sourceSpan: findExchangeSourceSpan(chat, job.userMsg, job.assistantMsg),
  }));

  const { maxInputChars } = computeExtractionInputBudget(
    systemPrompt,
    opts.extractionSettings.ctxSize,
    { maxTokens: opts.extractionSettings.maxTokens },
  );
  const batches = splitImmediateExchangesIntoBatches(exchanges, maxInputChars);

  for (const batch of batches) {
    await runImmediateBatch({
      state,
      session,
      batch,
      queueDepth: jobs.length,
      modelId: first.modelId,
      effectiveModelId,
      chat,
      chatId: first.chatId,
      projectId: first.projectId,
      systemPrompt,
      identityKey,
      settings: opts.settings,
      extractionSettings: opts.extractionSettings,
      maxInputChars,
      assumeMutexHeld: opts.assumeMutexHeld,
      freshSessionReason,
    });
    session = state.session ?? session;
    freshSessionReason = undefined;
  }
}

async function drainImmediateExtractionQueue(chatId: string): Promise<void> {
  const state = getImmediateQueueState(chatId);
  if (state.running) return;
  state.running = true;

  try {
    while (state.jobs.length > 0 && !state.cancelled) {
      const settings = await getSettings();
      const extractionSettings = await resolveExtractionRequestSettings(settings);

      if (settings.extractionModelUrl) {
        await withExtractionMutex(async () => {
          const jobs = state.jobs.splice(0);
          try {
            await processImmediateExtractionJobs(state, jobs, {
              settings,
              extractionSettings,
              assumeMutexHeld: true,
            });
          } catch (e) {
            extractionMetrics.failedExtractions += jobs.length;
            extractionMetrics.lastFailureAt = new Date().toISOString();
            jobs.forEach((job) => job.reject(e));
            throw e;
          }
        });
      } else {
        const jobs = state.jobs.splice(0);
        try {
          await processImmediateExtractionJobs(state, jobs, {
            settings,
            extractionSettings,
            assumeMutexHeld: false,
          });
        } catch (e) {
          extractionMetrics.failedExtractions += jobs.length;
          extractionMetrics.lastFailureAt = new Date().toISOString();
          jobs.forEach((job) => job.reject(e));
          throw e;
        }
      }
    }
  } catch (e) {
    console.error(`[memory] immediate extraction queue failed for chat ${chatId}:`, e);
  } finally {
    state.running = false;
    if (state.cancelled) {
      // Queue was cancelled during drain — clean up the stale entry now
      // that we're done. Pending jobs were already resolved by the
      // cancellation, and the in-flight batch hit the getChat guard.
      immediateExtractionQueues.delete(chatId);
    } else if (state.jobs.length > 0) {
      void drainImmediateExtractionQueue(chatId);
    }
  }
}

export function enqueueImmediateExtraction(
  modelId: string,
  chatId: string,
  userMsg: string,
  assistantMsg: string,
  projectId?: string
): Promise<void> {
  const state = getImmediateQueueState(chatId);
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  state.jobs.push({
    jobId: uuid(),
    modelId,
    chatId,
    userMsg,
    assistantMsg,
    projectId,
    enqueuedAt: Date.now(),
    resolve,
    reject,
  });

  void drainImmediateExtractionQueue(chatId);
  return promise;
}

export async function extractMemories(
  modelId: string,
  chatId: string,
  userMsg: string,
  assistantMsg: string,
  projectId?: string
): Promise<void> {
  return enqueueImmediateExtraction(modelId, chatId, userMsg, assistantMsg, projectId);
}

const PRE_COMPACTION_INSTRUCTIONS = `---

## Memory Preservation Task

This conversation is approaching its context limit and messages will be removed. Review the messages below and extract everything you need to continue effectively — write each memory in your own voice.

Focus on:
1. Task state — what is being worked on, what's done, what's pending, what decisions were made
2. Technical context — files discussed, architecture patterns, code changes
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
  const effectiveModelId = await getEffectiveExtractionModelId(modelId);
  const runHandle = startExtractionRun({
    trigger: "pre-compaction",
    chatId,
    chatTitle: chat?.title,
    model: effectiveModelId,
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

    // Re-check chat exists before saving — race window between the initial
    // getChat and here (LLM call + embedding). If deleted during
    // compaction, skip saving to avoid orphaned memories.
    const chatStillExists = await getChat(chatId).catch(() => null);
    if (!chatStillExists) {
      console.log("[memory] Pre-compaction flush: chat was deleted during extraction, skipping save");
      runHandle.complete({
        facts,
        saved: 0,
        superseded: 0,
        skippedDuplicates: 0,
        errors: 0,
        chunks: { count: chunkResult.chunkCount, failures: chunkResult.chunkFailures, timingsMs: chunkResult.chunkTimingsMs },
      });
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
    : "(none captured yet, please extract everything you can from the conversation below)";

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
  const extractionPrompt = `${userPromptHeader}\n\n${context.messages
    .map(({ message, index }) => formatMessageForExtraction(message, index))
    .join("\n\n---\n\n")}`;
  const systemPrompt = await buildDelayedExtractionSystemPrompt();
  const effectiveModelId = await getEffectiveExtractionModelId(modelId);

  const runHandle = startExtractionRun({
    trigger: "delayed",
    chatId,
    chatTitle: chat.title,
    model: effectiveModelId,
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

    // Re-check chat exists before saving — narrow race window between the
    // initial getChat and here (LLM call + embedding). If the chat was
    // deleted, skip saving to avoid orphaned memories.
    const chatStillExists = await getChat(chatId).catch(() => null);
    if (!chatStillExists) {
      console.log(`[memory-delayed] Chat ${chatId} was deleted during extraction, skipping save`);
      runHandle.complete({
        facts,
        saved: 0,
        superseded: 0,
        skippedDuplicates: 0,
        errors: 0,
        chunks: { count: chunkResult.chunkCount, failures: chunkResult.chunkFailures, timingsMs: chunkResult.chunkTimingsMs },
      });
      return;
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
        modelId,
        chunkResult.chunkCount === 1
          ? {
              extractionSystemPrompt: systemPrompt,
              extractionUserPrompt: extractionPrompt,
              extractionRawOutput: chunkResult.rawOutput,
            }
          : undefined,
      );

      const applyResult = await applyComparisonResolutions(comparisonResults, ambiguousCandidates);
      comparisonSuperseded = applyResult.superseded;
      comparisonSeparate = applyResult.separate;

      // Build resolution records for observability
      resolutions = comparisonResults.map((res, i) => {
        const candidate = ambiguousCandidates[res.candidateIndex] ?? ambiguousCandidates[i];
        return {
          newFactIndex: candidate.factIndex,
          newFactText: candidate.newText,
          existingMemoryId: res.oldMemoryId,
          existingMemoryText: candidate.oldText,
          embeddingSimilarity: candidate.embeddingSimilarity,
          textDiffOverlap: candidate.textOverlap,
          decision: res.decision,
          reason: res.reason,
        };
      });
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
