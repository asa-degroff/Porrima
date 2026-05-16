import express from "express";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { TTSBackend, TTSSettings } from "../types/tts.js";
import { DEFAULT_TTS_SETTINGS } from "../types/tts.js";
import { generateTTS, getAudioFile, getAvailableVoices, groupVoices, checkQwen3TTSInstallation, checkSupertonicTTSInstallation } from "../services/tts.js";
import { getQwen3AudioFile } from "../services/tts-qwen3.js";
import { getSupertonicAudioFile } from "../services/tts-supertonic.js";

const router = express.Router();

const BASE_DIR = join(homedir(), ".quje-agent");
const TTS_SETTINGS_PATH = join(BASE_DIR, "tts-settings.json");
const TTS_BACKENDS: TTSBackend[] = ["kokoro", "qwen3-tts", "supertonic-3"];

function isTTSBackend(value: unknown): value is TTSBackend {
  return typeof value === "string" && TTS_BACKENDS.includes(value as TTSBackend);
}

// In-memory cache, loaded from disk on startup
let userSettings: TTSSettings = { ...DEFAULT_TTS_SETTINGS };

async function loadTTSSettings(): Promise<void> {
  try {
    const data = await readFile(TTS_SETTINGS_PATH, "utf-8");
    userSettings = { ...DEFAULT_TTS_SETTINGS, ...JSON.parse(data) };
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
    const { voice, speed, pitch, enabled, autoReadEnabled, backend, streamingEnabled, streamingChunkSize, streamingBoundaryTier } = req.body;

    if (voice !== undefined) {
      if (typeof voice !== "string" || !voice.trim()) {
        return res.status(400).json({ error: "Voice must be a non-empty string" });
      }
      userSettings.voice = voice.trim();
    }

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

    if (backend !== undefined) {
      if (!isTTSBackend(backend)) {
        return res.status(400).json({ error: "Backend must be 'kokoro', 'qwen3-tts', or 'supertonic-3'" });
      }
      userSettings.backend = backend;
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
    const { text, voice, speed, pitch, backend } = req.body;

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
    
    if (backend === "qwen3-tts") {
      const result = await checkQwen3TTSInstallation();
      res.json({
        backend: "qwen3-tts",
        available: result.available,
        error: result.error,
        pythonPath: process.env.TTS_PYTHON_OVERRIDE || join(process.cwd(), ".venv", "bin", "python"),
      });
    } else if (backend === "supertonic-3") {
      const result = await checkSupertonicTTSInstallation();
      res.json({
        backend: "supertonic-3",
        available: result.available,
        error: result.error,
        pythonPath: process.env.TTS_PYTHON_OVERRIDE || join(process.cwd(), "..", ".venv", "bin", "python"),
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
      res.json({
        backend: "kokoro",
        available: true,
        pythonPath: process.env.TTS_PYTHON_OVERRIDE || join(process.cwd(), ".venv", "bin", "python"),
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
