import { v4 as uuid } from "uuid";
import { appendFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { streamChat } from "./agent.js";
import { embedBatch } from "./embeddings.js";
import { cosineSimilarity } from "./embeddings.js";
import {
  loadMemoryStore,
  addMemory,
  updateMemory,
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

const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction system. Your job is to extract atomic facts about the user from a conversation exchange.

Analyze the user's message and the assistant's response. Extract any facts worth remembering about the user — their preferences, personal details, behaviors, instructions, or important context.

Output a JSON array of facts. Each fact should be:
- "text": A concise, standalone statement about the user (e.g., "User prefers TypeScript over JavaScript")
- "category": One of "preference", "fact", "behavior", "instruction"
- "importance": 1-10 (10 = critical personal info, 1 = trivial detail)

If there is nothing worth remembering, output an empty array: []

IMPORTANT: Output ONLY the JSON array, no explanation or markdown fences. Example:
[{"text": "User's name is Alex", "category": "fact", "importance": 8}, {"text": "User prefers dark mode", "category": "preference", "importance": 4}]`;

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

  // Load existing memories for dedup
  const store = await loadMemoryStore();
  const existingMemories = store.memories;

  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i];
    const factEmbedding = embeddings[i];

    // Check for duplicates
    let bestMatch: { memory: Memory; similarity: number } | null = null;
    for (const existing of existingMemories) {
      const sim = cosineSimilarity(factEmbedding, existing.embedding);
      if (sim > DEDUP_THRESHOLD && (!bestMatch || sim > bestMatch.similarity)) {
        bestMatch = { memory: existing, similarity: sim };
      }
    }

    if (bestMatch) {
      // UPDATE: merge with existing memory
      console.log(
        `[memory] Updating existing memory (sim=${bestMatch.similarity.toFixed(3)}): "${bestMatch.memory.text}" -> "${fact.text}"`
      );
      await updateMemory(bestMatch.memory.id, {
        text: fact.text,
        embedding: factEmbedding,
        importance: Math.max(bestMatch.memory.importance, fact.importance),
        lastAccessed: new Date().toISOString(),
      });
    } else {
      // ADD: create new memory
      console.log(`[memory] New memory: "${fact.text}"`);
      const now = new Date().toISOString();
      const memory: Memory = {
        id: uuid(),
        text: fact.text,
        category: fact.category,
        importance: Math.min(10, Math.max(1, fact.importance)),
        embedding: factEmbedding,
        createdAt: now,
        lastAccessed: now,
        accessCount: 0,
        sourceChatId: chatId,
      };
      await addMemory(memory);
      existingMemories.push(memory); // So subsequent facts in this batch can dedup against it
    }
  }

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

Review the ENTIRE conversation below and extract ALL important facts about the user that should be preserved. Be thorough — this is the last chance to capture information before it's lost.

Output a JSON array of facts. Each fact should be:
- "text": A concise, standalone statement
- "category": One of "preference", "fact", "behavior", "instruction"
- "importance": 1-10

Output ONLY the JSON array.`;

export async function preCompactionFlush(
  modelId: string,
  chatId: string,
  messages: ChatMessage[]
): Promise<void> {
  console.log("[memory] Pre-compaction flush triggered");

  const conversationText = messages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n\n");

  let responseText = "";
  await withRetry(
    async () => {
      responseText = "";
      await streamChat(
        modelId,
        [{ role: "user", content: conversationText, timestamp: Date.now() }],
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

  const store = await loadMemoryStore();
  const existingMemories = store.memories;

  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i];
    const factEmbedding = embeddings[i];

    let bestMatch: { memory: Memory; similarity: number } | null = null;
    for (const existing of existingMemories) {
      const sim = cosineSimilarity(factEmbedding, existing.embedding);
      if (sim > DEDUP_THRESHOLD && (!bestMatch || sim > bestMatch.similarity)) {
        bestMatch = { memory: existing, similarity: sim };
      }
    }

    if (bestMatch) {
      await updateMemory(bestMatch.memory.id, {
        text: fact.text,
        embedding: factEmbedding,
        importance: Math.max(bestMatch.memory.importance, fact.importance),
        lastAccessed: new Date().toISOString(),
      });
    } else {
      const now = new Date().toISOString();
      const memory: Memory = {
        id: uuid(),
        text: fact.text,
        category: fact.category,
        importance: Math.min(10, Math.max(1, fact.importance)),
        embedding: factEmbedding,
        createdAt: now,
        lastAccessed: now,
        accessCount: 0,
        sourceChatId: chatId,
      };
      await addMemory(memory);
      existingMemories.push(memory);
    }
  }

  console.log("[memory] Pre-compaction flush complete");
}
