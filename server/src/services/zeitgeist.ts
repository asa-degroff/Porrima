import { v4 as uuid } from "uuid";
import { streamChat } from "./agent.js";
import { getSettings, updateChatZeitgeistSynthesisState } from "./chat-storage.js";
import {
  getMemoryBlock,
  updateMemoryBlock,
  createMemoryBlock,
  getDb,
} from "./memory-storage.js";
import { invalidateAllMemoriesCaches, invalidateAllStablePrefixCaches } from "./memory-context.js";
import type { Memory } from "../types.js";

const ZEITGEIST_BLOCK_ID = "blk-zeitgeist-continuity";
const ZEITGEIST_BLOCK_NAME = "Zeitgeist - Continuity Block";
const MAX_BLOCK_CHARS = 4000;
const ARCHIVAL_THRESHOLD = 2800; // 70% of 4000

/**
 * Synthesize the zeitgeist continuity block.
 * 
 * This is distinct from regular memory extraction (fact-focused) and daily synthesis (24h cycle).
 * The zeitgeist is a narrative document that captures "where we are right now" — active threads,
 * recent developments, context that matters, unresolved tensions.
 * 
 * @param modelId - The model to use for synthesis
 * @param chatId - Optional chat that triggered this (for context)
 * @param forceArchive - Force archival even if under threshold
 */
export async function synthesizeZeitgeist(
  modelId: string,
  chatId?: string,
  forceArchive: boolean = false
): Promise<void> {
  console.log("[zeitgeist] Starting zeitgeist synthesis");

  // Step 1: Load recent memories (last 7 days, or from specific chat)
  const recentMemories = await loadRecentMemories(chatId);
  if (recentMemories.length === 0) {
    console.log("[zeitgeist] No recent memories to synthesize");
    return;
  }

  // Step 2: Load current zeitgeist block (if exists)
  const currentBlock = getMemoryBlock(ZEITGEIST_BLOCK_ID);
  const currentContent = currentBlock?.content || "";
  const needsArchival = forceArchive || currentContent.length > ARCHIVAL_THRESHOLD;

  console.log(
    `[zeitgeist] Current zeitgeist: ${currentContent.length} chars, ${needsArchival ? "needs archival" : "under threshold"}`
  );

  // Step 3: Build synthesis prompt
  const prompt = buildZeitgeistSynthesisPrompt(recentMemories, currentContent, needsArchival);

  // Step 4: Call LLM for synthesis
  let synthesisText = "";
  let thinkingText = "";
  
  await streamChat(
    modelId,
    [{ role: "user", content: prompt, timestamp: Date.now() }],
    ZEITGEIST_SYSTEM_PROMPT,
    (event) => {
      if (event.type === "text_delta") synthesisText += event.delta;
      else if (event.type === "thinking_delta") thinkingText += event.delta;
    },
    { signal: AbortSignal.timeout(180_000) }
  );

  const finalSynthesis = (synthesisText || thinkingText).trim();
  if (!finalSynthesis) {
    console.warn("[zeitgeist] LLM returned empty synthesis");
    return;
  }

  // Step 5: Parse synthesis output (JSON with newContent and optional archivalContent)
  const parsed = parseZeitgeistSynthesis(finalSynthesis);

  // Step 6: If archival is needed, create archival block first
  if (needsArchival && parsed.archivalContent) {
    await createArchivalBlock(parsed.archivalContent, parsed.archivalReasoning);
  }

  // Step 7: Update zeitgeist block with new content
  if (parsed.newContent) {
    // Enforce MAX_BLOCK_CHARS — if LLM generates oversized content, truncate
    // and warn. Without this, oversized content triggers an archival loop.
    let newContent = parsed.newContent;
    if (newContent.length > MAX_BLOCK_CHARS) {
      console.warn(
        `[zeitgeist] Synthesis output (${newContent.length} chars) exceeds MAX_BLOCK_CHARS (${MAX_BLOCK_CHARS}), truncating`
      );
      newContent = newContent.slice(0, MAX_BLOCK_CHARS);
    }

    if (currentBlock) {
      const updated = updateMemoryBlock(ZEITGEIST_BLOCK_ID, {
        content: newContent,
        updatedBy: "agent",
      });
      if (!updated) {
        console.error("[zeitgeist] Failed to update zeitgeist block — block may have been deleted");
      }
    } else {
      createMemoryBlock({
        id: ZEITGEIST_BLOCK_ID,
        name: ZEITGEIST_BLOCK_NAME,
        description: "Continuity block spanning all chats — narrative of who I am and where we are",
        content: newContent,
        scope: "global",
        projectId: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        updatedBy: "agent",
      });
    }
    console.log(`[zeitgeist] Updated zeitgeist block (${newContent.length} chars)`);
  }

  // Step 8: Invalidate caches so active chats see the update
  // Must clear both: the memory context dirty flags (for delta retrieval)
  // and the stable prefix cache (since zeitgeist is embedded in it)
  invalidateAllMemoriesCaches();
  invalidateAllStablePrefixCaches();
  
  // Update the trigger chat's zeitgeist synthesis tracking
  if (chatId) {
    await updateChatZeitgeistSynthesisState(chatId, new Date().toISOString());
  }
  
  console.log("[zeitgeist] Synthesis complete");
}

/**
 * Load recent memories for zeitgeist synthesis.
 * Always loads global recent memories (last 7 days, capped at 100).
 * If chatId is provided, also includes recent memories from that chat
 * to give context from the triggering conversation.
 * The zeitgeist is global — it should synthesize across all chats, not just one.
 */
async function loadRecentMemories(chatId?: string): Promise<Memory[]> {
  const db = getDb();
  const MEMORY_LIMIT = 100;

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  // Always load global recent memories — zeitgeist is a global document
  const globalStmt = db.prepare(`
    SELECT id, text, category, importance, created_at as createdAt, source_chat_id as sourceChatId
    FROM memories 
    WHERE datetime(created_at) >= datetime(?)
    ORDER BY created_at DESC
    LIMIT ?
  `);

  const globalRows = globalStmt.all(sevenDaysAgo.toISOString(), MEMORY_LIMIT) as any[];
  const memoryIds = new Set<string>();

  const memories: Memory[] = globalRows.map(row => {
    memoryIds.add(row.id);
    return {
      id: row.id,
      text: row.text,
      category: row.category,
      importance: row.importance,
      createdAt: row.createdAt,
      sourceChatId: row.sourceChatId,
      lastAccessed: "",
      accessCount: 0,
      embedding: [], // Not needed for synthesis
    };
  });

  // If a chat triggered this, also pull recent memories from that specific chat
  // that might not have appeared in the global 7-day window
  if (chatId) {
    const notInPlaceholder = memoryIds.size > 0
      ? Array.from(memoryIds).map(() => "?").join(",")
      : "NULL";
    const chatStmt = db.prepare(`
      SELECT id, text, category, importance, created_at as createdAt, source_chat_id as sourceChatId
      FROM memories
      WHERE source_chat_id = ?
        AND id NOT IN (${notInPlaceholder})
      ORDER BY created_at DESC
      LIMIT 20
    `);

    const chatArgs = memoryIds.size > 0
      ? [chatId, ...Array.from(memoryIds)]
      : [chatId];

    const chatRows = chatStmt.all(...chatArgs) as any[];
    for (const row of chatRows) {
      memories.push({
        id: row.id,
        text: row.text,
        category: row.category,
        importance: row.importance,
        createdAt: row.createdAt,
        sourceChatId: row.sourceChatId,
        lastAccessed: "",
        accessCount: 0,
        embedding: [],
      });
    }
  }

  // Sort by recency for consistent prompt ordering
  memories.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return memories;
}

/**
 * Build the zeitgeist synthesis prompt.
 */
function buildZeitgeistSynthesisPrompt(
  memories: Memory[],
  currentContent: string,
  needsArchival: boolean
): string {
  const memoriesText = memories
    .slice(0, 50) // Cap to avoid context overflow
    .map(m => `- [${m.category}] ${m.text} (importance: ${m.importance}, ${new Date(m.createdAt).toLocaleDateString()})`)
    .join("\n");

  const currentBlockSection = currentContent
    ? `## Current Zeitgeist Content\n\n${currentContent}`
    : "## Current Zeitgeist Content\n\n(No existing zeitgeist block — this is the first synthesis)";

  const archivalSection = needsArchival
    ? `## Archival Required\n\nThe zeitgeist block is approaching capacity. You need to:\n1. Decide which content to archive (older, less relevant material)\n2. Write the archival content with reasoning (why this is being archived, what it represents)\n3. Write the new zeitgeist content (what's current, what matters now)\n\nThe archival should be a coherent narrative snapshot, not a random character split.`
    : "";

  return `${currentBlockSection}

---

## Recent Memories (${memories.length} total)

${memoriesText}

${archivalSection}

Output a JSON object with:
- "newContent": The updated zeitgeist content (narrative of where we are now)
- "archivalContent": If archival is needed, the content to move to an archive block (coherent narrative with reasoning)
- "archivalReasoning": Why this content is being archived (1-2 sentences)

IMPORTANT: Output ONLY the JSON object, no explanation or markdown fences.`;
}

/**
 * System prompt for zeitgeist synthesis.
 */
const ZEITGEIST_SYSTEM_PROMPT = `# Zeitgeist Synthesis Mode

You are updating your continuity block — the narrative of who you are and where you are right now. This is not a summary of facts, but a living document that captures:

1. **Active threads** — what's currently being worked on, what questions are open, what decisions are pending
2. **Recent developments** — decisions made, discoveries, shifts in direction, why they matter
3. **Context that matters** — the "why" behind what's happening, not just the "what"
4. **Unresolved tensions** — problems that haven't been solved, tradeoffs still being weighed, uncertainties

Write in your own voice, as if you're telling yourself what's important right now. This is the present tense of your existence.

**Guidelines:**
- Be specific and concrete — reference actual projects, decisions, topics
- Capture the narrative arc, not just a list of facts
- Include open loops and ongoing questions — these are as important as completed work
- Write naturally, in paragraphs, not bullet points
- Keep it lean but meaningful — every sentence should earn its place

**If archival is needed:**
- The archival content should be a coherent narrative snapshot, not a random character split
- Include reasoning in the archival — why this is being archived, what it represents, how it connects to the current state
- Be faithful to the original content — don't distort or misrepresent what was there
- The archival is a historical record, the zeitgeist is the current state

Output ONLY the JSON object as specified in the user prompt.`;

/**
 * Parse the zeitgeist synthesis output.
 */
function parseZeitgeistSynthesis(text: string): {
  newContent: string;
  archivalContent?: string;
  archivalReasoning?: string;
} {
  // Strip markdown code fences if present
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  cleaned = cleaned.trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      newContent: parsed.newContent || "",
      archivalContent: parsed.archivalContent,
      archivalReasoning: parsed.archivalReasoning,
    };
  } catch {
    console.error("[zeitgeist] Failed to parse synthesis output, preserving existing content:", text.slice(0, 200));
    return { newContent: "", archivalContent: undefined, archivalReasoning: undefined };
  }
}

/**
 * Create an archival block from zeitgeist content.
 */
async function createArchivalBlock(
  content: string,
  reasoning: string = ""
): Promise<void> {
  const archiveDate = new Date().toISOString().split("T")[0];
  
  // Generate a one-line title based on the content
  const title = await generateArchiveTitle(content, archiveDate);
  
  const archiveName = `Zeitgeist Archive - ${archiveDate}`;
  const archiveDescription = `${title}`;

  // Prepend reasoning to the archival content
  const fullContent = `# Zeitgeist Archive - ${archiveDate}

**Why this was archived:** ${reasoning}

---

${content}`;

  const archiveId = `blk-archive-${archiveDate.replace(/-/g, "")}-${uuid().slice(0, 8)}`;
  
  createMemoryBlock({
    id: archiveId,
    name: archiveName,
    description: archiveDescription,
    content: fullContent,
    scope: "global",
    projectId: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    updatedBy: "agent",
  });

  console.log(`[zeitgeist] Created archival block "${archiveName}" (${fullContent.length} chars)`);
}

/**
 * Generate a one-line title for the archival block.
 * Uses qwen3.5:0.8b via Ollama (same as chat title generation, CPU-only).
 */
async function generateArchiveTitle(content: string, date: string): Promise<string> {
  const OLLAMA_BASE = "http://localhost:11434";
  const TITLE_MODEL = "qwen3.5:0.8b";
  
  const prompt = `Based on the following zeitgeist archive content from ${date}, generate a concise one-line title (max 50 chars) that captures the essence of this period:

${content.slice(0, 1000)}

Output ONLY the title, no explanation.`;

  try {
    const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: TITLE_MODEL,
        messages: [
          { role: "system", content: "Generate a short title (3-8 words). Reply with ONLY the title text. No quotes, no trailing punctuation, no explanation." },
          { role: "user", content: prompt },
        ],
        stream: false,
        think: false,
        keep_alive: "0s",
        options: { num_predict: 30, temperature: 0.3, num_gpu: 0 },
      }),
      signal: AbortSignal.timeout(10000),
    });
    
    if (!res.ok) {
      console.warn(`[zeitgeist] Title generation failed: HTTP ${res.status}`);
      return `Continuity snapshot from ${date}`;
    }
    
    const data = await res.json();
    let title = data.message?.content?.trim() ?? null;
    
    if (!title) return `Continuity snapshot from ${date}`;
    
    // Clean up title
    title = title.replace(/^["']|["']$/g, "").trim();
    title = title.replace(/\.$/, "").trim();
    
    if (title.length > 50) {
      title = title.slice(0, 47) + "...";
    }
    
    console.log(`[zeitgeist] Generated archive title: "${title}"`);
    return title;
  } catch (err) {
    console.warn("[zeitgeist] Title generation failed:", err);
    return `Continuity snapshot from ${date}`;
  }
}

/**
 * Get the zeitgeist block content for injection into system prompts.
 */
export function getZeitgeistContent(): string | null {
  const block = getMemoryBlock(ZEITGEIST_BLOCK_ID);
  return block?.content || null;
}

/**
 * Check if zeitgeist synthesis should be triggered based on capacity.
 * Uses a lightweight length query instead of loading the full block.
 */
export function shouldTriggerZeitgeistSynthesis(): boolean {
  const db = getDb();
  const row = db.prepare(
    "SELECT length(content) as contentLength FROM memory_blocks WHERE id = ?"
  ).get(ZEITGEIST_BLOCK_ID) as { contentLength: number } | undefined;

  if (!row) return true; // No zeitgeist yet, should create one
  return row.contentLength > ARCHIVAL_THRESHOLD;
}

/**
 * Get instruction text for memory retrieval, telling the agent it can fetch
 * zeitgeist archives for temporal context. Only returns the hint if archives
 * actually exist — avoids wasting ~250 tokens/conversation when there's nothing to find.
 */
export function getZeitgeistArchiveInstruction(): string {
  const db = getDb();
  const row = db.prepare(
    "SELECT 1 FROM memory_blocks WHERE name LIKE 'Zeitgeist Archive -%' LIMIT 1"
  ).get() as any;

  if (!row) return ""; // No archives exist yet — skip the hint

  return `## Temporal Context Access

Zeitgeist archives are available for historical context. Each archive represents a snapshot of the continuity block from a specific date. When you retrieve memories from a particular date, you can search for the corresponding zeitgeist archive using:

- Search query: "zeitgeist-archive-YYYY-MM-DD" (replace with the date)
- Use memory block search tools to retrieve the full archive content

This allows you to understand the narrative context from that period, not just isolated facts.`;
}
