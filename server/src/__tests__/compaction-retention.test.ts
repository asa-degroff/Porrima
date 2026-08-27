import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat, ChatMessage } from "../types.js";
import { saveArchives } from "../services/chat-storage.js";

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

function makeChat(messages: ChatMessage[]): Chat {
  return {
    id: "retention-chat",
    title: "Retention Test",
    type: "agent",
    modelId: "test-model",
    systemPrompt: "You are helpful.",
    messages,
    createdAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
  };
}

describe("compaction retention planning", () => {
  beforeEach(() => {
    mockState.savedArchives = [];
    mockState.nextArchiveSequence = 1;
    vi.clearAllMocks();
  });

  it("backfills recent user and assistant text after splitting a bulky tool-only tail", async () => {
    const { truncateBeforeSend } = await import("../services/compaction.js");
    const hugeSource = "sigma source line with graph setup and reducers\n".repeat(1800);
    const currentUser = "I've rewritten the memory graph viewer with Sigma.js; review where to pick up.";
    const recentOutput = "Recent output: the custom dropdown work is complete and typecheck passes.";
    const chat = makeChat([
      { role: "user", content: "Earlier setup request.", timestamp: 1 },
      { role: "assistant", content: recentOutput, timestamp: 2 },
      { role: "user", content: currentUser, timestamp: 3 },
      {
        role: "assistant",
        content: "",
        thinking: "I should inspect the rewritten graph viewer and then check the diff.",
        timestamp: 4,
        toolCalls: [
          { id: "read", name: "read_file", arguments: { path: "/repo/MemoryGraphView.tsx" } },
          { id: "diff", name: "bash", arguments: { command: "git diff --stat HEAD" } },
        ],
        toolResults: [
          { toolCallId: "read", toolName: "read_file", content: hugeSource, isError: false },
          { toolCallId: "diff", toolName: "bash", content: "(no output)", isError: false },
        ],
      },
    ]);

    const result = await truncateBeforeSend(chat, 8000, "You are helpful.", undefined, undefined, []);

    expect(result?.truncated).toBe(true);
    const active = chat.messages.filter((m) => !m._outOfContext);
    expect(active.some((m) => m.role === "user" && m.content === currentUser)).toBe(true);
    expect(active.some((m) => m.role === "assistant" && m.content === recentOutput)).toBe(true);

    const activeToolPayload = JSON.stringify(active.map((m) => m.toolResults ?? []));
    expect(activeToolPayload).toContain("(no output)");
    expect(activeToolPayload).not.toContain("sigma source line");
    expect(JSON.stringify(mockState.savedArchives)).toContain("sigma source line");
  });

  it("runs onBeforeArchive before archiving removed messages", async () => {
    const { truncateBeforeSend } = await import("../services/compaction.js");
    const order: string[] = [];
    let hookRemoved: ChatMessage[] = [];
    vi.mocked(saveArchives).mockImplementation((archives: any[]) => {
      mockState.savedArchives.push(...archives);
      order.push("archived");
    });
    const hugeSource = "sigma source line with graph setup and reducers\n".repeat(1800);
    const chat = makeChat([
      { role: "user", content: "Earlier setup request.", timestamp: 1 },
      {
        role: "assistant",
        content: "",
        thinking: "I should inspect the rewritten graph viewer and then check the diff.",
        timestamp: 2,
        toolCalls: [
          { id: "read", name: "read_file", arguments: { path: "/repo/MemoryGraphView.tsx" } },
        ],
        toolResults: [
          { toolCallId: "read", toolName: "read_file", content: hugeSource, isError: false },
        ],
      },
      { role: "user", content: "Current request after the big read.", timestamp: 3 },
    ]);

    const result = await truncateBeforeSend(
      chat,
      8000,
      "You are helpful.",
      undefined,
      undefined,
      [],
      undefined,
      async (removed) => {
        order.push(`hook:${removed.length}`);
        hookRemoved = removed;
      },
    );

    expect(result?.truncated).toBe(true);
    // The hook saw the removed messages — the flush gets the real content,
    // including bulky tool payloads.
    expect(hookRemoved.length).toBeGreaterThan(0);
    expect(hookRemoved.some((m) =>
      m.content?.includes("sigma source line") ||
      (m.toolResults ?? []).some((t) => t.content.includes("sigma source line"))
    )).toBe(true);
    // And it ran before the archive/index generation consumed them.
    expect(order[0]).toMatch(/^hook:/);
    expect(order).toContain("archived");
  });

  it("keeps visible assistant output by archiving its oversized tool payload", async () => {
    const { truncateBeforeSend } = await import("../services/compaction.js");
    const hugeResult = "large inspection payload\n".repeat(2500);
    const assistantOutput = "I inspected the implementation and found the next step.";
    const currentUser = "Please continue from the Sigma.js rewrite review.";
    const chat = makeChat([
      { role: "user", content: "Earlier context.", timestamp: 1 },
      { role: "user", content: currentUser, timestamp: 2 },
      {
        role: "assistant",
        content: assistantOutput,
        thinking: "The source read is large, but the conclusion is compact.",
        timestamp: 3,
        toolCalls: [
          { id: "read", name: "read_file", arguments: { path: "/repo/MemoryGraphView.tsx" } },
        ],
        toolResults: [
          { toolCallId: "read", toolName: "read_file", content: hugeResult, isError: false },
        ],
      },
    ]);

    const result = await truncateBeforeSend(chat, 6000, "You are helpful.", undefined, undefined, []);

    expect(result?.truncated).toBe(true);
    const activeAssistant = chat.messages.find(
      (m) => !m._outOfContext && m.role === "assistant" && m.content === assistantOutput,
    );
    expect(activeAssistant).toBeTruthy();
    expect(activeAssistant?.toolCalls).toBeUndefined();
    expect(activeAssistant?.toolResults).toBeUndefined();
    expect(chat.messages.some((m) => !m._outOfContext && m.role === "user" && m.content === currentUser)).toBe(true);
    expect(JSON.stringify(mockState.savedArchives)).toContain("large inspection payload");
    // Fix 4: the archived split head must carry the turn's final text too, so
    // read_archived_context returns the conclusion, not just tool activity.
    const strippedHead = mockState.savedArchives
      .flatMap((a: any) => a.messages)
      .find((m: any) => m._isSplitHead);
    expect(strippedHead?.content).toBe(assistantOutput);
  });

  it("carries the turn's final text onto a tool-pair-tail split head", async () => {
    const { truncateBeforeSend } = await import("../services/compaction.js");
    const hugeWriteContent = "bulk artifact payload line\n".repeat(2400);
    const finalText = "Final conclusion: the retention planner keeps visible output intact.";
    const currentUser = "Continue from the retention planner review.";
    const chat = makeChat([
      { role: "user", content: "Earlier setup request.", timestamp: 1 },
      { role: "assistant", content: "Earlier output.", timestamp: 2 },
      { role: "user", content: currentUser, timestamp: 3 },
      {
        role: "assistant",
        content: finalText,
        thinking: "Write the artifact, then verify the diff.",
        timestamp: 4,
        toolCalls: [
          { id: "write", name: "write_file", arguments: { path: "/repo/artifact.html", content: hugeWriteContent } },
          { id: "diff", name: "bash", arguments: { command: "git diff --stat HEAD" } },
        ],
        toolResults: [],
      },
    ]);

    const result = await truncateBeforeSend(chat, 8000, "You are helpful.", undefined, undefined, []);

    expect(result?.truncated).toBe(true);
    const splitHead = mockState.savedArchives
      .flatMap((a: any) => a.messages)
      .find((m: any) => m._isSplitHead);
    expect(splitHead).toBeTruthy();
    expect(splitHead?.content).toBe(finalText);
    expect(JSON.stringify(mockState.savedArchives)).toContain("bulk artifact payload line");
    // The kept tail still holds the final text and the surviving pair.
    const active = chat.messages.filter((m) => !m._outOfContext);
    expect(active.some((m) => m.role === "assistant" && m.content === finalText)).toBe(true);
  });

  it("decomposes the removed count: the split head is a partial unit, not a whole removed message", async () => {
    const { truncateBeforeSend } = await import("../services/compaction.js");
    const hugeWriteContent = "bulk artifact payload line\n".repeat(2400);
    const finalText = "Final conclusion: the retention planner keeps visible output intact.";
    const currentUser = "Continue from the retention planner review.";
    const chat = makeChat([
      { role: "user", content: "Earlier setup request.", timestamp: 1 },
      { role: "assistant", content: "Earlier output.", timestamp: 2 },
      { role: "user", content: currentUser, timestamp: 3 },
      {
        role: "assistant",
        content: finalText,
        thinking: "Write the artifact, then verify the diff.",
        timestamp: 4,
        toolCalls: [
          { id: "write", name: "write_file", arguments: { path: "/repo/artifact.html", content: hugeWriteContent } },
          { id: "diff", name: "bash", arguments: { command: "git diff --stat HEAD" } },
        ],
        toolResults: [],
      },
    ]);

    const result = await truncateBeforeSend(chat, 8000, "You are helpful.", undefined, undefined, []);

    expect(result?.truncated).toBe(true);
    // Everything except the bulky payload fits in the window, so the planner
    // keeps the whole older pair and the ONLY removed unit is the split head
    // of the bulky turn — a pure partial compaction (0 whole messages). This
    // is the case the old UI misreported as "0 messages compacted"; the
    // decomposed count renders as "Partial turn archived" instead.
    expect(result?.removedCount).toBe(1);
    expect(result?.removedSplitCount).toBe(1);
    // The summary carries the same decomposition for the UI.
    const summary = chat.messages.find((m) => m._isCompactionSummary);
    expect(summary?._compactedMessageCount).toBe(1);
    expect(summary?._compactedSplitCount).toBe(1);
  });

  it("backfills across a single completed tool-only row by keeping an archived placeholder", async () => {
    const { truncateBeforeSend } = await import("../services/compaction.js");
    const hugeResult = "route handler line with chat compaction and tool loop state\n".repeat(2200);
    const recentOutput = "Recent conclusion: the resume path owns the handoff and prompt rebuild.";
    const currentUser = "Please continue by patching the retention planner.";
    const chat = makeChat([
      { role: "user", content: "Earlier setup request.", timestamp: 1 },
      { role: "assistant", content: recentOutput, timestamp: 2 },
      { role: "user", content: currentUser, timestamp: 3 },
      {
        role: "assistant",
        content: "",
        thinking: "I should inspect the chat route before editing compaction.",
        timestamp: 4,
        toolCalls: [
          { id: "read-route", name: "read_file", arguments: { path: "server/src/routes/chat.ts" } },
        ],
        toolResults: [
          { toolCallId: "read-route", toolName: "read_file", content: hugeResult, isError: false },
        ],
        segments: [
          {
            seq: 1,
            type: "tool_call",
            toolCall: { id: "read-route", name: "read_file", arguments: { path: "server/src/routes/chat.ts" } },
          },
          {
            seq: 2,
            type: "tool_result",
            toolResult: { toolCallId: "read-route", toolName: "read_file", content: hugeResult, isError: false },
          },
        ],
      },
      {
        role: "assistant",
        content: "I also checked the shared agent loop and can continue from the route seam.",
        timestamp: 5,
      },
    ]);

    const result = await truncateBeforeSend(chat, 10000, "You are helpful.", undefined, undefined, []);

    expect(result?.truncated).toBe(true);
    const active = chat.messages.filter((m) => !m._outOfContext);
    expect(active.some((m) => m.role === "user" && m.content === currentUser)).toBe(true);
    expect(active.some((m) => m.role === "assistant" && m.content === recentOutput)).toBe(true);

    const placeholder = active.find((m) => m.content.includes("Archived tool activity"));
    expect(placeholder).toBeTruthy();
    expect(placeholder?.content).toContain("read_file");
    expect(placeholder?.content).toContain("server/src/routes/chat.ts");
    expect(placeholder?.toolCalls).toBeUndefined();
    expect(placeholder?.toolResults).toBeUndefined();
    expect(placeholder?.segments).toBeUndefined();
    expect(JSON.stringify(active).length).toBeLessThan(5000);
    expect(JSON.stringify(mockState.savedArchives)).toContain("route handler line with chat compaction");
  });
});
