/**
 * Turn-engine phase 2 exit criteria (doc §7) — end-of-turn compaction.
 *
 * runEndOfTurnCompaction (turn-compaction.ts) is a pure move of the inline
 * block it replaced in chat.ts. The decision function itself is pinned by
 * compaction-forensics.test.ts; here we pin what the move must preserve:
 * decision routing, the execution ordering (pulse settle → truncate →
 * pre-archive flush → save → aftermath), the keepalive wrap, the
 * negative-path log, and the truncated-only aftermath.
 *
 * Fakes: truncateChatHistory and saveChat (module mocks).
 * endOfTurnNeedsCompaction is the REAL one (importOriginal) — the routing
 * under test must run the production decision, not a mirror.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEndOfTurnCompaction } from "../services/turn-compaction.js";
import type { Chat, ChatMessage } from "../types.js";

interface TruncateCall {
  chat: unknown;
  contextWindow: number;
  forceCompact: boolean;
  onCompacting?: () => void;
  onKeepalive?: () => void;
  knownUsage?: number;
  systemPrompt?: string;
  tools?: unknown;
  onBeforeArchive?: (removed: unknown[]) => Promise<void>;
}

const h = vi.hoisted(() => ({
  order: [] as string[],
  truncateCalls: [] as TruncateCall[],
  truncateResult: { truncated: false, removedCount: 0 } as { truncated: boolean; removedCount: number },
  saveChatCalls: [] as Array<{ chat: unknown; opts?: unknown }>,
  saveChatError: null as Error | null,
}));

vi.mock("../services/chat-storage.js", () => ({
  saveChat: vi.fn(async (chat: unknown, opts?: unknown) => {
    h.order.push("saveChat");
    h.saveChatCalls.push({ chat, opts });
    if (h.saveChatError) throw h.saveChatError;
  }),
  // compaction.ts (loaded via importOriginal) also imports these — stubs so
  // the real module graph links cleanly; none of them run in these tests.
  getNextArchiveSequence: vi.fn(() => 1),
  saveArchives: vi.fn(async () => undefined),
  getArchive: vi.fn(() => null),
  getChat: vi.fn(() => null),
  withChatWriteLock: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
  updateChatTitle: vi.fn(async () => undefined),
}));

vi.mock("../services/compaction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/compaction.js")>();
  return {
    ...actual,
    truncateChatHistory: vi.fn(
      async (
        chat: unknown,
        contextWindow: number,
        forceCompact: boolean,
        onCompacting?: () => void,
        onKeepalive?: () => void,
        knownUsage?: number,
        systemPrompt?: string,
        tools?: unknown,
        onBeforeArchive?: (removed: unknown[]) => Promise<void>,
      ) => {
        h.order.push("truncate:start");
        h.truncateCalls.push({
          chat,
          contextWindow,
          forceCompact,
          onCompacting,
          onKeepalive,
          knownUsage,
          systemPrompt,
          tools,
          onBeforeArchive,
        });
        // The real truncateChatHistory runs the pre-archive hook BEFORE
        // archive/index generation — mirror the ordering seam.
        if (onBeforeArchive) {
          await onBeforeArchive([]);
        }
        h.order.push("truncate:end");
        return h.truncateResult;
      },
    ),
  };
});

function makeChat(): Chat {
  const messages = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message ${i}`,
    _outOfContext: i < 3,
  })) as unknown as ChatMessage[];
  return { id: "test-chat", messages } as unknown as Chat;
}

function spyLogs(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((c) => c.join(" ")).join("\n");
}

describe("runEndOfTurnCompaction — phase 2a move (doc §4.4, exit criteria §7)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    h.order.length = 0;
    h.truncateCalls.length = 0;
    h.saveChatCalls.length = 0;
    h.truncateResult = { truncated: false, removedCount: 0 };
    h.saveChatError = null;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("quiet path: below trigger — no truncate, no save, no aftermath; negative log carries the exact fields", async () => {
    const chat = makeChat();
    const onCompacted = vi.fn();
    const r = await runEndOfTurnCompaction({
      chat,
      contextWindow: 100_000,
      lastUsage: 70_000,
      estimatedTokens: 72_000,
      onCompacted,
    });
    expect(r).toEqual({ triggered: false, truncated: false, drivingTokens: 72_000, ratio: 0.72 });
    expect(h.truncateCalls).toHaveLength(0);
    expect(h.saveChatCalls).toHaveLength(0);
    expect(onCompacted).not.toHaveBeenCalled();
    const logs = spyLogs(logSpy);
    expect(logs).toContain(
      `End-of-turn check: no compaction (chat=test-chat, driving=72000/100000 ` +
        `(${(0.72 * 100).toFixed(1)}%, trigger=${0.8 * 100}%) [usage=70000, estimated=72000]`,
    );
  });

  it("fires on the refined estimate alone (max() semantics); aftermath gets both counts", async () => {
    const chat = makeChat(); // 10 messages, 3 out-of-context → remaining 7
    h.truncateResult = { truncated: true, removedCount: 5 };
    const onCompacted = vi.fn(async () => {
      h.order.push("onCompacted");
    });
    const r = await runEndOfTurnCompaction({
      chat,
      contextWindow: 100_000,
      lastUsage: 70_000,
      estimatedTokens: 82_000,
      onCompacted,
    });
    expect(r).toEqual({ triggered: true, truncated: true, drivingTokens: 82_000, ratio: 0.82 });
    expect(h.truncateCalls).toHaveLength(1);
    expect(h.truncateCalls[0].forceCompact).toBe(false); // lastUsage !== 0
    expect(h.truncateCalls[0].knownUsage).toBe(70_000);
    expect(h.saveChatCalls).toHaveLength(1);
    expect(h.saveChatCalls[0].opts).toEqual({ allowTruncation: true });
    expect(onCompacted).toHaveBeenCalledTimes(1);
    expect(onCompacted).toHaveBeenCalledWith({ removedCount: 5, remainingCount: 7 });
  });

  it("hitContextLimit forces the decision and force-compacts; usage=0 + over-trigger also force-compacts", async () => {
    const chat = makeChat();
    h.truncateResult = { truncated: true, removedCount: 1 };

    const r1 = await runEndOfTurnCompaction({
      chat,
      contextWindow: 100_000,
      lastUsage: 0,
      estimatedTokens: 10_000,
      hitContextLimit: true,
    });
    expect(r1.triggered).toBe(true);
    expect(h.truncateCalls[0].forceCompact).toBe(true);

    const r2 = await runEndOfTurnCompaction({
      chat,
      contextWindow: 100_000,
      lastUsage: 0,
      estimatedTokens: 82_000,
    });
    expect(r2.triggered).toBe(true);
    expect(h.truncateCalls[1].forceCompact).toBe(true); // (lastUsage === 0 && needsCompaction)
  });

  it("ordering: keepalive wrap → pulse settle → truncate → pre-archive flush → save → aftermath", async () => {
    const chat = makeChat();
    h.truncateResult = { truncated: true, removedCount: 2 };
    await runEndOfTurnCompaction({
      chat,
      contextWindow: 100_000,
      lastUsage: 82_000,
      estimatedTokens: 81_000,
      keepaliveWrap: async (body) => {
        h.order.push("wrap:start");
        await body();
        h.order.push("wrap:end");
      },
      settleInFlight: async () => {
        h.order.push("settle");
      },
      preFlush: async () => {
        h.order.push("preFlush");
      },
      onCompacted: async () => {
        h.order.push("onCompacted");
      },
    });
    expect(h.order).toEqual([
      "wrap:start",
      "settle",
      "truncate:start",
      "preFlush",
      "truncate:end",
      "saveChat",
      "onCompacted",
      "wrap:end",
    ]);
  });

  it("emitters, flush hook, prompt, tools, and known usage pass through to truncateChatHistory by identity", async () => {
    const chat = makeChat();
    h.truncateResult = { truncated: false, removedCount: 0 };
    const emitCompacting = vi.fn();
    const emitKeepalive = vi.fn();
    const preFlush = vi.fn(async () => {});
    const tools = [{ name: "t" }];
    await runEndOfTurnCompaction({
      chat,
      contextWindow: 100_000,
      lastUsage: 82_000,
      estimatedTokens: 0,
      emitCompacting,
      emitKeepalive,
      preFlush,
      systemPrompt: "the-system-prompt",
      tools,
    });
    const c = h.truncateCalls[0];
    expect(c.onCompacting).toBe(emitCompacting);
    expect(c.onKeepalive).toBe(emitKeepalive);
    expect(c.onBeforeArchive).toBe(preFlush);
    expect(c.systemPrompt).toBe("the-system-prompt");
    expect(c.tools).toBe(tools);
    expect(c.knownUsage).toBe(82_000);
    expect(c.contextWindow).toBe(100_000);
  });

  it("triggered but not truncated → no save, no aftermath", async () => {
    const chat = makeChat();
    h.truncateResult = { truncated: false, removedCount: 0 };
    const onCompacted = vi.fn();
    const r = await runEndOfTurnCompaction({
      chat,
      contextWindow: 100_000,
      lastUsage: 82_000,
      estimatedTokens: 0,
      onCompacted,
    });
    expect(r).toMatchObject({ triggered: true, truncated: false });
    expect(h.saveChatCalls).toHaveLength(0);
    expect(onCompacted).not.toHaveBeenCalled();
  });

  it("triggerRatio override: 0.82 quiet at 0.85, and the log renders the ratio in force (D2/D3 seam)", async () => {
    const chat = makeChat();
    const r = await runEndOfTurnCompaction({
      chat,
      contextWindow: 100_000,
      lastUsage: 0,
      estimatedTokens: 82_000,
      triggerRatio: 0.85,
    });
    expect(r.triggered).toBe(false);
    expect(h.truncateCalls).toHaveLength(0);
    const logs = spyLogs(logSpy);
    expect(logs).toContain(`trigger=${0.85 * 100}%`);
  });

  it("save failure: caught, logged, and NOT reported as a persisted truncation; aftermath skipped", async () => {
    const chat = makeChat();
    h.truncateResult = { truncated: true, removedCount: 3 };
    h.saveChatError = new Error("db down");
    const onCompacted = vi.fn();
    const r = await runEndOfTurnCompaction({
      chat,
      contextWindow: 100_000,
      lastUsage: 82_000,
      estimatedTokens: 0,
      onCompacted,
    });
    expect(r).toMatchObject({ triggered: true, truncated: false });
    expect(onCompacted).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith("[compaction] End-of-turn compaction failed:", expect.any(Error));
  });

  it("logPrefix: headless adoption seam (system-chat/automation get their own prefix)", async () => {
    const chat = makeChat();
    await runEndOfTurnCompaction({
      chat,
      contextWindow: 100_000,
      lastUsage: 1_000,
      estimatedTokens: 1_000,
      logPrefix: "[system-chat]",
    });
    const logs = spyLogs(logSpy);
    expect(logs).toContain("[system-chat] End-of-turn check: no compaction");
  });

  it("D3 log-only gate — fire: decision computed and logged, NOTHING executed", async () => {
    const chat = makeChat();
    const onCompacted = vi.fn();
    const r = await runEndOfTurnCompaction({
      chat,
      contextWindow: 100_000,
      lastUsage: 88_000,
      estimatedTokens: 90_000,
      logOnly: true,
      logPrefix: "[automation:test-task]",
      onCompacted,
    });
    expect(r).toEqual({ triggered: true, truncated: false, drivingTokens: 90_000, ratio: 0.9 });
    expect(h.truncateCalls).toHaveLength(0); // the gate: no execution
    expect(h.saveChatCalls).toHaveLength(0);
    expect(onCompacted).not.toHaveBeenCalled();
    const logs = spyLogs(logSpy);
    // Formatted like the positive-path log so the gate-week data is
    // directly comparable to post-flip behavior.
    expect(logs).toContain(
      "[automation:test-task] End-of-turn check (log-only, D3 gate): WOULD trigger " +
        `(chat=test-chat, driving=90000/100000 (90.0%, trigger=80%) ` +
        `[usage=88000, estimated=90000]) — computed, not executed`,
    );
  });

  it("D3 log-only gate — same input WITHOUT the flag executes: the flip is a one-line removal", async () => {
    const chat = makeChat();
    h.truncateResult = { truncated: true, removedCount: 4 };
    const r = await runEndOfTurnCompaction({
      chat,
      contextWindow: 100_000,
      lastUsage: 88_000,
      estimatedTokens: 90_000,
    });
    expect(r).toEqual({ triggered: true, truncated: true, drivingTokens: 90_000, ratio: 0.9 });
    expect(h.truncateCalls).toHaveLength(1);
    expect(h.saveChatCalls).toHaveLength(1);
  });

  it("D3 log-only gate — quiet path: negative log carries the gate tag, no execution", async () => {
    const chat = makeChat();
    const r = await runEndOfTurnCompaction({
      chat,
      contextWindow: 100_000,
      lastUsage: 40_000,
      estimatedTokens: 42_000,
      logOnly: true,
    });
    expect(r.triggered).toBe(false);
    expect(h.truncateCalls).toHaveLength(0);
    const logs = spyLogs(logSpy);
    expect(logs).toContain("[compaction] End-of-turn check (log-only, D3 gate): no compaction");
  });

  it("D3 log-only gate — hitContextLimit also computes-and-logs only (the gate covers the forced path)", async () => {
    const chat = makeChat();
    const r = await runEndOfTurnCompaction({
      chat,
      contextWindow: 100_000,
      lastUsage: 0,
      estimatedTokens: 10_000,
      hitContextLimit: true,
      logOnly: true,
    });
    // Without the gate this would force-compact; with it, the first
    // stopReason=length automation run of the gate week changes nothing.
    expect(r).toMatchObject({ triggered: true, truncated: false });
    expect(h.truncateCalls).toHaveLength(0);
    expect(h.saveChatCalls).toHaveLength(0);
  });
});
