import type { AutomationTask, Settings } from "../types.js";
import { hasActiveChats } from "./memory-extraction.js";
import { isCacheWarmOrLlamaRuntimeBusy } from "./cache-warm-queue.js";
import { isSleepCycleActive as computeSleepCycleActive, parseTimestamp } from "./sleep-cycle.js";
import { getSettings } from "./chat-storage.js";
import { getMemoryCount } from "./memory-storage.js";
import {
  listEnabledAutomationTasks,
  SYNTHESIS_AUTOMATION_ID,
} from "./automation-storage.js";
import { getActiveAutomationTaskId, isAutomationActive } from "./automation-lock.js";
import { runAutomationTask } from "./automation-runner.js";
import { isSynthesisActive, isWakeCycleActive } from "./system-chat.js";
import { isSystemPauseActive } from "./system-pause.js";

const AUTOMATION_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_SLEEP_CYCLE_THRESHOLD_MINUTES = 60;

// Minimum idle time after last user/agent activity before any automation can
// start, regardless of activation policy. Prevents synthesis from launching
// immediately after a chat error-terminates (which marks the chat inactive)
// or right after the user sends a message and the assistant finishes.
const AUTOMATION_MIN_IDLE_MS = 2 * 60 * 1000; // 2 minutes

let automationCheckRunning = false;

function taskIsDue(task: AutomationTask, nowMs: number): boolean {
  if (!task.nextRunAt) return true;
  const dueMs = new Date(task.nextRunAt).getTime();
  return Number.isFinite(dueMs) && dueMs <= nowMs;
}

function sleepCycleActive(settings: Settings): boolean {
  return computeSleepCycleActive(settings, {
    hasActiveChats: hasActiveChats(),
    defaultThresholdMinutes: DEFAULT_SLEEP_CYCLE_THRESHOLD_MINUTES,
  });
}

async function shouldRunTask(task: AutomationTask, settings: Settings, nowMs: number): Promise<boolean> {
  if (!task.enabled) return false;
  if (task.activationPolicy === "manual_only") return false;
  if (!taskIsDue(task, nowMs)) return false;

  if (task.activationPolicy === "sleep_only" && !sleepCycleActive(settings)) {
    return false;
  }

  if (task.id === SYNTHESIS_AUTOMATION_ID || task.kind === "synthesis") {
    const memoryCount = await getMemoryCount();
    if (memoryCount === 0) return false;
    if (settings.sleepModeTriggeredAt) {
      const elapsedMs = Date.now() - new Date(settings.sleepModeTriggeredAt).getTime();
      if (elapsedMs < 2 * 60 * 60 * 1000) {
        console.log("[automation] Skipping synthesis — sleep mode cooldown active");
        return false;
      }
    }
  }

  return true;
}

export async function checkAndRunDueAutomations(): Promise<void> {
  if (automationCheckRunning) {
    console.log("[automation] Skipping check — previous automation check still running");
    return;
  }

  automationCheckRunning = true;
  try {
    if (isAutomationActive()) {
      console.log(`[automation] Skipping check — automation active (${getActiveAutomationTaskId()})`);
      return;
    }
    if (isSynthesisActive()) {
      console.log("[automation] Skipping check — legacy synthesis active");
      return;
    }
    if (isWakeCycleActive()) {
      console.log("[automation] Skipping check — legacy wake cycle active");
      return;
    }
    if (hasActiveChats()) {
      console.log("[automation] Skipping check — active chat(s) in progress");
      return;
    }

    // Grace period: don't start any automation if the user was recently active,
    // even if no chat is currently in progress. This catches the case where a
    // chat just error-terminated (marking it inactive) but the user hasn't had
    // time to retry — without this, synthesis can start within seconds of an
    // error-terminated chat.
    const settings = await getSettings();
    if (isSystemPauseActive(settings)) {
      console.log("[automation] Skipping check — system pause active");
      return;
    }

    const lastUserMs = parseTimestamp(settings.lastUserActivityAt);
    const lastInteractionMs = parseTimestamp(settings.lastUserInteractionAt);
    const lastAgentMs = parseTimestamp(settings.lastAgentCompletedAt);
    const recentActivityMs = Math.max(lastUserMs ?? 0, lastInteractionMs ?? 0, lastAgentMs ?? 0);
    if (recentActivityMs > 0) {
      const elapsedMs = Date.now() - recentActivityMs;
      if (elapsedMs < AUTOMATION_MIN_IDLE_MS) {
        const elapsedSec = (elapsedMs / 1000).toFixed(0);
        const minSec = (AUTOMATION_MIN_IDLE_MS / 1000).toFixed(0);
        console.log(`[automation] Skipping — recently active (${elapsedSec}s ago, need ${minSec}s idle)`);
        return;
      }
    }

    // Don't dispatch new automations while a cache-warm or llama.cpp prefill
    // is in progress. The runtime probe catches the case where an HTTP warm
    // request timed out but llama.cpp is still processing the slot.
    if (await isCacheWarmOrLlamaRuntimeBusy(settings.defaultModelId)) {
      console.log("[automation] Skipping check — cache-warm/llama runtime busy");
      return;
    }

    const nowMs = Date.now();
    const tasks = listEnabledAutomationTasks();
    for (const task of tasks) {
      if (!(await shouldRunTask(task, settings, nowMs))) continue;
      console.log(`[automation] ${task.title} due, starting task ${task.id}`);
      const result = await runAutomationTask(task, "scheduler");
      if (result.success) {
        console.log(
          `[automation] ${task.id} complete: ${result.summary.length} chars, ${result.toolCalls.length} tools`,
        );
      } else {
        console.error(`[automation] ${task.id} failed: ${result.error}`);
      }
      break;
    }
  } catch (e) {
    console.error("[automation] Check failed:", e);
  } finally {
    automationCheckRunning = false;
  }
}

export function startAutomationScheduler(): void {
  setTimeout(() => {
    console.log("[automation] Running initial automation check...");
    checkAndRunDueAutomations();
  }, 30 * 1000);

  setInterval(checkAndRunDueAutomations, AUTOMATION_CHECK_INTERVAL_MS);
  console.log("[automation] Scheduler started (checks every 5min)");
}
