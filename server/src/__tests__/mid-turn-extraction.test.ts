import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../types.js";

const mockState = vi.hoisted(() => ({
  addMemory: vi.fn(),
  embedBatch: vi.fn(),
  fetch: vi.fn(),
  getChat: vi.fn(),
  getSettings: vi.fn(),
  invalidateMemoriesCache: vi.fn(),
  startExtractionRun: vi.fn(),
}));

vi.mock("../services/chat-storage.js", () => ({
  getSettings: mockState.getSettings,
  getChat: mockState.getChat,
  updateChatExtractionState: vi.fn(),
}));

vi.mock("../services/embeddings.js", () => ({
  embedBatch: mockState.embedBatch,
}));

vi.mock("../services/llama-router-client.js", () => ({
  ensureRouterModelLoaded: vi.fn(),
  normalizeRouterModelId: vi.fn((id: string | undefined) => id?.replace(/\.gguf$/i, "") || ""),
}));

vi.mock("../services/memory-context.js", () => ({
  invalidateMemoriesCache: mockState.invalidateMemoriesCache,
}));

vi.mock("../services/memory-storage.js", () => ({
  addMemory: mockState.addMemory,
  updateMemory: vi.fn(),
  findSimilarMemoryCandidates: vi.fn(async () => []),
  createSupersessionLink: vi.fn(),
  getMemoriesByChatId: vi.fn(async () => []),
  getMaxBlockChars: vi.fn(() => 500),
  buildMemoryIndexText: (text: string, subject?: string) =>
    subject?.trim() ? `${subject.trim()}\n${text}` : text,
}));

vi.mock("../services/memory-extraction-observability.js", () => ({
  startExtractionRun: mockState.startExtractionRun,
}));

vi.mock("../services/model-stats.js", () => ({
  recordModelStats: vi.fn(),
}));

vi.mock("../services/agent.js", () => ({
  streamChat: vi.fn(),
}));

const originalFetch = globalThis.fetch;

function makeChat(): Chat {
  return {
    id: "chat-1",
    title: "Mid-turn extraction test",
    type: "agent",
    modelId: "chat-model",
    systemPrompt: "You are helpful.",
    messages: [
      { role: "user", content: "Please work on the feature.", timestamp: 1 },
      { role: "assistant", content: "I found the relevant module.", timestamp: 2 },
    ],
    createdAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
  };
}

function streamResponse(content: string): Response {
  const encoder = new TextEncoder();
  return {
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
  } as Response;
}

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    json: async () => data,
  } as Response;
}

describe("mid-turn extraction behavior", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mockState.getSettings.mockResolvedValue({
      extractionModelUrl: "http://127.0.0.1:32101",
      extractionModelId: "extract-model",
      extractionCtxSize: 16384,
      extractionMaxTokens: 4000,
      extractionTimeoutMs: 600000,
    });
    mockState.getChat.mockResolvedValue(makeChat());
    mockState.embedBatch.mockResolvedValue([new Array(1024).fill(0.1)]);
    mockState.startExtractionRun.mockReturnValue({
      attachOutput: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    });
    globalThis.fetch = mockState.fetch as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns an incomplete result when a pulse times out", async () => {
    const { triggerMidTurnExtractionPulse } = await import("../services/memory-extraction.js");
    mockState.fetch.mockImplementation((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })
    );

    const result = await triggerMidTurnExtractionPulse({
      modelId: "chat-model",
      chatId: "chat-1",
      content: {
        userMessage: "Please work on the feature.",
        thinkingText: "I should inspect the implementation.",
        toolCalls: [],
        toolResults: [],
      },
      pulseIndex: 0,
      timeoutMs: 5,
    });

    expect(result.completed).toBe(false);
    expect(mockState.addMemory).not.toHaveBeenCalled();
  });

  it("invalidates memory context after a successful mid-turn save", async () => {
    const { triggerMidTurnExtractionPulse } = await import("../services/memory-extraction.js");
    mockState.fetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/chat/completions")) {
        return streamResponse(
          `[{"text":"I found that mid-turn extraction should send deltas only.","category":"decision","importance":7}]`
        );
      }
      return jsonResponse({ default_generation_settings: { n_ctx: 16384 } });
    });

    const result = await triggerMidTurnExtractionPulse({
      modelId: "chat-model",
      chatId: "chat-1",
      projectId: "project-1",
      turnId: "turn-1",
      content: {
        userMessage: "Please work on the feature.",
        thinkingText: "I should inspect the implementation.",
        toolCalls: [{ name: "read_file", arguments: { path: "server/src/routes/chat.ts" } }],
        toolResults: [{ toolName: "read_file", content: "Relevant source.", isError: false }],
        sourceSpan: { startIndex: 1, endIndex: 2 },
      },
      pulseIndex: 0,
      timeoutMs: 1000,
    });

    expect(result.completed).toBe(true);
    expect(result.added).toBe(1);
    expect(mockState.addMemory).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      sourceMessageStartIndex: 1,
      sourceMessageEndIndex: 2,
      turnId: "turn-1",
    }));
    expect(mockState.invalidateMemoriesCache).toHaveBeenCalledWith("chat-1");
  });

  it("does not skip pre-compaction extraction solely because a pulse ran", async () => {
    const { preCompactionFlush } = await import("../services/memory-extraction.js");
    mockState.fetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/chat/completions")) return streamResponse("[]");
      return jsonResponse({ default_generation_settings: { n_ctx: 16384 } });
    });

    await preCompactionFlush(
      "chat-model",
      "chat-1",
      [{ role: "assistant", content: "Uncovered task state before compaction.", timestamp: 3 }],
      { projectId: "project-1" },
    );

    expect(mockState.fetch).toHaveBeenCalled();
  });

  it("continues the immediate extraction session for pre-compaction flushes", async () => {
    const { preCompactionFlush } = await import("../services/memory-extraction.js");
    const captured: Array<{ system: string; user: string }> = [];
    mockState.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/chat/completions")) {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
        const system = body.messages.find((m) => m.role === "system")?.content ?? "";
        const user = body.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
        captured.push({ system, user });
        return streamResponse("[]");
      }
      return jsonResponse({ default_generation_settings: { n_ctx: 16384 } });
    });

    await preCompactionFlush(
      "chat-model",
      "chat-1",
      [{ role: "assistant", content: "Task state that is about to be compacted away.", timestamp: 3 }],
      { projectId: "project-1" },
    );

    expect(captured.length).toBeGreaterThan(0);
    // Same system prompt as immediate/mid-turn extraction (session continuation,
    // not the old standalone pre-compaction system prompt).
    expect(captured[0].system).toContain("## Memory Extraction Task");
    // The pre-compaction framing lives in the user turn so the cached prefix is reused.
    expect(captured[0].user).toContain("[PRE-COMPACTION]");
    expect(captured[0].user).toContain("Task state that is about to be compacted away.");
  });

  it("runs a pre-compaction flush alone, after queued exchange jobs", async () => {
    const { enqueueImmediateExtraction, preCompactionFlush } = await import("../services/memory-extraction.js");
    // Unique chat id: immediate-extraction sessions and queues are keyed by
    // chat at module level and persist across tests in this file.
    const chatId = "chat-flush-order";
    mockState.getChat.mockResolvedValue({ ...makeChat(), id: chatId });
    const captured: Array<Array<{ role: string; content: string }>> = [];
    mockState.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/chat/completions")) {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
        captured.push(body.messages);
        return streamResponse("[]");
      }
      return jsonResponse({ default_generation_settings: { n_ctx: 16384 } });
    });

    const exchangeDone = enqueueImmediateExtraction(
      "chat-model",
      chatId,
      "Exchange user message about the parser.",
      "Exchange assistant reply about the parser.",
      "project-1",
    );
    const flushDone = preCompactionFlush(
      "chat-model",
      chatId,
      [{ role: "assistant", content: "Flushed task state before compaction.", timestamp: 3 }],
      { projectId: "project-1" },
    );
    await Promise.all([exchangeDone, flushDone]);

    expect(captured.length).toBe(2);
    // The exchange job ran first, as its own call.
    const exchangeUserTurns = captured[0].filter((m) => m.role === "user").map((m) => m.content).join("\n");
    expect(exchangeUserTurns).toContain("Exchange assistant reply about the parser.");
    expect(exchangeUserTurns).not.toContain("[PRE-COMPACTION]");
    // The flush ran alone afterwards: its own user turn carries the
    // pre-compaction framing and the removed content, and does not fold in
    // the exchange (that lives in session history, not the flush turn).
    const flushCall = captured[1];
    const flushUserTurn = flushCall.filter((m) => m.role === "user").at(-1)?.content ?? "";
    expect(flushUserTurn).toContain("[PRE-COMPACTION]");
    expect(flushUserTurn).toContain("Flushed task state before compaction.");
    expect(flushUserTurn).not.toContain("Exchange assistant reply about the parser.");
  });

  it("re-attempts a failed pre-compaction continuation chunk through the degraded path", async () => {
    const { preCompactionFlush } = await import("../services/memory-extraction.js");
    // Unique chat id: immediate-extraction sessions and queues are keyed by
    // chat at module level and persist across tests in this file.
    const chatId = "chat-failed-chunk";
    mockState.getChat.mockResolvedValue({ ...makeChat(), id: chatId });
    const bodies: string[] = [];
    let completions = 0;
    mockState.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/chat/completions")) {
        completions += 1;
        bodies.push(String(init?.body ?? ""));
        // Fail the first three completions — the first call's retries.
        if (completions <= 3) {
          return { ok: false, status: 500, text: async () => "synthetic failure" } as Response;
        }
        return streamResponse("[]");
      }
      return jsonResponse({ default_generation_settings: { n_ctx: 16384 } });
    });

    // ~21k chars of removed content: near the single-call budget for
    // ctx 16384 / maxTokens 4000, so the flush takes the chunked path.
    const filler = "Recoverable content prose about the cache redesign. ".repeat(120);
    await preCompactionFlush(
      "chat-model",
      chatId,
      [
        { role: "assistant", content: `FAILED-CHUNK-MARKER ${filler}`, timestamp: 3 },
        { role: "assistant", content: `SECOND-CHUNK-MARKER ${filler}`, timestamp: 4 },
        { role: "assistant", content: `THIRD-CHUNK-MARKER ${filler}`, timestamp: 5 },
      ],
      { projectId: "project-1" },
    );

    // The failed chunk's content must survive: it degrades to the independent
    // path and is re-attempted there, instead of being dropped with the
    // failed continuation call. (3 failed attempts + at least 1 degraded call.)
    const failedMarkerBodies = bodies.filter((b) => b.includes("FAILED-CHUNK-MARKER"));
    expect(failedMarkerBodies.length).toBeGreaterThanOrEqual(4);
    expect(completions).toBeGreaterThanOrEqual(4);
    // The remaining chunks were still extracted.
    expect(bodies.join("\n")).toContain("SECOND-CHUNK-MARKER");
    expect(bodies.join("\n")).toContain("THIRD-CHUNK-MARKER");
  }, 20_000);
});
