import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { TTSBackend, TTSGenerateRequest, TTSGenerateResponse, TTSSettings } from "../types/tts.js";
import { DEFAULT_TTS_SETTINGS } from "../types/tts.js";
import { extractTextForTTS } from "./tts-text-preprocessor.js";
import { generateQwen3TTS, getQwen3Voices, checkQwen3Availability } from "./tts-qwen3.js";
import { generateSupertonicTTS, getSupertonicVoices, checkSupertonicAvailability } from "./tts-supertonic.js";
import { getTtsPythonStatus, resolveTtsPython } from "./tts-python.js";

const CACHE_DIR = join(process.cwd(), "data", "tts-cache");
const MAX_CACHE_SIZE_MB = 500; // LRU cleanup threshold
const KOKORO_SCRIPT = join(process.cwd(), "src", "tts", "kokoro_wrapper.py");

// Ensure cache directory exists
if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true });
}

/**
 * Generate a cache key from text and settings
 */
function generateCacheKey(text: string, settings: TTSSettings): string {
  const input = `${settings.backend}|${text}|${settings.voice}|${settings.speed}|${settings.pitch}`;
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Get cache file path
 */
function getCachePath(cacheKey: string): string {
  return join(CACHE_DIR, `${cacheKey}.wav`);
}

/**
 * Cleanup old cache files using LRU strategy
 * Keeps files under MAX_CACHE_SIZE_MB total
 */
function cleanupCache(): void {
  try {
    if (!existsSync(CACHE_DIR)) return;

    const files = readdirSync(CACHE_DIR)
      .filter((f) => f.endsWith(".wav"))
      .map((fileName) => {
        const filePath = join(CACHE_DIR, fileName);
        const stat = statSync(filePath);
        return { name: fileName, path: filePath, mtime: stat.mtimeMs, size: stat.size };
      })
      .sort((a, b) => a.mtime - b.mtime); // Oldest first

    let totalSize = files.reduce((sum, f) => sum + f.size, 0);
    const maxSizeBytes = MAX_CACHE_SIZE_MB * 1024 * 1024;

    while (totalSize > maxSizeBytes && files.length > 0) {
      const oldest = files.shift()!;
      unlinkSync(oldest.path);
      totalSize -= oldest.size;
      console.log(`[TTS] Cache cleanup: removed ${oldest.name}`);
    }
  } catch (err) {
    console.error("[TTS] Cache cleanup failed:", err);
  }
}

/**
 * Run Kokoro TTS via Python subprocess
 */
async function runKokoro(
  text: string,
  voice: string,
  speed: number,
  _pitch: number
): Promise<{ audio: Buffer; duration: number; sampleRate: number }> {
  const { pythonPath } = await resolveTtsPython("kokoro");

  return new Promise((resolve, reject) => {
    // Note: Kokoro doesn't support pitch control natively
    // Pitch would require ffmpeg post-processing (not yet implemented)
    const args = [
      KOKORO_SCRIPT,
      "--text",
      text,
      "--voice",
      voice,
      "--speed",
      speed.toString(),
    ];

    const proc = spawn(pythonPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrData = "";
    const chunks: Buffer[] = [];

    proc.stdout.on("data", (data) => {
      chunks.push(data);
    });

    proc.stderr.on("data", (data) => {
      stderrData += data.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        // Try to parse error from stderr
        try {
          const lines = stderrData.trim().split("\n");
          const lastLine = lines[lines.length - 1];
          const error = JSON.parse(lastLine);
          reject(new Error(error.error || "TTS generation failed"));
        } catch {
          reject(new Error(stderrData || `TTS process exited with code ${code}`));
        }
        return;
      }

      // Parse metadata from last line of stderr
      let duration = 0;
      let sampleRate = 24000;
      try {
        const lines = stderrData.trim().split("\n");
        for (const line of lines.reverse()) {
          if (line.startsWith("{")) {
            const metadata = JSON.parse(line);
            duration = metadata.duration || 0;
            sampleRate = metadata.sample_rate || 24000;
            break;
          }
        }
      } catch {
        console.warn("[TTS] Could not parse metadata, using defaults");
      }

      const audio = Buffer.concat(chunks);
      resolve({ audio, duration, sampleRate });
    });

    proc.on("error", (err) => {
      // Check if Python interpreter is missing
      if (err.message.includes("ENOENT")) {
        reject(
          new Error(
            `Python interpreter not found at ${pythonPath}. Set KOKORO_TTS_PYTHON_OVERRIDE or repair the Kokoro venv.`
          )
        );
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Generate TTS audio with caching (backend-agnostic)
 */
export async function generateTTS(request: TTSGenerateRequest, settings: TTSSettings = DEFAULT_TTS_SETTINGS): Promise<TTSGenerateResponse> {
  const cacheKey = generateCacheKey(request.text, settings);
  const cachePath = getCachePath(cacheKey);

  // Check cache
  if (existsSync(cachePath)) {
    console.log(`[TTS] Cache hit: ${cacheKey}`);
    const audio = readFileSync(cachePath);
    const stat = statSync(cachePath);
    return {
      audioUrl: `/api/tts/audio/${cacheKey}.wav`,
      duration: stat.size / (24000 * 2),
      fileSize: stat.size,
    };
  }

  console.log(`[TTS] Cache miss: ${cacheKey}, generating with ${settings.backend}...`);

  // Preprocess markdown text for TTS (strip formatting)
  const cleanText = extractTextForTTS(request.text, settings.ttsTextMode);
  console.log(`[TTS] Preprocessed text: ${cleanText.substring(0, 100)}${cleanText.length > 100 ? "..." : ""}`);

  let audio: Buffer;
  let duration: number;

  // Route to appropriate backend
  if (settings.backend === "qwen3-tts") {
    const result = await generateQwen3TTS(request, settings);
    return result; // Qwen3 handles its own caching
  } else if (settings.backend === "supertonic-3") {
    const result = await generateSupertonicTTS(request, settings);
    return result; // Supertonic handles its own caching
  } else {
    // Kokoro backend
    const result = await runKokoro(cleanText, settings.voice, settings.speed, settings.pitch);
    audio = result.audio;
    duration = result.duration;
    
    // Save to cache
    writeFileSync(cachePath, audio);
    console.log(`[TTS] Saved ${cacheKey} (${Math.round(audio.length / 1024)}KB, ${duration.toFixed(2)}s)`);
    
    // Run cleanup
    cleanupCache();
    
    return {
      audioUrl: `/api/tts/audio/${cacheKey}.wav`,
      duration,
      fileSize: audio.length,
    };
  }
}

/**
 * Serve cached audio file (Kokoro backend)
 */
export function getAudioFile(cacheKey: string): Buffer | null {
  const cachePath = getCachePath(cacheKey);
  if (!existsSync(cachePath)) {
    return null;
  }
  return readFileSync(cachePath);
}

/**
 * List available voices from both backends
 */
export function getAvailableVoices(backend: TTSBackend = "kokoro"): Array<{ id: string; name: string; gender: "female" | "male"; accent?: "american" | "british" | "other"; language?: string; description?: string }> {
  if (backend === "qwen3-tts") {
    return getQwen3Voices();
  } else if (backend === "supertonic-3") {
    return getSupertonicVoices();
  } else {
    // Kokoro voices
    return [
      { id: "af_heart", name: "Heart", gender: "female", accent: "american" },
      { id: "af_alloy", name: "Alloy", gender: "female", accent: "american" },
      { id: "af_aoede", name: "Aoede", gender: "female", accent: "american" },
      { id: "af_bella", name: "Bella", gender: "female", accent: "american" },
      { id: "af_jessica", name: "Jessica", gender: "female", accent: "american" },
      { id: "af_kore", name: "Kore", gender: "female", accent: "american" },
      { id: "af_nicole", name: "Nicole", gender: "female", accent: "american" },
      { id: "af_nova", name: "Nova", gender: "female", accent: "american" },
      { id: "af_river", name: "River", gender: "female", accent: "american" },
      { id: "af_sarah", name: "Sarah", gender: "female", accent: "american" },
      { id: "af_sky", name: "Sky", gender: "female", accent: "american" },
      { id: "am_adam", name: "Adam", gender: "male", accent: "american" },
      { id: "am_echo", name: "Echo", gender: "male", accent: "american" },
      { id: "am_eric", name: "Eric", gender: "male", accent: "american" },
      { id: "am_fenrir", name: "Fenrir", gender: "male", accent: "american" },
      { id: "am_liam", name: "Liam", gender: "male", accent: "american" },
      { id: "am_michael", name: "Michael", gender: "male", accent: "american" },
      { id: "am_onyx", name: "Onyx", gender: "male", accent: "american" },
      { id: "am_puck", name: "Puck", gender: "male", accent: "american" },
      { id: "am_santa", name: "Santa", gender: "male", accent: "american" },
      { id: "bf_emma", name: "Emma", gender: "female", accent: "british" },
      { id: "bf_isabella", name: "Isabella", gender: "female", accent: "british" },
      { id: "bm_george", name: "George", gender: "male", accent: "british" },
      { id: "bm_lewis", name: "Lewis", gender: "male", accent: "british" },
    ];
  }
}

export async function checkKokoroAvailability(): Promise<{ available: boolean; error?: string; pythonPath?: string; source?: string }> {
  const status = await getTtsPythonStatus("kokoro");
  return {
    available: status.available,
    error: status.error,
    pythonPath: status.pythonPath,
    source: status.source,
  };
}

/**
 * Group voices by category for UI display
 */
export function groupVoices(voiceIds: Array<{ id: string; name: string; gender: "female" | "male"; accent?: "american" | "british" | "other"; language?: string; description?: string }>): Array<{ label: string; voices: Array<{ id: string; name: string; gender: "female" | "male"; accent?: "american" | "british" | "other"; language?: string; description?: string }> }> {
  // Group by language for Qwen3, by accent for Kokoro
  const hasLanguage = voiceIds.some((v) => "language" in v && v.language);
  
  if (hasLanguage) {
    // Qwen3 grouping by language
    const languages = new Set(voiceIds.map((v) => v.language || "Other"));
    const categories = Array.from(languages).map((lang) => ({
      label: lang,
      voices: voiceIds.filter((v) => (v.language || "Other") === lang).sort((a, b) => a.name.localeCompare(b.name)),
    }));
    return categories;
  } else {
    // Kokoro grouping by accent
    const categories = [
      { label: "American Female", voices: [] as Array<{ id: string; name: string; gender: "female" | "male"; accent?: "american" | "british" | "other"; language?: string; description?: string }> },
      { label: "American Male", voices: [] as Array<{ id: string; name: string; gender: "female" | "male"; accent?: "american" | "british" | "other"; language?: string; description?: string }> },
      { label: "British Female", voices: [] as Array<{ id: string; name: string; gender: "female" | "male"; accent?: "american" | "british" | "other"; language?: string; description?: string }> },
      { label: "British Male", voices: [] as Array<{ id: string; name: string; gender: "female" | "male"; accent?: "american" | "british" | "other"; language?: string; description?: string }> },
      { label: "Other", voices: [] as Array<{ id: string; name: string; gender: "female" | "male"; accent?: "american" | "british" | "other"; language?: string; description?: string }> },
    ];

    for (const voice of voiceIds) {
      const accent = voice.accent || "other";
      const gender = voice.gender;
      let categoryIndex: number;
      if (accent === "american") {
        categoryIndex = gender === "female" ? 0 : 1;
      } else if (accent === "british") {
        categoryIndex = gender === "female" ? 2 : 3;
      } else {
        categoryIndex = 4;
      }
      categories[categoryIndex].voices.push(voice);
    }

    // Sort within each category
    for (const category of categories) {
      category.voices.sort((a, b) => a.name.localeCompare(b.name));
    }

    return categories.filter((c) => c.voices.length > 0);
  }
}

/**
 * Check if Qwen3-TTS is available
 */
export async function checkQwen3TTSInstallation(): Promise<{ available: boolean; error?: string }> {
  return await checkQwen3Availability();
}

/**
 * Check if Supertonic 3 is available
 */
export async function checkSupertonicTTSInstallation(): Promise<{ available: boolean; error?: string }> {
  return await checkSupertonicAvailability();
}
