/**
 * Cache Warm Queue — serializes warm operations and defers them when
 * the LLM is actively generating or another warm is already in progress.
 *
 * Design:
 *  - Single mutex ensures only one prefill runs at a time per process
 *  - FIFO queue for pending requests; drained when mutex becomes free
 *  - Checks llm-activity.isActive() before acquiring; waits if busy
 *  - Each item has an AbortSignal for timeout control
 *  - Post-scheduler can enqueue bulk warm requests (system + recent chats)
 */

import { isActive, waitForIdle } from "./llm-activity.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CacheWarmJob {
  /** Chat ID to warm */
  chatId: string;
  /** Why this warm was enqueued */
  reason: "user-requested" | "sleep-prewarm" | "post-synthesis";
  /** Abort signal for timeout */
  signal?: AbortSignal;
  /** Resolve/reject the caller's promise when the job completes */
  resolve: (result: CacheWarmResult) => void;
  reject: (err: Error) => void;
}

export interface CacheWarmResult {
  warmed: boolean;
  chatId: string;
  modelId: string;
  reason: CacheWarmJob["reason"];
  promptMs?: number;
  tokensCached?: number;
  tokensEvaluated?: number;
  cacheHitRatio?: number;
  totalPromptTokens?: number;
  warmedAt: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const queue: CacheWarmJob[] = [];
let mutex: "idle" | CacheWarmJob = "idle";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enqueue a cache warm request. If the LLM is idle and no other warm is
 * in progress, the job runs immediately. Otherwise it queues behind any
 * active work and runs when the mutex is free.
 *
 * Returns a promise that resolves with the warm result.
 */
export function enqueueWarm(
  chatId: string,
  reason: CacheWarmJob["reason"],
  signal?: AbortSignal,
): Promise<CacheWarmResult> {
  return new Promise((resolve, reject) => {
    queue.push({ chatId, reason, signal, resolve, reject });
    drainQueue();
  });
}

/**
 * Get the current queue depth (excluding the item currently running).
 */
export function getQueueLength(): number {
  return queue.length;
}

/**
 * Get the queue position for a specific chat.
 * Returns 0 if actively warming, 1+ if queued, -1 if not in queue.
 */
export function getQueuePosition(chatId: string): number {
  if (mutex !== "idle" && mutex.chatId === chatId) return 0;
  const idx = queue.findIndex((job) => job.chatId === chatId);
  return idx >= 0 ? idx + 1 : -1;
}

/**
 * Check if a specific chat is currently being warmed or queued.
 */
export function isChatWarming(chatId: string): boolean {
  return getQueuePosition(chatId) >= 0;
}

/**
 * Remove all queued jobs for a specific chat (e.g. when user cancels or
 * a newer warm replaces an older one). The currently running job is not
 * affected.
 */
export function cancelQueuedWarms(chatId: string): void {
  const idx = queue.findIndex((job) => job.chatId === chatId);
  if (idx >= 0) {
    const [removed] = queue.splice(idx, 1);
    removed.reject(new Error("Cancelled (replaced by newer warm)"));
  }
}

// ---------------------------------------------------------------------------
// Internal — queue drain loop
// ---------------------------------------------------------------------------

async function drainQueue(): Promise<void> {
  // Already running — nothing to do
  if (mutex !== "idle") return;

  // Pick next job from queue
  const job = queue.shift();
  if (!job) return;

  // Acquire mutex
  mutex = job;

  try {
    // If LLM is actively generating, wait for it to finish
    if (isActive()) {
      console.log(`[cache-warm-queue] waiting for LLM idle before warming ${job.chatId}`);
      try {
        await waitForIdle(job.signal);
      } catch (err) {
        // Aborted while waiting — reject the job
        job.reject(err instanceof Error ? err : new Error("Aborted waiting for idle"));
        mutex = "idle";
        // Try next item in queue
        drainQueue();
        return;
      }
    }

    // Check if the job was aborted while we were waiting
    if (job.signal?.aborted) {
      job.reject(job.signal.reason instanceof Error ? job.signal.reason : new Error("Aborted"));
      mutex = "idle";
      drainQueue();
      return;
    }

    // Execute the warm — import lazily to avoid circular deps
    const { warmChatCache } = await import("./cache-warm.js");
    const result = await warmChatCache(job.chatId, {
      reason: job.reason,
      signal: job.signal,
    });

    // If the result was a queued warm but the actual warm function detected
    // that the chat doesn't need warming, we still count it as completed
    job.resolve({
      warmed: result.warmed,
      chatId: result.chatId,
      modelId: result.modelId,
      reason: job.reason,
      promptMs: result.promptMs,
      tokensCached: result.tokensCached,
      tokensEvaluated: result.tokensEvaluated,
      cacheHitRatio: result.cacheHitRatio,
      totalPromptTokens: result.totalPromptTokens,
      warmedAt: result.warmedAt,
      error: result.error,
    });
  } catch (err) {
    job.reject(err instanceof Error ? err : new Error(String(err)));
  } finally {
    // Release mutex and try next item
    mutex = "idle";
    drainQueue();
  }
}

// ---------------------------------------------------------------------------
// Post-synthesis scheduler
// ---------------------------------------------------------------------------

/**
 * After synthesis completes, the memory context for all chats has likely
 * changed (new memories, updated blocks). This function enqueues warm
 * operations for the system chat (so it can resume scheduled tasks quickly)
 * and the N most recent agent chats.
 */
export async function schedulePostSynthesisWarms(
  systemChatId: string | undefined,
  recentChatIds: string[],
  signal?: AbortSignal,
): Promise<CacheWarmResult[]> {
  const results: CacheWarmResult[] = [];

  // Warm system chat first
  if (systemChatId) {
    try {
      const result = await enqueueWarm(systemChatId, "post-synthesis", signal);
      results.push(result);
    } catch (err) {
      results.push({
        warmed: false,
        chatId: systemChatId,
        modelId: "",
        reason: "post-synthesis",
        warmedAt: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Warm recent agent chats (limit to avoid overwhelming the queue)
  const limit = Math.min(recentChatIds.length, 5);
  for (let i = 0; i < limit; i++) {
    const chatId = recentChatIds[i];
    try {
      const result = await enqueueWarm(chatId, "post-synthesis", signal);
      results.push(result);
    } catch (err) {
      results.push({
        warmed: false,
        chatId,
        modelId: "",
        reason: "post-synthesis",
        warmedAt: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
