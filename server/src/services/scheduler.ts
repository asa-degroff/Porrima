import crypto from "crypto";
import { shouldRunSynthesis, runDailySynthesis } from "./synthesis.js";
import { getDb, getSettings, saveSettings, createChat, findBlueskyChatId } from "./chat-storage.js";
import { v4 as uuidv4 } from "uuid";
import { extractDelayedMemories } from "./memory-extraction.js";
import { getBlueskyPoller } from "./bluesky-poller.js";
import { BLUESKY_SYSTEM_PROMPT } from "../routes/bluesky.js";
import { enrichCorpusBatch } from "./image-corpus.js";
import { synthesizeZeitgeist, shouldTriggerZeitgeistSynthesis } from "./zeitgeist.js";

const SYNTHESIS_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const DELAYED_EXTRACTION_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const ENRICHMENT_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_ENRICHMENT_BATCH_SIZE = 5;
const ZEITGEIST_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_ZEITGEIST_INACTIVITY_THRESHOLD_HOURS = 4; // 4 hours


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
 * Check and run corpus enrichment for entries missing embeddings or elements.
 * Called every 30 minutes to process backlog from failed fire-and-forget enrichments.
 * Uses small batch size to avoid overwhelming the LLM API.
 */
async function checkAndRunEnrichment() {
  try {
    const settings = await getSettings();
    const batchSize = settings.enrichmentBatchSize ?? DEFAULT_ENRICHMENT_BATCH_SIZE;
    const extractionModelId = settings.extractionModelId || settings.defaultModelId;
    
    console.log(`[scheduler] Running enrichment batch (size: ${batchSize}, model: ${extractionModelId || 'default'})...`);
    const enrichedCount = await enrichCorpusBatch(batchSize, extractionModelId);
    
    if (enrichedCount > 0) {
      console.log(`[scheduler] Enriched ${enrichedCount} corpus entries`);
    }
  } catch (e) {
    console.error("[scheduler] Enrichment check failed:", e);
  }
}

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
// Zeitgeist Synthesis Check (Deferred Trigger)
// ---------------------------------------------------------------------------

/**
 * Find agent chats that are inactive and need zeitgeist synthesis.
 * Criteria:
 * - Chat type is "agent"
 * - lastModified < now - threshold (inactive for N hours)
 * - (lastZeitgeistSynthesisAt IS NULL OR lastZeitgeistSynthesisAt < lastModified)
 *   (synthesis hasn't run since last activity)
 */
async function findChatsNeedingZeitgeistSynthesis(thresholdMs: number): Promise<string[]> {
  const db = getDb();
  const thresholdDate = new Date(Date.now() - thresholdMs).toISOString();
  
  const rows = db.prepare(`
    SELECT id, lastModified, lastZeitgeistSynthesisAt
    FROM chats
    WHERE type = 'agent'
      AND lastModified < ?
      AND (lastZeitgeistSynthesisAt IS NULL OR lastZeitgeistSynthesisAt < lastModified)
    ORDER BY lastModified DESC
  `).all(thresholdDate) as Array<{
    id: string;
    lastModified: string;
    lastZeitgeistSynthesisAt: string | null;
  }>;
  
  return rows.map(r => r.id);
}

/**
 * Check and run zeitgeist synthesis for inactive chats.
 * Called every 30 minutes to catch chats that cross the inactivity threshold.
 * Zeitgeist is global, so we only run one synthesis per check (not per chat).
 */
async function checkAndRunZeitgeistSynthesis() {
  try {
    const settings = await getSettings();
    const enabled = settings.zeitgeistEnabled ?? true;
    const thresholdHours = settings.zeitgeistInactivityThresholdHours ?? DEFAULT_ZEITGEIST_INACTIVITY_THRESHOLD_HOURS;
    const thresholdMs = thresholdHours * 60 * 60 * 1000;
    
    if (!enabled) {
      console.log("[scheduler] Zeitgeist synthesis disabled in settings");
      return;
    }
    
    // Check if zeitgeist needs synthesis based on capacity
    if (!shouldTriggerZeitgeistSynthesis()) {
      console.log("[scheduler] Zeitgeist under capacity threshold, skipping deferred check");
      return;
    }
    
    // Determine synthesis model from settings
    const configuredModelId = settings.extractionModelId || settings.defaultModelId;
    const fallbackEnabled = settings.extractionFallbackEnabled ?? true;
    
    // Discover available models once per run
    const { discoverOllamaModels } = await import("./models.js");
    const availableModels = await discoverOllamaModels();
    const availableModelIds = new Set(availableModels.map(m => m.id));
    
    // Resolve synthesis model
    let synthesisModelId = configuredModelId;
    if (!availableModelIds.has(synthesisModelId)) {
      if (fallbackEnabled && availableModels.length > 0) {
        console.log(`[scheduler] Configured synthesis model "${synthesisModelId}" not available, falling back to ${availableModels[0].id}`);
        synthesisModelId = availableModels[0].id;
      } else {
        console.error(`[scheduler] Synthesis model "${synthesisModelId}" not available and fallback disabled, aborting`);
        return;
      }
    }
    
    console.log(`[scheduler] Using zeitgeist synthesis model: ${synthesisModelId}`);
    
    // Find inactive chats (we only need one to trigger synthesis)
    const chatIds = await findChatsNeedingZeitgeistSynthesis(thresholdMs);
    if (chatIds.length === 0) {
      console.log("[scheduler] No chats meet zeitgeist inactivity threshold");
      return;
    }
    
    console.log(`[scheduler] Found ${chatIds.length} chat(s) needing zeitgeist synthesis, triggering with oldest inactive chat`);
    
    // Use the oldest inactive chat as the trigger (first in the list)
    const triggerChatId = chatIds[0];
    
    try {
      console.log(`[scheduler] Running zeitgeist synthesis with model ${synthesisModelId}...`);
      await synthesizeZeitgeist(synthesisModelId, triggerChatId, false);
      console.log(`[scheduler] Zeitgeist synthesis complete`);
    } catch (e) {
      console.error(`[scheduler] Zeitgeist synthesis failed:`, e);
    }
  } catch (e) {
    console.error("[scheduler] Zeitgeist check failed:", e);
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
  
  // Enrichment: wait 1 minute on startup before processing backlog
  setTimeout(() => {
    console.log("[scheduler] Running initial enrichment check (after 1min delay)...");
    checkAndRunEnrichment();
  }, 1 * 60 * 1000);
  
  // Zeitgeist: wait 5 minutes on startup before processing backlog
  // This gives the server time to stabilize and avoids immediate resource spike
  setTimeout(() => {
    console.log("[scheduler] Running initial zeitgeist check (after 5min delay)...");
    checkAndRunZeitgeistSynthesis();
  }, 5 * 60 * 1000);

  // Then check every 15 minutes for synthesis
  setInterval(checkAndRunSynthesis, SYNTHESIS_CHECK_INTERVAL_MS);
  
  // Check every 5 minutes for delayed extractions
  setInterval(checkAndRunDelayedExtractions, DELAYED_EXTRACTION_CHECK_INTERVAL_MS);
  
  // Check every 30 minutes for corpus enrichment
  setInterval(checkAndRunEnrichment, ENRICHMENT_CHECK_INTERVAL_MS);
  
  // Check every 30 minutes for zeitgeist synthesis
  setInterval(checkAndRunZeitgeistSynthesis, ZEITGEIST_CHECK_INTERVAL_MS);
  
  console.log("[scheduler] Started (synthesis every 15min, delayed extraction every 5min, enrichment every 30min, zeitgeist every 30min)");

  // Start Bluesky poller if enabled
  startBlueskyPoller();
}

/**
 * Start the Bluesky notification poller if enabled in settings.
 */
async function startBlueskyPoller(): Promise<void> {
  try {
    const settings = await getSettings();

    if (settings.bluesky?.enabled) {
      // Backfill missing blueskyChatId (e.g. interrupted setup, direct settings edit)
      if (!settings.bluesky.blueskyChatId) {
        const existing = await findBlueskyChatId();
        if (existing) {
          settings.bluesky.blueskyChatId = existing;
        } else {
          const chatId = uuidv4();
          await createChat({
            id: chatId, title: 'Bluesky', type: 'bluesky' as any,
            modelId: settings.defaultModelId,
            systemPrompt: BLUESKY_SYSTEM_PROMPT,
            messages: [],
            createdAt: new Date().toISOString(),
            lastModified: new Date().toISOString(),
          });
          settings.bluesky.blueskyChatId = chatId;
        }
        await saveSettings(settings);
        console.log(`[scheduler] Backfilled Bluesky chat: ${settings.bluesky.blueskyChatId}`);
      }

      const poller = getBlueskyPoller();
      const interval = settings.bluesky.pollingIntervalMinutes ?? 10;

      // Restore session if we have one
      if (settings.bluesky.blueskyChatId) {
        // Try to restore the most recent session
        const sessions = await import('./bluesky-agent.js').then(m => m.BlueskyAgent);
        const sessionInfos = sessions.getAllSessionInfo();
        
        if (sessionInfos.length > 0) {
          const agent = await import('./bluesky-agent.js').then(m => m.getBlueskyAgent());
          const restored = await agent.restoreSession(sessionInfos[0].did);
          
          if (restored) {
            console.log(`[scheduler] Restored Bluesky session for ${agent.getHandle()}`);
          }
        }
      }
      
      poller.start(interval);
      console.log(`[scheduler] Bluesky poller started (interval: ${interval}min)`);
    } else {
      console.log("[scheduler] Bluesky poller disabled in settings");
    }
  } catch (err: any) {
    console.error("[scheduler] Failed to start Bluesky poller:", err.message);
  }
}
