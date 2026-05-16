import type { TTSBackend, TTSSettings, TTSVoiceCategory } from "../types";

export interface TTSGenerateRequest {
  text: string;
  voice?: string;
  speed?: number;
  pitch?: number;
  backend?: TTSBackend;
}

export interface TTSGenerateResponse {
  audioUrl: string;
  duration: number;
  fileSize: number;
}

/**
 * Generate TTS audio from text
 */
export async function generateTTS(request: TTSGenerateRequest): Promise<TTSGenerateResponse> {
  const res = await fetch("/api/tts/generate", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: "Failed to generate audio" }));
    throw new Error(error.error || "Failed to generate audio");
  }

  return res.json();
}

/**
 * Get available TTS voices
 * @param backend - TTS backend
 */
export async function getTTSVoices(backend?: TTSBackend): Promise<TTSVoiceCategory[]> {
  const url = backend ? `/api/tts/voices?backend=${backend}` : "/api/tts/voices";
  const res = await fetch(url, {
    credentials: "include",
  });

  if (!res.ok) {
    throw new Error("Failed to get voices");
  }

  return res.json();
}

/**
 * Get current TTS settings
 */
export async function getTTSSettings(): Promise<TTSSettings> {
  const res = await fetch("/api/tts/settings", {
    credentials: "include",
  });

  if (!res.ok) {
    throw new Error("Failed to get settings");
  }

  return res.json();
}

/**
 * Update TTS settings
 */
export async function updateTTSSettings(settings: Partial<TTSSettings>): Promise<TTSSettings> {
  const res = await fetch("/api/tts/settings", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: "Failed to update settings" }));
    throw new Error(error.error || "Failed to update settings");
  }

  return res.json();
}

/**
 * Check TTS service status
 */
export async function getTTSStatus(): Promise<{ available: boolean; error?: string }> {
  try {
    const res = await fetch("/api/tts/status", {
      credentials: "include",
    });
    if (!res.ok) {
      return { available: false, error: "Service unavailable" };
    }
    return res.json();
  } catch {
    return { available: false, error: "Connection failed" };
  }
}
