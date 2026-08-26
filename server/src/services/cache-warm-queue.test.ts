import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enqueueWarm,
  isCacheWarmOrLlamaRuntimeBusy,
  schedulePostSynthesisWarms,
  slotHasActiveTask,
} from "./cache-warm-queue.js";
import { getSettings } from "./chat-storage.js";
import { listActiveQueueChats } from "./message-queue.js";
import { acquireTurn, getActiveTurn, releaseTurn } from "./turn-gate.js";

const warmMockState = vi.hoisted(() => ({
  calls: [] as string[],
}));

vi.mock("./chat-storage.js", () => ({
  getSettings: vi.fn(async () => ({
    defaultModelId: "demo-model",
    llamacppUrl: "http://router.test",
  })),
}));

vi.mock("./message-queue.js", () => ({
  listActiveQueueChats: vi.fn(async () => [] as string[]),
}));

vi.mock("./cache-warm.js", () => ({
  warmChatCache: vi.fn(async (chatId: string, options?: { reason?: string }) => {
    warmMockState.calls.push(`chat:${chatId}`);
    return {
      warmed: true,
      chatId,
      targetKind: "chat",
      modelId: "demo-model",
      reason: options?.reason ?? "post-synthesis",
      warmedAt: Date.now(),
    };
  }),
  warmNewAgentChatBaselineCache: vi.fn(async (options?: { reason?: string }) => {
    warmMockState.calls.push("baseline");
    return {
      warmed: true,
      chatId: "__porrima_new_agent_chat_baseline__",
      targetKind: "new-agent-chat",
      targetLabel: "New Chat",
      modelId: "demo-model",
      reason: options?.reason ?? "post-synthesis",
      warmedAt: Date.now(),
    };
  }),
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
  warmMockState.calls = [];
  vi.mocked(listActiveQueueChats).mockResolvedValue([]);
  // Turn-gate state lives on globalThis — release any lease a test left held.
  const active = getActiveTurn();
  if (active) releaseTurn(active);
  delete process.env.WARM_DEFER_RETRY_MS;
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

  it("does not treat stale n_remain on idle slots as active work (b10164 residue)", () => {
    // Live b10164 payload: slot idle, but its last task (finite max_tokens)
    // ended with 16 tokens of unused budget. n_remain = n_predict_max -
    // cumulative n_gen and is never zeroed on idle.
    expect(
      slotHasActiveTask({
        id: 0,
        is_processing: false,
        id_task: 240501,
        n_prompt_tokens: 0,
        n_prompt_tokens_processed: 6736,
        next_token: [{ has_next_token: false, has_new_line: false, n_remain: 16, n_decoded: 980 }],
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

describe("post-synthesis warm planning", () => {
  it("reserves limited capacity for baseline and system before recent chats", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "http://router.test/props") {
        return jsonResponse({ max_instances: 2 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await schedulePostSynthesisWarms("system", ["recent-1", "recent-2", "recent-3"]);

    expect(results.map((r) => r.chatId)).toEqual(["system", "__porrima_new_agent_chat_baseline__"]);
    expect(warmMockState.calls).toEqual(["chat:system", "baseline"]);
  });

  it("fills remaining capacity with recent chats and warms highest priority targets last", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "http://router.test/props") {
        return jsonResponse({ max_instances: 4 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await schedulePostSynthesisWarms("system", ["recent-1", "recent-2", "recent-3"]);

    expect(results.map((r) => r.chatId)).toEqual([
      "recent-2",
      "recent-1",
      "system",
      "__porrima_new_agent_chat_baseline__",
    ]);
    expect(warmMockState.calls).toEqual([
      "chat:recent-2",
      "chat:recent-1",
      "chat:system",
      "baseline",
    ]);
  });

  it("falls back to configured inference parallel when props capacity is unavailable", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({
      defaultModelId: "demo-model",
      llamacppUrl: "http://router.test",
      llamaServiceConfigs: {
        inference: { parallel: 3 },
      },
    } as any);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "http://router.test/props") {
        return jsonResponse({}, 500);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await schedulePostSynthesisWarms("system", ["recent-1", "recent-2"]);

    expect(results.map((r) => r.chatId)).toEqual([
      "recent-1",
      "system",
      "__porrima_new_agent_chat_baseline__",
    ]);
  });

  it("skips the post-synthesis pass when the user has queued messages", async () => {
    vi.mocked(listActiveQueueChats).mockResolvedValue(["chat-waiting"]);
    const fetchMock = vi.fn(async () => jsonResponse({ max_instances: 4 }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await schedulePostSynthesisWarms("system", ["recent-1", "recent-2"]);

    expect(results).toEqual([]);
    expect(warmMockState.calls).toEqual([]);
    // Skipped before capacity discovery — no router probe at all
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("warm queue deferral (turn gate + queued messages)", () => {
  it("defers warm while a real turn holds the gate (LLM idle in tool phase)", async () => {
    process.env.WARM_DEFER_RETRY_MS = "50";
    const lease = await acquireTurn("chat-turn");
    const warmPromise = enqueueWarm("chat-x", "post-synthesis");

    // The gate is busy but no LLM stream is active — the old guard alone
    // would have started the warm and collided on the single slot.
    await new Promise((r) => setTimeout(r, 150));
    expect(warmMockState.calls).toEqual([]);

    releaseTurn(lease);
    await vi.waitFor(
      () => expect(warmMockState.calls).toEqual(["chat:chat-x"]),
      { timeout: 2000 },
    );
    await warmPromise;
  });

  it("defers warm while a turn is queued at the gate, not just while one runs", async () => {
    process.env.WARM_DEFER_RETRY_MS = "50";
    const leaseA = await acquireTurn("chat-a");
    const leaseB = acquireTurn("chat-b"); // waits behind A
    const warmPromise = enqueueWarm("chat-x", "post-synthesis");

    await new Promise((r) => setTimeout(r, 150));
    expect(warmMockState.calls).toEqual([]);

    releaseTurn(leaseA); // grants B — gate still busy
    const leaseBResolved = await leaseB;
    await new Promise((r) => setTimeout(r, 150));
    expect(warmMockState.calls).toEqual([]);

    releaseTurn(leaseBResolved);
    await vi.waitFor(
      () => expect(warmMockState.calls).toEqual(["chat:chat-x"]),
      { timeout: 2000 },
    );
    await warmPromise;
  });

  it("defers post-synthesis warm while the user has queued messages, but not user-requested", async () => {
    process.env.WARM_DEFER_RETRY_MS = "50";
    vi.mocked(listActiveQueueChats).mockResolvedValue(["chat-waiting"]);

    const psPromise = enqueueWarm("chat-ps", "post-synthesis");
    await new Promise((r) => setTimeout(r, 150));
    expect(warmMockState.calls).toEqual([]);

    // An explicit user warm overtakes the yielding auto job
    const urPromise = enqueueWarm("chat-ur", "user-requested");
    await vi.waitFor(
      () => expect(warmMockState.calls).toEqual(["chat:chat-ur"]),
      { timeout: 2000 },
    );
    await urPromise;

    // Once the user goes quiet (queue drained/stale), the auto job runs
    vi.mocked(listActiveQueueChats).mockResolvedValue([]);
    await vi.waitFor(
      () => expect(warmMockState.calls).toEqual(["chat:chat-ur", "chat:chat-ps"]),
      { timeout: 2000 },
    );
    await psPromise;
  });
});
