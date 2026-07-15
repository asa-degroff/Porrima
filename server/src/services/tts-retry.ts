export const DEFAULT_TTS_CHUNK_MAX_ATTEMPTS = 3;
export const DEFAULT_TTS_CHUNK_RETRY_DELAY_MS = 200;

export interface TTSChunkRetryContext {
  backend: string;
  index: number;
  totalChunks?: number;
  textLength: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

export class TTSChunkGenerationError extends Error {
  readonly backend: string;
  readonly index: number;
  readonly totalChunks?: number;
  readonly attempts: number;
  readonly textLength: number;

  constructor(
    message: string,
    context: TTSChunkRetryContext,
    attempts: number,
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = "TTSChunkGenerationError";
    this.backend = context.backend;
    this.index = context.index;
    this.totalChunks = context.totalChunks;
    this.attempts = attempts;
    this.textLength = context.textLength;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wait(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function withTTSChunkRetry<T>(
  generate: () => Promise<T>,
  context: TTSChunkRetryContext,
): Promise<T> {
  const maxAttempts = Math.max(1, context.maxAttempts ?? DEFAULT_TTS_CHUNK_MAX_ATTEMPTS);
  const retryDelayMs = Math.max(0, context.retryDelayMs ?? DEFAULT_TTS_CHUNK_RETRY_DELAY_MS);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await generate();
    } catch (error) {
      lastError = error;
      const totalLabel = context.totalChunks == null ? "?" : String(context.totalChunks);
      const detail = [
        `backend=${context.backend}`,
        `chunk=${context.index + 1}/${totalLabel}`,
        `attempt=${attempt}/${maxAttempts}`,
        `textLength=${context.textLength}`,
      ].join(" ");

      if (attempt < maxAttempts) {
        console.warn(`[TTS] Chunk generation failed; retrying: ${detail}: ${errorMessage(error)}`);
        await wait(retryDelayMs * attempt);
      } else {
        console.error(`[TTS] Chunk generation failed permanently: ${detail}: ${errorMessage(error)}`);
      }
    }
  }

  throw new TTSChunkGenerationError(
    `TTS generation failed for chunk ${context.index + 1}${context.totalChunks == null ? "" : ` of ${context.totalChunks}`} after ${maxAttempts} attempts: ${errorMessage(lastError)}`,
    context,
    maxAttempts,
    lastError,
  );
}
