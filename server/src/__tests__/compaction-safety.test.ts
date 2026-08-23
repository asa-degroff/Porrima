import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat, ChatMessage } from "../types.js";

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

function makeChat(messages: ChatMessage[], id = "safety-chat"): Chat {
  return {
    id,
    title: "Compaction Safety",
    type: "agent",
    modelId: "test-model",
    systemPrompt: "You are helpful.",
    messages,
    createdAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
  };
}

// fb9cdb6f (Aug 19): a stale pre-compaction usage anchor (153625) survived in
// the retained tail after /compact, the unguarded anchor scan picked it up,
// the unbounded scale factor (14.8x) inflated the overhead, and the
// degenerate last-resort wiped ~19K of healthy context to a handful of
// messages. These tests pin each layer of the fix.
describe("compaction safety (fb9cdb6f regression)", () => {
  beforeEach(() => {
    mockState.savedArchives = [];
    mockState.nextArchiveSequence = 1;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ignores usage anchors that predate the most recent compaction summary (estimator)", async () => {
    const { estimateContextTokensWithExactToolResults } = await import("../services/compaction.js");

    const stale: ChatMessage[] = [
      {
        role: "assistant",
        content: "Pre-compaction work in progress.",
        usage: { input: 153_500, output: 125, totalTokens: 153_625 },
        timestamp: 1,
      },
      {
        role: "assistant",
        content: "Summary of earlier work.",
        _isCompactionSummary: true,
        timestamp: 2,
      },
      { role: "user", content: "New question after compaction.", timestamp: 3 },
    ];

    const refined = await estimateContextTokensWithExactToolResults(stale, "You are helpful.", []);
    expect(refined.contextBreakdown.displayPath).toBe("char_estimate");
    expect(refined.contextBreakdown.displayTokens).toBeLessThan(10_000);

    // Control: the same anchor WITHOUT a summary is still used.
    const fresh = stale.map((m) => ({ ...m }));
    delete (fresh[1] as ChatMessage)._isCompactionSummary;
    const refinedFresh = await estimateContextTokensWithExactToolResults(fresh, "You are helpful.", []);
    expect(refinedFresh.contextBreakdown.displayPath).toBe("usage_anchor");
    expect(refinedFresh.contextBreakdown.lastUsageTotal).toBe(153_625);
  });

  it("does not trigger end-of-turn compaction from a stale pre-summary usage anchor", async () => {
    const { truncateChatHistory } = await import("../services/compaction.js");
    const chat = makeChat([
      {
        role: "assistant",
        content: "Old work.",
        usage: { input: 153_500, output: 125, totalTokens: 153_625 },
        timestamp: 1,
      },
      {
        role: "assistant",
        content: "Summary of earlier work.",
        _isCompactionSummary: true,
        timestamp: 2,
      },
      { role: "user", content: "New question after compaction.", timestamp: 3 },
      {
        role: "assistant",
        content: "Recent reply.",
        usage: { input: 11_000, output: 100, totalTokens: 12_000 },
        timestamp: 4,
      },
    ]);

    // No knownUsage — the trigger must anchor on the post-summary reply (12K),
    // not the pre-compaction 153625.
    const result = await truncateChatHistory(chat, 113_152, false, undefined, undefined, undefined, "You are helpful.", []);

    expect(result.truncated).toBe(false);
    expect(chat.messages.every((m) => !m._outOfContext)).toBe(true);
  });

  it("clamps the scale factor when planning tokens diverge from char estimates", async () => {
    const { truncateBeforeSend } = await import("../services/compaction.js");
    // A FRESH anchor that massively diverges from the char estimate (no
    // summary involved): the raw scale would be ~thousands. Pre-fix this
    // inflated the ~27-token prompt into 80K of phantom overhead and hit the
    // degenerate last-resort; post-fix it clamps to 1.5x and keeps
    // everything.
    const chat = makeChat([
      { role: "user", content: "First message.", timestamp: 1 },
      {
        role: "assistant",
        content: "Short reply.",
        usage: { input: 100_000, output: 50, totalTokens: 100_050 },
        timestamp: 2,
      },
      { role: "user", content: "Second message.", timestamp: 3 },
    ]);
    const systemPrompt = "System prompt padding for scale clamp test. ".repeat(2);
    const warnSpy = vi.spyOn(console, "warn");

    const result = await truncateBeforeSend(chat, 113_152, systemPrompt, undefined, undefined, []);

    expect(result).toBeNull();
    expect(chat.messages.every((m) => !m._outOfContext)).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("scaleFactor clamped"));
  });

  it("skips compaction entirely when overhead alone exceeds the hard cap", async () => {
    const { truncateChatHistory } = await import("../services/compaction.js");
    // ~24-27K estimated tokens of prompt against a 20K window: overhead alone
    // is above the 95% hard cap. No compaction can fix a window this small
    // for this prompt — skip loudly instead of wiping to the last message.
    const systemPrompt = "System prompt padding for overhead test. ".repeat(2000);
    const chat = makeChat([
      { role: "user", content: "One.", timestamp: 1 },
      { role: "assistant", content: "Two.", timestamp: 2 },
      { role: "user", content: "Three.", timestamp: 3 },
    ]);
    const errorSpy = vi.spyOn(console, "error");

    const result = await truncateChatHistory(chat, 20_000, true, undefined, undefined, undefined, systemPrompt, []);

    expect(result.truncated).toBe(false);
    expect(chat.messages.every((m) => !m._outOfContext)).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("window too small"));
  });

  it("raises the target to overhead + margin instead of wiping when overhead exceeds the target", async () => {
    const { truncateChatHistory } = await import("../services/compaction.js");
    // ~35-41K estimated tokens of prompt against a 100K window: overhead is
    // above the 30% target (30K) but far below the 95% hard cap (95K).
    // Pre-fix the budget kept only the last message (overhead alone broke
    // the target); post-fix it keeps every recent message that fits within
    // overhead + margin and archives only the oversized old one.
    const systemPrompt = "System prompt padding for overhead test. ".repeat(3000);
    const big = "Old dense context that should be archived. ".repeat(600);
    const chat = makeChat([
      { role: "user", content: big, timestamp: 1 },
      { role: "assistant", content: "Mid reply.", timestamp: 2 },
      { role: "user", content: "Recent question.", timestamp: 3 },
      { role: "assistant", content: "Recent answer.", timestamp: 4 },
    ]);
    const warnSpy = vi.spyOn(console, "warn");

    const result = await truncateChatHistory(chat, 100_000, true, undefined, undefined, undefined, systemPrompt, []);

    expect(result.truncated).toBe(true);
    expect(result.removedCount).toBe(1);
    // The freshly inserted compaction summary is in-context; exclude it.
    const active = chat.messages.filter((m) => !m._outOfContext && !m._isCompactionSummary);
    expect(active.length).toBe(3);
    expect(active.some((m) => m.content === big)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("raising target"));
  });
});

// --- endOfTurnNeedsCompaction (fix 6: refined-estimator trigger at 0.80) ---
//
// Production dead band (Aug 9-23): a turn ended at 84.8% by raw final usage,
// under the old 0.85 trigger, so end-of-turn stayed quiet; the next turn's
// pre-send saw the refined estimate at 85.3%, crossed 0.85, and compacted
// while the user was already waiting. Fix 6 reads both signals (conservative
// max) against the earlier 0.80 end-of-turn threshold.
describe("endOfTurnNeedsCompaction", () => {
  const W = 100_000; // trigger at 0.80 → 80_000; old trigger at 0.85 → 85_000

  async function decision(lastUsage: number, estimatedTokens: number, hitContextLimit = false) {
    const { endOfTurnNeedsCompaction } = await import("../services/compaction.js");
    return endOfTurnNeedsCompaction({ lastUsage, estimatedTokens, contextWindow: W, hitContextLimit });
  }

  it("fires when the estimate crosses 0.80 but raw usage stays under (estimate-driven)", async () => {
    // Rows added after usage measurement (e.g. passive-recall injection) are
    // only visible to the estimate.
    const d = await decision(79_000, 82_000);
    expect(d.needsCompaction).toBe(true);
    expect(d.drivingTokens).toBe(82_000);
  });

  it("fires when raw usage crosses 0.80 but the estimate reads lower (measured wins — max, never min)", async () => {
    const d = await decision(81_000, 75_000);
    expect(d.needsCompaction).toBe(true);
    expect(d.drivingTokens).toBe(81_000);
  });

  it("fires at 84% — the production dead band the old 0.85 trigger let through", async () => {
    // 84.8% by usage / 85.3% by refined estimate: under the old shared
    // 0.85 trigger this turn stayed quiet at end-of-turn and the compaction
    // landed at pre-send. At 0.80 it compacts while the user is reading.
    const d = await decision(84_000, 84_500);
    expect(d.needsCompaction).toBe(true);
    expect(d.ratio).toBeCloseTo(0.845, 3);
  });

  it("stays quiet below 0.80", async () => {
    const d = await decision(78_000, 77_500);
    expect(d.needsCompaction).toBe(false);
    expect(d.drivingTokens).toBe(78_000);
    expect(d.ratio).toBeCloseTo(0.78, 3);
  });

  it("hitContextLimit forces compaction at any level", async () => {
    expect((await decision(50_000, 40_000, true)).needsCompaction).toBe(true);
    expect((await decision(50_000, 40_000, false)).needsCompaction).toBe(false);
  });

  it("degrades safely on a zero context window", async () => {
    const { endOfTurnNeedsCompaction } = await import("../services/compaction.js");
    const quiet = endOfTurnNeedsCompaction({ lastUsage: 10, estimatedTokens: 20, contextWindow: 0, hitContextLimit: false });
    expect(quiet.needsCompaction).toBe(false);
    expect(quiet.ratio).toBe(0);
    const forced = endOfTurnNeedsCompaction({ lastUsage: 10, estimatedTokens: 20, contextWindow: 0, hitContextLimit: true });
    expect(forced.needsCompaction).toBe(true);
  });
});
