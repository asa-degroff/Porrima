import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat, ChatMessage } from "../types.js";
import { invalidateKvSnapshot } from "../services/kv-snapshot.js";

const mockState = vi.hoisted(() => ({
  savedArchives: [] as any[],
  nextArchiveSequence: 1,
}));

vi.mock("../services/chat-storage.js", () => ({
  getNextArchiveSequence: vi.fn(() => mockState.nextArchiveSequence),
  saveArchives: vi.fn((archives: any[]) => {
    mockState.savedArchives.push(...archives);
  }),
  getArchive: vi.fn(() => undefined),
  getChat: vi.fn(() => undefined),
  saveChat: vi.fn(),
  withChatWriteLock: vi.fn(async (_chatId: string, fn: () => Promise<void>) => fn()),
  updateChatTitle: vi.fn(),
  getSettings: vi.fn(async () => ({
    extractionModelUrl: "",
    extractionModelId: "",
  })),
}));

vi.mock("../services/title-generation.js", () => ({
  regenerateTitle: vi.fn(async () => ""),
}));

vi.mock("../services/memory-extraction.js", () => ({
  readOpenAIContentStream: vi.fn(),
  withExtractionMutex: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock("../services/model-stats.js", () => ({
  recordModelStats: vi.fn(),
}));

vi.mock("../services/llama-router-client.js", () => ({
  ensureRouterModelLoaded: vi.fn(),
  normalizeRouterModelId: vi.fn((id: string) => id),
}));

vi.mock("../services/extraction-settings.js", () => ({
  resolveExtractionRequestSettings: vi.fn(async () => ({
    ctxSize: 32768,
    maxTokens: 768,
    timeoutMs: 1000,
  })),
}));

vi.mock("../services/kv-snapshot.js", () => ({
  invalidateKvSnapshot: vi.fn(async () => {}),
}));

function makeChat(id: string, messages: ChatMessage[]): Chat {
  return {
    id,
    title: "KV Invalidate Test",
    type: "agent",
    modelId: "test-model",
    messages,
    createdAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
  };
}

// A chat whose single bulky tool-result tail puts the estimate over the
// trigger for an 8000-token window (same shape the retention suite uses).
function oversizedChat(id: string): Chat {
  const hugeSource = "sigma source line with graph setup and reducers\n".repeat(1800);
  return makeChat(id, [
    { role: "user", content: "Earlier setup request.", timestamp: 1 },
    { role: "assistant", content: "Recent output.", timestamp: 2 },
    {
      role: "assistant",
      content: "",
      timestamp: 3,
      toolCalls: [{ id: "read", name: "read_file", arguments: { path: "/repo/MemoryGraphView.tsx" } }],
      toolResults: [
        { toolCallId: "read", toolName: "read_file", content: hugeSource, isError: false },
      ],
    },
  ]);
}

// The parked KV snapshot replays the OLD message spine. Every path that
// rewrites the spine must drop the parked row + file, or the next turn
// wastes a restore (and a breaker strike) on a prefix that no longer
// matches. truncateChatHistory has owned the funnel call since Phase 2;
// the pre-send backstop (truncateBeforeSend) archives on its own without
// ever entering that funnel, so it needs the call too (10-12).
describe("compaction invalidates parked KV snapshots", () => {
  beforeEach(() => {
    mockState.savedArchives = [];
    mockState.nextArchiveSequence = 1;
    vi.clearAllMocks();
  });

  it("invalidates on the truncateBeforeSend primary path (no funnel involvement)", async () => {
    const { truncateBeforeSend } = await import("../services/compaction.js");
    const chat = oversizedChat("pre-send-chat");

    const result = await truncateBeforeSend(chat, 8000, "You are helpful.", undefined, undefined, []);

    expect(result?.truncated).toBe(true);
    expect(invalidateKvSnapshot).toHaveBeenCalledWith("pre-send-chat", "compaction");
  });

  it("invalidates on the truncateChatHistory funnel (forced compaction)", async () => {
    const { truncateChatHistory } = await import("../services/compaction.js");
    const chat = oversizedChat("funnel-chat");

    const result = await truncateChatHistory(chat, 8000, true, undefined, undefined, undefined, "You are helpful.", []);

    expect(result.truncated).toBe(true);
    expect(invalidateKvSnapshot).toHaveBeenCalledWith("funnel-chat", "compaction");
  });

  it("does not invalidate when pre-send stays quiet (nothing was rewritten)", async () => {
    const { truncateBeforeSend } = await import("../services/compaction.js");
    const chat = makeChat("quiet-chat", [
      { role: "user", content: "Small question.", timestamp: 1 },
      { role: "assistant", content: "Small answer.", timestamp: 2 },
    ]);

    const result = await truncateBeforeSend(chat, 100_000, "You are helpful.", undefined, undefined, []);

    expect(result).toBeNull();
    expect(invalidateKvSnapshot).not.toHaveBeenCalled();
  });
});
