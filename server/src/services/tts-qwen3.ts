import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { TTSGenerateRequest, TTSGenerateResponse, TTSSettings } from "../types/tts.js";
import { extractTextForTTS } from "./tts-text-preprocessor.js";

const CACHE_DIR = join(process.cwd(), "data", "tts-cache-qwen3");
const MAX_CACHE_SIZE_MB = 500;
const PYTHON_SCRIPT = join(process.cwd(), "src", "tts", "qwen3_wrapper.py");
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
      .sort((a, b) => a.mtime - b.mtime);

    let totalSize = files.reduce((sum, f) => sum + f.size, 0);
    const maxSizeBytes = MAX_CACHE_SIZE_MB * 1024 * 1024;

    while (totalSize > maxSizeBytes && files.length > 0) {
      const oldest = files.shift()!;
      unlinkSync(oldest.path);
      totalSize -= oldest.size;
      console.log(`[TTS-Qwen3] Cache cleanup: removed ${oldest.name}`);
    }
  } catch (err) {
    console.error("[TTS-Qwen3] Cache cleanup failed:", err);
  }
}

/**
 * Run Qwen3-TTS via Python subprocess
 */
async function runQwen3TTS(
  text: string,
  voice: string,
  speed: number,
  _pitch: number,
  instruct?: string
): Promise<{ audio: Buffer; duration: number; sampleRate: number }> {
  return new Promise((resolve, reject) => {
    const args = [
      PYTHON_SCRIPT,
      "--text",
      text,
      "--speaker",
      voice,
      "--speed",
      speed.toString(),
    ];

    if (instruct) {
      args.push("--instruct");
      args.push(instruct);
    }

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
        console.warn("[TTS-Qwen3] Could not parse metadata, using defaults");
      }

      const audio = Buffer.concat(chunks);
      resolve({ audio, duration, sampleRate });
    });

    proc.on("error", (err) => {
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
 * Generate TTS audio with caching (Qwen3-TTS backend)
 */
export async function generateQwen3TTS(request: TTSGenerateRequest, settings: TTSSettings): Promise<TTSGenerateResponse> {
  const cacheKey = generateCacheKey(request.text, settings);
  const cachePath = getCachePath(cacheKey);

  // Check cache
  if (existsSync(cachePath)) {
    console.log(`[TTS-Qwen3] Cache hit: ${cacheKey}`);
    const audio = readFileSync(cachePath);
    const stat = statSync(cachePath);
    return {
      audioUrl: `/api/tts/audio/${cacheKey}.wav`,
      duration: stat.size / (24000 * 2),
      fileSize: stat.size,
    };
  }

  console.log(`[TTS-Qwen3] Cache miss: ${cacheKey}, generating...`);

  // Preprocess markdown text for TTS
  const cleanText = extractTextForTTS(request.text);
  console.log(`[TTS-Qwen3] Preprocessed text: ${cleanText.substring(0, 100)}${cleanText.length > 100 ? "..." : ""}`);

  // Generate audio
  const { audio, duration } = await runQwen3TTS(
    cleanText,
    settings.voice,
    settings.speed,
    settings.pitch,
    settings.backend === "qwen3-tts" ? undefined : undefined
  );

  // Save to cache
  writeFileSync(cachePath, audio);
  console.log(`[TTS-Qwen3] Saved ${cacheKey} (${Math.round(audio.length / 1024)}KB, ${duration.toFixed(2)}s)`);

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
export function getQwen3AudioFile(cacheKey: string): Buffer | null {
  const cachePath = getCachePath(cacheKey);
  if (!existsSync(cachePath)) {
    return null;
  }
  return readFileSync(cachePath);
}

/**
 * List available Qwen3-TTS voices (CustomVoice model presets)
 */
export function getQwen3Voices(): Array<{ id: string; name: string; gender: "female" | "male"; language: string; description: string }> {
  // Qwen3-TTS CustomVoice model presets
  // https://github.com/QwenLM/Qwen3-TTS
  return [
    { id: "Vivian", name: "Vivian", gender: "female", language: "Chinese", description: "Bright, slightly edgy young female voice" },
    { id: "Serena", name: "Serena", gender: "female", language: "Chinese", description: "Warm, gentle young female voice" },
    { id: "Uncle_Fu", name: "Uncle Fu", gender: "male", language: "Chinese", description: "Seasoned male voice with low, mellow timbre" },
    { id: "Dylan", name: "Dylan", gender: "male", language: "Chinese (Beijing)", description: "Youthful Beijing male voice, clear and natural" },
    { id: "Eric", name: "Eric", gender: "male", language: "Chinese (Sichuan)", description: "Lively Chengdu male voice, slightly husky" },
    { id: "Ryan", name: "Ryan", gender: "male", language: "English", description: "Dynamic male voice with strong rhythmic drive" },
    { id: "Aiden", name: "Aiden", gender: "male", language: "English", description: "Sunny American male voice with clear midrange" },
    { id: "Ono_Anna", name: "Ono Anna", gender: "female", language: "Japanese", description: "Playful Japanese female voice, light and nimble" },
    { id: "Sohee", name: "Sohee", gender: "female", language: "Korean", description: "Warm Korean female voice with rich emotion" },
  ];
}

/**
 * Check if Qwen3-TTS is available (Python package installed)
 */
export async function checkQwen3Availability(): Promise<{ available: boolean; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(VENV_PYTHON, ["-c", "import qwen_tts"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ available: true });
      } else {
        resolve({ available: false, error: "qwen_tts package not installed" });
      }
    });

    proc.on("error", () => {
      resolve({ available: false, error: "Python interpreter error" });
    });
  });
}
