import { describe, expect, it, vi } from "vitest";
import { TTSChunkGenerationError, withTTSChunkRetry } from "./tts-retry.js";

describe("withTTSChunkRetry", () => {
  it("returns the first successful result", async () => {
    const generate = vi.fn().mockResolvedValue("audio");

    await expect(withTTSChunkRetry(generate, {
      backend: "kokoro",
      index: 0,
      totalChunks: 2,
      textLength: 120,
      retryDelayMs: 0,
    })).resolves.toBe("audio");

    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("retries a transient chunk failure", async () => {
    const generate = vi.fn()
      .mockRejectedValueOnce(new Error("native process crashed"))
      .mockResolvedValue("recovered audio");

    await expect(withTTSChunkRetry(generate, {
      backend: "kokoro",
      index: 3,
      totalChunks: 8,
      textLength: 480,
      maxAttempts: 3,
      retryDelayMs: 0,
    })).resolves.toBe("recovered audio");

    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("reports chunk metadata after retry exhaustion", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("SIGSEGV"));

    const failure = await withTTSChunkRetry(generate, {
      backend: "kokoro",
      index: 4,
      totalChunks: 9,
      textLength: 512,
      maxAttempts: 2,
      retryDelayMs: 0,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TTSChunkGenerationError);
    expect(failure).toMatchObject({
      backend: "kokoro",
      index: 4,
      totalChunks: 9,
      attempts: 2,
      textLength: 512,
    });
    expect((failure as Error).message).toContain("chunk 5 of 9 after 2 attempts");
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
