import type { Settings } from "../types.js";

type SleepCycleSettings = Pick<
  Settings,
  | "sleepModeTriggeredAt"
  | "lastUserActivityAt"
  | "lastAgentCompletedAt"
  | "sleepCycleThresholdMinutes"
>;

interface SleepCycleOptions {
  hasActiveChats: boolean;
  nowMs?: number;
  defaultThresholdMinutes?: number;
}

function parseTimestamp(value: string | undefined | null): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function isManualSleepReleaseActive(settings: SleepCycleSettings): boolean {
  const sleepTriggeredMs = parseTimestamp(settings.sleepModeTriggeredAt);
  if (sleepTriggeredMs === null) return false;

  const lastUserActivityMs = parseTimestamp(settings.lastUserActivityAt);
  return lastUserActivityMs === null || lastUserActivityMs <= sleepTriggeredMs;
}

export function getSleepCycleInactivityAnchor(settings: SleepCycleSettings): string | null {
  const lastUserActivityMs = parseTimestamp(settings.lastUserActivityAt);
  const lastAgentCompletedMs = parseTimestamp(settings.lastAgentCompletedAt);

  if (lastAgentCompletedMs === null) return null;

  // A newer user message means the next inactivity window has not started yet.
  // It starts only when the assistant response to that user activity completes.
  if (lastUserActivityMs !== null && lastUserActivityMs > lastAgentCompletedMs) {
    return null;
  }

  return settings.lastAgentCompletedAt!;
}

export function isSleepCycleActive(settings: SleepCycleSettings, options: SleepCycleOptions): boolean {
  if (options.hasActiveChats) return false;

  if (isManualSleepReleaseActive(settings)) {
    return true;
  }

  const anchor = getSleepCycleInactivityAnchor(settings);
  const anchorMs = parseTimestamp(anchor);
  if (anchorMs === null) return false;

  const thresholdMinutes =
    settings.sleepCycleThresholdMinutes ?? options.defaultThresholdMinutes ?? 60;
  const elapsedMinutes = ((options.nowMs ?? Date.now()) - anchorMs) / (1000 * 60);

  return elapsedMinutes >= thresholdMinutes;
}
