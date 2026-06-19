import { afterEach, describe, expect, it, vi } from "vitest";

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
  "./automation-scheduler.js",
];

afterEach(() => {
  for (const path of MOCKED_MODULES) vi.doUnmock(path);
  vi.resetModules();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("automation scheduler idle gate", () => {
  it("treats recent non-chat user interactions as activity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-18T10:01:00.000Z"));

    const listEnabledAutomationTasks = vi.fn(() => [{
      id: "synthesis",
      kind: "synthesis",
      title: "Daily Synthesis",
      enabled: true,
      activationPolicy: "idle",
      nextRunAt: "2026-06-18T09:00:00.000Z",
    }]);
    const isCacheWarmOrLlamaRuntimeBusy = vi.fn(async () => false);
    const runAutomationTask = vi.fn();

    vi.doMock("./memory-extraction.js", () => ({
      hasActiveChats: vi.fn(() => false),
    }));
    vi.doMock("./cache-warm-queue.js", () => ({
      isCacheWarmOrLlamaRuntimeBusy,
    }));
    vi.doMock("./sleep-cycle.js", () => ({
      isSleepCycleActive: vi.fn(() => false),
      parseTimestamp: (value: string | undefined | null) => {
        if (!value) return null;
        const ms = new Date(value).getTime();
        return Number.isFinite(ms) ? ms : null;
      },
    }));
    vi.doMock("./chat-storage.js", () => ({
      getSettings: vi.fn(async () => ({
        defaultModelId: "demo-model",
        lastAgentCompletedAt: "2026-06-18T08:00:00.000Z",
        lastUserActivityAt: "2026-06-18T08:00:00.000Z",
        lastUserInteractionAt: "2026-06-18T10:00:00.000Z",
      })),
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
    expect(isCacheWarmOrLlamaRuntimeBusy).not.toHaveBeenCalled();
    expect(runAutomationTask).not.toHaveBeenCalled();
  });
});
