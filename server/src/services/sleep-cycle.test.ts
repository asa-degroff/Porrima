import { describe, expect, it } from "vitest";
import {
  getSleepCycleInactivityAnchor,
  isManualSleepReleaseActive,
  isSleepCycleActive,
} from "./sleep-cycle.js";

const now = new Date("2026-04-26T12:00:00.000Z").getTime();

describe("sleep cycle state", () => {
  it("suppresses sleep while a chat is active", () => {
    expect(
      isSleepCycleActive(
        { sleepModeTriggeredAt: "2026-04-26T10:00:00.000Z" },
        { hasActiveChats: true, nowMs: now },
      ),
    ).toBe(false);
  });

  it("treats manual sleep release as stale after newer user activity", () => {
    const settings = {
      sleepModeTriggeredAt: "2026-04-26T10:00:00.000Z",
      lastUserActivityAt: "2026-04-26T10:05:00.000Z",
    };

    expect(isManualSleepReleaseActive(settings)).toBe(false);
    expect(isSleepCycleActive(settings, { hasActiveChats: false, nowMs: now })).toBe(false);
  });

  it("waits for assistant completion after newer user activity", () => {
    const settings = {
      lastUserActivityAt: "2026-04-26T11:55:00.000Z",
      lastAgentCompletedAt: "2026-04-26T10:00:00.000Z",
      sleepCycleThresholdMinutes: 30,
    };

    expect(getSleepCycleInactivityAnchor(settings)).toBeNull();
    expect(isSleepCycleActive(settings, { hasActiveChats: false, nowMs: now })).toBe(false);
  });

  it("measures inactivity from assistant completion", () => {
    const settings = {
      lastUserActivityAt: "2026-04-26T10:00:00.000Z",
      lastAgentCompletedAt: "2026-04-26T10:45:00.000Z",
      sleepCycleThresholdMinutes: 60,
    };

    expect(getSleepCycleInactivityAnchor(settings)).toBe(settings.lastAgentCompletedAt);
    expect(isSleepCycleActive(settings, { hasActiveChats: false, nowMs: now })).toBe(true);
  });

  it("does not start the inactivity window before assistant completion", () => {
    const settings = {
      lastUserActivityAt: "2026-04-26T10:30:00.000Z",
      sleepCycleThresholdMinutes: 60,
    };

    expect(getSleepCycleInactivityAnchor(settings)).toBeNull();
    expect(isSleepCycleActive(settings, { hasActiveChats: false, nowMs: now })).toBe(false);
  });
});
