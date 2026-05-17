import express from "express";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { TTSBackend, TTSSettings, TTSTextMode } from "../types/tts.js";
import { DEFAULT_TTS_SETTINGS } from "../types/tts.js";
import { generateTTS, getAudioFile, getAvailableVoices, groupVoices, checkKokoroAvailability, checkQwen3TTSInstallation, checkSupertonicTTSInstallation } from "../services/tts.js";
import { getQwen3AudioFile } from "../services/tts-qwen3.js";
import { getSupertonicAudioFile } from "../services/tts-supertonic.js";
import { generateTTSChunks, planTTSChunks } from "../services/tts-chunking.js";
import { getTtsPythonStatus } from "../services/tts-python.js";

const router = express.Router();

const BASE_DIR = join(homedir(), ".quje-agent");
const TTS_SETTINGS_PATH = join(BASE_DIR, "tts-settings.json");
const TTS_BACKENDS: TTSBackend[] = ["kokoro", "qwen3-tts", "supertonic-3"];
const DEFAULT_VOICE_BY_BACKEND: Record<TTSBackend, string> = {
  kokoro: "af_heart",
  "qwen3-tts": "Ryan",
  "supertonic-3": "M1",
};
const SUPERTONIC_LANGUAGE_CODES = new Set([
  "en",
  "ko",
  "ja",
  "ar",
  "bg",
  "cs",
  "da",
  "de",
  "el",
  "es",
  "et",
  "fi",
  "fr",
  "hi",
  "hr",
  "hu",
  "id",
  "it",
  "lt",
  "lv",
  "nl",
  "pl",
  "pt",
  "ro",
  "ru",
  "sk",
  "sl",
  "sv",
  "tr",
  "uk",
  "vi",
  "na",
]);

function isTTSBackend(value: unknown): value is TTSBackend {
  return typeof value === "string" && TTS_BACKENDS.includes(value as TTSBackend);
}

function isTTSTextMode(value: unknown): value is TTSTextMode {
  return typeof value === "string" && ["minimal", "standard", "stripped"].includes(value);
}

function sanitizeSupertonicLanguage(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_TTS_SETTINGS.supertonicLanguage;
  const trimmed = value.trim().toLowerCase();
  return SUPERTONIC_LANGUAGE_CODES.has(trimmed) ? trimmed : DEFAULT_TTS_SETTINGS.supertonicLanguage;
}

function sanitizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function pitchMultiplierToSemitones(pitch: unknown): number {
  if (typeof pitch !== "number" || !Number.isFinite(pitch) || pitch <= 0) {
    return DEFAULT_TTS_SETTINGS.supertonicPitchSemitones;
  }
  return 12 * Math.log2(pitch);
}

function normalizeTTSSettings(settings: Partial<TTSSettings>): TTSSettings {
  const backend = isTTSBackend(settings.backend) ? settings.backend : DEFAULT_TTS_SETTINGS.backend;
  const voicesByBackend = {
    ...DEFAULT_VOICE_BY_BACKEND,
    ...(settings.voicesByBackend ?? {}),
  };

  if (settings.voice) {
    voicesByBackend[backend] = settings.voice;
  }

  const ttsTextMode = isTTSTextMode(settings.ttsTextMode) ? settings.ttsTextMode : DEFAULT_TTS_SETTINGS.ttsTextMode;

  return {
    ...DEFAULT_TTS_SETTINGS,
    ...settings,
    backend,
    ttsTextMode,
    voicesByBackend,
    voice: settings.voice || voicesByBackend[backend] || DEFAULT_VOICE_BY_BACKEND[backend],
    supertonicPitchSemitones: sanitizeNumber(
      settings.supertonicPitchSemitones ?? pitchMultiplierToSemitones(settings.pitch),
      DEFAULT_TTS_SETTINGS.supertonicPitchSemitones,
      -2,
      2
    ),
    supertonicLanguage: sanitizeSupertonicLanguage(settings.supertonicLanguage),
    supertonicSteps: Math.round(sanitizeNumber(settings.supertonicSteps, DEFAULT_TTS_SETTINGS.supertonicSteps, 1, 32)),
    supertonicMaxChunkLength: Math.round(sanitizeNumber(settings.supertonicMaxChunkLength, DEFAULT_TTS_SETTINGS.supertonicMaxChunkLength, 100, 600)),
    supertonicSilenceDuration: sanitizeNumber(settings.supertonicSilenceDuration, DEFAULT_TTS_SETTINGS.supertonicSilenceDuration, 0, 1),
    supertonicTrailingSilence: sanitizeNumber(settings.supertonicTrailingSilence, DEFAULT_TTS_SETTINGS.supertonicTrailingSilence, 0, 1),
  };
}

// In-memory cache, loaded from disk on startup
let userSettings: TTSSettings = normalizeTTSSettings(DEFAULT_TTS_SETTINGS);

async function loadTTSSettings(): Promise<void> {
  try {
    const data = await readFile(TTS_SETTINGS_PATH, "utf-8");
    userSettings = normalizeTTSSettings(JSON.parse(data));
  } catch {
    // File doesn't exist yet, use defaults
  }
}

async function saveTTSSettings(): Promise<void> {
  await mkdir(BASE_DIR, { recursive: true });
  await writeFile(TTS_SETTINGS_PATH, JSON.stringify(userSettings, null, 2));
}

// Load persisted settings on module init
loadTTSSettings();

/**
 * GET /api/tts/voices
 * List available voices grouped by category
 * Query param: backend=kokoro|qwen3-tts|supertonic-3 (default: kokoro)
 */
router.get("/voices", (req, res) => {
  try {
    const backend = isTTSBackend(req.query.backend) ? req.query.backend : "kokoro";
    const voices = getAvailableVoices(backend);
    const grouped = groupVoices(voices);
    res.json(grouped);
  } catch (error) {
    console.error("[TTS] Error getting voices:", error);
    res.status(500).json({ error: "Failed to get available voices" });
  }
});

/**
 * GET /api/tts/settings
 * Get current TTS settings
 */
router.get("/settings", (req, res) => {
  res.json(userSettings);
});

/**
 * POST /api/tts/settings
 * Update TTS settings
 */
router.post("/settings", async (req, res) => {
  try {
    const {
      voice,
      speed,
      pitch,
      enabled,
      autoReadEnabled,
      ttsTextMode,
      backend,
      streamingEnabled,
      streamingChunkSize,
      streamingBoundaryTier,
      supertonicPitchSemitones,
      supertonicLanguage,
      supertonicSteps,
      supertonicMaxChunkLength,
      supertonicSilenceDuration,
      supertonicTrailingSilence,
    } = req.body;

    if (speed !== undefined) {
      if (typeof speed !== "number" || speed < 0.5 || speed > 2.0) {
        return res.status(400).json({ error: "Speed must be a number between 0.5 and 2.0" });
      }
      userSettings.speed = speed;
    }

    if (pitch !== undefined) {
      if (typeof pitch !== "number" || pitch < 0.5 || pitch > 2.0) {
        return res.status(400).json({ error: "Pitch must be a number between 0.5 and 2.0" });
      }
      userSettings.pitch = pitch;
    }

    if (enabled !== undefined) {
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ error: "enabled must be a boolean" });
      }
      userSettings.enabled = enabled;
    }

    if (autoReadEnabled !== undefined) {
      if (typeof autoReadEnabled !== "boolean") {
        return res.status(400).json({ error: "autoReadEnabled must be a boolean" });
      }
      userSettings.autoReadEnabled = autoReadEnabled;
    }

    if (ttsTextMode !== undefined) {
      if (!isTTSTextMode(ttsTextMode)) {
        return res.status(400).json({ error: "ttsTextMode must be 'minimal', 'standard', or 'stripped'" });
      }
      userSettings.ttsTextMode = ttsTextMode;
    }

    let backendChanged = false;
    if (backend !== undefined) {
      if (!isTTSBackend(backend)) {
        return res.status(400).json({ error: "Backend must be 'kokoro', 'qwen3-tts', or 'supertonic-3'" });
      }
      backendChanged = backend !== userSettings.backend;
      userSettings.backend = backend;
    }

    userSettings.voicesByBackend = {
      ...DEFAULT_VOICE_BY_BACKEND,
      ...(userSettings.voicesByBackend ?? {}),
    };

    if (voice !== undefined) {
      if (typeof voice !== "string" || !voice.trim()) {
        return res.status(400).json({ error: "Voice must be a non-empty string" });
      }
      const trimmedVoice = voice.trim();
      userSettings.voice = trimmedVoice;
      userSettings.voicesByBackend[userSettings.backend] = trimmedVoice;
    } else if (backendChanged) {
      userSettings.voice = userSettings.voicesByBackend[userSettings.backend] || DEFAULT_VOICE_BY_BACKEND[userSettings.backend];
    }

    if (streamingEnabled !== undefined) {
      if (typeof streamingEnabled !== "boolean") {
        return res.status(400).json({ error: "streamingEnabled must be a boolean" });
      }
      userSettings.streamingEnabled = streamingEnabled;
    }

    if (streamingChunkSize !== undefined) {
      if (typeof streamingChunkSize !== "number" || streamingChunkSize < 30 || streamingChunkSize > 80) {
        return res.status(400).json({ error: "streamingChunkSize must be between 30 and 80" });
      }
      userSettings.streamingChunkSize = streamingChunkSize;
    }

    if (streamingBoundaryTier !== undefined) {
      if (!["clause", "sentence"].includes(streamingBoundaryTier)) {
        return res.status(400).json({ error: "streamingBoundaryTier must be 'clause' or 'sentence'" });
      }
      userSettings.streamingBoundaryTier = streamingBoundaryTier;
    }

    if (supertonicPitchSemitones !== undefined) {
      if (typeof supertonicPitchSemitones !== "number" || supertonicPitchSemitones < -2 || supertonicPitchSemitones > 2) {
        return res.status(400).json({ error: "supertonicPitchSemitones must be between -2 and 2" });
      }
      userSettings.supertonicPitchSemitones = supertonicPitchSemitones;
    }

    if (supertonicLanguage !== undefined) {
      if (typeof supertonicLanguage !== "string" || sanitizeSupertonicLanguage(supertonicLanguage) !== supertonicLanguage.trim().toLowerCase()) {
        return res.status(400).json({ error: "supertonicLanguage must be a supported Supertonic language code" });
      }
      userSettings.supertonicLanguage = supertonicLanguage.trim().toLowerCase();
    }

    if (supertonicSteps !== undefined) {
      if (typeof supertonicSteps !== "number" || !Number.isInteger(supertonicSteps) || supertonicSteps < 1 || supertonicSteps > 32) {
        return res.status(400).json({ error: "supertonicSteps must be an integer between 1 and 32" });
      }
      userSettings.supertonicSteps = supertonicSteps;
    }

    if (supertonicMaxChunkLength !== undefined) {
      if (
        typeof supertonicMaxChunkLength !== "number" ||
        !Number.isInteger(supertonicMaxChunkLength) ||
        supertonicMaxChunkLength < 100 ||
        supertonicMaxChunkLength > 600
      ) {
        return res.status(400).json({ error: "supertonicMaxChunkLength must be an integer between 100 and 600" });
      }
      userSettings.supertonicMaxChunkLength = supertonicMaxChunkLength;
    }

    if (supertonicSilenceDuration !== undefined) {
      if (typeof supertonicSilenceDuration !== "number" || supertonicSilenceDuration < 0 || supertonicSilenceDuration > 1) {
        return res.status(400).json({ error: "supertonicSilenceDuration must be between 0 and 1 second" });
      }
      userSettings.supertonicSilenceDuration = supertonicSilenceDuration;
    }

    if (supertonicTrailingSilence !== undefined) {
      if (typeof supertonicTrailingSilence !== "number" || supertonicTrailingSilence < 0 || supertonicTrailingSilence > 1) {
        return res.status(400).json({ error: "supertonicTrailingSilence must be between 0 and 1 second" });
      }
      userSettings.supertonicTrailingSilence = supertonicTrailingSilence;
    }

    await saveTTSSettings();
    res.json(userSettings);
  } catch (error) {
    console.error("[TTS] Error updating settings:", error);
    res.status(500).json({ error: "Failed to update settings" });
  }
});

/**
 * POST /api/tts/generate
 * Generate TTS audio from text
 */
router.post("/generate", async (req, res) => {
  try {
    const {
      text,
      voice,
      speed,
      pitch,
      backend,
      supertonicPitchSemitones,
      supertonicLanguage,
      supertonicSteps,
      supertonicMaxChunkLength,
      supertonicSilenceDuration,
      supertonicTrailingSilence,
    } = req.body;

    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "Text is required" });
    }

    // Build effective settings: request body overrides > server-side user settings > defaults
    const effectiveSettings: TTSSettings = {
      ...userSettings,
      ...(voice !== undefined && { voice }),
      ...(speed !== undefined && { speed }),
      ...(pitch !== undefined && { pitch }),
      ...(backend !== undefined && { backend }),
      ...(supertonicPitchSemitones !== undefined && { supertonicPitchSemitones }),
      ...(supertonicLanguage !== undefined && { supertonicLanguage }),
      ...(supertonicSteps !== undefined && { supertonicSteps }),
      ...(supertonicMaxChunkLength !== undefined && { supertonicMaxChunkLength }),
      ...(supertonicSilenceDuration !== undefined && { supertonicSilenceDuration }),
      ...(supertonicTrailingSilence !== undefined && { supertonicTrailingSilence }),
    };

    const response = await generateTTS({
      text: text.trim(),
      voice: effectiveSettings.voice,
      speed: effectiveSettings.speed,
      pitch: effectiveSettings.pitch,
    }, effectiveSettings);

    res.json(response);
  } catch (error) {
    console.error("[TTS] Generation error:", error);
    const message = error instanceof Error ? error.message : "Failed to generate audio";
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/tts/generate-stream
 * Generate TTS audio as independently playable chunks.
 */
router.post("/generate-stream", async (req, res) => {
  try {
    const {
      text,
      voice,
      speed,
      pitch,
      backend,
      supertonicPitchSemitones,
      supertonicLanguage,
      supertonicSteps,
      supertonicMaxChunkLength,
      supertonicSilenceDuration,
      supertonicTrailingSilence,
    } = req.body;

    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "Text is required" });
    }

    const effectiveSettings: TTSSettings = {
      ...userSettings,
      ...(voice !== undefined && { voice }),
      ...(speed !== undefined && { speed }),
      ...(pitch !== undefined && { pitch }),
      ...(backend !== undefined && { backend }),
      ...(supertonicPitchSemitones !== undefined && { supertonicPitchSemitones }),
      ...(supertonicLanguage !== undefined && { supertonicLanguage }),
      ...(supertonicSteps !== undefined && { supertonicSteps }),
      ...(supertonicMaxChunkLength !== undefined && { supertonicMaxChunkLength }),
      ...(supertonicSilenceDuration !== undefined && { supertonicSilenceDuration }),
      ...(supertonicTrailingSilence !== undefined && { supertonicTrailingSilence }),
    };

    if (!isTTSBackend(effectiveSettings.backend)) {
      return res.status(400).json({ error: "Backend must be 'kokoro', 'qwen3-tts', or 'supertonic-3'" });
    }

    const chunkTexts = planTTSChunks(text.trim());

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const writeEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    writeEvent("chunk_plan", { totalChunks: chunkTexts.length });

    let totalDuration = 0;
    let totalFileSize = 0;
    for await (const chunk of generateTTSChunks({ text: text.trim(), voice, speed, pitch }, effectiveSettings)) {
      if (res.writableEnded) break;
      totalDuration += chunk.duration;
      totalFileSize += chunk.fileSize;
      writeEvent("audio_chunk", {
        chunkId: chunk.chunkId,
        index: chunk.index,
        totalChunks: chunk.totalChunks,
        audioUrl: chunk.audioUrl,
        duration: chunk.duration,
        fileSize: chunk.fileSize,
      });
    }

    if (!res.writableEnded) {
      writeEvent("done", {
        totalChunks: chunkTexts.length,
        duration: totalDuration,
        fileSize: totalFileSize,
      });
      res.end();
    }
  } catch (error) {
    console.error("[TTS] Chunked generation error:", error);
    const message = error instanceof Error ? error.message : "Failed to generate chunked audio";
    if (res.headersSent) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
      res.end();
    } else {
      res.status(500).json({ error: message });
    }
  }
});

/**
 * GET /api/tts/audio/:cacheKey.wav
 * Serve cached audio file
 */
router.get("/audio/:cacheKey.wav", (req, res) => {
  try {
    const { cacheKey } = req.params;

    // Validate cache key format
    if (!/^[a-f0-9]{64}$/.test(cacheKey)) {
      return res.status(400).json({ error: "Invalid cache key" });
    }

    // Check all backend cache directories
    const audio = getAudioFile(cacheKey) ?? getQwen3AudioFile(cacheKey) ?? getSupertonicAudioFile(cacheKey);
    if (!audio) {
      return res.status(404).json({ error: "Audio not found" });
    }

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Cache-Control", "public, max-age=31536000"); // Cache for 1 year
    res.send(audio);
  } catch (error) {
    console.error("[TTS] Error serving audio:", error);
    res.status(500).json({ error: "Failed to serve audio" });
  }
});

/**
 * GET /api/tts/status
 * Check if TTS service is available
 * Query param: backend=kokoro|qwen3-tts|supertonic-3 (default: kokoro)
 */
router.get("/status", async (req, res) => {
  try {
    const backend = isTTSBackend(req.query.backend) ? req.query.backend : "kokoro";
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const pythonStatus = await getTtsPythonStatus(backend);
    
    if (backend === "qwen3-tts") {
      const result = await checkQwen3TTSInstallation();
      res.json({
        backend: "qwen3-tts",
        available: result.available,
        error: result.error,
        pythonPath: pythonStatus.pythonPath,
        pythonSource: pythonStatus.source,
        requiredImports: pythonStatus.requiredImports,
        installCommand: pythonStatus.installCommand,
        pythonCandidates: pythonStatus.candidates,
      });
    } else if (backend === "supertonic-3") {
      const result = await checkSupertonicTTSInstallation();
      res.json({
        backend: "supertonic-3",
        available: result.available,
        error: result.error,
        pythonPath: pythonStatus.pythonPath,
        pythonSource: pythonStatus.source,
        requiredImports: pythonStatus.requiredImports,
        installCommand: pythonStatus.installCommand,
        pythonCandidates: pythonStatus.candidates,
      });
    } else {
      const scriptPath = join(process.cwd(), "src", "tts", "kokoro_wrapper.py");
      if (!existsSync(scriptPath)) {
        return res.json({ 
          backend: "kokoro",
          available: false, 
          error: "TTS script not found" 
        });
      }
      const result = await checkKokoroAvailability();
      res.json({
        backend: "kokoro",
        available: result.available,
        error: result.error,
        pythonPath: result.pythonPath,
        pythonSource: result.source,
        requiredImports: pythonStatus.requiredImports,
        installCommand: pythonStatus.installCommand,
        pythonCandidates: pythonStatus.candidates,
      });
    }
  } catch (error) {
    console.error("[TTS] Status check failed:", error);
    res.json({ 
      backend: req.query.backend || "kokoro",
      available: false, 
      error: error instanceof Error ? error.message : "Unknown error" 
    });
  }
});

export default router;
