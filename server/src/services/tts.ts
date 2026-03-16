import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { TTSGenerateRequest, TTSGenerateResponse, TTSSettings } from "../types/tts.js";
import { DEFAULT_TTS_SETTINGS } from "../types/tts.js";
import { extractTextForTTS } from "./tts-text-preprocessor.js";

const CACHE_DIR = join(process.cwd(), "data", "tts-cache");
const MAX_CACHE_SIZE_MB = 500; // LRU cleanup threshold
const PYTHON_SCRIPT = join(process.cwd(), "src", "tts", "kokoro_wrapper.py");
const VENV_PYTHON = process.env.TTS_PYTHON_OVERRIDE || join(process.cwd(), ".venv", "bin", "python");

// Ensure cache directory exists
if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true });
}

/**
 * Generate a cache key from text and settings
 */
function generateCacheKey(text: string, settings: TTSSettings): string {
  const input = `${text}|${settings.voice}|${settings.speed}|${settings.pitch}`;
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
  return new Promise((resolve, reject) => {
    // Note: Kokoro doesn't support pitch control natively
    // Pitch would require ffmpeg post-processing (not yet implemented)
    const args = [
      PYTHON_SCRIPT,
      "--text",
      text,
      "--voice",
      voice,
      "--speed",
      speed.toString(),
    ];

    const proc = spawn(VENV_PYTHON, args, {
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
            `Python interpreter not found at ${VENV_PYTHON}. Set TTS_PYTHON_OVERRIDE env var or create a venv.`
          )
        );
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Generate TTS audio with caching
 */
export async function generateTTS(request: TTSGenerateRequest): Promise<TTSGenerateResponse> {
  const settings: TTSSettings = {
    ...DEFAULT_TTS_SETTINGS,
    voice: request.voice ?? DEFAULT_TTS_SETTINGS.voice,
    speed: request.speed ?? DEFAULT_TTS_SETTINGS.speed,
    // Note: pitch is stored in settings for future use, but not currently sent to Kokoro
    pitch: request.pitch ?? DEFAULT_TTS_SETTINGS.pitch,
  };

  const cacheKey = generateCacheKey(request.text, settings);
  const cachePath = getCachePath(cacheKey);

  // Check cache
  if (existsSync(cachePath)) {
    console.log(`[TTS] Cache hit: ${cacheKey}`);
    const audio = readFileSync(cachePath);
    const stat = statSync(cachePath);
    return {
      audioUrl: `/api/tts/audio/${cacheKey}.wav`,
      duration: stat.size / (24000 * 2), // Approximate duration from size
      fileSize: stat.size,
    };
  }

  console.log(`[TTS] Cache miss: ${cacheKey}, generating...`);

  // Preprocess markdown text for TTS (strip formatting)
  const cleanText = extractTextForTTS(request.text);
  console.log(`[TTS] Preprocessed text: ${cleanText.substring(0, 100)}${cleanText.length > 100 ? "..." : ""}`);

  // Generate audio
  const { audio, duration } = await runKokoro(cleanText, settings.voice, settings.speed, settings.pitch);

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

/**
 * Serve cached audio file
 */
export function getAudioFile(cacheKey: string): Buffer | null {
  const cachePath = getCachePath(cacheKey);
  if (!existsSync(cachePath)) {
    return null;
  }
  return readFileSync(cachePath);
}

/**
 * List available Kokoro voices
 * For now, return a hardcoded list based on Kokoro's defaults
 */
export function getAvailableVoices(): string[] {
  // These are the standard Kokoro voices
  // In the future, we could query the model dynamically
  return [
    "af_heart",
    "af_alloy",
    "af_aoede",
    "af_bella",
    "af_jessica",
    "af_kore",
    "af_nicole",
    "af_nova",
    "af_river",
    "af_sarah",
    "af_sky",
    "am_adam",
    "am_echo",
    "am_eric",
    "am_fenrir",
    "am_liam",
    "am_michael",
    "am_onyx",
    "am_puck",
    "am_santa",
    "bf_emma",
    "bf_isabella",
    "bm_george",
    "bm_lewis",
  ];
}

/**
 * Parse voice ID into display info
 */
export function parseVoiceId(id: string): { id: string; name: string; gender: "female" | "male"; accent: "american" | "british" | "other" } {
  const parts = id.split("_");
  if (parts.length < 2) {
    return { id, name: id, gender: "female", accent: "other" };
  }

  const [prefix, ...nameParts] = parts;
  const name = nameParts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");

  const accentChar = prefix.charAt(0).toLowerCase();
  const genderChar = prefix.charAt(1).toLowerCase();

  const accent = accentChar === "a" ? "american" : accentChar === "b" ? "british" : "other";
  const gender = genderChar === "m" ? "male" : "female";

  return { id, name, gender, accent };
}

/**
 * Group voices by category for UI display
 */
export function groupVoices(voiceIds: string[]): Array<{ label: string; voices: ReturnType<typeof parseVoiceId>[] }> {
  const categories = [
    { label: "American Female", voices: [] as ReturnType<typeof parseVoiceId>[] },
    { label: "American Male", voices: [] as ReturnType<typeof parseVoiceId>[] },
    { label: "British Female", voices: [] as ReturnType<typeof parseVoiceId>[] },
    { label: "British Male", voices: [] as ReturnType<typeof parseVoiceId>[] },
    { label: "Other", voices: [] as ReturnType<typeof parseVoiceId>[] },
  ];

  for (const id of voiceIds) {
    const info = parseVoiceId(id);
    let categoryIndex: number;
    if (info.accent === "american") {
      categoryIndex = info.gender === "female" ? 0 : 1;
    } else if (info.accent === "british") {
      categoryIndex = info.gender === "female" ? 2 : 3;
    } else {
      categoryIndex = 4;
    }
    categories[categoryIndex].voices.push(info);
  }

  // Sort within each category
  for (const category of categories) {
    category.voices.sort((a, b) => a.name.localeCompare(b.name));
  }

  return categories.filter((c) => c.voices.length > 0);
}
