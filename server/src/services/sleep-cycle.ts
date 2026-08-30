import type { AutomationAbsentWindow, Settings } from "../types.js";

type SleepCycleSettings = Pick<
  Settings,
  | "sleepModeTriggeredAt"
  | "lastUserActivityAt"
  | "lastUserInteractionAt"
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

export function parseTimestamp(value: string | undefined | null): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function isManualSleepReleaseActive(settings: SleepCycleSettings): boolean {
  const sleepTriggeredMs = parseTimestamp(settings.sleepModeTriggeredAt);
  if (sleepTriggeredMs === null) return false;

  const lastUserActivityMs = parseTimestamp(settings.lastUserActivityAt);
  const lastUserInteractionMs = parseTimestamp(settings.lastUserInteractionAt);
  const lastAgentCompletedMs = parseTimestamp(settings.lastAgentCompletedAt);
  if (lastAgentCompletedMs !== null && lastAgentCompletedMs > sleepTriggeredMs) {
    return false;
  }

  const lastUserInitiatedMs = Math.max(lastUserActivityMs ?? 0, lastUserInteractionMs ?? 0);
  return lastUserInitiatedMs === 0 || lastUserInitiatedMs <= sleepTriggeredMs;
}

export function getSleepCycleInactivityAnchor(settings: SleepCycleSettings): string | null {
  const lastUserActivityMs = parseTimestamp(settings.lastUserActivityAt);
  const lastUserInteractionMs = parseTimestamp(settings.lastUserInteractionAt);
  const lastAgentCompletedMs = parseTimestamp(settings.lastAgentCompletedAt);

  if (lastAgentCompletedMs === null) return null;

  // A newer user message means the next inactivity window has not started yet.
  // It starts only when the assistant response to that user activity completes.
  if (lastUserActivityMs !== null && lastUserActivityMs > lastAgentCompletedMs) {
    return null;
  }

  if (lastUserInteractionMs !== null && lastUserInteractionMs > lastAgentCompletedMs) {
    return settings.lastUserInteractionAt!;
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

function minutesOfDay(hour: string, minute: string): number | null {
  const h = Number(hour);
  const m = Number(minute);
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return null;
  }
  return h * 60 + m;
}

function parseWindowMinutes(value: string | undefined): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  return minutesOfDay(match[1], match[2]);
}

function localMinutesOfDay(nowMs: number): number {
  const d = new Date(nowMs);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Whether a local timestamp falls within a task's optional "absent" window.
 * - No window (or equal start/end) → always true (unrestricted).
 * - Normal window (start < end, e.g. 09:00–17:00): start inclusive, end exclusive.
 * - Midnight-crossing window (start > end, e.g. 22:00–07:00): true at/after start
 *   OR before end.
 */
export function isWithinAbsentWindow(
  window: AutomationAbsentWindow | undefined | null,
  nowMs: number,
): boolean {
  if (!window) return true;
  const startMin = parseWindowMinutes(window.start);
  const endMin = parseWindowMinutes(window.end);
  if (startMin === null || endMin === null || startMin === endMin) return true;

  const nowMin = localMinutesOfDay(nowMs);
  if (startMin < endMin) {
    return nowMin >= startMin && nowMin < endMin;
  }
  // Midnight-crossing window.
  return nowMin >= startMin || nowMin < endMin;
}
