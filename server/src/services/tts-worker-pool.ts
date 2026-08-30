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
 *
 * Resilience model:
 *  - initialize() is idempotent under concurrency (memoized init promise),
 *    so a dead/cold worker can never be double-spawned.
 *  - Every init's process handlers are bound to the specific process they
 *    spawned; a stale close event from a superseded process can never
 *    touch the current one.
 *  - A request that exceeds the per-backend timeout is treated as a wedged
 *    worker (the Python loop is sequential, so one stuck request blocks
 *    every later one): the process is killed, pending requests are
 *    rejected, and a fresh worker is respawned. Callers fall back to the
 *    subprocess path in the meantime.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolveTtsPython } from "./tts-python.js";
import { join } from "node:path";
import type { TTSSettings } from "../types/tts.js";

export type TTSWorkerBackend = "supertonic-3" | "kokoro";

const WORKER_SCRIPTS: Record<TTSWorkerBackend, string> = {
  "supertonic-3": join(process.cwd(), "src", "tts", "supertonic_worker.py"),
  "kokoro": join(process.cwd(), "src", "tts", "kokoro_worker.py"),
};

const READY_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS: Record<TTSWorkerBackend, number> = {
  "supertonic-3": 30_000,
  // Kokoro handles full (potentially long) messages through the worker,
  // so allow more headroom than per-chunk Supertonic requests.
  "kokoro": 120_000,
};

interface SupertonicWorkerRequest {
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

interface KokoroWorkerRequest {
  id: number;
  text: string;
  voice: string;
  speed: number;
  pitch: number;
  pitchProcessor: string;
  lang?: string;
}

type WorkerRequest = SupertonicWorkerRequest | KokoroWorkerRequest;

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

export interface TTSWorkerOptions {
  /** Override the worker script path (test seam; defaults to the backend script). */
  scriptPath?: string;
  /** Override the per-request timeout in ms (test seam; defaults per backend). */
  requestTimeoutMs?: number;
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
  private _initPromise: Promise<void> | null = null;
  private _readyResolver: (() => void) | null = null;
  private scriptPath: string | null = null;
  private requestTimeoutMs: number;

  constructor(backend: TTSWorkerBackend, options?: TTSWorkerOptions) {
    this.backend = backend;
    this.scriptPath = options?.scriptPath ?? null;
    this.requestTimeoutMs = options?.requestTimeoutMs ?? REQUEST_TIMEOUT_MS[backend];
  }
  private readonly backend: TTSWorkerBackend;

  /**
   * Spawn (or re-join an in-flight spawn of) the worker process.
   * Safe to call concurrently: all callers share one init promise, so a
   * dead or cold worker is never double-spawned.
   */
  async initialize(): Promise<void> {
    if (this._ready) return;
    if (this._initPromise) return this._initPromise;

    const promise = this.doInitialize();
    this._initPromise = promise;
    try {
      await promise;
    } finally {
      // Clear on settle (success OR failure) so a later initialization —
      // after a crash, reset, or failed init — starts a fresh spawn
      // instead of re-joining a stale promise.
      this._initPromise = null;
    }
  }

  private async doInitialize(): Promise<void> {
    const { pythonPath } = await resolveTtsPython(this.backend);
    this.pythonPath = pythonPath;

    return new Promise<void>((resolve, reject) => {
      if (this.destroyed) {
        reject(new Error("Worker destroyed during initialization"));
        return;
      }

      const proc = spawn(pythonPath, [this.scriptPath ?? WORKER_SCRIPTS[this.backend]], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          MIOPEN_FIND_MODE: "FAST",
        },
      });
      this.proc = proc;

      const readyTimeout = setTimeout(() => {
        fail(new Error(`TTS worker (${this.backend}) did not become ready within ${READY_TIMEOUT_MS / 1000}s`));
      }, READY_TIMEOUT_MS);
      const fail = (err: Error) => {
        clearTimeout(readyTimeout);
        this._readyResolver = null;
        if (this.proc === proc && !proc.killed) {
          proc.kill();
        }
        if (this.proc === proc) {
          this.proc = null;
        }
        reject(err);
      };

      proc.on("error", (err) => {
        if (this.proc === proc) fail(err);
      });

      proc.on("close", (code) => {
        // Superseded: a newer spawn already owns this worker. A stale
        // close from the old process must never reject or kill the new one.
        if (this.proc !== proc) return;
        clearTimeout(readyTimeout);
        if (this.destroyed) {
          // Intentional teardown: destroy() owns cleanup, nothing to report.
          this.proc = null;
          return;
        }
        if (!this._ready) {
          this.proc = null;
          reject(new Error(`TTS worker exited with code ${code}`));
        } else {
          this.handleUnexpectedExit(code);
        }
      });

      // Resolved directly from the ready line in startReading — no polling.
      this._readyResolver = () => {
        clearTimeout(readyTimeout);
        resolve();
      };

      this.startReading(proc);

      proc.stderr?.on("data", (data) => {
        const text = data.toString();
        for (const line of text.split("\n")) {
          if (line.trim()) {
            console.log(`[TTS-Worker:${this.backend}] ${line.trim()}`);
          }
        }
      });
    });
  }

  private startReading(proc: ChildProcess) {
    if (!proc.stdout) return;

    let buffer = "";
    proc.stdout.on("data", (data) => {
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
            // Ignore ready from a superseded process.
            if (this.proc !== proc) continue;
            this._ready = true;
            console.log(`[TTS-Worker:${this.backend}] Worker ready`);
            // Resolve the in-flight init promise immediately (no polling),
            // so `_ready` and the init promise can never disagree.
            this._readyResolver?.();
            this._readyResolver = null;
            // Flush any pending requests that were queued during startup
            this.flushPendingOnReady();
            continue;
          }

          if (resp.pong) continue;

          if (resp.id !== undefined) {
            const pending = this.pending.get(resp.id);
            if (!pending) {
              console.warn(`[TTS-Worker:${this.backend}] Unexpected response id=${resp.id}`);
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
          console.error(`[TTS-Worker:${this.backend}] Failed to parse response: ${line.substring(0, 100)}`, e);
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
    const req: WorkerRequest = this.buildRequest(id, params.text, params.settings);
    const sentToProc = this.proc;

    const result = new Promise<TTSWorkerResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });

      // Auto-timeout per request. A sequential worker that cannot answer
      // within the timeout is wedged for every later request too, so the
      // timeout escalates to a process reset + respawn (below) — the
      // fallback in tts.ts keeps the caller served in the meantime.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`TTS worker request ${id} timed out after ${this.requestTimeoutMs / 1000}s`));

        // Only the worker this request was actually sent to gets replaced;
        // a late timer from an earlier generation must not kill its successor.
        if (!this.destroyed && this.proc === sentToProc) {
          console.warn(`[TTS-Worker:${this.backend}] Request ${id} timed out — resetting wedged worker process`);
          this.resetAfterStall();
          void this.initialize().catch((err) => {
            console.error(`[TTS-Worker:${this.backend}] Respawn after timeout failed:`, err);
          });
        }
      }, this.requestTimeoutMs);

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

  /**
   * Kill the current (wedged) process and return to a cold state.
   * Non-terminal: the worker object is reused and the next initialize()
   * spawns a fresh process. Unlike destroy(), it does not set `destroyed`.
   *
   * SIGKILL directly — a process that ignored a request for the full
   * timeout will not reliably answer SIGTERM (PEP 475: a signal handler
   * cannot wake a blocked readline, and a wedged synthesis never returns
   * to check the shutdown flag). Any ffmpeg child dies on its own when
   * the pipes close.
   */
  private resetAfterStall(): void {
    this._ready = false;
    if (this._drainTimer) {
      clearTimeout(this._drainTimer);
      this._drainTimer = null;
    }
    const proc = this.proc;
    this.proc = null;
    if (proc && !proc.killed) {
      proc.kill("SIGKILL");
    }
    // Reject everything queued behind the wedge so callers fall back
    // immediately instead of waiting out their own timeouts.
    for (const [id, { reject }] of this.pending) {
      reject(new Error(`TTS worker reset after request timeout (request ${id})`));
      this.pending.delete(id);
    }
  }

  private buildRequest(id: number, text: string, settings: TTSSettings): WorkerRequest {
    if (this.backend === "kokoro") {
      return {
        id,
        text,
        voice: settings.voice || "af_heart",
        speed: settings.speed ?? 1.0,
        pitch: settings.pitch ?? 1.0,
        pitchProcessor: settings.kokoroPitchShiftProcessor ?? "resample",
      };
    }
    return {
      id,
      text,
      voice: settings.voice || "M1",
      speed: settings.speed ?? 1.05,
      pitchSemitones: settings.supertonicPitchSemitones ?? 0,
      pitchProcessor: settings.supertonicPitchShiftProcessor ?? "rubberband",
      lang: settings.supertonicLanguage ?? "en",
      steps: settings.supertonicSteps ?? 8,
      maxChunkLength: settings.supertonicMaxChunkLength ?? 300,
      silenceDuration: settings.supertonicSilenceDuration ?? 0.3,
      trailingSilence: settings.supertonicTrailingSilence ?? 0.1,
    };
  }

  private handleUnexpectedExit(code: number | null) {
    console.error(`[TTS-Worker:${this.backend}] Unexpected exit with code ${code}`);
    this._ready = false;
    if (this.proc) {
      this.proc = null;
    }
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
    this._ready = false;
    if (this._drainTimer) clearTimeout(this._drainTimer);
    if (this.proc) {
      this.proc.kill("SIGTERM");
      // unref: this backstop must never hold the event loop open — on a
      // clean shutdown the worker also self-terminates on stdin EOF.
      setTimeout(() => {
        if (!this.proc?.killed) this.proc?.kill("SIGKILL");
      }, 5000).unref();
    }
    for (const [id, { reject }] of this.pending) {
      reject(new Error("Worker destroyed"));
      this.pending.delete(id);
    }
  }
}

// Singleton pool — one worker per backend
const workers = new Map<TTSWorkerBackend, TTSWorker>();

export async function getWorker(backend: string): Promise<TTSWorker> {
  if (backend !== "supertonic-3" && backend !== "kokoro") {
    throw new Error(`Persistent worker not available for backend: ${backend}`);
  }

  let worker = workers.get(backend);
  if (!worker) {
    worker = new TTSWorker(backend);
    workers.set(backend, worker);
  }

  if (!worker.ready) {
    await worker.initialize();
  }

  return worker;
}

export function destroyWorker(backend: TTSWorkerBackend): void {
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
