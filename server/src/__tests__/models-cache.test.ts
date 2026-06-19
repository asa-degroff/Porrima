import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../types.js";
import { discoverLlamaCppModels, invalidateModelCache } from "../services/models.js";

const originalFetch = globalThis.fetch;

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    json: async () => data,
  } as Response;
}

describe("llama.cpp model discovery cache", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    invalidateModelCache();
    vi.restoreAllMocks();
  });

  it("keeps discovered context windows cached until invalidated", async () => {
    let liveCtxSize = 32768;
    const settings = {
      llamacppEnabled: true,
      llamacppUrl: "http://llama.test",
    } as Settings;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "http://llama.test/v1/models") {
        return jsonResponse({
          data: [
            {
              id: "demo-model.gguf",
              status: {
                value: "loaded",
                args: ["--ctx-size", String(liveCtxSize)],
              },
            },
          ],
        });
      }
      if (url.startsWith("http://llama.test/props")) {
        return jsonResponse({
          default_generation_settings: { n_ctx: liveCtxSize },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as any;

    await expect(discoverLlamaCppModels(settings)).resolves.toMatchObject([
      { id: "demo-model.gguf", contextWindow: 32768 },
    ]);

    liveCtxSize = 65536;
    await expect(discoverLlamaCppModels(settings)).resolves.toMatchObject([
      { id: "demo-model.gguf", contextWindow: 32768 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    invalidateModelCache();
    await expect(discoverLlamaCppModels(settings)).resolves.toMatchObject([
      { id: "demo-model.gguf", contextWindow: 65536 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});
