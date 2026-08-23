import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat, ChatMessage } from "../types.js";

const mockState = vi.hoisted(() => ({
  savedArchives: [] as any[],
  nextArchiveSequence: 1,
}));

// Same module mocks as compaction-safety.test.ts — importing compaction.js
// pulls the storage/title/extraction stack, none of which matters here.
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

function makeChat(messages: ChatMessage[], id = "forensics-chat"): Chat {
  return {
    id,
    title: "Forensics Regression",
    type: "agent",
    modelId: "test-model",
    systemPrompt: "You are helpful.",
    messages,
    createdAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
  };
}

// Content sizing: ~4 chars/token for prose (estimateTextTokens "default").
// 336_000 chars ≈ 84_000 tokens — a context that genuinely sits near a 100K
// window, so the budget math has real content to remove, not just a usage
// number (the fb9cdb6f failure mode: usage said 85K, chars said 5K).
const BIG_PROSE = "Context block. ".repeat(24_000); // 336_000 chars ≈ 84K tokens

// 14-day forensics (Aug 09–23), converted to named regression tests per
// docs/design/turn-engine.md Phase 0. These pin CURRENT behavior before the
// turn-engine refactor moves any of it. The production numbers are the
// assertions: they are what the logs recorded, not approximations.
describe("14-day forensics regressions (Aug 09–23)", () => {
  beforeEach(() => {
    mockState.savedArchives = [];
    mockState.nextArchiveSequence = 1;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dead band (Aug 22): 84.8% usage / 85.3% refined estimate fires at end-of-turn", async () => {
    const { endOfTurnNeedsCompaction } = await import("../services/compaction.js");
    // Chat 89c48c29: the turn ended at 84.8% by raw final usage. Under the
    // old single-signal 0.85 trigger end-of-turn stayed quiet; the refined
    // estimate read 85.3%, so compaction landed at pre-send — while the user
    // was already waiting (7-minute send-to-first-token gap). Either signal
    // crossing 0.80 now compacts while the user is reading.
    const d = endOfTurnNeedsCompaction({
      lastUsage: 84_800,
      estimatedTokens: 85_300,
      contextWindow: 100_000,
      hitContextLimit: false,
    });
    expect(d.needsCompaction).toBe(true);
    // Conservative max: the estimate drives, never the lower usage.
    expect(d.drivingTokens).toBe(85_300);
    expect(d.ratio).toBeCloseTo(0.853, 3);
  });

  it("boundary: exactly 0.80 is quiet (strict >), one token over fires", async () => {
    const { endOfTurnNeedsCompaction } = await import("../services/compaction.js");
    // The comparator is strict: 80_000/100_000 === 0.8 (identical double), so
    // a turn landing exactly on the trigger does NOT compact. Pinning the
    // exact boundary so a later "fix" to >= (or a rounding change) is a
    // deliberate behavioral decision, not a refactor side effect.
    const at = endOfTurnNeedsCompaction({ lastUsage: 80_000, estimatedTokens: 80_000, contextWindow: 100_000, hitContextLimit: false });
    expect(at.needsCompaction).toBe(false);
    expect(at.ratio).toBe(0.8);
    const over = endOfTurnNeedsCompaction({ lastUsage: 80_001, estimatedTokens: 80_001, contextWindow: 100_000, hitContextLimit: false });
    expect(over.needsCompaction).toBe(true);
    expect(over.ratio).toBeCloseTo(0.80001, 5);
  });

  it("negative path: the quiet decision carries the exact fields the no-compaction log renders", async () => {
    const { endOfTurnNeedsCompaction } = await import("../services/compaction.js");
    // Main-route end-of-turn fired 0× in 14 days and the check was
    // unobservable — fix 8 (Aug 23) added the negative-path log at
    // chat.ts: "End-of-turn check: no compaction (chat=…, driving=X/Y
    // (Z%, trigger=80%) [usage=…, estimated=…])". This pins the fields that
    // line renders, so Phase 1/2's evaluateTurnGuards must return the same
    // shape or the observability we just gained silently breaks.
    const d = endOfTurnNeedsCompaction({
      lastUsage: 79_800,
      estimatedTokens: 79_900,
      contextWindow: 100_000,
      hitContextLimit: false,
    });
    expect(d).toEqual({ needsCompaction: false, drivingTokens: 79_900, ratio: 0.799 });
  });

  it("pre-send fire: refined display above 0.85 compacts down to target (14-day: 10 fires, 7 at cycle starts)", async () => {
    const { truncateBeforeSend } = await import("../services/compaction.js");
    // The 10 pre-send fires in the forensic window were the backstop doing
    // its job: display = usage anchor (84K) + post-anchor delta (≈3K) crosses
    // 0.85×100K. The context is REAL 84K of content (big user message), so the
    // budget has something to remove: the oversized old message goes, the
    // recent tail stays.
    const chat = makeChat([
      { role: "user", content: BIG_PROSE, timestamp: 1 },
      {
        role: "assistant",
        content: "Done with the big request.",
        usage: { input: 83_900, output: 100, totalTokens: 84_000 },
        timestamp: 2,
      },
      { role: "user", content: "Follow-up. ".repeat(1_500), timestamp: 3 }, // 12_000 chars ≈ 3K tokens
    ]);
    const onCompacting = vi.fn();
    const logSpy = vi.spyOn(console, "log");

    const result = await truncateBeforeSend(chat, 100_000, "You are helpful.", onCompacting, undefined, []);

    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(true);
    expect(result!.removedCount).toBeGreaterThanOrEqual(1);
    // The oversized old message is what went; the recent tail is intact.
    expect(chat.messages[0]._outOfContext).toBe(true);
    const tail = chat.messages.filter((m) => !m._outOfContext && !m._isCompactionSummary);
    expect(tail.some((m) => m.content === "Follow-up. ".repeat(1_500))).toBe(true);
    expect(onCompacting).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Pre-send truncation triggered"));
  });

  it("pre-send quiet: 82.5% display does not trigger (0.85 stays a backstop, not a new compaction)", async () => {
    const { truncateBeforeSend } = await import("../services/compaction.js");
    // Same shape as the fire case, anchor at 82K: display ≈ 82.5K, under the
    // 0.85 trigger and far from the 0.95 hard cap / 1.15 char-safety paths.
    // Pre-send must return null and touch nothing.
    const chat = makeChat([
      { role: "user", content: BIG_PROSE, timestamp: 1 },
      {
        role: "assistant",
        content: "Done with the big request.",
        usage: { input: 81_900, output: 100, totalTokens: 82_000 },
        timestamp: 2,
      },
      { role: "user", content: "Small follow-up.", timestamp: 3 },
    ]);
    const logSpy = vi.spyOn(console, "log");

    const result = await truncateBeforeSend(chat, 100_000, "You are helpful.", undefined, undefined, []);

    expect(result).toBeNull();
    expect(chat.messages.every((m) => !m._outOfContext)).toBe(true);
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("Pre-send truncation triggered"));
  });

  it("system-chat >100%: the decision fires above ratio 1.0 (2 of 3 forensic fires were over the window)", async () => {
    const { endOfTurnNeedsCompaction } = await import("../services/compaction.js");
    // System-chat end-of-turn fired 3× in the window, twice with the context
    // ALREADY over 100% — char-only estimates (and a stale denominator) were
    // under-reading headless context, so by the time the check ran the window
    // was already breached. The decision must not assume ratio < 1: it fires
    // above 1.0 with the measured usage driving.
    const slight = endOfTurnNeedsCompaction({ lastUsage: 102_000, estimatedTokens: 95_000, contextWindow: 100_000, hitContextLimit: false });
    expect(slight.needsCompaction).toBe(true);
    expect(slight.drivingTokens).toBe(102_000);
    expect(slight.ratio).toBeCloseTo(1.02, 3);
    const deep = endOfTurnNeedsCompaction({ lastUsage: 118_000, estimatedTokens: 105_000, contextWindow: 100_000, hitContextLimit: false });
    expect(deep.needsCompaction).toBe(true);
    expect(deep.drivingTokens).toBe(118_000);
    expect(deep.ratio).toBeCloseTo(1.18, 3);
  });

  it("system-chat >100%: over-window context still compacts to target — no wipe, no silent skip", async () => {
    const { truncateChatHistory } = await import("../services/compaction.js");
    // The truncation side of the same forensics: measured usage of 118K
    // against a 100K window (denominator under-read, usage real). Compaction
    // must remove the oversized old content and keep the recent tail — not
    // error out, not hit the "window too small" skip (overhead is small here),
    // and not wipe to the last message.
    const chat = makeChat([
      { role: "user", content: BIG_PROSE, timestamp: 1 },
      {
        role: "assistant",
        content: "Summary of the big work.",
        usage: { input: 117_900, output: 100, totalTokens: 118_000 },
        timestamp: 2,
      },
      { role: "user", content: "Recent question.", timestamp: 3 },
      { role: "assistant", content: "Recent answer.", timestamp: 4 },
    ]);
    const errorSpy = vi.spyOn(console, "error");

    const result = await truncateChatHistory(chat, 100_000, false, undefined, undefined, 118_000, "You are helpful.", []);

    expect(result.truncated).toBe(true);
    expect(result.removedCount).toBeGreaterThanOrEqual(1);
    const active = chat.messages.filter((m) => !m._outOfContext && !m._isCompactionSummary);
    expect(active.some((m) => m.content === "Recent question.")).toBe(true);
    expect(active.some((m) => m.content === "Recent answer.")).toBe(true);
    expect(active.some((m) => m.content === BIG_PROSE)).toBe(false);
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("window too small"));
  });
});
