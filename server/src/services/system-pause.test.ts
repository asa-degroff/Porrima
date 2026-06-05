import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../types.js";

function makeSettings(settings: Partial<Settings>): Settings {
  return settings as Settings;
}

async function loadSystemPause(initial: Partial<Settings> = {}) {
  vi.resetModules();

  let stored: Partial<Settings> = { ...initial };
  const getSettings = vi.fn(async () => ({ ...stored }) as Settings);
  const saveSettings = vi.fn(async (settings: Settings) => {
    const next: Partial<Settings> = { ...stored, ...settings };
    const record = next as unknown as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (record[key] === undefined) {
        delete record[key];
      }
    }
    stored = next;
    return { ...stored } as Settings;
  });

  vi.doMock("./chat-storage.js", () => ({
    getSettings,
    saveSettings,
  }));

  const module = await import("./system-pause.js");
  return {
    module,
    getSettings,
    saveSettings,
    getStored: () => ({ ...stored }),
  };
}

afterEach(() => {
  vi.doUnmock("./chat-storage.js");
  vi.resetModules();
});

describe("system pause state", () => {
  const nowMs = new Date("2026-06-05T12:00:00.000Z").getTime();

  it("treats a future pause-until timestamp as active", async () => {
    const { module } = await loadSystemPause();

    const state = module.getSystemPauseState(
      makeSettings({
        systemPauseStartedAt: "2026-06-05T11:00:00.000Z",
        systemPauseUntil: "2026-06-05T13:00:00.000Z",
      }),
      { nowMs, pending: true },
    );

    expect(state).toEqual({
      active: true,
      pending: true,
      startedAt: "2026-06-05T11:00:00.000Z",
      until: "2026-06-05T13:00:00.000Z",
      indefinite: false,
    });
  });

  it("clears expired timed pause state when reading stored status", async () => {
    const { module, getStored, saveSettings } = await loadSystemPause({
      systemPauseStartedAt: "2026-06-05T09:00:00.000Z",
      systemPauseUntil: "2026-06-05T10:00:00.000Z",
      systemPauseIndefinite: false,
    });

    const state = await module.getStoredSystemPauseState({ nowMs });

    expect(state.active).toBe(false);
    expect(state.pending).toBe(false);
    expect(saveSettings).toHaveBeenCalledOnce();
    expect(getStored().systemPauseStartedAt).toBeUndefined();
    expect(getStored().systemPauseUntil).toBeUndefined();
    expect(getStored().systemPauseIndefinite).toBeUndefined();
  });

  it("persists a timed pause duration", async () => {
    const { module, getStored } = await loadSystemPause();

    const state = await module.pauseSystem({
      durationMs: 60 * 60 * 1000,
      nowMs,
    });

    expect(state.active).toBe(true);
    expect(state.startedAt).toBe("2026-06-05T12:00:00.000Z");
    expect(state.until).toBe("2026-06-05T13:00:00.000Z");
    expect(state.indefinite).toBe(false);
    expect(getStored().systemPauseUntil).toBe("2026-06-05T13:00:00.000Z");
  });

  it("persists an indefinite pause until resume clears it", async () => {
    const { module, getStored } = await loadSystemPause();

    const paused = await module.pauseSystem({ indefinite: true, nowMs });

    expect(paused.active).toBe(true);
    expect(paused.indefinite).toBe(true);
    expect(getStored().systemPauseIndefinite).toBe(true);
    expect(getStored().systemPauseUntil).toBeNull();

    const resumed = await module.resumeSystem();

    expect(resumed.active).toBe(false);
    expect(getStored().systemPauseStartedAt).toBeUndefined();
    expect(getStored().systemPauseUntil).toBeUndefined();
    expect(getStored().systemPauseIndefinite).toBeUndefined();
  });

  it("rejects invalid timed pause durations", async () => {
    const { module } = await loadSystemPause();

    await expect(module.pauseSystem({ durationMs: 0, nowMs })).rejects.toThrow(
      "durationMs must be a positive number",
    );
  });
});
