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
      isManualSleepReleaseActive: vi.fn(() => false),
      isWithinAbsentWindow: vi.fn(() => true),
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

async function installAbsentGateHarness(opts: {
  sleepCycleActive: boolean;
  manualSleepReleaseActive: boolean;
  withinAbsentWindow: boolean;
}) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-18T10:01:00.000Z"));

  const task = {
    id: "auto-nightly",
    kind: "custom",
    title: "Nightly review",
    enabled: true,
    activationPolicy: "absent",
    absentWindow: { start: "22:00", end: "07:00" },
    nextRunAt: "2026-06-18T09:00:00.000Z",
  };
  const listEnabledAutomationTasks = vi.fn(() => [task]);
  const runAutomationTask = vi.fn(async () => ({ success: true, summary: "", toolCalls: [] }));
  const isSleepCycleActive = vi.fn(() => opts.sleepCycleActive);
  const isManualSleepReleaseActive = vi.fn(() => opts.manualSleepReleaseActive);
  const isWithinAbsentWindow = vi.fn(() => opts.withinAbsentWindow);

  vi.doMock("./memory-extraction.js", () => ({ hasActiveChats: vi.fn(() => false) }));
  vi.doMock("./cache-warm-queue.js", () => ({
    isCacheWarmOrLlamaRuntimeBusy: vi.fn(async () => false),
  }));
  vi.doMock("./sleep-cycle.js", () => ({
    isSleepCycleActive,
    isManualSleepReleaseActive,
    isWithinAbsentWindow,
    parseTimestamp: (value: string | undefined | null) => {
      if (!value) return null;
      const ms = new Date(value).getTime();
      return Number.isFinite(ms) ? ms : null;
    },
  }));
  vi.doMock("./chat-storage.js", () => ({
    getSettings: vi.fn(async () => ({
      defaultModelId: "demo-model",
      lastUserActivityAt: "2026-06-18T06:00:00.000Z",
      lastAgentCompletedAt: "2026-06-18T06:00:00.000Z",
    })),
  }));
  vi.doMock("./memory-storage.js", () => ({
    getMemoryCount: vi.fn(async () => 1),
  }));
  vi.doMock("./automation-storage.js", () => ({
    listEnabledAutomationTasks,
    SYNTHESIS_AUTOMATION_ID: "builtin:synthesis",
  }));
  vi.doMock("./automation-lock.js", () => ({
    getActiveAutomationTaskId: vi.fn(() => null),
    isAutomationActive: vi.fn(() => false),
  }));
  vi.doMock("./automation-runner.js", () => ({ runAutomationTask }));
  vi.doMock("./system-chat.js", () => ({
    isSynthesisActive: vi.fn(() => false),
    isWakeCycleActive: vi.fn(() => false),
  }));

  const { checkAndRunDueAutomations } = await import("./automation-scheduler.js");
  await checkAndRunDueAutomations();
  return { task, runAutomationTask, isWithinAbsentWindow };
}

describe("automation scheduler absent window gate", () => {
  it("skips an absent task outside its window even when inactivity threshold is met", async () => {
    const { runAutomationTask, isWithinAbsentWindow } = await installAbsentGateHarness({
      sleepCycleActive: true,
      manualSleepReleaseActive: false,
      withinAbsentWindow: false,
    });
    expect(isWithinAbsentWindow).toHaveBeenCalledWith({ start: "22:00", end: "07:00" }, expect.any(Number));
    expect(runAutomationTask).not.toHaveBeenCalled();
  });

  it("runs an absent task inside its window when the inactivity threshold is met", async () => {
    const { task, runAutomationTask, isWithinAbsentWindow } = await installAbsentGateHarness({
      sleepCycleActive: true,
      manualSleepReleaseActive: false,
      withinAbsentWindow: true,
    });
    expect(isWithinAbsentWindow).toHaveBeenCalled();
    expect(runAutomationTask).toHaveBeenCalledWith(task, "scheduler");
  });

  it("lets a manual sleep release bypass the window", async () => {
    const { task, runAutomationTask, isWithinAbsentWindow } = await installAbsentGateHarness({
      sleepCycleActive: true,
      manualSleepReleaseActive: true,
      withinAbsentWindow: false,
    });
    expect(isWithinAbsentWindow).not.toHaveBeenCalled();
    expect(runAutomationTask).toHaveBeenCalledWith(task, "scheduler");
  });
});
