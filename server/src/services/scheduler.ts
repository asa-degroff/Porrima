import crypto from "crypto";
import { shouldRunSynthesis, runDailySynthesis } from "./synthesis.js";
import { getDb, getSettings, saveSettings, createChat, findBlueskyChatId } from "./chat-storage.js";
import { v4 as uuidv4 } from "uuid";
import { extractDelayedMemories } from "./memory-extraction.js";
import { getBlueskyPoller } from "./bluesky-poller.js";
import { BLUESKY_SYSTEM_PROMPT } from "../routes/bluesky.js";
import { buildClusters } from "./cluster-engine.js";
import { getClusters } from "./cluster-storage.js";
import { getAllCorpusEntries, enrichCorpusBatch } from "./image-corpus.js";
import { proposeDirections } from "./creative-engine.js";
import { createDirectionJob, processPendingJobs } from "./job-queue.js";
import { clearCache } from "./direction-cache.js";

const SYNTHESIS_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const DELAYED_EXTRACTION_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const ENRICHMENT_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_ENRICHMENT_BATCH_SIZE = 5;

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
 * Unload the Ollama model to free VRAM for ComfyUI or the larger chat model.
 * Uses keep_alive: "0s" to immediately release GPU memory.
 */
async function unloadOllamaModel(modelId: string): Promise<void> {
  try {
    await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId, prompt: "", keep_alive: "0s" }),
    });
    console.log(`[scheduler] Unloaded Ollama model ${modelId} to free VRAM`);
  } catch {
    // Non-critical — model may already be unloaded
  }
}

/**
 * Unload llama.cpp model slots AND the loaded model to free VRAM on both GPUs.
 * The 27B chat model needs both GPUs, so we must fully release it before
 * ComfyUI can claim GPU 1, and before the 27B can reload after the cycle.
 */
async function unloadLlamaCppSlots(): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.llamacppEnabled) return;
    const baseUrl = settings.llamacppUrl || "http://localhost:8080";

    // Erase context from slots to free KV cache memory
    await fetch(`${baseUrl}/slots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "erase" }),
      signal: AbortSignal.timeout(30_000),
    });

    // Unload any loaded model so VRAM is fully released on both GPUs
    const modelsRes = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(3000) });
    if (modelsRes.ok) {
      const modelsData = await modelsRes.json();
      for (const m of modelsData.data || []) {
        if (m.status?.value === "loaded") {
          console.log(`[scheduler] Unloading llama.cpp model: ${m.id}`);
          await fetch(`${baseUrl}/models/unload`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: m.id }),
            signal: AbortSignal.timeout(30_000),
          });
        }
      }
    }

    // Invalidate cached model state
    const { invalidateLoadedModel } = await import("./openai-compat-provider.js");
    invalidateLoadedModel();
    console.log("[scheduler] Unloaded llama.cpp model and erased slots to free VRAM on both GPUs");
  } catch (err) {
    console.warn("[scheduler] Failed to unload llama.cpp:", err);
  }
}

/**
 * Run the corpus creative cycle: rebuild clusters, generate directions, save as memories.
 * Called during daily synthesis to keep the creative engine fresh.
 *
 * GPU coordination: with dual RX 7700 GPUs, ComfyUI runs on GPU 1 (via
 * --cuda-device 1) and the review LLM runs on GPU 0 (via Ollama with
 * HIP_VISIBLE_DEVICES=0). They can operate concurrently during the review
 * loop. However, the larger chat model (27B) needs BOTH GPUs via
 * llama-server (ROCR_VISIBLE_DEVICES=0,1). Before starting the creative
 * cycle, we must ensure the 27B model is unloaded from both GPUs so that
 * ComfyUI can claim GPU 1. After all directions complete, we unload the
 * review model and free ComfyUI's GPU memory so the 27B model can reclaim
 * both GPUs.
 */
async function runCorpusCreativeCycle() {
  try {
    const settings = await getSettings();
    const cdSettings = settings.creativeDirections ?? {};

    // Check if creative directions are disabled
    if (cdSettings.enabled === false) {
      console.log("[scheduler] Creative directions disabled in settings, skipping cycle");
      return;
    }

    console.log("[scheduler] Running corpus creative cycle...");

    // 1. Rebuild clusters with current corpus
    const corpus = await getAllCorpusEntries();
    const clusterMap = await buildClusters(corpus);
    console.log(`[scheduler] Rebuilt ${clusterMap.clusters.length} clusters from ${corpus.length} images`);

    // 2. Generate creative directions (LLM phase — uses Ollama GPU)
    const modelId = cdSettings.modelId || settings.defaultVisionModelId || "qwen3.5:9b";
    const limit = cdSettings.limit ?? 5;
    const minNovelty = cdSettings.minNovelty ?? 0.15;
    const directions = await proposeDirections(clusterMap.clusters, corpus, {
      limit,
      minNovelty,
      useCache: false,
      modelId,
    });
    console.log(`[scheduler] Generated ${directions.length} creative directions`);

    // 3. Save directions to a project-scoped memory block
    const { ensureDirectionsProject } = await import("./project-storage.js");
    const { createMemoryBlock } = await import("./memory-storage.js");

    const projectId = await ensureDirectionsProject();
    const cycleDate = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const blockName = `Creative Directions — ${cycleDate}`;

    // Format all directions into structured block content
    const blockContent = directions.map((dir, idx) => `
## Direction ${idx + 1}: ${dir.type}

**Description:** ${dir.description}

**Source Clusters:** ${dir.sourceClusters.join(", ") || "none (gap-fill)"}

**Novelty Score:** ${dir.noveltyScore.toFixed(3)}

**Element Combination:**
${dir.elementCombination.takeThemesFrom ? `- Themes from: ${dir.elementCombination.takeThemesFrom}` : ""}
${dir.elementCombination.takeSettingsFrom ? `- Settings from: ${dir.elementCombination.takeSettingsFrom}` : ""}
${dir.elementCombination.takeCharactersFrom ? `- Characters from: ${dir.elementCombination.takeCharactersFrom}` : ""}
${dir.elementCombination.takeStylesFrom ? `- Styles from: ${dir.elementCombination.takeStylesFrom}` : ""}
${dir.elementCombination.injectNovelty ? `- Inject novelty: ${dir.elementCombination.injectNovelty}` : ""}

**Proposed Prompt:**

${dir.proposedPrompt}

---
`).join("\n");

    const blockDescription = `${directions.length} creative directions generated during daily synthesis cycle`;
    const now = new Date().toISOString();

    await createMemoryBlock({
      id: uuidv4(),
      name: blockName,
      description: blockDescription,
      content: blockContent,
      scope: "project",
      projectId: projectId,
      createdAt: now,
      updatedAt: now,
      updatedBy: "agent" as const,
    });

    console.log(`[scheduler] Saved ${directions.length} directions to memory block "${blockName}"`);

    // 4. Execute top directions autonomously with agent loop review
    // The agent loop alternates between Ollama (LLM evaluation) and ComfyUI
    // (image generation), so Ollama must remain available throughout.
    const { executeDirectionWithReview, DEFAULT_AUTONOMOUS_CONFIG } = await import("./autonomous-generation.js");
    const { getClusterMembers } = await import("./creative-engine.js");
    const systemChatId = "autonomous-system";
    const maxExecutions = cdSettings.maxExecutions ?? 4;
    const maxReviewIterations = cdSettings.maxReviewIterations ?? 3;

    // Build config overrides from settings
    const genConfig = {
      ...DEFAULT_AUTONOMOUS_CONFIG,
      ...(cdSettings.imageModelId ? { modelId: cdSettings.imageModelId } : {}),
      ...(cdSettings.cfgScale != null ? { cfgScale: cdSettings.cfgScale } : {}),
      ...(cdSettings.steps != null ? { steps: cdSettings.steps } : {}),
    };

    for (const dir of directions.slice(0, maxExecutions)) {
      console.log(`[scheduler] Executing direction with review: ${dir.type} - ${dir.description}`);

      // Gather corpus members for vision context.
      // For directions with source clusters, pick representative members.
      // For gap-fill directions (empty sourceClusters), find corpus entries
      // matching the gap theme so the agent can judge novelty against them.
      let corpusMembers: import("./image-corpus.js").ImageCorpusEntry[] = [];
      if (dir.sourceClusters.length > 0) {
        for (const clusterId of dir.sourceClusters) {
          const cluster = clusterMap.clusters.find(c => c.id === clusterId);
          if (cluster) {
            const members = await getClusterMembers(cluster, corpus, 2);
            corpusMembers.push(...members);
          }
        }
      } else if (dir.elementCombination.injectNovelty) {
        // Gap-fill: find existing entries with the underrepresented theme
        const theme = dir.elementCombination.injectNovelty.toLowerCase();
        corpusMembers = corpus.filter(
          e => e.elements?.themes?.some(t => t.toLowerCase().includes(theme))
        ).slice(0, 3);
      }
      // Deduplicate and limit
      const seen = new Set<string>();
      corpusMembers = corpusMembers.filter(m => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      }).slice(0, 3);

      const result = await executeDirectionWithReview(dir, systemChatId, genConfig, {
        maxIterations: maxReviewIterations,
        modelId: modelId,
        corpusMembers,
      });
      if (result.success) {
        console.log(`[scheduler] Generated: ${result.imageId} (accepted at iteration ${result.acceptedAtIteration}/${maxReviewIterations})`);
      } else {
        console.log(`[scheduler] Failed: ${result.error}`);
      }
    }

    // Unload models after all directions are processed to free VRAM for
    // the chat model to reload. Also free ComfyUI's cached models.
    await unloadOllamaModel(modelId);
    await unloadLlamaCppSlots();

    // Ask ComfyUI to free its models — the idle-unload-timeout will handle
    // this eventually, but we explicitly request it so the chat model can
    // reclaim GPU 1's VRAM sooner if it needs both GPUs.
    try {
      const { getSettings } = await import("./chat-storage.js");
      const settings = await getSettings();
      const comfyuiUrl = settings.comfyuiUrl || "http://127.0.0.1:8188";
      await fetch(`${comfyuiUrl}/free`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unload_models: true, free_memory: true }),
        signal: AbortSignal.timeout(10_000),
      });
      console.log("[scheduler] Freed ComfyUI models after creative cycle");
    } catch {
      // Non-critical — ComfyUI may not be running
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
 * Check and run corpus enrichment for entries missing embeddings or elements.
 * Called every 30 minutes to process backlog from failed fire-and-forget enrichments.
 * Uses small batch size to avoid overwhelming the LLM API.
 */
async function checkAndRunEnrichment() {
  try {
    const settings = await getSettings();
    const batchSize = settings.enrichmentBatchSize ?? DEFAULT_ENRICHMENT_BATCH_SIZE;
    
    console.log(`[scheduler] Running enrichment batch (size: ${batchSize})...`);
    const enrichedCount = await enrichCorpusBatch(batchSize);
    
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

  // Then check hourly for synthesis
  setInterval(checkAndRunSynthesis, SYNTHESIS_CHECK_INTERVAL_MS);
  
  // Check every 5 minutes for delayed extractions
  setInterval(checkAndRunDelayedExtractions, DELAYED_EXTRACTION_CHECK_INTERVAL_MS);
  
  // Check every 30 minutes for corpus enrichment
  setInterval(checkAndRunEnrichment, ENRICHMENT_CHECK_INTERVAL_MS);
  
  console.log("[scheduler] Started (synthesis every 15min, delayed extraction every 5min, enrichment every 30min)");

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
