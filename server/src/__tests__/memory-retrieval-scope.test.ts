import { describe, expect, it } from "vitest";
import {
  applyGlobalProjectScoreMultiplier,
  applyCrossProjectScoreMultiplier,
  normalizeGlobalProjectScoreMultiplier,
  normalizeCrossProjectScoreMultiplier,
  sortByAdjustedScore,
} from "../services/memory-retrieval-scope.js";
import { buildMemoryRerankQuery, filterMemoriesAlreadyInCurrentContext } from "../services/memory-context.js";
import { KERNEL_STATE_COMPACT_NOTICE } from "../services/compaction-notice.js";
import type { ChatMessage, Memory } from "../types.js";

function memory(overrides: Partial<Memory>): Memory {
  return {
    id: overrides.id || "memory-1",
    text: overrides.text || "Remember the active topic.",
    category: overrides.category || "context",
    importance: overrides.importance ?? 5,
    embedding: overrides.embedding || [0.1, 0.2],
    createdAt: overrides.createdAt || new Date(0).toISOString(),
    lastAccessed: overrides.lastAccessed || new Date(0).toISOString(),
    accessCount: overrides.accessCount ?? 0,
    subject: overrides.subject || "",
    durability: overrides.durability || "durable",
    ...overrides,
  };
}

describe("memory retrieval project scoping", () => {
  it("builds memory-context rerank queries from recent real user messages", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Earlier topic about cache behavior.", timestamp: 1000 },
      { role: "assistant", content: "Some answer.", timestamp: 2000 },
      {
        role: "user",
        content: "[System: Context was compacted mid-turn.]\n\nKey context from this conversation\n" + "x".repeat(5000),
        timestamp: 3000,
      },
      { role: "user", content: "Why did the reranker fallback happen?", timestamp: 4000 },
    ];

    const query = buildMemoryRerankQuery(messages, 900);

    expect(query).toContain("Earlier topic about cache behavior.");
    expect(query).toContain("Why did the reranker fallback happen?");
    expect(query).not.toContain("[System:");
    expect(query).not.toContain("Key context from this conversation");
    expect(query.length).toBeLessThanOrEqual(900);
  });

  it("excludes automation trigger prompts from memory-context rerank queries", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Earlier useful context about memory retrieval.", timestamp: 1000 },
      {
        role: "user",
        content: "# Wake Cycle\n\nExplore something that interests you during your sleep cycle.",
        timestamp: 2000,
        _isSystemMessage: true,
        _isAutomationMessage: true,
        _automationTaskId: "builtin:wake",
      },
    ];

    const query = buildMemoryRerankQuery(messages, 900);

    expect(query).toContain("Earlier useful context");
    expect(query).not.toContain("Wake Cycle");
    expect(query).not.toContain("sleep cycle");
  });

  it("keeps the latest memory-context rerank query within the configured budget", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "first " + "a".repeat(1000), timestamp: 1000 },
      { role: "user", content: "second " + "b".repeat(1000), timestamp: 2000 },
      { role: "user", content: "latest " + "c".repeat(1000), timestamp: 3000 },
    ];

    const query = buildMemoryRerankQuery(messages, 500);

    expect(query).toContain("latest");
    expect(query.length).toBeLessThanOrEqual(500);
  });

  it("anchors thin rerank queries with the latest in-context compaction summary index", () => {
    const summary: ChatMessage = {
      role: "assistant",
      content:
        "KV snapshot parking design.\nReranker query construction review." +
        KERNEL_STATE_COMPACT_NOTICE +
        "User: can you review how the queries are constructed?\nVela: two builders feed one client.",
      timestamp: 2000,
      _isCompactionSummary: true,
    };
    const messages: ChatMessage[] = [
      { role: "user", content: "Start of the thread.", timestamp: 1000 },
      summary,
      { role: "user", content: "yeah, go with that", timestamp: 3000 },
    ];

    const query = buildMemoryRerankQuery(messages, 900);

    expect(query.startsWith("KV snapshot parking design")).toBe(true);
    expect(query).not.toContain("two builders feed one client");
    expect(query.endsWith("yeah, go with that"));
    expect(query.length).toBeLessThanOrEqual(900);
  });

  it("leaves substantial rerank queries untouched even when a summary exists", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content:
          "Why does the post-warm park skip the slot-identity guard when the workload counters double count on warm LCP prefills in the live regime?",
        timestamp: 1000,
      },
      {
        role: "assistant",
        content: "Compacted summary index." + KERNEL_STATE_COMPACT_NOTICE + "recap text",
        timestamp: 2000,
        _isCompactionSummary: true,
      },
      {
        role: "user",
        content: "And what does the value-inverted plan allocation do to the expensive just-changed heads under the hardware-derived capacity budget?",
        timestamp: 3000,
      },
    ];

    const query = buildMemoryRerankQuery(messages, 900);

    expect(query).not.toContain("Compacted summary index");
  });

  it("does not anchor thin queries when no compaction summary is in context", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "quick question here", timestamp: 1000 },
      { role: "assistant", content: "answer", timestamp: 2000 },
    ];

    const query = buildMemoryRerankQuery(messages, 900);

    expect(query).toBe("quick question here");
  });

  it("ignores out-of-context summaries when anchoring", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "Old topic index." + KERNEL_STATE_COMPACT_NOTICE + "old recap",
        timestamp: 1000,
        _isCompactionSummary: true,
        _outOfContext: true,
      },
      { role: "user", content: "ok, do it", timestamp: 2000 },
    ];

    const query = buildMemoryRerankQuery(messages, 900);

    expect(query).toBe("ok, do it");
  });

  it("anchors with the latest of multiple in-context summaries", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "Old phase topics." + KERNEL_STATE_COMPACT_NOTICE + "old recap",
        timestamp: 1000,
        _isCompactionSummary: true,
      },
      {
        role: "assistant",
        content: "New phase topics." + KERNEL_STATE_COMPACT_NOTICE + "new recap",
        timestamp: 2000,
        _isCompactionSummary: true,
      },
      { role: "user", content: "go ahead", timestamp: 3000 },
    ];

    const query = buildMemoryRerankQuery(messages, 900);

    expect(query).toContain("New phase topics");
    expect(query).not.toContain("Old phase topics");
  });

  it("clamps the anchor to the remaining query budget", () => {
    const longIndex = "topic word ".repeat(200).trim();
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: longIndex + KERNEL_STATE_COMPACT_NOTICE + "recap",
        timestamp: 1000,
        _isCompactionSummary: true,
      },
      { role: "user", content: "ok", timestamp: 2000 },
    ];

    const query = buildMemoryRerankQuery(messages, 400);

    expect(query.length).toBeLessThanOrEqual(400);
    expect(query.startsWith("topic word")).toBe(true);
    expect(query.endsWith("ok"));
  });

  it("anchors from the full summary when the composition marker is absent", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "old style summary body " + "z".repeat(100),
        timestamp: 1000,
        _isCompactionSummary: true,
      },
      { role: "user", content: "sure", timestamp: 2000 },
    ];

    const query = buildMemoryRerankQuery(messages, 900);

    expect(query).toContain("old style summary body");
  });

  it("sandwich-clamps long rerank-query messages, keeping head and tail", () => {
    const head = "opening framing of the pasted log";
    const tail = "the error line the user is asking about";
    const messages: ChatMessage[] = [
      { role: "user", content: head + " " + "m".repeat(2000) + " " + tail, timestamp: 1000 },
    ];

    const query = buildMemoryRerankQuery(messages, 900);

    expect(query.startsWith(head)).toBe(true);
    expect(query.endsWith(tail));
    expect(query).toContain("…");
    expect(query).not.toContain("[truncated]");
  });

  it("keeps three long messages within the total rerank budget", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "a".repeat(1500), timestamp: 1000 },
      { role: "user", content: "b".repeat(1500), timestamp: 2000 },
      { role: "user", content: "c".repeat(1500), timestamp: 3000 },
    ];

    const query = buildMemoryRerankQuery(messages, 1500);

    expect(query.length).toBeLessThanOrEqual(1500);
    expect(query.startsWith("b".repeat(249))).toBe(true);
    expect(query.endsWith("c".repeat(249)));
    expect(query).not.toContain("[truncated]");
  });

  it("passes medium messages through unclamped when the budget allows", () => {
    const text = "d".repeat(700);
    const messages: ChatMessage[] = [{ role: "user", content: text, timestamp: 1000 }];

    const query = buildMemoryRerankQuery(messages, 2500);

    expect(query).toBe(text);
  });

  it("keeps the custom-minimum profile inside its total budget", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "e".repeat(1500), timestamp: 1000 },
      { role: "user", content: "f".repeat(1500), timestamp: 2000 },
      { role: "user", content: "g".repeat(1500), timestamp: 3000 },
    ];

    const query = buildMemoryRerankQuery(messages, 400);

    expect(query.length).toBeLessThanOrEqual(400);
  });

  it("scrubs operational noise from rerank-query user messages", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content:
          "Can you look at server/src/services/memory-context.ts and tell me why read_file keeps failing on the slots endpoint?",
        timestamp: 1000,
      },
    ];

    const query = buildMemoryRerankQuery(messages, 900);

    expect(query).toContain("memory context");
    expect(query).toContain("slots endpoint");
    expect(query).not.toContain("server/src");
    expect(query).not.toContain("services");
    expect(query).not.toContain("read_file");
  });

  it("dampens cross-project scores without filtering them out", () => {
    const candidates = [
      { memory: { projectId: "other" }, score: 0.9 },
      { memory: { projectId: "current" }, score: 0.4 },
      { memory: {}, score: 0.3 },
    ];

    const count = applyCrossProjectScoreMultiplier(candidates, "current", 0.3);

    expect(count).toBe(1);
    expect(candidates[0].score).toBeCloseTo(0.27);
    expect(sortByAdjustedScore(candidates).map((candidate) => candidate.memory.projectId ?? "global")).toEqual([
      "current",
      "global",
      "other",
    ]);
  });

  it("allows a sufficiently specific cross-project memory to remain competitive", () => {
    const candidates = [
      { memory: { projectId: "other" }, score: 0.99 },
      { memory: { projectId: "current" }, score: 0.25 },
    ];

    applyCrossProjectScoreMultiplier(candidates, "current", 0.3);

    expect(sortByAdjustedScore(candidates)[0].memory.projectId).toBe("other");
  });

  it("normalizes invalid or out-of-range multipliers", () => {
    expect(normalizeCrossProjectScoreMultiplier(undefined)).toBe(0.3);
    expect(normalizeCrossProjectScoreMultiplier(-1)).toBe(0);
    expect(normalizeCrossProjectScoreMultiplier(2)).toBe(1);
  });

  it("dampens project-scoped memories for no-project chats when configured", () => {
    const candidates = [
      { memory: { projectId: "project-a" }, score: 0.9 },
      { memory: {}, score: 0.5 },
      { memory: { projectId: "project-b" }, score: 0.4 },
    ];

    const count = applyGlobalProjectScoreMultiplier(candidates, 0.5);

    expect(count).toBe(2);
    expect(candidates[0].score).toBeCloseTo(0.45);
    expect(candidates[2].score).toBeCloseTo(0.2);
    expect(sortByAdjustedScore(candidates).map((candidate) => candidate.memory.projectId ?? "global")).toEqual([
      "global",
      "project-a",
      "project-b",
    ]);
  });

  it("defaults global/project memory sharing to equal relevance", () => {
    expect(normalizeGlobalProjectScoreMultiplier(undefined)).toBe(1);
  });

  it("skips same-chat memories whose source messages are still in context", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Tell me about cache residency.", timestamp: 1000 },
      { role: "assistant", content: "Cache residency keeps the slot warm.", timestamp: 2000 },
    ];
    const candidates = [
      {
        memory: memory({
          id: "same-visible",
          sourceChatId: "chat-1",
          sourceMessageStartTimestamp: 1000,
          sourceMessageEndTimestamp: 2000,
        }),
        score: 0.9,
      },
      {
        memory: memory({
          id: "other-chat",
          sourceChatId: "chat-2",
          sourceMessageStartTimestamp: 1000,
          sourceMessageEndTimestamp: 2000,
        }),
        score: 0.8,
      },
    ];

    const filtered = filterMemoriesAlreadyInCurrentContext(candidates, "chat-1", messages, "test");

    expect(filtered.map((candidate) => candidate.memory.id)).toEqual(["other-chat"]);
  });

  it("keeps same-chat memories once their source messages are out of context", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Old topic", timestamp: 1000, _outOfContext: true },
      { role: "assistant", content: "Old answer", timestamp: 2000, _outOfContext: true },
      { role: "assistant", content: "Summary of compacted work", timestamp: 2500, _isCompactionSummary: true },
      { role: "user", content: "Return to the old topic.", timestamp: 3000 },
    ];
    const candidates = [
      {
        memory: memory({
          id: "same-compacted",
          sourceChatId: "chat-1",
          sourceMessageStartTimestamp: 1000,
          sourceMessageEndTimestamp: 2000,
        }),
        score: 0.9,
      },
    ];

    const filtered = filterMemoriesAlreadyInCurrentContext(candidates, "chat-1", messages, "test");

    expect(filtered.map((candidate) => candidate.memory.id)).toEqual(["same-compacted"]);
  });

  it("keeps same-chat memories when a meaningful part of their source span was compacted away", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Part 1", timestamp: 1000, _outOfContext: true },
      { role: "assistant", content: "Part 2", timestamp: 2000, _outOfContext: true },
      { role: "user", content: "Part 3", timestamp: 3000, _outOfContext: true },
      { role: "assistant", content: "Part 4", timestamp: 4000 },
      { role: "user", content: "Part 5", timestamp: 5000 },
    ];
    const candidates = [
      {
        memory: memory({
          id: "same-mixed",
          sourceChatId: "chat-1",
          sourceMessageStartTimestamp: 1000,
          sourceMessageEndTimestamp: 5000,
          sourceMessageStartIndex: 0,
          sourceMessageEndIndex: 4,
        }),
        score: 0.9,
      },
    ];

    const filtered = filterMemoriesAlreadyInCurrentContext(candidates, "chat-1", messages, "test");

    expect(filtered.map((candidate) => candidate.memory.id)).toEqual(["same-mixed"]);
  });

  it("skips same-chat memories when most of their source span is still visible", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Part 1", timestamp: 1000, _outOfContext: true },
      { role: "assistant", content: "Part 2", timestamp: 2000 },
      { role: "user", content: "Part 3", timestamp: 3000 },
      { role: "assistant", content: "Part 4", timestamp: 4000 },
      { role: "user", content: "Part 5", timestamp: 5000 },
    ];
    const candidates = [
      {
        memory: memory({
          id: "same-mostly-visible",
          sourceChatId: "chat-1",
          sourceMessageStartTimestamp: 1000,
          sourceMessageEndTimestamp: 5000,
          sourceMessageStartIndex: 0,
          sourceMessageEndIndex: 4,
        }),
        score: 0.9,
      },
    ];

    const filtered = filterMemoriesAlreadyInCurrentContext(candidates, "chat-1", messages, "test");

    expect(filtered).toEqual([]);
  });
});
