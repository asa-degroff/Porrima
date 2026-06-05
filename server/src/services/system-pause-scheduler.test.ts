import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../types.js";

function pausedSettings(): Settings {
  return {
    systemPauseStartedAt: "2026-06-05T11:00:00.000Z",
    systemPauseUntil: "2099-06-05T12:00:00.000Z",
    systemPauseIndefinite: false,
  } as Settings;
}

const MOCKED_MODULES = [
  "./memory-extraction.js",
  "./cache-warm-queue.js",
  "./sleep-cycle.js",
  "./chat-storage.js",
  "./memory-storage.js",
  "./automation-storage.js",
  "./automation-lock.js",
  "./automation-runner.js",
  "./system-chat.js",
  "./image-corpus.js",
  "./llama-router-client.js",
  "./automation-scheduler.js",
];

afterEach(() => {
  for (const path of MOCKED_MODULES) {
    vi.doUnmock(path);
  }
  vi.resetModules();
  vi.clearAllMocks();
});

describe("system pause scheduler gates", () => {
  it("skips due automation checks before selecting or running a task", async () => {
    const listEnabledAutomationTasks = vi.fn(() => []);
    const runAutomationTask = vi.fn();

    vi.doMock("./memory-extraction.js", () => ({
      hasActiveChats: vi.fn(() => false),
    }));
    vi.doMock("./cache-warm-queue.js", () => ({
      getQueueLength: vi.fn(() => 0),
    }));
    vi.doMock("./sleep-cycle.js", () => ({
      isSleepCycleActive: vi.fn(() => false),
      parseTimestamp: vi.fn(() => null),
    }));
    vi.doMock("./chat-storage.js", () => ({
      getSettings: vi.fn(async () => pausedSettings()),
    }));
    vi.doMock("./memory-storage.js", () => ({
      getMemoryCount: vi.fn(async () => 1),
    }));
    vi.doMock("./automation-storage.js", () => ({
      listEnabledAutomationTasks,
      SYNTHESIS_AUTOMATION_ID: "synthesis",
    }));
    vi.doMock("./automation-lock.js", () => ({
      getActiveAutomationTaskId: vi.fn(() => null),
      isAutomationActive: vi.fn(() => false),
    }));
    vi.doMock("./automation-runner.js", () => ({
      runAutomationTask,
    }));
    vi.doMock("./system-chat.js", () => ({
      isSynthesisActive: vi.fn(() => false),
      isWakeCycleActive: vi.fn(() => false),
    }));

    const { checkAndRunDueAutomations } = await import("./automation-scheduler.js");
    await checkAndRunDueAutomations();

    expect(listEnabledAutomationTasks).not.toHaveBeenCalled();
    expect(runAutomationTask).not.toHaveBeenCalled();
  });

  it("skips delayed extraction before backlog or model discovery work", async () => {
    const getDb = vi.fn();
    const extractDelayedMemories = vi.fn();

    vi.doMock("./system-chat.js", () => ({
      shouldRunSystemSynthesis: vi.fn(),
      runSystemSynthesis: vi.fn(),
      isSynthesisActive: vi.fn(() => false),
      runWakeCycle: vi.fn(),
      isWakeCycleActive: vi.fn(() => false),
    }));
    vi.doMock("./chat-storage.js", () => ({
      getDb,
      getSettings: vi.fn(async () => pausedSettings()),
      saveSettings: vi.fn(),
    }));
    vi.doMock("./memory-storage.js", () => ({
      getLastWakeCycleAt: vi.fn(),
    }));
    vi.doMock("./memory-extraction.js", () => ({
      extractDelayedMemories,
      hasActiveChats: vi.fn(() => false),
      isChatActive: vi.fn(() => false),
    }));
    vi.doMock("./cache-warm-queue.js", () => ({
      getQueueLength: vi.fn(() => 0),
    }));
    vi.doMock("./image-corpus.js", () => ({
      enrichCorpusBatch: vi.fn(),
    }));
    vi.doMock("./llama-router-client.js", () => ({
      normalizeRouterModelId: vi.fn((id: string) => id),
    }));
    vi.doMock("./sleep-cycle.js", () => ({
      isSleepCycleActive: vi.fn(() => false),
    }));
    vi.doMock("./automation-scheduler.js", () => ({
      startAutomationScheduler: vi.fn(),
    }));

    const { checkAndRunDelayedExtractions } = await import("./scheduler.js");
    await checkAndRunDelayedExtractions();

    expect(getDb).not.toHaveBeenCalled();
    expect(extractDelayedMemories).not.toHaveBeenCalled();
  });
});
