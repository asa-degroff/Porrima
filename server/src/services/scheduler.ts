import { isSynthesisActive } from "./system-chat.js";
import { reapStaleTurnLease } from "./turn-gate.js";
import { getDb, getSettings } from "./chat-storage.js";
import { extractDelayedMemories, hasActiveChats, isChatActive } from "./memory-extraction.js";
import { normalizeRouterModelId } from "./llama-router-client.js";
import { startAutomationScheduler } from "./automation-scheduler.js";
import { isSystemPauseActive } from "./system-pause.js";
import { sweepExpired } from "./tool-output-store.js";

const DELAYED_EXTRACTION_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const TOOL_OUTPUT_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let delayedExtractionCheckRunning = false;
const delayedExtractionsInProgress = new Set<string>();


// ---------------------------------------------------------------------------
// Delayed Extraction Check
// ---------------------------------------------------------------------------

/**
 * Find agent chats that are inactive and need delayed extraction.
 * Criteria:
 * - Chat type is "agent"
 * - lastModified < now - threshold (inactive for N minutes)
 * - AND (one of):
 *   - lastDelayedExtractionAt IS NULL (never extracted)
 *   - lastDelayedExtractionAt < lastModified (new activity since last run)
 *   - lastDelayedExtractionMessageIndex < lastDelayedExtractionTailIndex
 *     (over-cap window still draining — the watermark lags the tail the last
 *     run persisted; re-select until the backlog is processed)
 */
export async function findChatsNeedingDelayedExtraction(thresholdMs: number): Promise<string[]> {
  const db = getDb();
  const thresholdDate = new Date(Date.now() - thresholdMs).toISOString();

  const rows = db.prepare(`
    SELECT id, lastModified, lastDelayedExtractionAt
    FROM chats
    WHERE lastModified < ?
      AND (
        lastDelayedExtractionAt IS NULL
        OR lastDelayedExtractionAt < lastModified
        OR (lastDelayedExtractionMessageIndex IS NOT NULL
            AND lastDelayedExtractionTailIndex IS NOT NULL
            AND lastDelayedExtractionMessageIndex < lastDelayedExtractionTailIndex)
      )
    ORDER BY lastModified DESC
  `).all(thresholdDate) as Array<{
    id: string;
    lastModified: string;
    lastDelayedExtractionAt: string | null;
  }>;

  return rows.map(r => r.id);
}

// ---------------------------------------------------------------------------
// Delayed Extraction Check
// ---------------------------------------------------------------------------

/**
 * Check and run delayed extractions for inactive chats.
 * Called every 5 minutes to catch chats that cross the inactivity threshold.
 * Processes chats in batches to avoid overwhelming the LLM API.
 */
export async function checkAndRunDelayedExtractions() {
  if (delayedExtractionCheckRunning) {
    console.log("[scheduler] Skipping delayed extraction check — previous check still running");
    return;
  }

  delayedExtractionCheckRunning = true;
  try {
    const settings = await getSettings();
    if (isSystemPauseActive(settings)) {
      console.log("[scheduler] Skipping delayed extraction — system pause active");
      return;
    }

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

    let extractionModelId = configuredExtractionModelId
      ? normalizeRouterModelId(configuredExtractionModelId)
      : configuredExtractionModelId;

    // If a dedicated extraction server is configured, trust it as authoritative
    // for the extraction model — streamChat will route to that URL directly.
    // Skip the chat-router availability check entirely.
    const { getExtractionRoute, discoverAllModels } = await import("./models.js");
    const extractionRoute = await getExtractionRoute();

    if (!extractionRoute) {
      // No dedicated server: verify the model is loaded somewhere reachable
      // (extraction or chat-router llama.cpp) before dispatching work.
      const availableModels = await discoverAllModels();
      const availableModelIds = new Set(availableModels.map(m => m.id));
      if (!availableModelIds.has(extractionModelId)) {
        if (fallbackEnabled && availableModels.length > 0) {
          console.log(`[scheduler] Configured extraction model "${extractionModelId}" not available, falling back to ${availableModels[0].id}`);
          extractionModelId = availableModels[0].id;
        } else {
          console.error(`[scheduler] Extraction model "${extractionModelId}" not available and fallback disabled, aborting`);
          return;
        }
      }
    }
    
    console.log(`[scheduler] Using extraction model: ${extractionModelId}`);

    // Skip entirely if a chat is actively running — its compaction cycles
    // already use the extraction server for preCompactionFlush and index
    // generation. Running scheduled extraction concurrently wastes the
    // single-slot server and piles up memory.
    if (hasActiveChats()) {
      console.log("[scheduler] Skipping delayed extraction — active chat(s) in progress");
      return;
    }
    // Also skip if system synthesis is running
    if (isSynthesisActive()) {
      console.log("[scheduler] Skipping delayed extraction — system synthesis active");
      return;
    }

    const chatIds = await findChatsNeedingDelayedExtraction(thresholdMs);
    if (chatIds.length === 0) {
      return; // No chats need extraction
    }

    console.log(`[scheduler] Found ${chatIds.length} chat(s) needing delayed extraction`);

    // Process sequentially — the extraction server is --parallel 1, so
    // concurrent requests just queue in Node.js memory. Sequential processing
    // avoids holding multiple request bodies simultaneously.
    for (let i = 0; i < chatIds.length; i++) {
      const chatId = chatIds[i];
      if (delayedExtractionsInProgress.has(chatId)) {
        console.log(`[scheduler] Skipping chat ${chatId} — delayed extraction already in progress`);
        continue;
      }
      // Re-check: a chat may have become active since we started
      if (isChatActive(chatId)) {
        console.log(`[scheduler] Skipping chat ${chatId} — now active`);
        continue;
      }
      delayedExtractionsInProgress.add(chatId);
      try {
        console.log(`[scheduler] Running delayed extraction for chat ${chatId} (${i + 1}/${chatIds.length}) with model ${extractionModelId}...`);
        await extractDelayedMemories(chatId, extractionModelId);
        console.log(`[scheduler] Delayed extraction complete for chat ${chatId}`);
      } catch (e) {
        console.error(`[scheduler] Delayed extraction failed for chat ${chatId}:`, e);
      } finally {
        delayedExtractionsInProgress.delete(chatId);
      }
    }

    console.log(`[scheduler] Delayed extraction backlog complete (${chatIds.length} chats processed)`);
  } catch (e) {
    console.error("[scheduler] Delayed extraction check failed:", e);
  } finally {
    delayedExtractionCheckRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Llama.cpp PID Monitoring (detect server restarts)
// ---------------------------------------------------------------------------

/**
 * Periodically checks the PID of each configured llama.cpp server.
 * When a PID changes, the server has restarted and the KV cache is gone.
 * We clear all stale cache residency records so the UI stops showing
 * false "warm cache" indicators for dead entries.
 */
async function checkLlamaServerPids(): Promise<void> {
  try {
    const { getSettings } = await import("./chat-storage.js");
    const { getLlamaServerStatuses } = await import("./llama-supervisor.js");
    const settings = await getSettings();
    const statuses = await getLlamaServerStatuses(settings);

    for (const status of statuses) {
      if (status.systemd.mainPid != null && status.http.status === "ok") {
        // getLlamaServerStatuses already calls checkLlamaServerRestart
        // via the integration point in llama-supervisor.ts, but we also
        // check here as a belt-and-suspenders measure
        try {
          const { checkLlamaServerRestart } = await import("./llama-cache-residency.js");
          checkLlamaServerRestart(status.url, status.systemd.mainPid);
        } catch {
          // Non-fatal
        }
      }
    }
  } catch (e) {
    // Non-fatal — PID tracking is best-effort
  }
}

// ---------------------------------------------------------------------------
// Scheduler Startup
// ---------------------------------------------------------------------------

export function startScheduler(): void {
  // User-configurable automations own synthesis/wake scheduling.
  startAutomationScheduler();
  
  // Delayed extraction: wait 2 minutes on startup before processing backlog
  // This gives the server time to stabilize and avoids immediate resource spike
  setTimeout(() => {
    console.log("[scheduler] Running initial delayed extraction check (after 2min delay)...");
    checkAndRunDelayedExtractions();
  }, 2 * 60 * 1000);
  
  // Check every 5 minutes for delayed extractions
  setInterval(checkAndRunDelayedExtractions, DELAYED_EXTRACTION_CHECK_INTERVAL_MS);
  
  // Check llama.cpp server PIDs every 30 seconds to detect restarts and clear
  // stale cache residency records. The KV cache is process-local — when the
  // process dies and restarts, the old residency data is no longer valid.
  setInterval(checkLlamaServerPids, 30_000);

  // Reap stale turn-gate leases every minute: a hung turn holder (no
  // heartbeat) must not block queued turns indefinitely when no new turn
  // arrives to trigger the steal-on-acquire path.
  setInterval(reapStaleTurnLease, 60_000);

  // Sweep expired tool-output spill files (24 h TTL, newest-64 per chat) on
  // startup and hourly. The store is shared by bash capture and, later,
  // kernel cell output.
  const sweepToolOutput = () => {
    void sweepExpired().catch((error) => {
      console.warn("[scheduler] tool-output sweep failed:", error);
    });
  };
  sweepToolOutput();
  setInterval(sweepToolOutput, TOOL_OUTPUT_SWEEP_INTERVAL_MS);

  console.log("[scheduler] Started (automations every 5min, delayed extraction every 5min, llama PID check every 30s, turn-gate reap every 1min, tool-output sweep every 1h)");
}
