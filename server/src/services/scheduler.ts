import crypto from "crypto";
import { shouldRunSynthesis, runDailySynthesis } from "./synthesis.js";
import { getDb, getSettings, saveSettings, createChat, findBlueskyChatId } from "./chat-storage.js";
import { v4 as uuidv4 } from "uuid";
import { extractDelayedMemories } from "./memory-extraction.js";
import { getBlueskyPoller } from "./bluesky-poller.js";
import { BLUESKY_SYSTEM_PROMPT } from "../routes/bluesky.js";
import { enrichCorpusBatch } from "./image-corpus.js";
import { triggerZeitgeistSynthesis, shouldRunZeitgeistSynthesis } from "./zeitgeist.js";

const SYNTHESIS_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const DELAYED_EXTRACTION_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const ENRICHMENT_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_ENRICHMENT_BATCH_SIZE = 5;
const ZEITGEIST_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_ZEITGEIST_INACTIVITY_THRESHOLD_HOURS = 1; // 1 hour


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
// Zeitgeist Synthesis Check
// ---------------------------------------------------------------------------

/**
 * Find agent chats that have had activity since the last zeitgeist synthesis.
 * Used to determine whether there's new material to weave into the zeitgeist.
 * Criteria:
 * - Chat type is "agent"
 * - Inactive for at least the threshold period
 * - Has activity newer than the last zeitgeist synthesis for that chat
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
 * Check and run zeitgeist synthesis.
 * Called every 15 minutes. Runs when the zeitgeist block is stale
 * (hasn't been updated recently) or needs archival. The zeitgeist is
 * global, so we only run one synthesis per check.
 */
async function checkAndRunZeitgeistSynthesis() {
  try {
    // Staleness/capacity check — replaces the old capacity-only gate.
    // Returns true when the block hasn't been updated in an hour, or
    // needs archival, or doesn't exist yet.
    if (!shouldRunZeitgeistSynthesis()) {
      return;
    }

    const settings = await getSettings();
    const thresholdHours = settings.zeitgeistInactivityThresholdHours ?? DEFAULT_ZEITGEIST_INACTIVITY_THRESHOLD_HOURS;
    const thresholdMs = thresholdHours * 60 * 60 * 1000;

    const chatIds = await findChatsNeedingZeitgeistSynthesis(thresholdMs);
    if (chatIds.length === 0) {
      // No chats with new activity — still run synthesis if the block is
      // over capacity (archival needed) or doesn't exist yet. The staleness
      // check above already confirmed one of these conditions.
      const db = getDb();
      const row = db.prepare(
        "SELECT length(content) as contentLength FROM memory_blocks WHERE id = ?"
      ).get("blk-zeitgeist-continuity") as { contentLength: number } | undefined;

      if (!row) {
        // Block doesn't exist yet — create it even without chat activity
        console.log("[scheduler] Zeitgeist block missing, triggering creation");
        triggerZeitgeistSynthesis({ trigger: "scheduler" });
      } else if (row.contentLength > 2800) {
        // Over capacity — run synthesis for archival
        console.log("[scheduler] Zeitgeist over capacity threshold, triggering archival synthesis");
        triggerZeitgeistSynthesis({ trigger: "scheduler" });
      }
      // Otherwise: stale but no new chat activity — wait for new material
      return;
    }

    const triggerChatId = chatIds[0];
    console.log(`[scheduler] Triggering zeitgeist synthesis (${chatIds.length} candidate chats, using most-recently-inactive: ${triggerChatId})`);
    triggerZeitgeistSynthesis({ chatId: triggerChatId, trigger: "scheduler" });
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
  
  // Check every 15 minutes for zeitgeist synthesis
  setInterval(checkAndRunZeitgeistSynthesis, ZEITGEIST_CHECK_INTERVAL_MS);
  
  console.log("[scheduler] Started (synthesis every 15min, delayed extraction every 5min, enrichment every 30min, zeitgeist every 15min)");

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