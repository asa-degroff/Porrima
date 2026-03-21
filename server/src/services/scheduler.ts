import { shouldRunSynthesis, runDailySynthesis } from "./synthesis.js";
import { getDb } from "./chat-storage.js";
import { getSettings } from "./chat-storage.js";
import { extractDelayedMemories } from "./memory-extraction.js";

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
    }
  } catch (e) {
    console.error("[scheduler] Synthesis check failed:", e);
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
      
      // Discover available models once per batch
      const { discoverOllamaModels } = await import("./models.js");
      const availableModels = await discoverOllamaModels();
      const availableModelIds = new Set(availableModels.map(m => m.id));
      
      await Promise.all(
        batch.map(async (chatId) => {
          try {
            const db = getDb();
            const modelRow = db.prepare("SELECT modelId FROM chats WHERE id = ?").get(chatId) as { modelId: string } | undefined;
            if (!modelRow) {
              console.warn(`[scheduler] Chat ${chatId} has no modelId, skipping`);
              return;
            }
            
            // Check if the chat's model is available; fall back to first available if not
            let extractionModelId = modelRow.modelId;
            if (!availableModelIds.has(extractionModelId)) {
              console.warn(`[scheduler] Chat ${chatId} model "${extractionModelId}" not available, falling back to ${availableModels[0]?.id}`);
              extractionModelId = availableModels[0]?.id || "qwen3:8b";
            }
            
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
