import { createWriteStream, type WriteStream } from "fs";
import { mkdir } from "fs/promises";
import { dirname } from "path";

// ---------------------------------------------------------------------------
// Bounded output capture with spill, for bash capture and (later) any other
// supervised consumer. Reimplements the pi 0.85.1 `OutputCapture` semantics
// (docs/design/pi-1.0-migration.md §3.3) with one addition: a per-file spill
// byte cap, because the spill preserves the full stream and file-count/TTL
// retention does not bound bytes.
//
// Contract:
// - push() may be called from stream 'data' handlers; it never throws.
// - The bounded window is tail-only by default (pi parity); "head" is
//   supported for callers that want the start of the output.
// - Spill starts at the first truncation and includes everything received
//   before it (the pre-truncation prefix). When the stream is backpressured
//   the consumer is asked to pause via onBackpressure(true) and resume on
//   false; data still pushed meanwhile is buffered.
// - After the cap the spill stops, gets a truncation marker, and the snapshot
//   reports capped: true. The capture keeps draining (push stays cheap) so a
//   producer blocked on a full pipe can still be killed.
// - Late pushes after finish()/dispose() are ignored.
// ---------------------------------------------------------------------------

const DEFAULT_EMIT_INTERVAL_MS = 100;
const DEFAULT_SPILL_HIGH_WATER_MARK = 8 * 1024 * 1024;
const INVALID_SHELL_OUTPUT = /[\x00-\x08\x0b-\x1f\ufff9-\ufffb]/g;

export interface CaptureLimits {
  maxBytes: number;
  maxLines: number;
  /** Window side to keep. Default "tail". */
  retain?: "tail" | "head";
}

export interface CaptureTruncation {
  truncated: boolean;
  truncatedBy: "bytes" | "lines" | null;
  totalBytes: number;
  totalLines: number;
  outputBytes: number;
  outputLines: number;
  maxBytes: number;
  maxLines: number;
}

export interface CaptureSnapshot {
  text: string;
  truncation: CaptureTruncation;
  spillPath?: string;
  capped?: boolean;
}

export interface CreateOutputCaptureOptions {
  limits: CaptureLimits;
  spill?: {
    path: string;
    /** Per-file byte cap; writers should pass DEFAULT_SPILL_MAX_BYTES. */
    maxBytes?: number;
    highWaterMark?: number;
  };
  onUpdate?: (view: CaptureSnapshot) => void;
  onBackpressure?: (paused: boolean) => void;
  /** Minimum ms between onUpdate emissions. 0 emits on every push. */
  minEmitIntervalMs?: number;
}

export interface OutputCapture {
  push(chunk: Buffer | string): void;
  snapshot(): CaptureSnapshot;
  finish(): Promise<CaptureSnapshot>;
  dispose(): void;
  readonly truncated: boolean;
  readonly backpressured: boolean;
}

export function createOutputCapture(options: CreateOutputCaptureOptions): OutputCapture {
  const maxBytes = options.limits.maxBytes;
  const maxLines = options.limits.maxLines;
  const retain = options.limits.retain ?? "tail";
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new TypeError("Output maxBytes must be a positive finite number");
  }
  if (!Number.isInteger(maxLines) || maxLines <= 0) {
    throw new TypeError("Output maxLines must be a positive integer");
  }
  const minEmitIntervalMs = options.minEmitIntervalMs ?? DEFAULT_EMIT_INTERVAL_MS;

  const decoder = new TextDecoder();
  let buffer = "";
  let bufferBytes = 0;
  let totalBytes = 0;
  let newlines = 0;
  let endsWithNewline = true;
  let disposed = false;
  let finished = false;

  const spillPath = options.spill?.path;
  const spillMaxBytes = options.spill?.maxBytes ?? Number.POSITIVE_INFINITY;
  const spillHighWaterMark = options.spill?.highWaterMark ?? DEFAULT_SPILL_HIGH_WATER_MARK;
  let spillStream: WriteStream | null = null;
  let spillReady = false;
  let spillStarted = false;
  let spillCapped = false;
  let spillFailed = false;
  let spillBytes = 0;
  let spillBackpressured = false;
  let spillStartPromise: Promise<void> | null = null;
  let spillFinishPromise: Promise<void> | null = null;
  const prefixChunks: Buffer[] = [];
  const pendingChunks: Buffer[] = [];

  let lastEmitAt = 0;
  let emitTimer: NodeJS.Timeout | null = null;

  function totalLines(): number {
    return newlines + (endsWithNewline || totalBytes === 0 ? 0 : 1);
  }

  function truncated(): boolean {
    return totalBytes > maxBytes || totalLines() > maxLines;
  }

  function appendText(text: string): void {
    if (text === "") return;
    const textBytes = Buffer.byteLength(text, "utf8");
    totalBytes += textBytes;
    newlines += countNewlines(text);
    endsWithNewline = text.endsWith("\n");
    buffer += text;
    bufferBytes += textBytes;
    // Lazy guard trim: snapshot() does the precise windowing; this only bounds
    // memory between snapshots.
    const guard = maxBytes * 4;
    if (bufferBytes > guard) {
      buffer = trimToBytes(buffer, maxBytes * 2, retain);
      bufferBytes = Buffer.byteLength(buffer, "utf8");
    }
  }

  function maybeSpill(raw: Buffer): void {
    if (!spillPath || spillFailed) return;
    if (!spillStarted) {
      if (truncated()) {
        spillStarted = true;
        const chunks = [...prefixChunks, raw];
        prefixChunks.length = 0;
        startSpill(chunks);
      } else {
        prefixChunks.push(raw);
      }
      return;
    }
    writeSpill(raw);
  }

  function startSpill(chunks: Buffer[]): void {
    spillStartPromise = (async () => {
      try {
        await mkdir(dirname(spillPath!), { recursive: true, mode: 0o700 });
        spillStream = createWriteStream(spillPath!, { flags: "w", highWaterMark: spillHighWaterMark });
        spillStream.on("error", onSpillError);
        spillStream.on("drain", onSpillDrain);
        spillReady = true;
        for (const chunk of chunks) writeSpill(chunk);
        for (const chunk of pendingChunks.splice(0)) writeSpill(chunk);
      } catch (error) {
        onSpillError(error);
      }
    })();
  }

  function writeSpill(chunk: Buffer): void {
    if (spillFailed || spillCapped || chunk.length === 0) return;
    if (!spillReady || !spillStream) {
      pendingChunks.push(chunk);
      return;
    }
    const remaining = spillMaxBytes - spillBytes;
    if (remaining <= 0) {
      capSpill();
      return;
    }
    let toWrite = chunk;
    if (chunk.length > remaining) {
      toWrite = chunk.subarray(0, remaining);
      capSpill();
    }
    spillBytes += toWrite.length;
    if (!spillStream.write(toWrite) && !spillBackpressured) {
      spillBackpressured = true;
      options.onBackpressure?.(true);
    }
  }

  function capSpill(): void {
    spillCapped = true;
    if (spillBackpressured) {
      spillBackpressured = false;
      options.onBackpressure?.(false);
    }
  }

  function onSpillDrain(): void {
    if (!spillBackpressured) return;
    spillBackpressured = false;
    options.onBackpressure?.(false);
  }

  function onSpillError(error: unknown): void {
    if (spillFailed) return;
    spillFailed = true;
    console.warn(
      `[output-capture] spill write failed for ${spillPath}:`,
      error instanceof Error ? error.message : error,
    );
    if (spillBackpressured) {
      spillBackpressured = false;
      options.onBackpressure?.(false);
    }
    spillStream?.destroy();
    spillStream = null;
  }

  function endSpillStream(): Promise<void> {
    if (!spillStream) return Promise.resolve();
    if (spillFinishPromise) return spillFinishPromise;
    const stream = spillStream;
    spillFinishPromise = new Promise<void>((resolve) => {
      stream.once("error", () => resolve());
      stream.once("finish", () => resolve());
      stream.end();
    });
    return spillFinishPromise;
  }

  function scheduleEmit(): void {
    if (!options.onUpdate || disposed) return;
    if (minEmitIntervalMs <= 0) {
      emitNow();
      return;
    }
    const elapsed = Date.now() - lastEmitAt;
    if (elapsed >= minEmitIntervalMs) {
      emitNow();
      return;
    }
    if (!emitTimer) {
      emitTimer = setTimeout(() => {
        emitTimer = null;
        emitNow();
      }, minEmitIntervalMs - elapsed);
      emitTimer.unref?.();
    }
  }

  function emitNow(): void {
    if (disposed) return;
    lastEmitAt = Date.now();
    options.onUpdate?.(snapshot());
  }

  function snapshot(): CaptureSnapshot {
    const window = truncateToWindow(buffer, { maxBytes, maxLines, retain });
    const result: CaptureSnapshot = {
      text: sanitizeShellOutput(window.content),
      truncation: {
        truncated: window.truncated,
        truncatedBy: window.truncatedBy,
        totalBytes,
        totalLines: totalLines(),
        outputBytes: window.outputBytes,
        outputLines: window.outputLines,
        maxBytes,
        maxLines,
      },
    };
    if (spillPath && spillStarted && !spillFailed) {
      result.spillPath = spillPath;
      if (spillCapped) result.capped = true;
    }
    return result;
  }

  function push(chunk: Buffer | string): void {
    if (disposed || finished) return;
    if (typeof chunk === "string") {
      appendText(decoder.decode());
      appendText(chunk);
      maybeSpill(Buffer.from(chunk, "utf8"));
    } else {
      appendText(decoder.decode(chunk, { stream: true }));
      maybeSpill(chunk);
    }
    scheduleEmit();
  }

  async function finish(): Promise<CaptureSnapshot> {
    if (disposed) return snapshot();
    if (!finished) {
      finished = true;
      appendText(decoder.decode());
      if (spillStarted && spillPath && !spillFailed) {
        await spillStartPromise;
        if (spillStream && spillCapped) {
          spillStream.write(
            `\n\n[spill capped at ${formatCapLabel(spillMaxBytes)} — later output not captured]\n`,
          );
        }
        await endSpillStream();
      }
      if (emitTimer) {
        clearTimeout(emitTimer);
        emitTimer = null;
      }
      emitNow();
    }
    return snapshot();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (emitTimer) {
      clearTimeout(emitTimer);
      emitTimer = null;
    }
    spillStream?.destroy();
    spillStream = null;
  }

  return {
    push,
    snapshot,
    finish,
    dispose,
    get truncated() {
      return truncated();
    },
    get backpressured() {
      return spillBackpressured;
    },
  };
}

/** Strip control bytes that corrupt terminal/tool output (pi parity). */
export function sanitizeShellOutput(text: string): string {
  return text.replace(INVALID_SHELL_OUTPUT, "");
}

export function formatCapLabel(bytes: number): string {
  if (!Number.isFinite(bytes)) return "the configured cap";
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function countNewlines(text: string): number {
  let count = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    count++;
  }
  return count;
}

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

function trimToBytes(text: string, maxBytes: number, retain: "tail" | "head"): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  if (retain === "head") {
    let end = maxBytes;
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
    return bytes.subarray(0, end).toString("utf8");
  }
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

interface WindowResult {
  content: string;
  truncated: boolean;
  truncatedBy: "bytes" | "lines" | null;
  outputBytes: number;
  outputLines: number;
}

function truncateToWindow(
  content: string,
  limits: { maxBytes: number; maxLines: number; retain: "tail" | "head" },
): WindowResult {
  const contentBytes = Buffer.byteLength(content, "utf8");
  const lines = splitLines(content);
  const lineCount = lines.length;
  if (contentBytes <= limits.maxBytes && lineCount <= limits.maxLines) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      outputBytes: contentBytes,
      outputLines: lineCount,
    };
  }

  if (limits.retain === "head") {
    if (lineCount > 0 && Buffer.byteLength(lines[0]!, "utf8") > limits.maxBytes) {
      return { content: "", truncated: true, truncatedBy: "bytes", outputBytes: 0, outputLines: 0 };
    }
    const kept: string[] = [];
    let bytes = 0;
    let truncatedBy: "bytes" | "lines" = "lines";
    for (let i = 0; i < lines.length && i < limits.maxLines; i++) {
      const lineBytes = Buffer.byteLength(lines[i]!, "utf8") + (i > 0 ? 1 : 0);
      if (bytes + lineBytes > limits.maxBytes) {
        truncatedBy = "bytes";
        break;
      }
      kept.push(lines[i]!);
      bytes += lineBytes;
    }
    if (kept.length >= limits.maxLines && bytes <= limits.maxBytes) truncatedBy = "lines";
    const out = kept.join("\n");
    return {
      content: out,
      truncated: true,
      truncatedBy,
      outputBytes: Buffer.byteLength(out, "utf8"),
      outputLines: kept.length,
    };
  }

  const kept: string[] = [];
  let bytes = 0;
  let truncatedBy: "bytes" | "lines" = "lines";
  for (let i = lines.length - 1; i >= 0 && kept.length < limits.maxLines; i--) {
    const lineBytes = Buffer.byteLength(lines[i]!, "utf8") + (kept.length > 0 ? 1 : 0);
    if (bytes + lineBytes > limits.maxBytes) {
      truncatedBy = "bytes";
      if (kept.length === 0) {
        const partial = trimToBytes(lines[i]!, limits.maxBytes, "tail");
        kept.unshift(partial);
        bytes = Buffer.byteLength(partial, "utf8");
      }
      break;
    }
    kept.unshift(lines[i]!);
    bytes += lineBytes;
  }
  if (kept.length >= limits.maxLines && bytes <= limits.maxBytes) truncatedBy = "lines";
  const out = kept.join("\n");
  return {
    content: out,
    truncated: true,
    truncatedBy,
    outputBytes: Buffer.byteLength(out, "utf8"),
    outputLines: kept.length,
  };
}
