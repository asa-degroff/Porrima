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
    expect(
      isSleepCycleActive(settings, {
        hasActiveChats: false,
        nowMs: new Date("2026-04-26T10:06:00.000Z").getTime(),
      }),
    ).toBe(false);
  });

  it("treats manual sleep release as stale after newer non-chat user interaction", () => {
    const settings = {
      sleepModeTriggeredAt: "2026-04-26T10:00:00.000Z",
      lastUserActivityAt: "2026-04-26T09:55:00.000Z",
      lastUserInteractionAt: "2026-04-26T10:05:00.000Z",
    };

    expect(isManualSleepReleaseActive(settings)).toBe(false);
    expect(
      isSleepCycleActive(settings, {
        hasActiveChats: false,
        nowMs: new Date("2026-04-26T10:06:00.000Z").getTime(),
      }),
    ).toBe(false);
  });

  it("treats manual sleep release as stale after newer assistant completion", () => {
    const settings = {
      sleepModeTriggeredAt: "2026-04-26T10:00:00.000Z",
      lastUserActivityAt: "2026-04-26T09:55:00.000Z",
      lastAgentCompletedAt: "2026-04-26T10:05:00.000Z",
    };

    expect(isManualSleepReleaseActive(settings)).toBe(false);
    expect(
      isSleepCycleActive(settings, {
        hasActiveChats: false,
        nowMs: new Date("2026-04-26T10:06:00.000Z").getTime(),
      }),
    ).toBe(false);
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

  it("measures inactivity from completed non-chat user interactions", () => {
    const settings = {
      lastUserActivityAt: "2026-04-26T10:00:00.000Z",
      lastAgentCompletedAt: "2026-04-26T10:45:00.000Z",
      lastUserInteractionAt: "2026-04-26T11:00:00.000Z",
      sleepCycleThresholdMinutes: 60,
    };
    const beforeThreshold = new Date("2026-04-26T12:01:00.000Z").getTime();
    const afterThreshold = new Date("2026-04-26T12:03:00.000Z").getTime();

    expect(getSleepCycleInactivityAnchor(settings)).toBe(settings.lastUserInteractionAt);
    expect(isSleepCycleActive(settings, { hasActiveChats: false, nowMs: beforeThreshold })).toBe(false);
    expect(isSleepCycleActive(settings, { hasActiveChats: false, nowMs: afterThreshold })).toBe(true);
  });

  it("does not start the inactivity window before assistant completion", () => {
    const settings = {
      lastUserActivityAt: "2026-04-26T10:30:00.000Z",
      sleepCycleThresholdMinutes: 60,
    };

    expect(getSleepCycleInactivityAnchor(settings)).toBeNull();
    expect(isSleepCycleActive(settings, { hasActiveChats: false, nowMs: now })).toBe(false);
  });

  it("does not activate sleep within the grace period after threshold", () => {
    // Agent completed 61 minutes ago. Threshold is 60 min.
    // With a 2-minute grace period, effective threshold is 62 — sleep should not yet activate.
    const settings = {
      lastUserActivityAt: "2026-04-26T10:00:00.000Z",
      lastAgentCompletedAt: "2026-04-26T10:59:00.000Z",
      sleepCycleThresholdMinutes: 60,
    };

    // Now is 12:00, anchor is 10:59 → 61 minutes elapsed.
    // Effective threshold is 62 (60 + 2 grace). Sleep should be inactive.
    expect(isSleepCycleActive(settings, { hasActiveChats: false, nowMs: now })).toBe(false);
  });

  it("activates sleep after the grace period has elapsed", () => {
    // Agent completed 75 minutes ago. Threshold is 60 min.
    // Effective threshold is 62. 75 >= 62, so sleep activates.
    const settings = {
      lastUserActivityAt: "2026-04-26T10:00:00.000Z",
      lastAgentCompletedAt: "2026-04-26T10:45:00.000Z",
      sleepCycleThresholdMinutes: 60,
    };

    expect(isSleepCycleActive(settings, { hasActiveChats: false, nowMs: now })).toBe(true);
  });
});
