import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const SCHEDULER_MOCKS = [
  "../services/memory-extraction.js",
  "../services/cache-warm-queue.js",
  "../services/sleep-cycle.js",
  "../services/memory-storage.js",
  "../services/automation-lock.js",
  "../services/automation-runner.js",
  "../services/system-chat.js",
];

async function loadWithHome(homeDir: string) {
  vi.resetModules();
  vi.doMock("os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("os")>();
    return { ...actual, homedir: () => homeDir };
  });
  mkdirSync(join(homeDir, ".porrima"), { recursive: true });
  return {
    storage: await import("../services/automation-storage.js"),
    chatStorage: await import("../services/chat-storage.js"),
  };
}

async function closeChatStorage() {
  const chatStorage = await import("../services/chat-storage.js").catch(() => null);
  chatStorage?.closeChatDb?.();
}

function installSchedulerMocks() {
  const runAutomationTask = vi.fn(async () => ({ success: true, summary: "", toolCalls: [] }));
  vi.doMock("../services/memory-extraction.js", () => ({ hasActiveChats: vi.fn(() => false) }));
  vi.doMock("../services/cache-warm-queue.js", () => ({
    isCacheWarmOrLlamaRuntimeBusy: vi.fn(async () => false),
  }));
  vi.doMock("../services/sleep-cycle.js", () => ({
    isSleepCycleActive: vi.fn(() => false),
    isManualSleepReleaseActive: vi.fn(() => false),
    isWithinAbsentWindow: vi.fn(() => true),
    parseTimestamp: (value: string | undefined | null) => {
      if (!value) return null;
      const ms = new Date(value).getTime();
      return Number.isFinite(ms) ? ms : null;
    },
  }));
  vi.doMock("../services/memory-storage.js", () => ({ getMemoryCount: vi.fn(async () => 1) }));
  vi.doMock("../services/automation-lock.js", () => ({
    getActiveAutomationTaskId: vi.fn(() => null),
    isAutomationActive: vi.fn(() => false),
  }));
  vi.doMock("../services/automation-runner.js", () => ({ runAutomationTask }));
  vi.doMock("../services/system-chat.js", () => ({
    isSynthesisActive: vi.fn(() => false),
    isWakeCycleActive: vi.fn(() => false),
    getDefaultSynthesisPromptSteps: vi.fn(() => []),
    getDefaultWakePromptSteps: vi.fn(() => []),
  }));
  return runAutomationTask;
}

afterEach(async () => {
  await closeChatStorage().catch(() => {});
  for (const path of SCHEDULER_MOCKS) vi.doUnmock(path);
  vi.doUnmock("os");
  vi.resetModules();
  vi.clearAllMocks();
});

describe("automation orphan sweep gates the scheduler", () => {
  it("does not start a once-task that the sweep archived", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-orphan-sweep-"));
    try {
      const { storage, chatStorage } = await loadWithHome(homeDir);
      const task = storage.createCustomAutomationTask({
        schedule: { type: "once", runAt: new Date(Date.now() - 60_000).toISOString() },
        promptSteps: [{ id: "step-1", title: "Prompt", prompt: "Do it." }],
      });
      chatStorage.getDb().prepare(
        `INSERT INTO automation_runs (id, taskId, status, origin, startedAt)
         VALUES (?, ?, 'running', 'scheduler', ?)`,
      ).run("orphan-run", task.id, new Date().toISOString());

      expect(storage.sweepOrphanedAutomationRuns()).toBe(1);
      expect(storage.getAutomationTask(task.id)?.enabled).toBe(false);

      const runAutomationTask = installSchedulerMocks();
      const { checkAndRunDueAutomations } = await import("../services/automation-scheduler.js");
      await checkAndRunDueAutomations();

      expect(runAutomationTask).not.toHaveBeenCalled();
    } finally {
      await closeChatStorage().catch(() => {});
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("still starts a once-task left armed by a crash before start", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-orphan-sweep-"));
    try {
      const { storage } = await loadWithHome(homeDir);
      const task = storage.createCustomAutomationTask({
        schedule: { type: "once", runAt: new Date(Date.now() - 60_000).toISOString() },
        promptSteps: [{ id: "step-1", title: "Prompt", prompt: "Do it." }],
      });
      expect(storage.sweepOrphanedAutomationRuns()).toBe(0);
      expect(storage.getAutomationTask(task.id)?.enabled).toBe(true);

      const runAutomationTask = installSchedulerMocks();
      const { checkAndRunDueAutomations } = await import("../services/automation-scheduler.js");
      await checkAndRunDueAutomations();

      expect(runAutomationTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: task.id }),
        "scheduler",
      );
    } finally {
      await closeChatStorage().catch(() => {});
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
