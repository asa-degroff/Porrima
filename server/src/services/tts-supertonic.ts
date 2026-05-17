import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { TTSGenerateRequest, TTSGenerateResponse, TTSSettings } from "../types/tts.js";
import { extractTextForTTS } from "./tts-text-preprocessor.js";

const CACHE_DIR = join(process.cwd(), "data", "tts-cache-supertonic");
const MAX_CACHE_SIZE_MB = 500;
const PYTHON_SCRIPT = join(process.cwd(), "src", "tts", "supertonic_wrapper.py");
const VENV_PYTHON = process.env.TTS_PYTHON_OVERRIDE || join(process.cwd(), "..", ".venv", "bin", "python");
const SAMPLE_RATE = 44100;

if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true });
}

function pitchSemitonesToRatio(semitones: number): number {
  return Math.pow(2, semitones / 12);
}

function generateCacheKey(text: string, settings: TTSSettings): string {
  const input = [
    "supertonic-3-v5",
    text,
    settings.voice,
    settings.speed,
    settings.supertonicPitchSemitones,
    settings.supertonicLanguage,
    settings.supertonicSteps,
    settings.supertonicMaxChunkLength,
    settings.supertonicSilenceDuration,
    settings.supertonicTrailingSilence,
  ].join("|");
  return createHash("sha256").update(input).digest("hex");
}

function getCachePath(cacheKey: string): string {
  return join(CACHE_DIR, `${cacheKey}.wav`);
}

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
      console.log(`[TTS-Supertonic] Cache cleanup: removed ${oldest.name}`);
    }
  } catch (err) {
    console.error("[TTS-Supertonic] Cache cleanup failed:", err);
  }
}

function getWavDuration(audio: Buffer): number {
  if (audio.length < 44 || audio.toString("ascii", 0, 4) !== "RIFF") {
    return audio.length / (SAMPLE_RATE * 2);
  }

  const channels = audio.readUInt16LE(22) || 1;
  const sampleRate = audio.readUInt32LE(24) || SAMPLE_RATE;
  const bitsPerSample = audio.readUInt16LE(34) || 16;
  const bytesPerSample = bitsPerSample / 8;
  let offset = 12;

  while (offset + 8 <= audio.length) {
    const chunkId = audio.toString("ascii", offset, offset + 4);
    const chunkSize = audio.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      return chunkSize / (sampleRate * channels * bytesPerSample);
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }

  return audio.length / (sampleRate * channels * bytesPerSample);
}

async function runSupertonicTTS(
  text: string,
  settings: TTSSettings
): Promise<{ audio: Buffer; duration: number; sampleRate: number }> {
  return new Promise((resolve, reject) => {
    const pitchRatio = pitchSemitonesToRatio(settings.supertonicPitchSemitones);
    const args = [
      PYTHON_SCRIPT,
      "--text",
      text,
      "--voice",
      settings.voice,
      "--speed",
      settings.speed.toString(),
      "--pitch",
      pitchRatio.toFixed(6),
      "--lang",
      settings.supertonicLanguage,
      "--steps",
      settings.supertonicSteps.toString(),
      "--max-chunk-length",
      settings.supertonicMaxChunkLength.toString(),
      "--silence-duration",
      settings.supertonicSilenceDuration.toString(),
      "--trailing-silence",
      settings.supertonicTrailingSilence.toString(),
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
        try {
          const lines = stderrData.trim().split("\n");
          const lastLine = lines[lines.length - 1];
          const error = JSON.parse(lastLine);
          reject(new Error(error.error || "Supertonic TTS generation failed"));
        } catch {
          reject(new Error(stderrData || `Supertonic TTS process exited with code ${code}`));
        }
        return;
      }

      let duration = 0;
      let sampleRate = SAMPLE_RATE;
      try {
        const lines = stderrData.trim().split("\n");
        for (const line of lines.reverse()) {
          if (line.startsWith("{")) {
            const metadata = JSON.parse(line);
            duration = metadata.duration || 0;
            sampleRate = metadata.sample_rate || SAMPLE_RATE;
            break;
          }
        }
      } catch {
        console.warn("[TTS-Supertonic] Could not parse metadata, using WAV header");
      }

      const audio = Buffer.concat(chunks);
      resolve({ audio, duration: duration || getWavDuration(audio), sampleRate });
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

export async function generateSupertonicTTS(request: TTSGenerateRequest, settings: TTSSettings): Promise<TTSGenerateResponse> {
  const cacheKey = generateCacheKey(request.text, settings);
  const cachePath = getCachePath(cacheKey);

  if (existsSync(cachePath)) {
    console.log(`[TTS-Supertonic] Cache hit: ${cacheKey}`);
    const audio = readFileSync(cachePath);
    return {
      audioUrl: `/api/tts/audio/${cacheKey}.wav`,
      duration: getWavDuration(audio),
      fileSize: audio.length,
    };
  }

  console.log(`[TTS-Supertonic] Cache miss: ${cacheKey}, generating...`);

  const cleanText = extractTextForTTS(request.text);
  console.log(`[TTS-Supertonic] Preprocessed text: ${cleanText.substring(0, 100)}${cleanText.length > 100 ? "..." : ""}`);

  const { audio, duration } = await runSupertonicTTS(cleanText, settings);

  writeFileSync(cachePath, audio);
  console.log(`[TTS-Supertonic] Saved ${cacheKey} (${Math.round(audio.length / 1024)}KB, ${duration.toFixed(2)}s)`);

  cleanupCache();

  return {
    audioUrl: `/api/tts/audio/${cacheKey}.wav`,
    duration,
    fileSize: audio.length,
  };
}

export function getSupertonicAudioFile(cacheKey: string): Buffer | null {
  const cachePath = getCachePath(cacheKey);
  if (!existsSync(cachePath)) {
    return null;
  }
  return readFileSync(cachePath);
}

export function getSupertonicVoices(): Array<{ id: string; name: string; gender: "female" | "male"; language: string; description: string }> {
  return [
    { id: "M1", name: "M1", gender: "male", language: "Multilingual", description: "Lively, upbeat male voice with confident energy" },
    { id: "M2", name: "M2", gender: "male", language: "Multilingual", description: "Deep, robust male voice with calm, serious presence" },
    { id: "M3", name: "M3", gender: "male", language: "Multilingual", description: "Polished, authoritative male voice" },
    { id: "M4", name: "M4", gender: "male", language: "Multilingual", description: "Soft, neutral-toned male voice" },
    { id: "M5", name: "M5", gender: "male", language: "Multilingual", description: "Warm, soft-spoken male storytelling voice" },
    { id: "F1", name: "F1", gender: "female", language: "Multilingual", description: "Calm female voice with a steady, composed tone" },
    { id: "F2", name: "F2", gender: "female", language: "Multilingual", description: "Bright, cheerful female voice" },
    { id: "F3", name: "F3", gender: "female", language: "Multilingual", description: "Clear, professional announcer-style female voice" },
    { id: "F4", name: "F4", gender: "female", language: "Multilingual", description: "Crisp, confident female voice" },
    { id: "F5", name: "F5", gender: "female", language: "Multilingual", description: "Kind, gentle female voice" },
  ];
}

export async function checkSupertonicAvailability(): Promise<{ available: boolean; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(VENV_PYTHON, ["-c", "import supertonic, soundfile, numpy"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ available: true });
      } else {
        resolve({ available: false, error: "supertonic package not installed" });
      }
    });

    proc.on("error", () => {
      resolve({ available: false, error: "Python interpreter error" });
    });
  });
}
