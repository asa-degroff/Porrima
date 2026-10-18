import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat, ChatMessage } from "../types.js";
import { getArchive, getChat, saveArchives } from "../services/chat-storage.js";

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

vi.mock("../services/agent.js", () => ({
  streamChat: vi.fn(),
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

  it("carries verbatim user and assistant prose into the summary recap", async () => {
    const { truncateBeforeSend } = await import("../services/compaction.js");
    const bigProse = "Deployment analysis line with staging configuration details.\n".repeat(400);
    const hugeLog = "log detail line about the failing subsystem\n".repeat(2500);
    const earlierAsk = "Earlier ask: the deployment target is staging and keep the change minimal.";
    const splitProse = "Findings: the config is consistent with the staging target.";
    const chat = makeChat([
      { role: "user", content: earlierAsk, timestamp: 1 },
      { role: "assistant", content: `Deployment target confirmed: staging.\n${bigProse}`, timestamp: 2 },
      { role: "user", content: "Follow-up after the analysis.", timestamp: 3 },
      {
        role: "assistant",
        content: splitProse,
        timestamp: 4,
        toolCalls: [{ id: "read-log", name: "read_file", arguments: { path: "/tmp/big.log" } }],
        toolResults: [{ toolCallId: "read-log", toolName: "read_file", content: hugeLog, isError: false }],
      },
      { role: "user", content: "Continue from the findings.", timestamp: 5 },
    ]);

    const result = await truncateBeforeSend(chat, 8000, "You are helpful.", undefined, undefined, []);

    expect(result?.truncated).toBe(true);
    const summary = chat.messages.find((m) => m._isCompactionSummary);
    expect(summary).toBeTruthy();
    const recap = summary?._archiveRecap ?? [];
    // Oldest -> newest, one line per removed prose row.
    expect(recap.length).toBe(2);
    expect(recap[0]).toMatch(/^user: Earlier ask/);
    expect(recap[1]).toMatch(/^assistant: Deployment target confirmed/);
    // The assistant excerpt keeps both ends of a long response.
    expect(recap[1]).toContain(" ... ");
    expect(summary?.content).toContain("Archived turn recap");
    expect(summary?.content).toContain(recap[0]);
    expect(summary?.content).toContain(recap[1]);
    // Split-head prose stays in the kept tail and must not be duplicated.
    expect(recap.join("\n")).not.toContain("Findings: the config");
    const active = chat.messages.filter((m) => !m._outOfContext);
    expect(active.some((m) => m.content === splitProse)).toBe(true);
    // The archive keeps the full removed prose.
    expect(JSON.stringify(mockState.savedArchives)).toContain("staging configuration details");
  });

  it("carries forward the previous summary's recap when that summary is removed", async () => {
    const { truncateBeforeSend } = await import("../services/compaction.js");
    const bigProse = "Deployment analysis line with staging configuration details.\n".repeat(400);
    const hugeLog = "log detail line about the failing subsystem\n".repeat(2500);
    const priorRecap = [
      "user: an earlier promise from the previous era",
      "assistant: an earlier conclusion",
    ];
    const chat = makeChat([
      {
        role: "assistant",
        content: "[Compacted context — use read_archived_context to retrieve details]\nArchived blocks:\n- archive:retention-chat:001 — Earlier work",
        timestamp: 0,
        _isCompactionSummary: true,
        _compactedMessageCount: 4,
        _archiveIds: ["archive:retention-chat:001"],
        _archiveRecap: priorRecap,
      },
      { role: "user", content: "Earlier ask: the deployment target is staging.", timestamp: 1 },
      { role: "assistant", content: `Deployment target confirmed: staging.\n${bigProse}`, timestamp: 2 },
      { role: "user", content: "Follow-up after the analysis.", timestamp: 3 },
      {
        role: "assistant",
        content: "Findings: the config is consistent.",
        timestamp: 4,
        toolCalls: [{ id: "read-log", name: "read_file", arguments: { path: "/tmp/big.log" } }],
        toolResults: [{ toolCallId: "read-log", toolName: "read_file", content: hugeLog, isError: false }],
      },
      { role: "user", content: "Continue from the findings.", timestamp: 5 },
    ]);

    const result = await truncateBeforeSend(chat, 8000, "You are helpful.", undefined, undefined, []);

    expect(result?.truncated).toBe(true);
    const summaries = chat.messages.filter((m) => m._isCompactionSummary);
    expect(summaries.length).toBe(2);
    const activeSummary = summaries.find((m) => !m._outOfContext);
    const recap = activeSummary?._archiveRecap ?? [];
    // Carry first, then the fresh excerpts, still oldest -> newest overall.
    expect(recap[0]).toBe(priorRecap[0]);
    expect(recap[1]).toBe(priorRecap[1]);
    expect(recap[2]).toMatch(/^user: Earlier ask/);
    expect(recap[3]).toMatch(/^assistant: Deployment target confirmed/);
    expect(activeSummary?.content).toContain("an earlier promise from the previous era");
    // The removed summary row is not recapped as conversation content.
    expect(recap.some((line) => line.includes("Compacted context"))).toBe(false);
  });

  it("sizes the recap reserve from the 30% target with a half-budget clamp", async () => {
    const { computeRecapReserveTokens } = await import("../services/compaction.js");
    // 15% of the 30% target, below the 2048 ceiling.
    expect(computeRecapReserveTokens(32768, 32768 * 0.3, 0)).toBe(1474);
    // Capped at 2048 on large windows.
    expect(computeRecapReserveTokens(65536, 65536 * 0.3, 0)).toBe(2048);
    // Never more than half the post-overhead message budget.
    expect(computeRecapReserveTokens(8000, 2400, 2000)).toBe(200);
    // Tight windows get no reserve.
    expect(computeRecapReserveTokens(8000, 2400, 2400)).toBe(0);
  });

  it("shrinks recap excerpt caps to the reserve instead of emptying the recap", async () => {
    const { buildArchivedTurnRecap } = await import("../services/compaction.js");
    const longReply = "Conclusion about the staging deployment. ".repeat(300);
    const removed: ChatMessage[] = [
      { role: "user", content: "Please check the staging deployment.", timestamp: 1 },
      { role: "assistant", content: longReply, timestamp: 2 },
    ];

    // A 200-token reserve cannot afford the 1000-char assistant cap. Whole-
    // line trimming would drop that excerpt and then the user line, leaving
    // nothing; reserve-derived caps shorten the excerpt so the newest line
    // fits on its own.
    const recap = buildArchivedTurnRecap(removed, 200, 1);
    expect(recap.length).toBeGreaterThan(0);
    const last = recap[recap.length - 1];
    expect(last.startsWith("assistant: ")).toBe(true);
    expect(last.length).toBeLessThanOrEqual(1000 + 11);
    expect(last).toContain(" ... ");
  });

  it("counts recap costs and caps in the planner's scaled units", async () => {
    const { buildArchivedTurnRecap } = await import("../services/compaction.js");
    const removed: ChatMessage[] = [
      {
        role: "assistant",
        content: "Finding: the lease key is normalized before lookup. ".repeat(100),
        timestamp: 1,
      },
    ];

    // 300 scaled tokens at scale 1.5 = 200 raw tokens ~= 800 chars. The cap
    // divides the scale factor back out and the cost multiplies it on, so
    // the line fits the reserve. Unscaled math would build a 1000-char
    // excerpt costing 380 scaled tokens and trim to empty.
    const recap = buildArchivedTurnRecap(removed, 300, 1.5);
    expect(recap.length).toBe(1);
    expect(recap[0].startsWith("assistant: Finding:")).toBe(true);
  });

  it("skips promoted-thinking rows in the recap", async () => {
    const { buildArchivedTurnRecap } = await import("../services/compaction.js");
    const removed: ChatMessage[] = [
      {
        role: "assistant",
        content: "Promoted reasoning that should not be recapped.",
        _thinkingPromoted: true,
        timestamp: 1,
      },
      { role: "assistant", content: "The real reply stays in the recap.", timestamp: 2 },
    ];

    const recap = buildArchivedTurnRecap(removed, 2048, 1);
    expect(recap).toEqual(["assistant: The real reply stays in the recap."]);
  });

  it("preserves the recap and kernel notice when deferred enrichment rewrites the summary", async () => {
    const { truncateBeforeSend, enrichArchiveDescriptions, KERNEL_STATE_COMPACT_NOTICE } =
      await import("../services/compaction.js");
    const bigProse = "Deployment analysis line with staging configuration details.\n".repeat(400);
    const hugeLog = "log detail line about the failing subsystem\n".repeat(2500);
    const chat = makeChat([
      { role: "user", content: "Earlier ask: the deployment target is staging.", timestamp: 1 },
      { role: "assistant", content: `Deployment target confirmed: staging.\n${bigProse}`, timestamp: 2 },
      { role: "user", content: "Follow-up after the analysis.", timestamp: 3 },
      {
        role: "assistant",
        content: "Findings: the config is consistent.",
        timestamp: 4,
        toolCalls: [{ id: "read-log", name: "read_file", arguments: { path: "/tmp/big.log" } }],
        toolResults: [{ toolCallId: "read-log", toolName: "read_file", content: hugeLog, isError: false }],
      },
      { role: "user", content: "Continue from the findings.", timestamp: 5 },
    ]);

    const result = await truncateBeforeSend(chat, 8000, "You are helpful.", undefined, undefined, []);
    expect(result?.truncated).toBe(true);
    const summary = chat.messages.find((m) => m._isCompactionSummary);
    const archiveIds = summary?._archiveIds ?? [];
    expect(archiveIds.length).toBeGreaterThan(0);

    // Point the storage mocks at the in-memory results, then run enrichment.
    vi.mocked(getArchive).mockImplementation((id: string) =>
      mockState.savedArchives.find((a: any) => a.id === id));
    vi.mocked(getChat).mockResolvedValue(chat);
    const agentModule = await import("../services/agent.js");
    vi.mocked(agentModule.streamChat).mockResolvedValue({
      content: archiveIds.map((id) => `- ${id} — upgraded description`).join("\n"),
      thinking: "",
    } as any);

    await enrichArchiveDescriptions(chat.id, archiveIds, chat.modelId);

    const updated = chat.messages.find((m) => m._isCompactionSummary);
    expect(updated?.content).toContain("upgraded description");
    // Enrichment re-renders the full composition: index + notice + recap.
    expect(updated?.content).toContain(KERNEL_STATE_COMPACT_NOTICE);
    expect(updated?.content).toContain("Archived turn recap");
    expect(updated?.content).toContain("user: Earlier ask");
    expect(updated?._archiveRecap?.length).toBe(2);
  });
});
