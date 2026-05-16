/**
 * TTS Streaming Service
 * 
 * Generator-based streaming TTS for Qwen3-TTS backend.
 * Streams audio chunks incrementally as tokens arrive from LLM.
 */

import { spawn } from "node:child_process";
import { StreamingTokenBuffer } from "./tts-buffer.js";
import type { TTSBackend, TTSSettings } from "../types/tts.js";

const VENV_PYTHON = process.env.TTS_PYTHON_OVERRIDE || "/home/asa/quje-agent/.venv/bin/python";
const QWEN3_WRAPPER = "/home/asa/quje-agent/server/src/tts/qwen3_wrapper.py";

export interface StreamingTTSOptions extends TTSSettings {
  chunkSize?: number;
  boundaryTier?: 'clause' | 'sentence';
}

/**
 * Stream TTS audio chunks as tokens arrive
 * 
 * This is a generator function that yields WAV buffers incrementally.
 * Each chunk is a complete WAV file with header, suitable for MediaSource API.
 * 
 * @param textStream - Async iterable of tokens from LLM
 * @param options - TTS settings and streaming options
 * @yields Complete WAV buffers (with 44-byte header)
 */
export async function* streamTTS(
  textStream: AsyncIterable<string>,
  options: StreamingTTSOptions
): AsyncGenerator<Buffer> {
  const buffer = new StreamingTokenBuffer({
    minTokens: options.chunkSize ?? 50,
    maxTokens: (options.chunkSize ?? 50) + 30,
    maxChars: 500,
    boundaryTier: options.boundaryTier ?? 'clause',
  });
  
  for await (const token of textStream) {
    buffer.push(token);
    
    const result = buffer.checkBoundary();
    if (result.shouldEmit) {
      const chunkText = result.chunkText;
      buffer.flush();
      
      // Generate audio for this chunk
      const wav = await generateTTSChunk(chunkText, options);
      if (wav) {
        yield wav;
      }
    }
  }
  
  // Flush remaining text
  if (buffer.length > 0) {
    const wav = await generateTTSChunk(buffer.flush(), options);
    if (wav) {
      yield wav;
    }
  }
}

/**
 * Generate TTS audio for a single chunk
 * 
 * Calls qwen3_wrapper.py as subprocess, returns WAV buffer.
 */
async function generateTTSChunk(
  text: string,
  options: StreamingTTSOptions
): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const args = [
      QWEN3_WRAPPER,
      "--text",
      text,
      "--speaker",
      options.voice || "Ryan",
      "--speed",
      options.speed.toString(),
      "--language",
      "English",
    ];
    
    const proc = spawn(VENV_PYTHON, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Pass attention mode if set
        QWEN_TTS_ATTN: options.backend === "qwen3-tts" ? 
          (options as any).attentionMode || "eager" : undefined,
        MIOPEN_FIND_MODE: "FAST", // Performance optimization for ROCm
      },
    });
    
    const chunks: Buffer[] = [];
    let stderrData = "";
    
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
      
      const audio = Buffer.concat(chunks);
      if (audio.length > 0) {
        resolve(audio);
      } else {
        resolve(null);
      }
    });
    
    proc.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Check if streaming is supported for current backend
 */
export function isStreamingCapable(backend: TTSBackend): boolean {
  return backend === "qwen3-tts";
}
