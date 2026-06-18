import { afterEach, describe, expect, it, vi } from "vitest";
import { isCacheWarmOrLlamaRuntimeBusy, slotHasActiveTask } from "./cache-warm-queue.js";
import { getSettings } from "./chat-storage.js";

vi.mock("./chat-storage.js", () => ({
  getSettings: vi.fn(async () => ({
    defaultModelId: "demo-model",
    llamacppUrl: "http://router.test",
  })),
}));

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("llama slot busy detection", () => {
  it("does not treat stale task ids on idle slots as active work", () => {
    expect(
      slotHasActiveTask({
        id: 0,
        is_processing: false,
        id_task: 46074,
        n_prompt_tokens: 0,
        n_prompt_tokens_processed: 5477,
        next_token: [{ has_next_token: false, n_remain: -1, n_decoded: 360 }],
      }),
    ).toBe(false);
  });

  it("detects explicit active slot state", () => {
    expect(slotHasActiveTask({ is_processing: true, id_task: 10 })).toBe(true);
    expect(slotHasActiveTask({ processing: true })).toBe(true);
    expect(slotHasActiveTask({ state: "busy" })).toBe(true);
    expect(slotHasActiveTask({ next_token: [{ has_next_token: true }] })).toBe(true);
  });

  it("falls back to task ids for older payloads without explicit idle fields", () => {
    expect(slotHasActiveTask({ id_task: 10 })).toBe(true);
    expect(slotHasActiveTask({ id_task: -1 })).toBe(false);
  });

  it("does not load an unloaded router model while probing busy state", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "http://router.test/v1/models") {
        return jsonResponse({
          data: [
            {
              id: "demo-model",
              status: { value: "unloaded" },
            },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(isCacheWarmOrLlamaRuntimeBusy()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://router.test/v1/models",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("checks the loaded child instance slots instead of router slots", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({
      defaultModelId: "demo-model",
      llamacppUrl: "http://router.test",
    } as any);

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "http://router.test/v1/models") {
        return jsonResponse({
          data: [
            {
              id: "demo-model",
              status: {
                value: "loaded",
                args: ["--host", "127.0.0.1", "--port", "49152"],
              },
            },
          ],
        });
      }
      if (url === "http://127.0.0.1:49152/slots") {
        return jsonResponse({ slots: [{ is_processing: true }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(isCacheWarmOrLlamaRuntimeBusy()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/slots?model="),
      expect.anything(),
    );
  });
});
