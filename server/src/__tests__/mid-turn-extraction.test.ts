import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../types.js";

const mockState = vi.hoisted(() => ({
  addMemory: vi.fn(),
  embedBatch: vi.fn(),
  fetch: vi.fn(),
  getChat: vi.fn(),
  invalidateMemoriesCache: vi.fn(),
  startExtractionRun: vi.fn(),
}));

vi.mock("../services/chat-storage.js", () => ({
  getSettings: vi.fn(async () => ({
    extractionModelUrl: "http://127.0.0.1:32101",
    extractionModelId: "extract-model",
    extractionCtxSize: 16384,
    extractionMaxTokens: 4000,
    extractionTimeoutMs: 600000,
  })),
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
      { projectId: "project-1", lastPulseIndex: 0 },
    );

    expect(mockState.fetch).toHaveBeenCalled();
  });
});
