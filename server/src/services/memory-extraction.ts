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

const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction system. Your job is to extract atomic facts from a conversation exchange.

Analyze the user's message and the assistant's response. Extract any facts worth remembering — user preferences, personal details, behaviors, instructions, or important context.

Output a JSON array of facts. Each fact should be:
- "text": A concise, standalone statement
- "category": One of "preference", "fact", "behavior", "instruction", "note", "reflection"
- "importance": 1-10 (10 = critical info, 1 = trivial detail)

If there is nothing worth remembering, output an empty array: []

IMPORTANT: Output ONLY the JSON array, no explanation or markdown fences. Example:
[{"text": "User's name is Alex", "category": "fact", "importance": 8}, {"text": "Project supports dark mode", "category": "preference", "importance": 4}]`;

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
        ["preference", "fact", "behavior", "instruction"].includes(f.category)
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

const PRE_COMPACTION_SYSTEM_PROMPT = `You are a memory preservation system. A conversation is approaching its context limit and will be truncated.

Review the conversation messages below that will be removed. Extract:
1. Important facts (user preferences, project details, preferences, instructions)
2. Current task/goal state — what is being worked on, what decisions were made, what code was discussed
3. Key technical context the agent needs to continue effectively

Output a JSON array of facts. Each fact should be:
- "text": A concise, standalone statement
- "category": One of "preference", "fact", "behavior", "instruction"
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
