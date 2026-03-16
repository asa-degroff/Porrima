import { v4 as uuid } from "uuid";
import { appendFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { streamChat } from "./agent.js";
import { embedBatch } from "./embeddings.js";
import {
  addMemory,
  updateMemory,
  findDuplicates,
} from "./memory-storage.js";
import type { ChatMessage, Memory, MemoryCategory } from "../types.js";

const LOG_DIR = join(homedir(), ".quje-agent", "logs");

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

const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction system. Analyze a conversation exchange and extract information worth remembering for future interactions.

Think beyond surface-level facts. Consider:
- **User context**: preferences, expertise, role, goals, working style
- **Project context**: architecture decisions, tech stack details, ongoing initiatives, constraints, what's being built and why
- **Decisions & rationale**: why something was chosen over alternatives, tradeoffs discussed
- **Relationships**: connections between concepts, dependencies, blockers
- **Lessons**: what worked, what didn't, patterns that emerged

Each extracted memory should be a self-contained statement that would be meaningful without the original conversation. Include enough context to understand the "why" — not just the "what." 1-3 sentences per memory is ideal.

Output a JSON array. Each item:
- "text": A standalone statement with sufficient context (1-3 sentences)
- "category": One of "preference", "fact", "behavior", "instruction", "context", "decision"
- "importance": 1-10 (10 = critical, 1 = trivial)

Categories:
- "preference" — user likes, dislikes, stylistic choices
- "fact" — concrete information about the user, their role, or their environment
- "behavior" — recurring patterns in how the user works or communicates
- "instruction" — explicit directives about how the agent should behave
- "context" — project-level information: architecture, tech choices, ongoing work, constraints, relationships between systems
- "decision" — a choice that was made and why, tradeoffs considered

If nothing is worth remembering, output: []

IMPORTANT: Output ONLY the JSON array, no explanation or markdown fences.`;

interface ExtractedFact {
  text: string;
  category: MemoryCategory;
  importance: number;
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
        ["preference", "fact", "behavior", "instruction", "context", "decision"].includes(f.category)
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
export async function dedupAndSave(
  facts: ExtractedFact[],
  embeddings: number[][],
  chatId: string
): Promise<void> {
  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i];
    const factEmbedding = embeddings[i];

    const match = await findDuplicates(factEmbedding, DEDUP_THRESHOLD);

    if (match) {
      console.log(
        `[memory] Updating existing memory (sim=${match.similarity.toFixed(3)}): "${match.memory.text}" -> "${fact.text}"`
      );
      await updateMemory(match.memory.id, {
        text: fact.text,
        embedding: factEmbedding,
        importance: Math.max(match.memory.importance, fact.importance),
        lastAccessed: new Date().toISOString(),
      });
    } else {
      console.log(`[memory] New memory: "${fact.text}"`);
      const now = new Date().toISOString();
      await addMemory({
        id: uuid(),
        text: fact.text,
        category: fact.category,
        importance: Math.min(10, Math.max(1, fact.importance)),
        embedding: factEmbedding,
        createdAt: now,
        lastAccessed: now,
        accessCount: 0,
        sourceChatId: chatId,
      });
    }
  }
}

export async function extractMemories(
  modelId: string,
  chatId: string,
  userMsg: string,
  assistantMsg: string
): Promise<void> {
  extractionMetrics.totalExtractions++;
  try {
  const extractionPrompt = `User message: ${userMsg}\n\nAssistant response: ${assistantMsg}`;

  // Call the LLM to extract facts (with retry)
  let responseText = "";
  await withRetry(
    async () => {
      responseText = "";
      await streamChat(
        modelId,
        [{ role: "user", content: extractionPrompt, timestamp: Date.now() }],
        EXTRACTION_SYSTEM_PROMPT,
        (event) => {
          if (event.type === "text_delta") {
            responseText += event.delta;
          }
        }
      );
    },
    `extractMemories LLM call (chat ${chatId})`
  );

  const facts = parseExtractionResponse(responseText);
  if (facts.length === 0) {
    console.log("[memory] No facts extracted from exchange");
    extractionMetrics.successfulExtractions++;
    extractionMetrics.lastExtractionAt = new Date().toISOString();
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
    return;
  }

  // Dedup and save inside a single write lock to prevent concurrent overwrites
  await dedupAndSave(facts, embeddings, chatId);

  extractionMetrics.successfulExtractions++;
  extractionMetrics.totalFactsExtracted += facts.length;
  extractionMetrics.lastExtractionAt = new Date().toISOString();
  } catch (e) {
    extractionMetrics.failedExtractions++;
    extractionMetrics.lastFailureAt = new Date().toISOString();
    throw e;
  }
}

const PRE_COMPACTION_SYSTEM_PROMPT = `You are a memory preservation system. A conversation is approaching its context limit and messages will be removed.

Review the messages below and extract everything the agent needs to continue effectively. Focus on:
1. Task state — what is being worked on, what's done, what's pending, what decisions were made
2. Technical context — files discussed, architecture patterns, code changes, API details
3. User context — preferences, instructions, corrections, expertise revealed
4. Decisions & rationale — why approaches were chosen, tradeoffs considered, alternatives rejected

Each memory should be self-contained and meaningful without the original conversation (1-3 sentences).

Output a JSON array. Each item:
- "text": A standalone statement with sufficient context (1-3 sentences)
- "category": One of "preference", "fact", "behavior", "instruction", "context", "decision"
- "importance": 1-10

Output ONLY the JSON array.`;

/**
 * Pre-compaction flush: extract memories from messages that are about to be removed.
 * Only sends the removed messages (not full conversation) to avoid hitting context limits.
 * Captures both user facts AND task/goal state for agent continuity.
 */
export async function preCompactionFlush(
  modelId: string,
  chatId: string,
  removedMessages: ChatMessage[]
): Promise<void> {
  if (removedMessages.length === 0) {
    console.log("[memory] Pre-compaction flush: no messages to process");
    return;
  }

  console.log(`[memory] Pre-compaction flush: processing ${removedMessages.length} removed messages`);

  // Only send the messages being removed, not the full conversation
  const removedText = removedMessages
    .map((m, i) => `${m.role} (${i + 1}): ${m.content}`)
    .join("\n\n");

  let responseText = "";
  await withRetry(
    async () => {
      responseText = "";
      await streamChat(
        modelId,
        [{ role: "user", content: removedText, timestamp: Date.now() }],
        PRE_COMPACTION_SYSTEM_PROMPT,
        (event) => {
          if (event.type === "text_delta") {
            responseText += event.delta;
          }
        }
      );
    },
    `preCompactionFlush LLM call (chat ${chatId})`
  );

  const facts = parseExtractionResponse(responseText);
  if (facts.length === 0) {
    console.log("[memory] Pre-compaction flush: no facts extracted");
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
    return;
  }

  await dedupAndSave(facts, embeddings, chatId);

  console.log("[memory] Pre-compaction flush complete");
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

  let responseText = "";
  try {
    await withRetry(
      async () => {
        responseText = "";
        await streamChat(
          modelId,
          [{ role: "user", content: extractionPrompt, timestamp: Date.now() }],
          EXTRACTION_SYSTEM_PROMPT,
          (event) => {
            if (event.type === "text_delta") {
              responseText += event.delta;
            }
          }
        );
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

    await dedupAndSave(facts, embeddings, entryId);
    console.log("[memory] Notebook memory extraction complete");
  } catch (e) {
    console.error("[memory] Notebook extraction failed:", e);
    throw e;
  }
}
