import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveExtractionRequestSettings,
} from "../services/extraction-settings.js";

const originalFetch = globalThis.fetch;

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    json: async () => data,
  } as Response;
}

describe("resolveExtractionRequestSettings", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("uses live /props context for a dedicated extraction server", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({
      default_generation_settings: { n_ctx: 32768 },
    })) as any;

    const result = await resolveExtractionRequestSettings({
      extractionModelUrl: "http://127.0.0.1:32101",
      extractionModelId: "Qwen3.5-9B.gguf",
      extractionCtxSize: 131072,
      extractionMaxTokens: 4000,
      extractionTimeoutMs: 600000,
    });

    expect(result.ctxSize).toBe(32768);
    expect(result.configuredCtxSize).toBe(131072);
    expect(result.ctxSource).toBe("props");
  });

  it("does not clamp a live context upward", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({
      default_generation_settings: { n_ctx: 1024 },
    })) as any;

    const result = await resolveExtractionRequestSettings({
      extractionModelUrl: "http://127.0.0.1:32101",
      extractionCtxSize: 16384,
      extractionMaxTokens: 4000,
      extractionTimeoutMs: 600000,
    });

    expect(result.ctxSize).toBe(1024);
    expect(result.ctxSource).toBe("props");
  });

  it("falls back to /v1/models max_model_len when /props has no usable context", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return jsonResponse({
          data: [{
            id: "Qwen3.5-9B",
            max_model_len: 24576,
          }],
        });
      }
      return jsonResponse({ default_generation_settings: { n_ctx: 0 } });
    }) as any;

    const result = await resolveExtractionRequestSettings({
      extractionModelUrl: "http://127.0.0.1:32101",
      extractionModelId: "Qwen3.5-9B.gguf",
      extractionCtxSize: 131072,
      extractionMaxTokens: 4000,
      extractionTimeoutMs: 600000,
    });

    expect(result.ctxSize).toBe(24576);
    expect(result.ctxSource).toBe("models");
  });

  it("uses normalized settings when the live service cannot report context", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) } as Response)) as any;

    const result = await resolveExtractionRequestSettings({
      extractionModelUrl: "http://127.0.0.1:32101",
      extractionCtxSize: 999999,
      extractionMaxTokens: 4000,
      extractionTimeoutMs: 600000,
    });

    expect(result.ctxSize).toBe(131072);
    expect(result.configuredCtxSize).toBe(131072);
    expect(result.ctxSource).toBe("settings");
  });
});
