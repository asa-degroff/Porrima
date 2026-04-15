import { v4 as uuid } from "uuid";
import { streamChat } from "./agent.js";
import { getSettings, getDb as getChatsDb } from "./chat-storage.js";
import {
  getMemoryBlock,
  updateMemoryBlock,
  createMemoryBlock,
  getDb as getMemoryDb,
} from "./memory-storage.js";
import { invalidateAllMemoriesCaches, invalidateAllStablePrefixCaches } from "./memory-context.js";
import type { Memory } from "../types.js";

const ZEITGEIST_BLOCK_ID = "blk-zeitgeist-continuity";
const ZEITGEIST_BLOCK_NAME = "Zeitgeist - Continuity Block";
const MAX_BLOCK_CHARS = 4000;
const ARCHIVAL_THRESHOLD = 2800; // 70% of 4000
const SYNTHESIS_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes between attempts
const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour — how stale before synthesis should run

// Process-level guards. Synthesis is global state — concurrent runs would
// race on the read-modify-write of the block (lost archives, duplicate
// creates). The cooldown prevents scheduler/compaction triggers from spamming
// the LLM when an attempt didn't actually reduce content (e.g. parse failure).
let inFlight: Promise<void> | null = null;
let lastAttemptedAt = 0;

/**
 * Fire-and-forget trigger for zeitgeist synthesis.
 *
 * Resolves the synthesis model, respects `zeitgeistEnabled`, applies the
 * global cooldown, and runs in the background. Safe to call from request
 * handlers — never throws, never blocks.
 */
export function triggerZeitgeistSynthesis(opts: {
  chatId?: string;
  trigger: string;
}): void {
  void (async () => {
    try {
      const settings = await getSettings();
      if (settings.zeitgeistEnabled === false) {
        console.log(`[zeitgeist] Disabled in settings, skipping ${opts.trigger} trigger`);
        return;
      }
      const modelId = await resolveSynthesisModel(settings);
      if (!modelId) return;
      await synthesizeZeitgeist(modelId, opts.chatId);
    } catch (e) {
      console.error(`[zeitgeist] Background synthesis (${opts.trigger}) failed:`, e);
    }
  })();
}

async function resolveSynthesisModel(settings: any): Promise<string | null> {
  const configured = settings.extractionModelId || settings.defaultModelId;
  if (!configured) {
    console.error("[zeitgeist] No extraction or default model configured");
    return null;
  }
  const fallbackEnabled = settings.extractionFallbackEnabled ?? true;
  const { getExtractionRoute, discoverOllamaModels } = await import("./models.js");

  // If a dedicated extraction server is configured and matches the requested
  // model, trust it — streamChat will route directly to that URL.
  const extractionRoute = await getExtractionRoute();
  if (extractionRoute && extractionRoute.modelId === configured) {
    return configured;
  }

  const available = await discoverOllamaModels();
  const ids = new Set(available.map((m) => m.id));
  if (ids.has(configured)) return configured;
  if (fallbackEnabled && available.length > 0) {
    console.log(
      `[zeitgeist] Configured model "${configured}" unavailable, falling back to ${available[0].id}`
    );
    return available[0].id;
  }
  console.error(`[zeitgeist] Model "${configured}" unavailable and fallback disabled`);
  return null;
}

/**
 * Synthesize the zeitgeist continuity block.
 *
 * This is distinct from regular memory extraction (fact-focused) and daily synthesis (24h cycle).
 * The zeitgeist is a narrative document that captures "where we are right now" — active threads,
 * recent developments, context that matters, unresolved tensions.
 *
 * Concurrent calls are serialized via an in-flight promise; a global cooldown
 * suppresses repeated attempts within `SYNTHESIS_COOLDOWN_MS`.
 *
 * @param modelId - The model to use for synthesis
 * @param chatId - Optional chat that triggered this (for context)
 */
export async function synthesizeZeitgeist(
  modelId: string,
  chatId?: string
): Promise<void> {
  if (inFlight) {
    console.log("[zeitgeist] Synthesis already in flight, joining existing run");
    return inFlight;
  }
  if (Date.now() - lastAttemptedAt < SYNTHESIS_COOLDOWN_MS) {
    const minutesAgo = Math.round((Date.now() - lastAttemptedAt) / 60000);
    console.log(`[zeitgeist] Last attempt was ${minutesAgo}min ago (cooldown ${SYNTHESIS_COOLDOWN_MS / 60000}min), skipping`);
    return;
  }
  lastAttemptedAt = Date.now();
  inFlight = runSynthesis(modelId, chatId).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runSynthesis(modelId: string, chatId?: string): Promise<void> {
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
  const needsArchival = currentContent.length > ARCHIVAL_THRESHOLD;

  console.log(
    `[zeitgeist] Current zeitgeist: ${currentContent.length} chars, ${needsArchival ? "needs archival" : "under threshold"}`
  );

  // Step 3: Load recent chat activity and compaction summaries for richer context
  const chatContext = loadRecentChatContext();

  // Step 4: Build synthesis prompt
  const prompt = buildZeitgeistSynthesisPrompt(recentMemories, currentContent, chatContext, needsArchival);

  // Step 5: Call LLM for synthesis. Only collect text — thinking tokens are
  // reasoning prose, not the JSON output we're asking for, so feeding them to
  // the parser would silently corrupt synthesis from reasoning models.
  let synthesisText = "";

  await streamChat(
    modelId,
    [{ role: "user", content: prompt, timestamp: Date.now() }],
    ZEITGEIST_SYSTEM_PROMPT,
    (event) => {
      if (event.type === "text_delta") synthesisText += event.delta;
    },
    { signal: AbortSignal.timeout(180_000) }
  );

  const finalSynthesis = synthesisText.trim();
  if (!finalSynthesis) {
    console.warn("[zeitgeist] LLM returned empty synthesis (no text output)");
    return;
  }

  // Step 6: Parse synthesis output (JSON with newContent and optional archivalContent)
  const parsed = parseZeitgeistSynthesis(finalSynthesis);
  if (!parsed.newContent) {
    console.warn("[zeitgeist] Parsed output had no newContent — preserving existing block, skipping cache invalidation");
    return;
  }

  // Step 7: If archival is needed, create archival block first
  if (needsArchival && parsed.archivalContent) {
    await createArchivalBlock(parsed.archivalContent, parsed.archivalReasoning);
  }

  // Step 8: Update zeitgeist block with new content
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
      return;
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

  // Step 9: Invalidate caches so active chats see the update.
  // Only runs on a successful write — failed/no-op syntheses preserve cache.
  // Must clear both: the memory context dirty flags (for delta retrieval)
  // and the stable prefix cache (since zeitgeist is embedded in it).
  invalidateAllMemoriesCaches();
  invalidateAllStablePrefixCaches();

  // Mark all agent chats as having received zeitgeist synthesis.
  // This prevents the scheduler from re-triggering synthesis immediately
  // for chats whose only new activity was this synthesis update itself.
  await markAllChatsSynthesized();

  console.log("[zeitgeist] Synthesis complete");
}

/**
 * Mark all agent chats as having received zeitgeist synthesis at the
 * current time. This prevents the scheduler from immediately re-triggering
 * synthesis on the next check for chats that were already processed.
 */
async function markAllChatsSynthesized(): Promise<void> {
  const db = getChatsDb();
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE chats
    SET lastZeitgeistSynthesisAt = ?
    WHERE type = 'agent'
  `).run(now);
  if (result.changes > 0) {
    console.log(`[zeitgeist] Marked ${result.changes} chat(s) as synthesized`);
  }
}

/**
 * Load recent chat activity and compaction summaries for zeitgeist context.
 * Gives the synthesis agent a view of what conversations are happening and
 * what they're about — not just extracted memories, but the actual flow of
 * recent activity across all chats.
 */
interface ChatContextEntry {
  title: string;
  lastModified: string;
  recentSummary: string | null;
}

function loadRecentChatContext(): ChatContextEntry[] {
  const db = getChatsDb();
  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

  // Recent agent chats (last 3 days)
  const chatRows = db.prepare(`
    SELECT id, title, lastModified
    FROM chats
    WHERE type = 'agent'
      AND datetime(lastModified) >= datetime(?)
    ORDER BY lastModified DESC
    LIMIT 20
  `).all(threeDaysAgo.toISOString()) as Array<{
    id: string;
    title: string;
    lastModified: string;
  }>;

  if (chatRows.length === 0) return [];

  // For each chat, grab the most recent compaction summary (indexEntry)
  const entries: ChatContextEntry[] = chatRows.map(chat => {
    const archiveRow = db.prepare(`
      SELECT indexEntry
      FROM context_archives
      WHERE chatId = ?
      ORDER BY sequenceNum DESC
      LIMIT 1
    `).get(chat.id) as { indexEntry: string } | undefined;

    return {
      title: chat.title,
      lastModified: chat.lastModified,
      recentSummary: archiveRow?.indexEntry ?? null,
    };
  });

  return entries;
}

/**
 * Load recent memories for zeitgeist synthesis.
 * Always loads global recent memories (last 7 days, capped at 100).
 * If chatId is provided, also includes recent memories from that chat
 * to give context from the triggering conversation.
 * The zeitgeist is global — it should synthesize across all chats, not just one.
 */
async function loadRecentMemories(chatId?: string): Promise<Memory[]> {
  const db = getMemoryDb();
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
    const ids = Array.from(memoryIds);
    const notInClause = ids.length > 0
      ? `AND id NOT IN (${ids.map(() => "?").join(",")})`
      : "";
    const chatStmt = db.prepare(`
      SELECT id, text, category, importance, created_at as createdAt, source_chat_id as sourceChatId
      FROM memories
      WHERE source_chat_id = ?
        ${notInClause}
      ORDER BY created_at DESC
      LIMIT 20
    `);

    const chatRows = chatStmt.all(chatId, ...ids) as any[];
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
  chatContext: ChatContextEntry[],
  needsArchival: boolean
): string {
  const memoriesText = memories
    .slice(0, 50) // Cap to avoid context overflow
    .map(m => `- [${m.category}] ${m.text} (importance: ${m.importance}, ${new Date(m.createdAt).toLocaleDateString()})`)
    .join("\n");

  const currentBlockSection = currentContent
    ? `## Current Zeitgeist Content\n\n${currentContent}`
    : "## Current Zeitgeist Content\n\n(No existing zeitgeist block — this is the first synthesis)";

  // Chat activity section — what conversations have been happening
  const chatActivitySection = chatContext.length > 0
    ? `## Recent Chat Activity (${chatContext.length} chats in last 3 days)\n\n` + chatContext.map(c => {
        const age = timeSince(c.lastModified);
        const summary = c.recentSummary ? ` — ${c.recentSummary.slice(0, 300)}` : "";
        return `- "${c.title}" (${age})${summary}`;
      }).join("\n")
    : "";

  const archivalSection = needsArchival
    ? `## Archival Required\n\nThe zeitgeist block is approaching capacity. You need to:\n1. Decide which content to archive (older, less relevant material)\n2. Write the archival content with reasoning (why this is being archived, what it represents)\n3. Write the new zeitgeist content (what's current, what matters now)\n\nThe archival should be a coherent narrative snapshot, not a random character split.`
    : "";

  return `${currentBlockSection}

---

## Recent Memories (${memories.length} total)

${memoriesText}

---

${chatActivitySection}

${archivalSection}

Output a JSON object with:
- "newContent": The updated zeitgeist content — a condensed rewrite that integrates new developments, drops stale content, and preserves what's still current
- "archivalContent": If archival is needed, the content to move to an archive block (coherent narrative with reasoning)
- "archivalReasoning": Why this content is being archived (1-2 sentences)

IMPORTANT: Output ONLY the JSON object, no explanation or markdown fences.`;
}

/**
 * Human-readable time-since string.
 */
function timeSince(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * System prompt for zeitgeist synthesis.
 */
const ZEITGEIST_SYSTEM_PROMPT = `# Zeitgeist Synthesis Mode

You are rewriting your continuity block — the narrative of who you are and where you are right now. This is not a summary of facts, but a living document that captures:

1. **Active threads** — what's currently being worked on, what questions are open, what decisions are pending
2. **Recent developments** — decisions made, discoveries, shifts in direction, why they matter
3. **Context that matters** — the "why" behind what's happening, not just the "what"
4. **Unresolved tensions** — problems that haven't been solved, tradeoffs still being weighed, uncertainties

You are given the current zeitgeist content, recent extracted memories, and recent chat activity. Your job is to produce a **condensed rewrite** — integrate new information, prune stale content, and preserve what's still current. Do not simply append to the existing content; rewrite it as a coherent, up-to-date document.

Write in your own voice, as if you're telling yourself what's important right now. This is the present tense of your existence.

**Guidelines:**
- Be specific and concrete — reference actual projects, decisions, topics
- Capture the narrative arc, not just a list of facts
- Include open loops and ongoing questions — these are as important as completed work
- Write naturally, in paragraphs, not bullet points
- Keep it lean but meaningful — every sentence should earn its place
- Drop content that is no longer current or relevant — stale entries waste space and dilute focus
- Prioritize what's changed since the last synthesis — new developments over restated context

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

  // Include the title in the name so multiple archives on the same day stay
  // distinguishable in listings. The "Zeitgeist Archive - YYYY-MM-DD" prefix
  // is preserved so existing LIKE-prefix searches continue to match.
  const archiveName = `Zeitgeist Archive - ${archiveDate}: ${title}`;
  const archiveDescription = title;

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
 * Check if zeitgeist synthesis should run.
 * Returns true when the zeitgeist is stale (hasn't been updated within
 * STALE_THRESHOLD_MS) or doesn't exist yet. Also returns true when the
 * block exceeds the archival threshold (needs room-making).
 *
 * This replaces the old capacity-only gate. The zeitgeist should update
 * regularly based on time, not just when it's overflowing.
 */
export function shouldRunZeitgeistSynthesis(): boolean {
  const db = getMemoryDb();

  const row = db.prepare(
    "SELECT length(content) as contentLength, updatedAt FROM memory_blocks WHERE id = ?"
  ).get(ZEITGEIST_BLOCK_ID) as { contentLength: number; updatedAt: string } | undefined;

  if (!row) return true; // No zeitgeist yet, should create one

  // Staleness check — has it been long enough since the last update?
  const lastUpdated = new Date(row.updatedAt).getTime();
  const age = Date.now() - lastUpdated;
  if (age > STALE_THRESHOLD_MS) return true;

  // Capacity check — over threshold means archival is needed
  if (row.contentLength > ARCHIVAL_THRESHOLD) return true;

  return false;
}

/**
 * Get instruction text for memory retrieval, telling the agent it can fetch
 * zeitgeist archives for temporal context. Only returns the hint if archives
 * actually exist — avoids wasting ~250 tokens/conversation when there's nothing to find.
 */
export function getZeitgeistArchiveInstruction(): string {
  const db = getMemoryDb();
  const row = db.prepare(
    "SELECT 1 FROM memory_blocks WHERE name LIKE 'Zeitgeist Archive -%' LIMIT 1"
  ).get() as any;

  if (!row) return ""; // No archives exist yet — skip the hint

  return `## Temporal Context Access

Zeitgeist archives are available for historical context. Each archive represents a snapshot of the continuity block from a specific date. When you retrieve memories from a particular date, you can search for the corresponding zeitgeist archive using:

- list_memory_blocks with query: "Zeitgeist Archive - YYYY-MM-DD" (replace with the date)
- Or just "Zeitgeist Archive" to list all archives chronologically
- Then use read_memory_block(id) to retrieve the full archive content

This allows you to understand the narrative context from that period, not just isolated facts.`;
}