import { v4 as uuid } from "uuid";
import { appendFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { streamChat } from "./agent.js";
import { getSettings } from "./chat-storage.js";
import { embedBatch } from "./embeddings.js";
import {
  addMemory,
  updateMemory,
  findDuplicates,
  searchMemoriesRaw,
  createSupersessionLink,
  getAllMemories,
  getDb,
  getMemoriesByChatId,
  getMemoryById,
} from "./memory-storage.js";
import { getChat, updateChatExtractionState } from "./chat-storage.js";
import { invalidateMemoriesCache, invalidateStablePrefixCache } from "./memory-context.js";
import { startExtractionRun } from "./memory-extraction-observability.js";
import { recordModelStats } from "./model-stats.js";
import type { LlamaTimings } from "./model-stats.js";
import type { ChatMessage, Memory, MemoryCategory, Chat } from "../types.js";

const LOG_DIR = join(homedir(), ".quje-agent", "logs");

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

      // Direct call to dedicated extraction endpoint (CPU-only, no provider pipeline)
      const res = await fetch(`${extractionUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: settings.extractionModelId || "extraction",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: truncatedContent },
          ],
          max_tokens: 2000,
          temperature: 0.3,
          stream: false,
        }),
        signal: signal ?? AbortSignal.timeout(600_000),
      });
      if (!res.ok) {
        const err = await res.text().catch(() => "");
        throw new Error(`Extraction model error ${res.status}: ${err}`);
      }
      const data = await res.json();

      // Record model stats from extraction timings (same structure as chat model)
      const timings = data.timings as LlamaTimings | undefined;
      if (timings) {
        try {
          recordModelStats(
            settings.extractionModelId || "extraction",
            "llamacpp-extraction",
            timings
          );
        } catch (e) {
          console.warn("[memory] Failed to record extraction model stats:", e);
        }
      }

      return data.choices?.[0]?.message?.content?.trim() || "";
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

I know who I am. My identity, personality, values, communication style, and how I work are already part of me and do not need to be extracted or saved as memories. I do NOT archive statements about my own nature, characteristics, or operational style.

Source attribution is critical:
- USER/HUMAN messages are the only source for the user's preferences, personal facts, and intent.
- ASSISTANT/AGENT messages are my own prior responses, proposals, interpretations, tool summaries, and work product. Do NOT attribute assistant-message content to the user unless a user message confirms it.
- When preserving task or project continuity from assistant messages, phrase it as project/task state or work I performed/proposed, not as something the user said, believes, or wants.
- If user and assistant messages conflict, treat the user's message as the source of truth.

What I capture: things worth remembering for future interactions — written in my own voice, as something I'd tell myself to remember. Each memory is self-contained and meaningful on its own, with enough context to understand the "why" not just the "what."

What I skip: my own identity traits, broad preferences, anything already in existing knowledge blocks, and generic observations without specific context.`;

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
- "category": One of "preference", "fact", "behavior", "instruction", "context", "decision", "note"
- "importance": 1-10 (10 = critical, 1 = trivial)

Categories:
- "preference" — likes, dislikes, stylistic choices
- "fact" — concrete information about the user, their role, or their environment
- "behavior" — recurring patterns in how the user works or communicates
- "instruction" — explicit directives about how I should behave
- "context" — project-level information: architecture, tech choices, ongoing work, constraints, relationships between systems
- "decision" — a choice that was made and why, tradeoffs considered
- "note" — general observations, curiosities, personal details, or anything worth remembering that doesn't fit the above categories

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
function computeBlockCharBudget(
  blockCount: number,
  staticChars: number,
  ctxSize: number,
): number {
  if (blockCount === 0) return 0;
  // sysPrompt target tokens = ctxSize * ratio; × 3 chars/token (conservative).
  const sysPromptCharBudget = Math.floor(ctxSize * SYS_PROMPT_CTX_RATIO * 3);
  const remaining = Math.max(0, sysPromptCharBudget - staticChars);
  const perBlock = Math.floor(remaining / blockCount);
  // Never let per-block drop below a useful minimum, and never exceed the
  // original 4000-char slice (so small ctx models get tighter budgets but
  // large ctx models don't inflate block summaries beyond what callers expect).
  return Math.max(300, Math.min(4000, perBlock));
}

async function buildExtractionSystemPrompt(projectId?: string): Promise<string> {
  const settings = await getSettings();
  const ctxSize = settings.extractionCtxSize ?? 16384;

  // Include loaded block summaries so extraction avoids redundant facts.
  // Filter out system-managed blocks (synthesis, notebook, zeitgeist archives) —
  // they are off-topic for the extraction task and bloat the context window.
  let blockContext = "";
  try {
    const { getMemoryBlocksByScope } = await import("./memory-storage.js");
    const isSystemBlock = (b: { id: string; scope: string; blockType?: string }) =>
      b.id === "blk-zeitgeist-continuity" ||
      b.scope === "archived" ||
      (b.blockType !== undefined && b.blockType !== "note") ||
      b.id.startsWith("blk-archive-") ||
      b.id.startsWith("blk-synth-") ||
      b.id.startsWith("blk-notebook-");

    const globalBlocks = getMemoryBlocksByScope("global").filter((b) => !isSystemBlock(b));
    const projectBlocks = projectId ? getMemoryBlocksByScope("project", projectId).filter((b) => !isSystemBlock(b)) : [];
    const allBlocks = [...globalBlocks, ...projectBlocks];
    if (allBlocks.length > 0) {
      const staticChars =
        EXTRACTION_AGENT_PREFIX.length + EXTRACTION_INSTRUCTIONS.length + 400;
      const perBlockChars = computeBlockCharBudget(allBlocks.length, staticChars, ctxSize);
      const summaries = allBlocks
        .map((b) => `- ${b.name}: ${b.content.slice(0, perBlockChars)}`)
        .join("\n");
      blockContext = `\n\n## Existing Knowledge Blocks\nThe following memory blocks already contain relevant context — do NOT extract information that is already covered here:\n${summaries}\n`;
    }
  } catch { /* non-critical */ }

  return `${EXTRACTION_AGENT_PREFIX}${blockContext}\n\n${EXTRACTION_INSTRUCTIONS}`;
}

const DELAYED_EXTRACTION_SYSTEM_INSTRUCTIONS = `---

## Delayed Memory Extraction Task

You are looking back at a full conversation thread you had. Your task is to extract patterns, decisions, and context that emerged across the entire conversation — write each memory in your own voice.

The conversation is explicitly labeled by speaker. USER (human) messages are the user's words. ASSISTANT (agent/me) messages are my own prior responses and work.

Previously captured memories will be provided alongside the conversation. Those memories are already saved — do NOT duplicate them. Instead, focus on:
1. **New developments** — patterns, decisions, or facts that emerged after the previous extraction
2. **Evolutions or contradictions** — if a previous position has been refined or amended
3. **Thematic context** — higher-level insights that connect multiple exchanges
4. **Unresolved threads** — ongoing work, open questions, or pending decisions

Each extracted memory should be self-contained and meaningful without the original conversation (1-3 sentences).

Output a JSON array. Each item:
- "text": A standalone statement with sufficient context (2-5 sentences)
- "category": One of "preference", "fact", "behavior", "instruction", "context", "decision", "note"
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
  return `${EXTRACTION_AGENT_PREFIX}\n\n${DELAYED_EXTRACTION_SYSTEM_INSTRUCTIONS}`;
}

interface ExtractedFact {
  text: string;
  category: MemoryCategory;
  importance: number;
  blockUpdate?: {
    blockId?: string;  // Existing block to update
    targetBlockName?: string;  // Name of block — only for creating NEW blocks
    updateType: "append" | "replace_section";  // append = add text to end, replace_section = modify a section
    content: string;  // The NEW text to add (NOT the entire block content)
    section?: string;  // Which section header to modify (required for replace_section)
    reasoning: string;  // Why this block needs updating
  };
}

export function parseExtractionResponse(text: string): ExtractedFact[] {
  // Strip markdown code fences if present
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  cleaned = cleaned.trim();

  // Find the JSON array
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1) return [];

  try {
    const arr = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (f: any) =>
        typeof f.text === "string" &&
        f.text.length > 0 &&
        ["preference", "fact", "behavior", "instruction", "context", "decision", "note", "reflection"].includes(f.category)
    );
  } catch {
    return [];
  }
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
  return role === "user" ? "USER (human)" : "ASSISTANT (agent/me)";
}

/**
 * Max characters for a single tool result in extraction context.
 * Full webpage content (50KB from web_fetch) is useless for memory extraction
 * and would consume the entire context budget of the extraction model. A short
 * preview is enough for the extraction agent to understand what was fetched.
 */
const EXTRACT_TOOL_RESULT_MAX = 4_000;

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

const DEDUP_THRESHOLD = 0.85;

/**
 * Dedup + save: for each fact, find the nearest existing memory via sqlite-vec.
 * If similarity > threshold, update in place; otherwise insert new.
 */
export interface DedupAndSaveOutcome {
  added: number;
  superseded: number;
  skippedDuplicates: number;
}

export async function dedupAndSave(
  facts: ExtractedFact[],
  embeddings: number[][],
  chatId: string,
  projectId?: string,
  sourceType: 'chat' | 'notebook' | 'explicit' = 'chat',
  sourceId?: string
): Promise<DedupAndSaveOutcome> {
  let added = 0;
  let superseded = 0;
  let skippedDuplicates = 0;
  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i];
    const factEmbedding = embeddings[i];

    const match = await findDuplicates(factEmbedding, DEDUP_THRESHOLD);

    if (match) {
      // If the text is effectively identical (very high similarity), just bump metadata
      // without creating a new memory in the chain
      if (match.similarity > 0.95) {
        console.log(
          `[memory] Near-identical match (sim=${match.similarity.toFixed(3)}), bumping metadata: "${match.memory.text}"`
        );
        await updateMemory(match.memory.id, {
          importance: Math.max(match.memory.importance, fact.importance),
          lastAccessed: new Date().toISOString(),
        });
        skippedDuplicates++;
      } else {
        // Text has meaningfully changed — create a new memory that supersedes the old one
        console.log(
          `[memory] Superseding memory (sim=${match.similarity.toFixed(3)}): "${match.memory.text}" → "${fact.text}"`
        );
        const now = new Date().toISOString();
        const newMemoryId = uuid();
        await addMemory({
          id: newMemoryId,
          text: fact.text,
          category: fact.category || match.memory.category,
          importance: Math.min(10, Math.max(1, Math.max(match.memory.importance, fact.importance))),
          embedding: factEmbedding,
          createdAt: now,
          lastAccessed: now,
          accessCount: 0,
          sourceChatId: sourceType === 'chat' ? chatId : '',
          ...(projectId ? { projectId } : {}),
          sourceType,
          sourceId: sourceId || chatId,
        });
        const linked = await createSupersessionLink(newMemoryId, match.memory.id, match.similarity);
        if (!linked) {
          console.log(`[memory] Supersession link rejected (cycle detected): ${match.memory.id} ↛ ${newMemoryId}`);
        }
        superseded++;
      }
    } else {
      console.log(`[memory] New memory: "${fact.text}"`);
      const now = new Date().toISOString();
      const newMemoryId = uuid();
      await addMemory({
        id: newMemoryId,
        text: fact.text,
        category: fact.category,
        importance: Math.min(10, Math.max(1, fact.importance)),
        embedding: factEmbedding,
        createdAt: now,
        lastAccessed: now,
        accessCount: 0,
        sourceChatId: sourceType === 'chat' ? chatId : '',
        ...(projectId ? { projectId } : {}),
        sourceType,
        sourceId: sourceId || chatId,
      });
      
      // Check for automatic supersession after saving new memory
      await checkSupersession(newMemoryId, fact.text, factEmbedding);
      added++;
    }
  }
  return { added, superseded, skippedDuplicates };
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
    console.log("[memory] No facts extracted from exchange");
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
  const outcome = await dedupAndSave(facts, embeddings, chatId, projectId);

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

### Memory Block Updates

You will be provided with existing memory blocks below. These are structured knowledge documents that organize related information. Consider whether the conversation contains information that should update these blocks.

**When to update blocks:**
- Substantive changes to architecture, decisions, or technical context already covered in a block
- New important details that expand on existing block content
- Corrections or refinements to information in blocks

**When to create a new block:**
- Newly emerged, substantive topic that isn't directly covered by existing blocks but is still important to preserve

**When to use atomic memories instead:**
- Quick facts, preferences, or one-off details
- Information that doesn't fit existing block topics
- Lower importance observations (importance ≤ 7)

**Block update guidelines:**
- You will see remaining character space for each block (max 4000 chars)
- Use "append" to add new content to an existing block when space allows (>500 chars remaining)
- Use "replace_section" to modify a specific section when the block is nearly full
- IMPORTANT: "content" for append/replace_section should contain ONLY the new text to add, NOT the entire block
- Only create new blocks for genuinely new topics that don't match existing block names

Output a JSON array. Each item:
- "text": A standalone statement with sufficient context (2-5 sentences)
- "category": One of "preference", "fact", "behavior", "instruction", "context", "decision", "note"
- "importance": 1-10
- "blockUpdate": Optional. If this fact warrants a block update:
  - "blockId": ID of existing block to update (use the ID from the block header, e.g. [blk-xxxxx])
  - "targetBlockName": Name of block — only use this when creating a NEW block for a topic with no existing block
  - "updateType": "append" (add text to end) or "replace_section" (modify specific section)
  - "content": The NEW text to add — NOT the entire block content
  - "section": Which section header to modify (required for replace_section)
  - "reasoning": Why this block needs updating

Output ONLY the JSON array.`;

async function buildPreCompactionSystemPrompt(projectId?: string): Promise<string> {
  const settings = await getSettings();
  const ctxSize = settings.extractionCtxSize ?? 16384;

  // Load existing blocks with space awareness.
  // Filter out system-managed blocks (synthesis, notebook, zeitgeist archives) —
  // they are off-topic for the extraction task and bloat the context window.
  let blockContext = "";
  try {
    const { getMemoryBlocksByScope } = await import("./memory-storage.js");
    const isSystemBlock = (b: { id: string; scope: string; blockType?: string }) =>
      b.id === "blk-zeitgeist-continuity" ||
      b.scope === "archived" ||
      (b.blockType !== undefined && b.blockType !== "note") ||
      b.id.startsWith("blk-archive-") ||
      b.id.startsWith("blk-synth-") ||
      b.id.startsWith("blk-notebook-");

    const globalBlocks = getMemoryBlocksByScope("global").filter((b) => !isSystemBlock(b));
    const projectBlocks = projectId ? getMemoryBlocksByScope("project", projectId).filter((b) => !isSystemBlock(b)) : [];
    const allBlocks = [...globalBlocks, ...projectBlocks];

    if (allBlocks.length > 0) {
      const MAX_BLOCK_CHARS = 4000;  // block storage cap — unchanged, used for remaining-space math
      const staticChars =
        EXTRACTION_AGENT_PREFIX.length + PRE_COMPACTION_INSTRUCTIONS.length + 600;
      const displayBudget = computeBlockCharBudget(allBlocks.length, staticChars, ctxSize);

      const blockSummaries = allBlocks.map((b) => {
        // "Remaining space" reflects how much room is left in the stored block,
        // not how much of it we're showing here. Keep the stored-cap math intact
        // so the LLM makes correct append/replace decisions.
        const remainingSpace = MAX_BLOCK_CHARS - b.content.length;
        const spaceStatus = remainingSpace > 500
          ? `${remainingSpace.toLocaleString()} chars remaining (good for appends)`
          : remainingSpace > 100
          ? `${remainingSpace.toLocaleString()} chars remaining (consider targeted edits)`
          : `${remainingSpace.toLocaleString()} chars remaining (space constrained)`;

        const shownContent = b.content.length > displayBudget
          ? b.content.slice(0, displayBudget) + `\n[...truncated for extraction context; full block is ${b.content.length} chars]`
          : b.content;

        return `### ${b.name} [${b.id}]
Scope: ${b.scope}
${spaceStatus}

${shownContent}`;
      }).join("\n\n");

      blockContext = `\n\n## Existing Memory Blocks\nThe following memory blocks contain structured knowledge. Consider whether information from this conversation should update these blocks:\n\n${blockSummaries}\n`;
    }
  } catch { /* non-critical */ }

  return `${EXTRACTION_AGENT_PREFIX}${blockContext}\n\n${PRE_COMPACTION_INSTRUCTIONS}`;
}

/**
 * Process block updates from extraction output.
 * Only applies updates for facts with importance >= minImportance (default: 8) that have blockUpdate field.
 * Pre-compaction flush passes a lower threshold (7) since messages are about to be removed and
 * need more aggressive preservation.
 */
async function processBlockUpdates(
  facts: ExtractedFact[],
  projectId?: string,
  minImportance: number = 8
): Promise<boolean> {
  const { getMemoryBlock, getMemoryBlocksByScope, updateMemoryBlock, createMemoryBlock } = await import("./memory-storage.js");
  
  const MAX_BLOCK_CHARS = 4000;
  const MIN_SPACE_FOR_APPEND = 500;
  
  let updatesMade = false;
  const now = new Date().toISOString();
  
  for (const fact of facts) {
    // Only process facts above the importance threshold with block updates
    if (!fact.blockUpdate || fact.importance < minImportance) continue;
    
    const update = fact.blockUpdate;
    
    try {
      // Normalize "refine" to "append" — the extraction LLM sometimes outputs
      // "refine" but means "add this content". Previously "refine" was destructive
      // (replacing the entire block), so we map it to append for safety.
      if (update.updateType === "refine" as string) {
        update.updateType = "append";
        console.log(`[memory-blocks] Normalized "refine" updateType to "append" for block update`);
      }
      
      // Resolve the target block: either by ID or by name lookup
      let existingBlock: ReturnType<typeof getMemoryBlock> = null;
      let resolvedBlockId: string | undefined = update.blockId;
      
      if (update.blockId) {
        existingBlock = getMemoryBlock(update.blockId);
        if (!existingBlock) {
          console.warn(`[memory-blocks] Block ${update.blockId} not found, skipping update`);
          continue;
        }
      } else if (update.targetBlockName) {
        // No blockId provided — look up by name in the appropriate scope.
        // This prevents creating duplicate blocks when the LLM provides
        // a targetBlockName without the blockId.
        const scope = projectId ? "project" : "global";
        const blocks = getMemoryBlocksByScope(scope as "global" | "project", projectId);
        const match = blocks.find(b => b.name === update.targetBlockName);
        if (match) {
          existingBlock = match;
          resolvedBlockId = match.id;
          console.log(`[memory-blocks] Resolved targetBlockName "${update.targetBlockName}" to existing block ${match.id}`);
        }
      }
      
      if (existingBlock && resolvedBlockId) {
        // Update existing block
        const remainingSpace = MAX_BLOCK_CHARS - existingBlock.content.length;
        
        if (update.updateType === "append") {
          // Append new content to the existing block.
          if (remainingSpace < MIN_SPACE_FOR_APPEND) {
            console.log(`[memory-blocks] Insufficient space for append on ${resolvedBlockId} (${remainingSpace} chars remaining), skipping`);
            continue;
          }
          
          const newContent = existingBlock.content + "\n\n" + update.content;
          if (newContent.length > MAX_BLOCK_CHARS) {
            console.warn(`[memory-blocks] Append would exceed limit (${newContent.length} > ${MAX_BLOCK_CHARS}), skipping`);
            continue;
          }
          
          updateMemoryBlock(resolvedBlockId, {
            content: newContent,
            updatedBy: "agent",
          });
          console.log(`[memory-blocks] Appended to block "${existingBlock.name}" ${resolvedBlockId} (${newContent.length} chars total)`);
          updatesMade = true;
        } else if (update.updateType === "replace_section" && update.section) {
          // Find and replace the section
          const sectionHeader = `### ${update.section}`;
          const sectionIndex = existingBlock.content.indexOf(sectionHeader);
          
          if (sectionIndex === -1) {
            console.warn(`[memory-blocks] Section "${update.section}" not found in ${resolvedBlockId}, skipping`);
            continue;
          }
          
          // Find end of section (next ### or end of content)
          const nextSectionIndex = existingBlock.content.indexOf("\n### ", sectionIndex + sectionHeader.length);
          const sectionEnd = nextSectionIndex === -1 ? existingBlock.content.length : nextSectionIndex;
          
          const beforeSection = existingBlock.content.slice(0, sectionIndex);
          const afterSection = existingBlock.content.slice(sectionEnd);
          const newContent = beforeSection + sectionHeader + "\n" + update.content + afterSection;
          
          if (newContent.length > MAX_BLOCK_CHARS) {
            console.warn(`[memory-blocks] Section replace would exceed limit (${newContent.length} > ${MAX_BLOCK_CHARS}), skipping`);
            continue;
          }
          
          updateMemoryBlock(resolvedBlockId, {
            content: newContent,
            updatedBy: "agent",
          });
          console.log(`[memory-blocks] Replaced section "${update.section}" in block "${existingBlock.name}" ${resolvedBlockId}`);
          updatesMade = true;
        }
      } else if (update.targetBlockName) {
        // No existing block found with this name — create a new one
        const newBlockId = `blk-${Math.random().toString(36).substr(2, 9)}`;
        createMemoryBlock({
          id: newBlockId,
          name: update.targetBlockName,
          description: update.reasoning.slice(0, 200),  // Use reasoning as initial description
          content: update.content,
          scope: projectId ? "project" : "global",
          projectId: projectId || "",
          createdAt: now,
          updatedAt: now,
          updatedBy: "agent",
        });
        console.log(`[memory-blocks] Created new block "${update.targetBlockName}" (${newBlockId})`);
        updatesMade = true;
      }
    } catch (e) {
      console.error(`[memory-blocks] Failed to apply block update:`, e);
    }
  }
  
  return updatesMade;
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

  // Filter out compaction summary messages — they contain archive indices
  // and system metadata, not actual conversation content worth remembering.
  const substantiveMessages = removedMessages.filter((m) => !m._isCompactionSummary);
  if (substantiveMessages.length === 0) {
    console.log("[memory] Pre-compaction flush: only compaction summaries, skipping");
    return;
  }

  console.log(`[memory] Pre-compaction flush: processing ${substantiveMessages.length} removed messages (${removedMessages.length - substantiveMessages.length} compaction summaries skipped)`);

  // Only send the messages being removed, not the full conversation
  const removedText = substantiveMessages
    .map((m, i) => formatMessageForExtraction(m, i))
    .join("\n\n---\n\n");

  const systemPrompt = await buildPreCompactionSystemPrompt(projectId);
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

    const outcome = await dedupAndSave(facts, embeddings, chatId, projectId);

    // Process block updates (only high-importance facts with blockUpdate field)
    // Use lower importance threshold (7) for pre-compaction flush since messages
    // are about to be removed — moderate-importance architectural context that would
    // normally stay in conversation needs more aggressive block preservation.
    const blockUpdatesMade = await processBlockUpdates(facts, projectId, 7);
    if (blockUpdatesMade) {
      invalidateStablePrefixCache(chatId);  // Force reload of updated blocks
    }

    // Invalidate memories cache so next turn picks up new memories
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

/**
 * Check if a new memory supersedes any existing memories.
 * Uses semantic similarity + contradiction detection to auto-create supersession links.
 */
async function checkSupersession(
  newMemoryId: string,
  newText: string,
  newEmbedding: number[]
): Promise<void> {
  const newMemory = await getMemoryById(newMemoryId);
  if (!newMemory) return;

  const similarMemories = await searchMemoriesRaw(newEmbedding, 10);

  for (const oldMemory of similarMemories) {
    // Skip if same memory or already has supersession link
    if (oldMemory.memory.id === newMemoryId) continue;
    if (oldMemory.memory.supersededBy) continue;

    // Only check memories older than the new one
    if (new Date(oldMemory.memory.createdAt) >= new Date(newMemory.createdAt)) continue;
    
    const similarity = 1 - oldMemory.score; // Convert distance to similarity
    const confidence = calculateSupersessionConfidence(newText, oldMemory.memory.text, similarity);
    
    if (confidence > 0.75) {
      console.log(
        `[memory] Auto-superson: "${oldMemory.memory.text}" → "${newText}" (confidence=${confidence.toFixed(2)}, similarity=${similarity.toFixed(2)})`
      );
      const linked = await createSupersessionLink(newMemoryId, oldMemory.memory.id, confidence);
      if (!linked) {
        console.log(`[memory] Supersession link rejected (cycle detected): ${oldMemory.memory.id} ↛ ${newMemoryId}`);
      }
    } else if (confidence > 0.50) {
      console.log(
        `[memory] Potential supersession flagged: "${oldMemory.memory.text}" vs "${newText}" (confidence=${confidence.toFixed(2)})`
      );
      // Could log to a review queue here for daily synthesis to pick up
    }
  }
}

function calculateSupersessionConfidence(newText: string, oldText: string, similarity: number): number {
  // Weighted confidence scoring based on multiple signals
  const similarityWeight = similarity * 0.4;
  
  // Check for contradiction patterns
  const contradictionPatterns = [
    /\bnot\b.*\b(previously|before|earlier)\b/i,
    /\b(previously|before|earlier)\b.*\bnot\b/i,
    /\bchanged\b.*\bfrom\b/i,
    /\bno longer\b/i,
    /\breplaced\b/i,
    /\binstead of\b/i,
    /\bupdated\b/i,
    /\bcorrected\b/i,
  ];
  
  const hasContradiction = contradictionPatterns.some(p => p.test(newText) || p.test(oldText));
  const contradictionScore = hasContradiction ? 0.3 : 0;
  
  // Specificity gain (newer text is longer/more detailed)
  const specificityGain = Math.max(0, newText.length - oldText.length) / 200;
  const specificityScore = Math.min(0.2, specificityGain);
  
  // Entity overlap (simple word overlap for now)
  const newWords = new Set(newText.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const oldWords = new Set(oldText.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const overlap = [...newWords].filter(w => oldWords.has(w)).length;
  const entityScore = Math.min(0.1, overlap / 5);
  
  return similarityWeight + contradictionScore + specificityScore + entityScore;
}

/**
 * Backfill scan: check all existing memories for potential supersessions.
 * Uses embedding-based similarity for accurate detection.
 */
export async function backfillSupersessions(): Promise<void> {
  console.log("[memory] Starting backfill supersession scan...");
  
  const db = getDb();
  const allMemories = await getAllMemories();
  
  // Sort by creation date descending (newest first)
  const sorted = allMemories.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  
  let processed = 0;
  let linked = 0;
  
  for (let i = 0; i < sorted.length; i++) {
    const newMemory = sorted[i];
    
    // Skip if already has supersession links
    if (newMemory.supersededBy || newMemory.supersedes) continue;
    
    // Get embedding for this memory
    const vecRow = db.prepare("SELECT embedding FROM vec_memories WHERE id = ?").get(newMemory.id) as { embedding: Buffer } | undefined;
    if (!vecRow) continue;
    
    const embedding = Array.from(new Float32Array(vecRow.embedding.buffer, vecRow.embedding.byteOffset, vecRow.embedding.byteLength / 4));
    
    // Search for similar older memories
    const similarMemories = await searchMemoriesRaw(embedding, 10);
    
    for (const match of similarMemories) {
      const oldMemory = match.memory;
      
      // Skip if not actually older
      if (new Date(oldMemory.createdAt).getTime() >= new Date(newMemory.createdAt).getTime()) continue;
      
      // Skip if already superseded
      if (oldMemory.supersededBy) continue;
      
      const similarity = 1 - match.score;
      const confidence = calculateSupersessionConfidence(newMemory.text, oldMemory.text, similarity);
      
      if (confidence > 0.75) {
        console.log(
          `[memory] Backfill: "${oldMemory.text}" → "${newMemory.text}" (confidence=${confidence.toFixed(2)}, similarity=${similarity.toFixed(2)})`
        );
        const linkCreated = await createSupersessionLink(newMemory.id, oldMemory.id, confidence);
        if (linkCreated) {
          linked++;
        } else {
          console.log(`[memory] Backfill supersession link rejected (cycle detected): ${oldMemory.id} ↛ ${newMemory.id}`);
        }
      }
    }
    
    processed++;
  }
  
  console.log(`[memory] Backfill complete: processed ${processed} memories, created ${linked} supersession links`);
}

// ---------------------------------------------------------------------------
// Delayed Full-Chat Extraction
// ---------------------------------------------------------------------------

const DEFAULT_MESSAGE_CAP = 50;

interface IndexedChatMessage {
  index: number;
  message: ChatMessage;
}

function isSubstantiveForDelayedExtraction(message: ChatMessage): boolean {
  return !message._isCompactionSummary && !message._outOfContext && !message._isSystemMessage;
}

/**
 * Build context for delayed extraction: recent messages + previous memories.
 * For long chats, caps the message window but includes all previous memories
 * to provide semantic compression of earlier conversation.
 */
async function buildDelayedExtractionContext(
  chat: Chat,
  messageCap: number = DEFAULT_MESSAGE_CAP
): Promise<{
  messages: IndexedChatMessage[];
  previousMemories: Omit<Memory, "embedding">[];
}> {
  const previousMemories = await getMemoriesByChatId(chat.id);
  const substantiveMessages = chat.messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => isSubstantiveForDelayedExtraction(message));
  
  if (substantiveMessages.length <= messageCap) {
    // Short chat: send everything
    return { messages: substantiveMessages, previousMemories };
  }
  
  // Long chat: send last N messages + all previous memories
  const recentMessages = substantiveMessages.slice(-messageCap);
  return { messages: recentMessages, previousMemories };
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
  
  if (chat.type !== "agent") {
    console.log(`[memory-delayed] Skipping quick chat ${chatId}`);
    return;
  }
  
  // Build context: recent messages + previous memories
  const context = await buildDelayedExtractionContext(chat, messageCap);
  if (context.messages.length === 0) {
    console.log(`[memory-delayed] No substantive messages to process for chat ${chatId}`);
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
    for (let i = 0; i < facts.length; i++) {
      const fact = facts[i];
      const factEmbedding = embeddings[i];

      // Check for duplicates against existing memories
      const match = await findDuplicates(factEmbedding, DEDUP_THRESHOLD);

      if (match) {
        console.log(
          `[memory-delayed] Skipping duplicate (sim=${match.similarity.toFixed(3)}): "${fact.text}"`
        );
        runSkipped++;
      } else {
        const now = new Date().toISOString();
        const newMemoryId = uuid();
        await addMemory({
          id: newMemoryId,
          text: fact.text,
          category: fact.category,
          importance: Math.min(10, Math.max(1, fact.importance)),
          embedding: factEmbedding,
          createdAt: now,
          lastAccessed: now,
          accessCount: 0,
          sourceChatId: chatId,
          ...(chat.projectId ? { projectId: chat.projectId } : {}),
          sourceType: 'chat_delayed',
          sourceId: chatId,
        });

        // Check for automatic supersession
        await checkSupersession(newMemoryId, fact.text, factEmbedding);
        runSaved++;
      }
    }

    // Update chat tracking fields without touching lastModified
    await updateChatExtractionState(chatId, new Date().toISOString(), chat.messages.length - 1);

    console.log(`[memory-delayed] Extraction complete for chat ${chatId}`);
    runHandle.complete({
      facts: facts.map((f) => ({ text: f.text, category: f.category, importance: f.importance })),
      saved: runSaved,
      superseded: 0,
      skippedDuplicates: runSkipped,
      errors: 0,
      chunks: { count: chunkResult.chunkCount, failures: chunkResult.chunkFailures, timingsMs: chunkResult.chunkTimingsMs },
    });
  } catch (e) {
    runHandle.fail(e);
    throw e;
  }
}
