import express from "express";
import type { TTSSettings } from "../types/tts.js";
import { DEFAULT_TTS_SETTINGS } from "../types/tts.js";
import { generateTTS, getAudioFile, getAvailableVoices, groupVoices } from "../services/tts.js";

const router = express.Router();

// In-memory storage for user TTS settings
// In a multi-user setup, this would be in the database
let userSettings: TTSSettings = { ...DEFAULT_TTS_SETTINGS };

/**
 * GET /api/tts/voices
 * List available voices grouped by category
 */
router.get("/voices", (req, res) => {
  try {
    const voices = getAvailableVoices();
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
router.post("/settings", (req, res) => {
  try {
    const { voice, speed, pitch, autoReadEnabled } = req.body;

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

    if (autoReadEnabled !== undefined) {
      if (typeof autoReadEnabled !== "boolean") {
        return res.status(400).json({ error: "autoReadEnabled must be a boolean" });
      }
      userSettings.autoReadEnabled = autoReadEnabled;
    }

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
    const { text, voice, speed, pitch } = req.body;

    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "Text is required" });
    }

    const response = await generateTTS({
      text: text.trim(),
      voice,
      speed,
      pitch,
    });

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

    const audio = getAudioFile(cacheKey);
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
 */
router.get("/status", async (req, res) => {
  try {
    // Quick check: verify Python script exists
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const scriptPath = join(process.cwd(), "src", "tts", "kokoro_wrapper.py");

    if (!existsSync(scriptPath)) {
      return res.json({ available: false, error: "TTS script not found" });
    }

    // Could test Python here, but that's expensive
    // For now, just confirm the script exists
    res.json({
      available: true,
      pythonPath: process.env.TTS_PYTHON_OVERRIDE || join(process.cwd(), ".venv", "bin", "python"),
    });
  } catch (error) {
    console.error("[TTS] Status check failed:", error);
    res.json({ available: false, error: error instanceof Error ? error.message : "Unknown error" });
  }
});

export default router;
