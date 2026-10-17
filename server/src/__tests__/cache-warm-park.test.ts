import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Post-warm park (docs/design/kv-snapshot-parking.md §5.3a, 10-17):
 * warmChatCache pins the prefill to a physical slot (`id_slot` on the
 * /completion request) and, on success, fires a fire-and-forget
 * parkAfterWarm with the warm as its own witness (wire-truth warm size +
 * the warm body's head digest). Auto binding mode degrades to today's
 * behavior: no pin on the wire, and the park skips (null lease).
 */

const BASE_URL = "http://localhost:8080";
const CHAT_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const MODEL_ID = "big-model";

function makeLease(slotId = 2) {
  return {
    chatId: CHAT_ID,
    leaseId: "lease-warm",
    baseUrl: BASE_URL,
    modelId: MODEL_ID,
    contextWindow: 262144,
    poolKey: `["${BASE_URL}","${MODEL_ID}",262144]`,
    slotId,
    maxInstances: 3,
  };
}

interface Harness {
  warm: typeof import("../services/cache-warm.js");
  fetchMock: ReturnType<typeof vi.fn>;
  acquireMock: ReturnType<typeof vi.fn>;
  releaseMock: ReturnType<typeof vi.fn>;
  parkMock: ReturnType<typeof vi.fn>;
  home: string;
}

async function loadHarness(options: {
  lease?: ReturnType<typeof makeLease> | null;
  prefillFails?: boolean;
  tokensCached?: number;
  tokensEvaluated?: number;
} = {}): Promise<Harness> {
  vi.resetModules();
  const home = mkdtempSync(join(tmpdir(), "warm-park-"));
  process.env.PORRIMA_DATA_DIR = home;

  const lease = options.lease === undefined ? makeLease() : options.lease;

  const undiciFetchMock = vi.fn(async (url: any) => {
    const u = String(url);
    if (u.endsWith("/apply-template")) {
      return { ok: true, json: async () => ({ prompt: "RENDERED PROMPT" }) };
    }
    if (u.endsWith("/tokenize")) {
      return { ok: true, json: async () => ({ tokens: [1, 2, 3, 4] }) };
    }
    if (u.endsWith("/detokenize")) {
      return { ok: true, json: async () => ({ content: "WARM PROMPT" }) };
    }
    if (u.endsWith("/completion")) {
      if (options.prefillFails) {
        return { ok: false, status: 500, text: async () => "prefill exploded" };
      }
      return {
        ok: true,
        json: async () => ({
          timings: { prompt_ms: 100 },
          tokens_cached: options.tokensCached ?? 0,
          tokens_evaluated: options.tokensEvaluated ?? 3,
        }),
      };
    }
    throw new Error(`unexpected url ${u}`);
  });
  vi.doMock("undici", async (importOriginal) => {
    const actual = await importOriginal<typeof import("undici")>();
    return {
      ...actual,
      fetch: undiciFetchMock,
    };
  });

  vi.doMock("../services/chat-storage.js", () => ({
    getChat: vi.fn(async () => ({
      id: CHAT_ID,
      type: "agent",
      modelId: MODEL_ID,
      projectId: null,
      activeSkills: [],
      // Ends with a user message: the render plan takes "exact" mode (the
      // assistant-ending case would exercise the next-user sentinel, which
      // is the warm's own business, not this seam's).
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
      ],
    })),
    getProject: vi.fn(async () => null),
    getSettings: vi.fn(async () => ({ llamacppUrl: BASE_URL })),
  }));

  vi.doMock("../services/agent.js", () => ({
    chatMessagesToHydratedPiMessages: vi.fn(async (messages: any[]) => messages),
  }));

  vi.doMock("../services/llama-router-client.js", () => ({
    ensureRouterModelLoaded: vi.fn(async () => "loaded"),
    normalizeRouterModelId: vi.fn((id: string) => id),
  }));

  vi.doMock("../services/models.js", () => ({
    createPiModelFromProvider: vi.fn(async () => ({
      id: MODEL_ID,
      baseUrl: BASE_URL,
      reasoning: false,
      contextWindow: 262144,
    })),
    discoverAllModels: vi.fn(async () => [{ id: MODEL_ID, baseUrl: BASE_URL }]),
    getEffectiveContextWindow: vi.fn(() => 262144),
  }));

  vi.doMock("../services/memory-context.js", () => ({
    buildStablePrefix: vi.fn(async () => "STABLE"),
    buildSplitAugmentedPrompt: vi.fn(async () => ({ systemPrompt: "SP", blocksSection: "" })),
    invalidateMemoriesCache: vi.fn(),
    resetMemoryContext: vi.fn(),
    setCachedAugmentedPrompt: vi.fn(),
  }));

  vi.doMock("../services/agent-tools.js", () => ({
    getAgentTools: vi.fn(() => []),
  }));

  vi.doMock("../services/skills.js", () => ({
    buildSkillAugmentedPrompt: vi.fn((sp: string) => sp),
    discoverSkills: vi.fn(async () => []),
  }));

  vi.doMock("../services/llama-prompt-debug.js", () => ({
    recordWarmPromptSnapshot: vi.fn(),
    digestPromptText: vi.fn((s: string) => `digest:${s.length}`),
  }));

  vi.doMock("../services/llama-ports.js", () => ({
    getDefaultLlamaServerUrl: vi.fn(() => BASE_URL),
  }));

  vi.doMock("../services/openai-compat-provider.js", () => ({
    // Faithful to the real seam under test: the lease adds id_slot and
    // nothing else to the body (the warm's byte-parity contract).
    buildOpenAICompatChatBody: vi.fn(async (model: any, context: any, options: any) => {
      const body: any = { model: model.id, messages: context.messages, stream: true };
      if (options?.llamaSlotLease) body.id_slot = options.llamaSlotLease.slotId;
      return { body, cachePrompt: true };
    }),
    buildTranscriptContext: vi.fn((sp: string, messages: any, tools: any) => ({
      systemPrompt: sp,
      messages,
      tools,
    })),
    digestPromptPayload: vi.fn(() => "payload-digest"),
  }));

  vi.doMock("../services/llama-cache-residency.js", () => ({
    markLlamaCacheResidencyStarted: vi.fn(),
    markLlamaCacheResidencyFinished: vi.fn(),
    recordLlamaCacheResidencyRun: vi.fn(),
    NEW_AGENT_CHAT_BASELINE_CACHE_ID: "new-agent-chat",
    NEW_AGENT_CHAT_BASELINE_CACHE_LABEL: "baseline",
  }));

  const acquireMock = vi.fn(async () => lease);
  const releaseMock = vi.fn(async () => {});
  vi.doMock("../services/llama-slot-leases.js", () => ({
    acquireLlamaSlotLease: acquireMock,
    releaseLlamaSlotLease: releaseMock,
  }));

  const parkMock = vi.fn(async () => {});
  vi.doMock("../services/kv-snapshot.js", () => ({
    parkAfterWarm: parkMock,
    computeLlamaPrefixDigest: vi.fn((body: any) => `digest-of-${body.messages?.[0]?.content ?? ""}`),
  }));

  const warm = await import("../services/cache-warm.js");

  return {
    warm,
    fetchMock: undiciFetchMock,
    acquireMock,
    releaseMock,
    parkMock,
    home,
  };
}

const completionCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/completion"));

describe("cache-warm post-warm park (§5.3a)", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    delete process.env.PORRIMA_DATA_DIR;
  });

  it("pins the prefill to the leased slot and parks with the warm as its own witness", async () => {
    const h = await loadHarness({ lease: makeLease(2) });
    try {
      const result = await h.warm.warmChatCache(CHAT_ID, { reason: "post-synthesis" });
      expect(result.warmed).toBe(true);
      expect(h.acquireMock).toHaveBeenCalledWith({
        baseUrl: BASE_URL,
        chatId: CHAT_ID,
        modelId: MODEL_ID,
        contextWindow: 262144,
      });

      // The operative pin: id_slot on the /completion prefill.
      const calls = completionCalls(h.fetchMock);
      expect(calls).toHaveLength(1);
      expect(JSON.parse(calls[0][1].body).id_slot).toBe(2);

      // The park fires fire-and-forget with the warm's witness inputs.
      expect(h.parkMock).toHaveBeenCalledTimes(1);
      expect(h.parkMock).toHaveBeenCalledWith({
        chatId: CHAT_ID,
        lease: expect.objectContaining({ slotId: 2 }),
        promptTokens: 3, // warmTokenCount: the one-token-short prompt length (what the slot holds)
        prefixDigest: expect.any(String),
      });

      // The lease is released exactly once, on the pinned slot.
      expect(h.releaseMock).toHaveBeenCalledTimes(1);
      expect(h.releaseMock).toHaveBeenCalledWith(expect.objectContaining({ slotId: 2 }));
    } finally {
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it("auto binding mode: no pin on the wire, park receives the null lease", async () => {
    const h = await loadHarness({ lease: null });
    try {
      const result = await h.warm.warmChatCache(CHAT_ID);
      expect(result.warmed).toBe(true);

      const calls = completionCalls(h.fetchMock);
      expect(calls).toHaveLength(1);
      expect(JSON.parse(calls[0][1].body).id_slot).toBeUndefined();

      // The park is still invoked; the null lease makes it a documented no-op
      // (pinned-skip is covered by the kv-snapshot suite).
      expect(h.parkMock).toHaveBeenCalledTimes(1);
      expect(h.parkMock).toHaveBeenCalledWith({
        chatId: CHAT_ID,
        lease: null,
        promptTokens: 3, // warmTokenCount, again — the null lease makes the park a no-op downstream
        prefixDigest: expect.any(String),
      });
      expect(h.releaseMock).toHaveBeenCalledWith(null);
    } finally {
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it("a warm-LCP prefill parks the slot state, not the server's workload counters (10-17 field case)", async () => {
    // Field shape: the slot already held ~the warm prompt (high LCP), so the
    // server reports tokens_cached ≈ tokens_evaluated ≈ prompt length (3 each
    // here; 68,040 each in the field). The park must expect the slot state —
    // warmTokenCount — not their sum: the sum false-fired the slot-identity
    // guard and discarded a correct save (n_saved=68,040 < expected 136,080).
    const h = await loadHarness({ lease: makeLease(2), tokensCached: 3, tokensEvaluated: 3 });
    try {
      const result = await h.warm.warmChatCache(CHAT_ID, { reason: "post-synthesis" });
      expect(result.warmed).toBe(true);
      expect(result.totalPromptTokens).toBe(6); // workload counters: cached + evaluated
      expect(h.parkMock).toHaveBeenCalledTimes(1);
      expect(h.parkMock).toHaveBeenCalledWith({
        chatId: CHAT_ID,
        lease: expect.objectContaining({ slotId: 2 }),
        promptTokens: 3, // warmTokenCount — NOT 3 + 3 = 6
        prefixDigest: expect.any(String),
      });
    } finally {
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it("a failed prefill parks nothing but still releases the lease", async () => {
    const h = await loadHarness({ lease: makeLease(2), prefillFails: true });
    try {
      const result = await h.warm.warmChatCache(CHAT_ID);
      expect(result.warmed).toBe(false);
      expect(result.error).toContain("/completion failed");
      expect(h.parkMock).not.toHaveBeenCalled();
      expect(h.releaseMock).toHaveBeenCalledTimes(1);
      expect(h.releaseMock).toHaveBeenCalledWith(expect.objectContaining({ slotId: 2 }));
    } finally {
      rmSync(h.home, { recursive: true, force: true });
    }
  });
});
