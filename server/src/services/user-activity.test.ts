import { afterEach, describe, expect, it, vi } from "vitest";

const MOCKED_MODULES = ["./chat-storage.js", "./user-activity.js"];

afterEach(() => {
  for (const path of MOCKED_MODULES) vi.doUnmock(path);
  vi.resetModules();
  vi.clearAllMocks();
});

describe("user activity stamps", () => {
  it("stamps chat turns as both chat activity and foreground interaction", async () => {
    const saveSettings = vi.fn(async (settings) => settings);
    vi.doMock("./chat-storage.js", () => ({
      getSettings: vi.fn(async () => ({
        sleepModeTriggeredAt: "2026-06-18T09:00:00.000Z",
      })),
      saveSettings,
    }));

    const { stampUserTurnActivity } = await import("./user-activity.js");
    await stampUserTurnActivity({ now: new Date("2026-06-18T10:00:00.000Z") });

    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      lastUserActivityAt: "2026-06-18T10:00:00.000Z",
      lastUserInteractionAt: "2026-06-18T10:00:00.000Z",
      sleepModeTriggeredAt: undefined,
    }));
  });

  it("stamps non-chat foreground interactions without creating a pending chat turn", async () => {
    const saveSettings = vi.fn(async (settings) => settings);
    vi.doMock("./chat-storage.js", () => ({
      getSettings: vi.fn(async () => ({
        sleepModeTriggeredAt: "2026-06-18T09:00:00.000Z",
        lastUserActivityAt: "2026-06-18T08:00:00.000Z",
        lastAgentCompletedAt: "2026-06-18T08:01:00.000Z",
      })),
      saveSettings,
    }));

    const { stampUserInteractionActivity } = await import("./user-activity.js");
    await stampUserInteractionActivity({ now: new Date("2026-06-18T10:00:00.000Z") });

    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      lastUserActivityAt: "2026-06-18T08:00:00.000Z",
      lastUserInteractionAt: "2026-06-18T10:00:00.000Z",
      lastAgentCompletedAt: "2026-06-18T08:01:00.000Z",
      sleepModeTriggeredAt: undefined,
    }));
  });
});
