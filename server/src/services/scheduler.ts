import crypto from "crypto";
import { shouldRunSynthesis, runDailySynthesis } from "./synthesis.js";
import { getDb } from "./chat-storage.js";
import { getSettings } from "./chat-storage.js";
import { extractDelayedMemories } from "./memory-extraction.js";
import { buildClusters } from "./cluster-engine.js";
import { getClusters } from "./cluster-storage.js";
import { getAllCorpusEntries } from "./image-corpus.js";
import { proposeDirections } from "./creative-engine.js";
import { addMemory } from "./memory-storage.js";

const SYNTHESIS_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DELAYED_EXTRACTION_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

// ---------------------------------------------------------------------------
// Daily Synthesis Check
// ---------------------------------------------------------------------------

async function checkAndRunSynthesis() {
  try {
    if (await shouldRunSynthesis()) {
      console.log("[scheduler] Synthesis due, starting...");
      await runDailySynthesis();
      
      // After synthesis, rebuild clusters and generate creative directions
      await runCorpusCreativeCycle();
    }
  } catch (e) {
    console.error("[scheduler] Synthesis check failed:", e);
  }
}

/**
 * Run the corpus creative cycle: rebuild clusters, generate directions, save as memories.
 * Called during daily synthesis to keep the creative engine fresh.
 */
async function runCorpusCreativeCycle() {
  try {
    console.log("[scheduler] Running corpus creative cycle...");
    
    // 1. Rebuild clusters with current corpus
    const corpus = await getAllCorpusEntries();
    const clusterMap = await buildClusters(corpus);
    console.log(`[scheduler] Rebuilt ${clusterMap.clusters.length} clusters from ${corpus.length} images`);
    
    // 2. Generate creative directions
    const directions = await proposeDirections(clusterMap.clusters, corpus, { limit: 5, minNovelty: 0.6 });
    console.log(`[scheduler] Generated ${directions.length} creative directions`);
    
    // 3. Save directions as context memories for future reference
    for (const dir of directions.slice(0, 3)) {
      await addMemory({
        id: crypto.randomUUID(),
        text: `Creative direction proposed: ${dir.type} - ${dir.description}. Prompt: ${dir.proposedPrompt.substring(0, 200)}...`,
        category: "context",
        importance: 6,
        embedding: dir.proposedEmbedding ?? [],
        createdAt: new Date().toISOString(),
        lastAccessed: new Date().toISOString(),
        accessCount: 0,
        sourceChatId: undefined,
        projectId: undefined,
        sourceType: "synthesis",
        sourceId: `creative-cycle-${Date.now()}`,
        supersededBy: undefined,
        supersedes: undefined,
      });
    }
    
    console.log("[scheduler] Corpus creative cycle complete");
  } catch (e) {
    console.error("[scheduler] Corpus creative cycle failed:", e);
  }
}

// ---------------------------------------------------------------------------
// Delayed Extraction Check
// ---------------------------------------------------------------------------

/**
 * Find agent chats that are inactive and need delayed extraction.
 * Criteria:
 * - Chat type is "agent"
 * - lastModified < now - threshold (inactive for N minutes)
 * - (lastDelayedExtractionAt IS NULL OR lastDelayedExtractionAt < lastModified)
 *   (extraction hasn't run since last activity)
 */
async function findChatsNeedingDelayedExtraction(thresholdMs: number): Promise<string[]> {
  const db = getDb();
  const now = new Date().toISOString();
  const thresholdDate = new Date(Date.now() - thresholdMs).toISOString();
  
  const rows = db.prepare(`
    SELECT id, lastModified, lastDelayedExtractionAt
    FROM chats
    WHERE type = 'agent'
      AND lastModified < ?
      AND (lastDelayedExtractionAt IS NULL OR lastDelayedExtractionAt < lastModified)
    ORDER BY lastModified DESC
  `).all(thresholdDate) as Array<{
    id: string;
    lastModified: string;
    lastDelayedExtractionAt: string | null;
  }>;
  
  return rows.map(r => r.id);
}

/**
 * Check and run delayed extractions for inactive chats.
 * Called every 5 minutes to catch chats that cross the inactivity threshold.
 * Processes chats in batches to avoid overwhelming the LLM API.
 */
async function checkAndRunDelayedExtractions() {
  try {
    const settings = await getSettings();
    const enabled = settings.delayedExtractionEnabled ?? true;
    const thresholdMinutes = settings.delayedExtractionThresholdMinutes ?? 30;
    const thresholdMs = thresholdMinutes * 60 * 1000;
    
    if (!enabled) {
      console.log("[scheduler] Delayed extraction disabled in settings");
      return;
    }
    
    // Determine extraction model from settings
    const configuredExtractionModelId = settings.extractionModelId || settings.defaultModelId;
    const fallbackEnabled = settings.extractionFallbackEnabled ?? true;
    
    // Discover available models once per run
    const { discoverOllamaModels } = await import("./models.js");
    const availableModels = await discoverOllamaModels();
    const availableModelIds = new Set(availableModels.map(m => m.id));
    
    // Resolve extraction model
    let extractionModelId = configuredExtractionModelId;
    if (!availableModelIds.has(extractionModelId)) {
      if (fallbackEnabled && availableModels.length > 0) {
        console.log(`[scheduler] Configured extraction model "${extractionModelId}" not available, falling back to ${availableModels[0].id}`);
        extractionModelId = availableModels[0].id;
      } else {
        console.error(`[scheduler] Extraction model "${extractionModelId}" not available and fallback disabled, aborting`);
        return;
      }
    }
    
    console.log(`[scheduler] Using extraction model: ${extractionModelId}`);
    
    const chatIds = await findChatsNeedingDelayedExtraction(thresholdMs);
    if (chatIds.length === 0) {
      return; // No chats need extraction
    }
    
    console.log(`[scheduler] Found ${chatIds.length} chat(s) needing delayed extraction`);
    
    // Process in batches of 3 to avoid overwhelming the LLM API
    const BATCH_SIZE = 3;
    for (let i = 0; i < chatIds.length; i += BATCH_SIZE) {
      const batch = chatIds.slice(i, i + BATCH_SIZE);
      console.log(`[scheduler] Processing batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.join(", ")}`);
      
      await Promise.all(
        batch.map(async (chatId) => {
          try {
            console.log(`[scheduler] Running delayed extraction for chat ${chatId} with model ${extractionModelId}...`);
            await extractDelayedMemories(chatId, extractionModelId);
            console.log(`[scheduler] Delayed extraction complete for chat ${chatId}`);
          } catch (e) {
            console.error(`[scheduler] Delayed extraction failed for chat ${chatId}:`, e);
          }
        })
      );
      
      // Small delay between batches to give LLM time to recover
      if (i + BATCH_SIZE < chatIds.length) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    console.log(`[scheduler] Delayed extraction backlog complete (${chatIds.length} chats processed)`);
  } catch (e) {
    console.error("[scheduler] Delayed extraction check failed:", e);
  }
}

// ---------------------------------------------------------------------------
// Scheduler Startup
// ---------------------------------------------------------------------------

export function startScheduler(): void {
  // Run synthesis check immediately on startup (catches overdue synthesis)
  checkAndRunSynthesis();
  
  // Delayed extraction: wait 2 minutes on startup before processing backlog
  // This gives the server time to stabilize and avoids immediate resource spike
  setTimeout(() => {
    console.log("[scheduler] Running initial delayed extraction check (after 2min delay)...");
    checkAndRunDelayedExtractions();
  }, 2 * 60 * 1000);

  // Then check hourly for synthesis
  setInterval(checkAndRunSynthesis, SYNTHESIS_CHECK_INTERVAL_MS);
  
  // Check every 5 minutes for delayed extractions
  setInterval(checkAndRunDelayedExtractions, DELAYED_EXTRACTION_CHECK_INTERVAL_MS);
  
  console.log("[scheduler] Started (synthesis hourly, delayed extraction every 5 minutes)");
}
