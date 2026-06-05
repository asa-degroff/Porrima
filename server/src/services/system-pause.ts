import type { Settings, SystemPauseStatus } from "../types.js";
import { getSettings, saveSettings } from "./chat-storage.js";

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function hasPauseFields(settings: Settings): boolean {
  return Boolean(
    settings.systemPauseStartedAt ||
    settings.systemPauseUntil ||
    settings.systemPauseIndefinite,
  );
}

function clearPauseFields(settings: Settings): Settings {
  return {
    ...settings,
    systemPauseStartedAt: undefined,
    systemPauseUntil: undefined,
    systemPauseIndefinite: undefined,
  };
}

export function getSystemPauseState(
  settings: Settings,
  options: { nowMs?: number; pending?: boolean } = {},
): SystemPauseStatus {
  const nowMs = options.nowMs ?? Date.now();
  const indefinite = settings.systemPauseIndefinite === true;
  const untilMs = parseTimestamp(settings.systemPauseUntil);
  const active = indefinite || (untilMs !== null && untilMs > nowMs);

  return {
    active,
    pending: active && options.pending === true,
    startedAt: settings.systemPauseStartedAt ?? null,
    until: settings.systemPauseUntil ?? null,
    indefinite,
  };
}

export function isSystemPauseActive(settings: Settings, nowMs = Date.now()): boolean {
  return getSystemPauseState(settings, { nowMs }).active;
}

export async function clearExpiredSystemPause(
  settings: Settings,
  nowMs = Date.now(),
): Promise<Settings> {
  const state = getSystemPauseState(settings, { nowMs });
  if (state.active || !hasPauseFields(settings)) return settings;
  return saveSettings(clearPauseFields(settings));
}

export async function getStoredSystemPauseState(
  options: { nowMs?: number; pending?: boolean } = {},
): Promise<SystemPauseStatus> {
  const settings = await clearExpiredSystemPause(await getSettings(), options.nowMs);
  return getSystemPauseState(settings, options);
}

export async function pauseSystem(input: {
  durationMs?: number;
  indefinite?: boolean;
  nowMs?: number;
}): Promise<SystemPauseStatus> {
  const settings = await getSettings();
  const nowMs = input.nowMs ?? Date.now();
  const startedAt = new Date(nowMs).toISOString();

  if (input.indefinite) {
    const next: Settings = {
      ...settings,
      systemPauseStartedAt: startedAt,
      systemPauseUntil: null,
      systemPauseIndefinite: true,
    };
    const saved = await saveSettings(next);
    return getSystemPauseState(saved, { nowMs });
  }

  if (!Number.isFinite(input.durationMs) || (input.durationMs ?? 0) <= 0) {
    throw new Error("durationMs must be a positive number");
  }

  const until = new Date(nowMs + input.durationMs!).toISOString();
  const next: Settings = {
    ...settings,
    systemPauseStartedAt: startedAt,
    systemPauseUntil: until,
    systemPauseIndefinite: false,
  };
  const saved = await saveSettings(next);
  return getSystemPauseState(saved, { nowMs });
}

export async function resumeSystem(): Promise<SystemPauseStatus> {
  const settings = await getSettings();
  const saved = await saveSettings(clearPauseFields(settings));
  return getSystemPauseState(saved);
}
