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
      // Truncate input to fit within the extraction model's context window.
      // Reserve tokens for system prompt, max_tokens output (2000), and overhead.
      // Use 3 chars/token (conservative — 4 underestimates for dense/code-heavy content).
      const ctxSize = settings.extractionCtxSize ?? 16384;
      const reservedTokens = 4000;
      const maxInputChars = Math.max(4000, (ctxSize - reservedTokens) * 3);
      const truncatedContent = userContent.length > maxInputChars
        ? userContent.slice(0, maxInputChars) + `\n[Truncated: ${(userContent.length / 1024).toFixed(0)}KB → ${(maxInputChars / 1024).toFixed(0)}KB to fit extraction context]`
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

What I capture: things worth remembering for future interactions — written in my own voice, as something I'd tell myself to remember. Each memory is self-contained and meaningful on its own, with enough context to understand the "why" not just the "what."

What I skip: my own identity traits, broad preferences,anything already in existing knowledge blocks, and generic observations without specific context.`;

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

async function buildExtractionSystemPrompt(projectId?: string): Promise<string> {
  // Include loaded block summaries so extraction avoids redundant facts
  let blockContext = "";
  try {
    const { getMemoryBlocksByScope } = await import("./memory-storage.js");
    const globalBlocks = getMemoryBlocksByScope("global");
    const projectBlocks = projectId ? getMemoryBlocksByScope("project", projectId) : [];
    const allBlocks = [...globalBlocks, ...projectBlocks];
    if (allBlocks.length > 0) {
      const summaries = allBlocks.map((b) => `- ${b.name}: ${b.content.slice(0, 4000)}`).join("\n");
      blockContext = `\n\n## Existing Knowledge Blocks\nThe following memory blocks already contain relevant context — do NOT extract information that is already covered here:\n${summaries}\n`;
    }
  } catch { /* non-critical */ }

  return `${EXTRACTION_AGENT_PREFIX}${blockContext}\n\n${EXTRACTION_INSTRUCTIONS}`;
}

const DELAYED_EXTRACTION_SYSTEM_INSTRUCTIONS = `---

## Delayed Memory Extraction Task

You are looking back at a full conversation thread you had. Your task is to extract patterns, decisions, and context that emerged across the entire conversation — write each memory in your own voice.

Previously captured memories will be provided alongside the conversation. Those memories are already saved — do NOT duplicate them. Instead, focus on:
1. **New developments** — patterns, decisions, or facts that emerged after the previous extraction
2. **Evolutions or contradictions** — if the user changed their mind or refined a previous position
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

These memories are already saved. Do NOT duplicate them.`;

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

  // Call the LLM to extract facts (with retry)
  let responseText = "";
  await withRetry(
    async () => {
      responseText = await callExtractionLLM(modelId, extractionPrompt, systemPrompt);
    },
    `extractMemories LLM call (chat ${chatId})`
  );
  runHandle.attachOutput(responseText);

  const facts = parseExtractionResponse(responseText);
  if (facts.length === 0) {
    console.log("[memory] No facts extracted from exchange");
    extractionMetrics.successfulExtractions++;
    extractionMetrics.lastExtractionAt = new Date().toISOString();
    runHandle.complete({ facts: [], saved: 0, superseded: 0, skippedDuplicates: 0, errors: 0 });
    return;
  }

  console.log(`[memory] Extracted ${facts.length} fact(s), embedding batch...`);

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
  // Load existing blocks with space awareness
  let blockContext = "";
  try {
    const { getMemoryBlocksByScope } = await import("./memory-storage.js");
    const globalBlocks = getMemoryBlocksByScope("global");
    const projectBlocks = projectId ? getMemoryBlocksByScope("project", projectId) : [];
    const allBlocks = [...globalBlocks, ...projectBlocks];
    
    if (allBlocks.length > 0) {
      const MAX_BLOCK_CHARS = 4000;
      const blockSummaries = allBlocks.map((b) => {
        const remainingSpace = MAX_BLOCK_CHARS - b.content.length;
        const spaceStatus = remainingSpace > 500 
          ? `${remainingSpace.toLocaleString()} chars remaining (good for appends)`
          : remainingSpace > 100
          ? `${remainingSpace.toLocaleString()} chars remaining (consider targeted edits)`
          : `${remainingSpace.toLocaleString()} chars remaining (space constrained)`;
        
        return `### ${b.name} [${b.id}]
Scope: ${b.scope}
${spaceStatus}

${b.content}`;
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
    .map((m, i) => `${m.role} (${i + 1}): ${m.content}`)
    .join("\n\n");

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
    let responseText = "";
    await withRetry(
      async () => {
        responseText = await callExtractionLLM(modelId, removedText, systemPrompt);
      },
      `preCompactionFlush LLM call (chat ${chatId})`
    );
    runHandle.attachOutput(responseText);

    const facts = parseExtractionResponse(responseText);
    if (facts.length === 0) {
      console.log("[memory] Pre-compaction flush: no facts extracted");
      runHandle.complete({ facts: [], saved: 0, superseded: 0, skippedDuplicates: 0, errors: 0 });
      return;
    }

    console.log(`[memory] Pre-compaction flush: ${facts.length} facts extracted, embedding batch...`);

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

  const extractionPrompt = `${author === 'user' ? 'User' : 'Agent'} notebook entry:\n${text}`;
  const systemPrompt = await buildExtractionSystemPrompt();

  let responseText = "";
  try {
    await withRetry(
      async () => {
        responseText = await callExtractionLLM(modelId, extractionPrompt, systemPrompt);
      },
      `extractMemoriesFromText LLM call (entry ${entryId})`
    );

    const facts = parseExtractionResponse(responseText);
    if (facts.length === 0) {
      console.log("[memory] No facts extracted from notebook entry");
      return;
    }

    console.log(`[memory] Extracted ${facts.length} fact(s) from notebook, embedding batch...`);

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

/**
 * Build context for delayed extraction: recent messages + previous memories.
 * For long chats, caps the message window but includes all previous memories
 * to provide semantic compression of earlier conversation.
 */
async function buildDelayedExtractionContext(
  chat: Chat,
  messageCap: number = DEFAULT_MESSAGE_CAP
): Promise<{
  messages: ChatMessage[];
  previousMemories: Omit<Memory, "embedding">[];
}> {
  const previousMemories = await getMemoriesByChatId(chat.id);
  
  if (chat.messages.length <= messageCap) {
    // Short chat: send everything
    return { messages: chat.messages, previousMemories };
  }
  
  // Long chat: send last N messages + all previous memories
  const recentMessages = chat.messages.slice(-messageCap);
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
  const startIndex = Math.max(0, chat.messages.length - context.messages.length);
  
  console.log(
    `[memory-delayed] Processing ${context.messages.length} messages (${startIndex}-${chat.messages.length}) with ${context.previousMemories.length} previous memories`
  );
  
  // Build prompt with previous memories injected
  const prompt = buildDelayedExtractionPrompt(context.previousMemories, context.messages.length, startIndex);
  
  // Serialize messages for LLM input
  const conversationText = context.messages
    .map((m, i) => `${m.role} (${startIndex + i + 1}): ${m.content}`)
    .join("\n\n");
  
  const extractionPrompt = `${prompt}\n\nCONVERSATION:\n${conversationText}`;
  const systemPrompt = await buildDelayedExtractionSystemPrompt();

  const runHandle = startExtractionRun({
    trigger: "delayed",
    chatId,
    chatTitle: chat.title,
    model: modelId,
    priorMemoryCount: context.previousMemories.length,
    messages: context.messages.map((m) => ({ role: m.role, content: m.content })),
    systemPrompt,
    userPrompt: extractionPrompt,
  });

  let runSaved = 0;
  let runSkipped = 0;

  try {
    // Call LLM to extract memories
    let responseText = "";
    try {
      await withRetry(
        async () => {
          responseText = await callExtractionLLM(modelId, extractionPrompt, systemPrompt);
        },
        `extractDelayedMemories LLM call (chat ${chatId})`
      );
    } catch (e) {
      console.error(`[memory-delayed] LLM extraction failed:`, e);
      throw e;
    }
    runHandle.attachOutput(responseText);

    const facts = parseExtractionResponse(responseText);
    if (facts.length === 0) {
      console.log(`[memory-delayed] No new memories extracted from chat ${chatId}`);
      // Still update tracking fields to mark extraction as run
      await updateChatExtractionState(chatId, new Date().toISOString(), chat.messages.length - 1);
      runHandle.complete({ facts: [], saved: 0, superseded: 0, skippedDuplicates: 0, errors: 0 });
      return;
    }

    console.log(`[memory-delayed] Extracted ${facts.length} new memory(ies), embedding batch...`);

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
    });
  } catch (e) {
    runHandle.fail(e);
    throw e;
  }
}
