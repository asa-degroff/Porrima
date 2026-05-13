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

// Grace period after agent completion before the inactivity window starts ticking.
// Gives the SSE connection time to properly close and client state to settle,
// preventing premature sleep activation immediately after a response finishes.
const SLEEP_GRACE_PERIOD_MINUTES = 2;

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

  const configuredThreshold =
    settings.sleepCycleThresholdMinutes ?? options.defaultThresholdMinutes ?? 60;
  // Grace period adds a buffer after agent completion before sleep can activate,
  // so the SSE connection has time to close and client state settles.
  const effectiveThreshold = configuredThreshold + SLEEP_GRACE_PERIOD_MINUTES;
  const elapsedMinutes = ((options.nowMs ?? Date.now()) - anchorMs) / (1000 * 60);

  return elapsedMinutes >= effectiveThreshold;
}
