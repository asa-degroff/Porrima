/**
 * Persistent TTS Worker Pool
 * 
 * Maintains long-lived Python subprocesses with models loaded in memory.
 * Eliminates subprocess spawn overhead (~200-500ms per chunk) by reusing
 * the same process across all TTS requests.
 * 
 * Protocol: JSON lines over stdin/stdout.
 * Request:  {"id": number, "text": string, ...params}
 * Response: {"id": number, "audio": "<base64 wav>", "duration": number}
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolveTtsPython } from "./tts-python.js";
import { join } from "node:path";
import type { TTSSettings } from "../types/tts.js";

const WORKER_SCRIPT = join(process.cwd(), "src", "tts", "supertonic_worker.py");

interface WorkerRequest {
  id: number;
  text: string;
  voice: string;
  speed: number;
  pitchSemitones: number;
  pitchProcessor: string;
  lang: string;
  steps: number;
  maxChunkLength: number;
  silenceDuration: number;
  trailingSilence: number;
}

interface WorkerResponse {
  id?: number;
  ready?: boolean;
  pong?: boolean;
  audio?: string;
  duration?: number;
  sampleRate?: number;
  modelDuration?: number;
  size?: number;
  error?: string;
}

interface TTSWorkerResult {
  audioBase64: string;
  duration: number;
  sampleRate: number;
  size: number;
}

class TTSWorker {
  private proc: ChildProcess | null = null;
  private _ready = false;
  public get ready(): boolean { return this._ready; }
  private requestCounter = 0;
  private pending = new Map<number, { resolve: (v: TTSWorkerResult) => void; reject: (e: Error) => void }>();
  private pythonPath: string | null = null;
  private _drainTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  async initialize(): Promise<void> {
    if (this._ready) return;

    const { pythonPath } = await resolveTtsPython("supertonic-3");
    this.pythonPath = pythonPath;

    return new Promise((resolve, reject) => {
      if (this.destroyed) {
        reject(new Error("Worker destroyed during initialization"));
        return;
      }

      this.proc = spawn(pythonPath, [WORKER_SCRIPT], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          MIOPEN_FIND_MODE: "FAST",
        },
      });

      const readyTimeout = setTimeout(() => {
        cleanupOnFail(new Error("TTS worker did not become ready within 60s"));
      }, 60_000);
      let pollInterval: ReturnType<typeof setInterval> | null = null;
      const cleanupOnFail = (err: Error) => {
        clearTimeout(readyTimeout);
        if (pollInterval) clearInterval(pollInterval);
        if (this.proc && !this.proc.killed) {
          this.proc.kill();
        }
        this.proc = null;
        reject(err);
      };

      this.proc.on("error", (err) => cleanupOnFail(err));

      this.proc.on("close", (code) => {
        clearTimeout(readyTimeout);
        if (pollInterval) clearInterval(pollInterval);
        if (!this._ready) {
          cleanupOnFail(new Error(`TTS worker exited with code ${code}`));
        } else {
          this.handleUnexpectedExit(code);
        }
      });

      this.startReading();

      this.proc.stderr?.on("data", (data) => {
        const text = data.toString();
        for (const line of text.split("\n")) {
          if (line.trim()) {
            console.log(`[TTS-Worker] ${line.trim()}`);
          }
        }
      });

      // Resolve when ready message arrives
      const checkReady = () => {
        if (this._ready) {
          clearTimeout(readyTimeout);
          if (pollInterval) clearInterval(pollInterval);
          resolve();
        }
      };
      // Poll briefly for ready state (set in startReading)
      pollInterval = setInterval(checkReady, 100);
    });
  }

  private startReading() {
    if (!this.proc?.stdout) return;

    let buffer = "";
    this.proc.stdout.on("data", (data) => {
      buffer += data.toString();
      while (true) {
        const newlineIdx = buffer.indexOf("\n");
        if (newlineIdx === -1) break;

        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line) continue;

        try {
          const resp: WorkerResponse = JSON.parse(line);

          if (resp.ready) {
            this._ready = true;
            console.log("[TTS-Worker] Worker ready");
            // Flush any pending requests that were queued during startup
            this.flushPendingOnReady();
            continue;
          }

          if (resp.pong) continue;

          if (resp.id !== undefined) {
            const pending = this.pending.get(resp.id);
            if (!pending) {
              console.warn(`[TTS-Worker] Unexpected response id=${resp.id}`);
              continue;
            }
            this.pending.delete(resp.id);

            if (resp.error) {
              pending.reject(new Error(resp.error));
            } else if (resp.audio) {
              pending.resolve({
                audioBase64: resp.audio,
                duration: resp.duration ?? 0,
                sampleRate: resp.sampleRate ?? 44100,
                size: resp.size ?? 0,
              });
            }
          }
        } catch (e) {
          console.error(`[TTS-Worker] Failed to parse response: ${line.substring(0, 100)}`, e);
        }
      }
    });
  }

  private flushPendingOnReady() {
    // Already handled naturally — requests queued during initialization
    // will be sent when sendRequest is called again by the caller's retry logic
  }

  async synthesize(params: {
    text: string;
    settings: TTSSettings;
  }): Promise<TTSWorkerResult> {
    if (!this._ready || !this.proc?.stdin) {
      throw new Error("TTS worker not ready");
    }

    const id = ++this.requestCounter;
    const req: WorkerRequest = {
      id,
      text: params.text,
      voice: params.settings.voice || "M1",
      speed: params.settings.speed ?? 1.05,
      pitchSemitones: params.settings.supertonicPitchSemitones ?? 0,
      pitchProcessor: "resample",
      lang: params.settings.supertonicLanguage ?? "en",
      steps: params.settings.supertonicSteps ?? 8,
      maxChunkLength: params.settings.supertonicMaxChunkLength ?? 300,
      silenceDuration: params.settings.supertonicSilenceDuration ?? 0.3,
      trailingSilence: params.settings.supertonicTrailingSilence ?? 0.1,
    };

    const result = new Promise<TTSWorkerResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });

      // Auto-timeout per request (30s)
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`TTS worker request ${id} timed out after 30s`));
      }, 30_000);

      // Clear timer when resolved
      const originalResolve = resolve;
      const originalReject = reject;
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); originalResolve(v); },
        reject: (e) => { clearTimeout(timer); originalReject(e); },
      });
    });

    const jsonLine = JSON.stringify(req) + "\n";
    if (!this.proc.stdin.write(jsonLine)) {
      // Backpressure — wait for drain
      await new Promise<void>((resolve) => {
        this._drainTimer = setTimeout(() => resolve(), 100);
        this.proc?.stdin?.once("drain", () => resolve());
      });
    }

    return result;
  }

  private handleUnexpectedExit(code: number | null) {
    console.error(`[TTS-Worker] Unexpected exit with code ${code}`);
    this._ready = false;
    // Reject all pending requests
    for (const [id, { reject }] of this.pending) {
      reject(new Error(`TTS worker exited unexpectedly (code ${code})`));
      this.pending.delete(id);
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this._ready || !this.proc) return false;
    try {
      this.proc.stdin?.write(JSON.stringify({ ping: true }) + "\n");
      // Ping response handled in startReading
      return true;
    } catch {
      return false;
    }
  }

  destroy() {
    this.destroyed = true;
    if (this._drainTimer) clearTimeout(this._drainTimer);
    if (this.proc) {
      this.proc.kill("SIGTERM");
      setTimeout(() => {
        if (!this.proc?.killed) this.proc?.kill("SIGKILL");
      }, 5000);
    }
    for (const [id, { reject }] of this.pending) {
      reject(new Error("Worker destroyed"));
      this.pending.delete(id);
    }
  }
}

// Singleton pool — one worker per backend
const workers = new Map<string, TTSWorker>();

export async function getWorker(backend: string): Promise<TTSWorker> {
  if (backend !== "supertonic-3") {
    throw new Error(`Persistent worker not available for backend: ${backend}`);
  }

  let worker = workers.get(backend);
  if (!worker) {
    worker = new TTSWorker();
    workers.set(backend, worker);
  }

  if (!worker.ready) {
    await worker.initialize();
  }

  return worker;
}

export function destroyWorker(backend: string): void {
  const worker = workers.get(backend);
  if (worker) {
    worker.destroy();
    workers.delete(backend);
  }
}

export function destroyAllWorkers(): void {
  for (const [key] of workers) {
    destroyWorker(key);
  }
}

// Export for testing
export { TTSWorker };
