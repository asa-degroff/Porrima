import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureRouterModelLoaded, invalidateRouterCache } from "../services/llama-router-client.js";

const BASE_URL = "http://router.test";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

function modelList(contextWindow: number) {
  return {
    data: [
      {
        id: "demo-model",
        status: {
          value: "loaded",
          args: ["--ctx-size", String(contextWindow)],
        },
      },
    ],
  };
}

afterEach(() => {
  invalidateRouterCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ensureRouterModelLoaded", () => {
  it("does not reload a forced router model when the context already matches", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${BASE_URL}/v1/models`) return jsonResponse(modelList(8192));
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await ensureRouterModelLoaded(BASE_URL, "demo-model", {
      contextWindow: 8192,
      force: true,
    });

    expect(result).toBe("loaded");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalledWith(`${BASE_URL}/models/load`, expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith(`${BASE_URL}/models/unload`, expect.anything());
  });

  it("reloads a forced router model when the loaded context differs", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${BASE_URL}/v1/models`) {
        const calls = fetchMock.mock.calls.filter(([calledUrl]) => String(calledUrl) === `${BASE_URL}/v1/models`).length;
        return jsonResponse(calls === 1 ? modelList(4096) : { data: [] });
      }
      if (url === `${BASE_URL}/models/unload`) return jsonResponse({});
      if (url === `${BASE_URL}/models/load`) {
        expect(JSON.parse(String(init?.body))).toEqual({
          model: "demo-model",
          args: ["--ctx-size", "8192"],
        });
        return jsonResponse({});
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await ensureRouterModelLoaded(BASE_URL, "demo-model", {
      contextWindow: 8192,
      force: true,
    });

    expect(result).toBe("loaded");
    expect(fetchMock).toHaveBeenCalledWith(`${BASE_URL}/models/unload`, expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ model: "demo-model" }),
    }));
    expect(fetchMock).toHaveBeenCalledWith(`${BASE_URL}/models/load`, expect.objectContaining({
      method: "POST",
    }));
  });
});
