import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Slot capacity discovery (GET /slots) regression pin — the /props-only probe
 * silently pinned maxInstances at 1 on current llama.cpp (no max_instances
 * key), serializing every chat onto slot 0 with eviction churn.
 */

const BASE = "http://localhost:8080";

function slotsBody(n: number) {
  return JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: i, is_processing: false, n_prompt_tokens: 0 })));
}

async function loadLeases() {
  vi.resetModules();
  const { acquireLlamaSlotLease, releaseLlamaSlotLease } = await import("../services/llama-slot-leases.js");
  return { acquireLlamaSlotLease, releaseLlamaSlotLease };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  process.env.PORRIMA_DATA_DIR = mkdtempSync(join(tmpdir(), "slotleases-"));
  vi.doMock("../services/chat-storage.js", () => ({
    getSettings: vi.fn(async () => ({ llamacppSlotBindingMode: "enforced" })),
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.PORRIMA_DATA_DIR;
});

function stubFetch(handler: (url: string) => { status: number; body: string }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any) => {
      const r = handler(String(url));
      return { ok: r.status === 200, status: r.status, json: async () => JSON.parse(r.body) } as any;
    }),
  );
}

describe("llama slot capacity discovery", () => {
  it("discovers 3 slots from GET /slots and distributes distinct chats across 0/1/2", async () => {
    stubFetch((url) =>
      url.includes("/slots") ? { status: 200, body: slotsBody(3) } : { status: 404, body: "{}" },
    );
    const { acquireLlamaSlotLease } = await loadLeases();

    const a = await acquireLlamaSlotLease({ baseUrl: BASE, chatId: "chat-a", modelId: "m", contextWindow: 1000 });
    const b = await acquireLlamaSlotLease({ baseUrl: BASE, chatId: "chat-b", modelId: "m", contextWindow: 1000 });
    const c = await acquireLlamaSlotLease({ baseUrl: BASE, chatId: "chat-c", modelId: "m", contextWindow: 1000 });

    expect(a?.maxInstances).toBe(3);
    expect([a?.slotId, b?.slotId, c?.slotId].sort()).toEqual([0, 1, 2]);
  });

  it("falls back to /props max_instances when /slots is unavailable", async () => {
    stubFetch((url) =>
      url.includes("/slots")
        ? { status: 501, body: "not found" }
        : { status: 200, body: JSON.stringify({ max_instances: 4 }) },
    );
    const { acquireLlamaSlotLease } = await loadLeases();
    const a = await acquireLlamaSlotLease({ baseUrl: BASE, chatId: "chat-a", modelId: "m", contextWindow: 1000 });
    expect(a?.maxInstances).toBe(4);
  });

  it("defaults to capacity 1 when every probe fails", async () => {
    stubFetch(() => ({ status: 500, body: "{}" }));
    const { acquireLlamaSlotLease } = await loadLeases();
    const a = await acquireLlamaSlotLease({ baseUrl: BASE, chatId: "chat-a", modelId: "m", contextWindow: 1000 });
    expect(a?.maxInstances).toBe(1);
    expect(a?.slotId).toBe(0);
  });

  it("evicts an inactive LRU peer instead of de-allocating when slots run out", async () => {
    stubFetch((url) =>
      url.includes("/slots") ? { status: 200, body: slotsBody(2) } : { status: 404, body: "{}" },
    );
    const { acquireLlamaSlotLease, releaseLlamaSlotLease } = await loadLeases();

    const a = await acquireLlamaSlotLease({ baseUrl: BASE, chatId: "chat-a", modelId: "m", contextWindow: 1000 });
    const b = await acquireLlamaSlotLease({ baseUrl: BASE, chatId: "chat-b", modelId: "m", contextWindow: 1000 });
    await releaseLlamaSlotLease(a); // a goes inactive, holds slot 0

    const c = await acquireLlamaSlotLease({ baseUrl: BASE, chatId: "chat-c", modelId: "m", contextWindow: 1000 });
    expect(c?.slotId).toBe(0); // took a's freed assignment
    expect(c?.evictedChatId).toBe("chat-a");

    // With every slot active, a newcomer declines (auto selection) rather
    // than stealing an active lease.
    await releaseLlamaSlotLease(b);
    await releaseLlamaSlotLease(c);
    const d = await acquireLlamaSlotLease({ baseUrl: BASE, chatId: "chat-d", modelId: "m", contextWindow: 1000 });
    const e = await acquireLlamaSlotLease({ baseUrl: BASE, chatId: "chat-e", modelId: "m", contextWindow: 1000 });
    expect(d).not.toBeNull();
    expect(e).not.toBeNull();
    const f = await acquireLlamaSlotLease({ baseUrl: BASE, chatId: "chat-f", modelId: "m", contextWindow: 1000 });
    expect(f).toBeNull(); // capacity 2, both active -> no steal
  });
});
