import type { TTSGenerateRequest, TTSGenerateResponse, TTSSettings, TTSTextMode } from "../types/tts.js";
import { extractTextForTTS, splitIntoSentences } from "./tts-text-preprocessor.js";
import { generateTTS, getAudioFile } from "./tts.js";
import { getQwen3AudioFile } from "./tts-qwen3.js";
import { generateSupertonicTTSDirect } from "./tts-supertonic.js";

export interface TTSStreamedChunk {
  chunkId: string;
  index: number;
  totalChunks: number;
  audioBase64: string;
  duration: number;
  sampleRate: number;
  mimeType: string;
}

export interface TTSChunkPlanOptions {
  firstChunkTargetChars?: number;
  chunkTargetChars?: number;
  hardMaxChars?: number;
  textMode?: TTSTextMode;
}

export interface TTSGeneratedChunk extends TTSGenerateResponse {
  chunkId: string;
  index: number;
  totalChunks: number;
}

const DEFAULT_FIRST_CHUNK_TARGET = 220;
const DEFAULT_CHUNK_TARGET = 520;
const DEFAULT_HARD_MAX = 760;
const BACKEND_CHUNK_DEFAULTS: Partial<Record<TTSSettings["backend"], Required<Pick<TTSChunkPlanOptions, "firstChunkTargetChars" | "chunkTargetChars" | "hardMaxChars">>>> = {
  kokoro: {
    firstChunkTargetChars: 220,
    chunkTargetChars: 560,
    hardMaxChars: 820,
  },
  "supertonic-3": {
    firstChunkTargetChars: 220,
    chunkTargetChars: 520,
    hardMaxChars: 760,
  },
};

function splitLongText(text: string, hardMaxChars: number): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining.length > hardMaxChars) {
    const windowText = remaining.slice(0, hardMaxChars);
    const clauseBreak = Math.max(
      windowText.lastIndexOf("; "),
      windowText.lastIndexOf(": "),
      windowText.lastIndexOf(", "),
      windowText.lastIndexOf(" - "),
    );
    const wordBreak = windowText.lastIndexOf(" ");
    const splitAt = clauseBreak > hardMaxChars * 0.45 ? clauseBreak + 1 : wordBreak > 0 ? wordBreak : hardMaxChars;

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

export function planTTSChunks(text: string, options: TTSChunkPlanOptions = {}): string[] {
  const cleanText = extractTextForTTS(text, options.textMode ?? "stripped");
  if (!cleanText) return [];

  const firstChunkTarget = options.firstChunkTargetChars ?? DEFAULT_FIRST_CHUNK_TARGET;
  const chunkTarget = options.chunkTargetChars ?? DEFAULT_CHUNK_TARGET;
  const hardMax = options.hardMaxChars ?? DEFAULT_HARD_MAX;

  const sentenceCandidates = splitIntoSentences(cleanText).flatMap((sentence) => {
    const trimmed = sentence.trim();
    return trimmed.length > hardMax ? splitLongText(trimmed, hardMax) : [trimmed];
  }).filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentenceCandidates) {
    const target = chunks.length === 0 ? firstChunkTarget : chunkTarget;
    const candidate = current ? `${current} ${sentence}` : sentence;

    if (current && candidate.length > target) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current = candidate;
    }

    if (current.length >= hardMax) {
      chunks.push(current.trim());
      current = "";
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

export async function* generateTTSChunks(
  request: TTSGenerateRequest,
  settings: TTSSettings,
  options: TTSChunkPlanOptions = {},
): AsyncGenerator<TTSGeneratedChunk> {
  const textChunks = planTTSChunks(request.text, chunkPlanOptionsForSettings(settings, options));
  const totalChunks = textChunks.length;

  for (let index = 0; index < totalChunks; index++) {
    const chunkText = textChunks[index];
    const audio = await generateTTS({ ...request, text: chunkText }, settings);
    yield {
      ...audio,
      chunkId: `${index + 1}-${Date.now().toString(36)}`,
      index,
      totalChunks,
    };
  }
}

export function chunkPlanOptionsForSettings(settings: TTSSettings, options: TTSChunkPlanOptions = {}): TTSChunkPlanOptions {
  return {
    ...BACKEND_CHUNK_DEFAULTS[settings.backend],
    textMode: settings.ttsTextMode,
    ...options,
  };
}

/**
 * Generate TTS chunks with inline audio data (base64) instead of URLs.
 * Uses the persistent worker for zero-spawn-overhead generation.
 * Designed for SSE streaming — no disk I/O, audio flows directly to the client.
 */
export async function* generateTTSChunksStreamed(
  request: TTSGenerateRequest,
  settings: TTSSettings,
  options: TTSChunkPlanOptions = {},
): AsyncGenerator<TTSStreamedChunk> {
  const textChunks = planTTSChunks(request.text, chunkPlanOptionsForSettings(settings, options));
  const totalChunks = textChunks.length;

  for (let index = 0; index < totalChunks; index++) {
    const chunkText = textChunks[index];

    if (settings.backend === "supertonic-3") {
      const result = await generateSupertonicTTSDirect(chunkText, settings);
      yield {
        chunkId: `${index + 1}-${Date.now().toString(36)}`,
        index,
        totalChunks,
        audioBase64: result.audioBase64,
        duration: result.duration,
        sampleRate: result.sampleRate,
        mimeType: "audio/wav",
      };
    } else {
      // Fallback: use existing disk-based generation for other backends
      const audio = await generateTTS({ ...request, text: chunkText }, settings);
      const cacheKey = audio.audioUrl.replace("/api/tts/audio/", "").replace(".wav", "");
      const buf = settings.backend === "qwen3-tts"
        ? getQwen3AudioFile(cacheKey)
        : getAudioFile(cacheKey);

      if (buf) {
        yield {
          chunkId: `${index + 1}-${Date.now().toString(36)}`,
          index,
          totalChunks,
          audioBase64: buf.toString("base64"),
          duration: audio.duration,
          sampleRate: 24000,
          mimeType: "audio/wav",
        };
      } else {
        throw new Error(`Generated TTS audio was not found in the ${settings.backend} cache`);
      }
    }
  }
}
