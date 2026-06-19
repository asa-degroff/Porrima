import type { Settings } from "../types.js";
import { getSettings, saveSettings } from "./chat-storage.js";

interface ActivityStampOptions {
  now?: Date;
}

function toIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

async function stampSettings(
  label: string,
  apply: (settings: Settings, iso: string) => void,
  options?: ActivityStampOptions,
): Promise<void> {
  try {
    const settings = await getSettings();
    apply(settings, toIso(options?.now));
    await saveSettings(settings);
  } catch (e) {
    console.warn(`[activity] Failed to stamp ${label}:`, e);
  }
}

export async function stampUserTurnActivity(options?: ActivityStampOptions): Promise<void> {
  await stampSettings("user turn activity", (settings, iso) => {
    settings.lastUserActivityAt = iso;
    settings.lastUserInteractionAt = iso;
    settings.sleepModeTriggeredAt = undefined;
  }, options);
}

export async function stampUserInteractionActivity(options?: ActivityStampOptions): Promise<void> {
  await stampSettings("user interaction activity", (settings, iso) => {
    settings.lastUserInteractionAt = iso;
    settings.sleepModeTriggeredAt = undefined;
  }, options);
}

export async function stampAssistantCompletionActivity(options?: ActivityStampOptions): Promise<void> {
  await stampSettings("assistant completion", (settings, iso) => {
    settings.lastAgentCompletedAt = iso;
  }, options);
}
