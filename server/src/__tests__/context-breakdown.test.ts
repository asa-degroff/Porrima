import { describe, expect, it } from "vitest";
import type { Chat, ChatMessage } from "../types.js";
import { computeContextBreakdown } from "../services/context-breakdown.js";
import { setCachedAugmentedPrompt } from "../services/memory-context.js";

function quickChat(messages: ChatMessage[], contextWindow = 32768): Chat {
  return {
    id: "chat-test",
    title: "Test",
    type: "quick",
    modelId: "test-model",
    systemPrompt: "You are a helpful assistant.",
    contextWindow,
    messages,
    createdAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
  };
}

describe("computeContextBreakdown", () => {
  it("classifies conversation content into user, assistant, thinking, and tool rows", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Hello there, how are you today?", timestamp: 1 },
      {
        role: "assistant",
        content: "I am doing well, thanks for asking.",
        thinking: "Let me think about how to respond politely.",
        toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "/tmp/x" } }],
        toolResults: [{ toolCallId: "c1", toolName: "read_file", content: "file contents here", isError: false }],
        usage: { input: 0, output: 0, totalTokens: 0 },
        timestamp: 2,
      },
    ];

    const result = computeContextBreakdown(quickChat(messages), 32768);

    const byKey = Object.fromEntries(result.rows.map((r) => [r.key, r.tokens]));
    expect(byKey.userMessages).toBeGreaterThan(0);
    expect(byKey.assistantText).toBeGreaterThan(0);
    expect(byKey.thinking).toBeGreaterThan(0);
    expect(byKey.toolCalls).toBeGreaterThan(0);
    expect(byKey.toolResults).toBeGreaterThan(0);
    expect(byKey.framing).toBeGreaterThan(0);
  });

  it("counts hidden system rows as memory, not conversation", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "## Updated context — my newly recalled memories:\n- likes tea", timestamp: 1 },
      { role: "user", content: "Hi", timestamp: 2 },
    ];

    const result = computeContextBreakdown(quickChat(messages), 32768);
    const memoryDelta = result.rows.find((r) => r.key === "memoryDelta");
    expect(memoryDelta).toBeDefined();
    expect(memoryDelta!.tokens).toBeGreaterThan(0);
    expect(memoryDelta!.group).toBe("memory");
  });

  it("skips out-of-context messages", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "visible message", timestamp: 1 },
      { role: "user", content: "hidden message that should not count", timestamp: 2, _outOfContext: true },
    ];

    const withHidden = computeContextBreakdown(quickChat(messages), 32768);
    const withoutHidden = computeContextBreakdown(quickChat([messages[0]]), 32768);

    const user = (r: ReturnType<typeof computeContextBreakdown>) =>
      r.rows.find((x) => x.key === "userMessages")?.tokens ?? 0;
    expect(user(withHidden)).toBe(user(withoutHidden));
  });

  it("scales input rows to the real usage anchor and reports real output", () => {
    const realInput = 10_000;
    const realOutput = 250;
    const messages: ChatMessage[] = [
      { role: "user", content: "a quick question", timestamp: 1 },
      {
        role: "assistant",
        content: "a short answer",
        usage: { input: realInput, output: realOutput, totalTokens: realInput + realOutput },
        timestamp: 2,
      },
    ];

    const result = computeContextBreakdown(quickChat(messages), 32768);

    expect(result.estimated).toBe(false);
    expect(result.outputTokens).toBe(realOutput);
    expect(result.inputTokens).toBe(realInput);

    const inputGroupSum = result.rows
      .filter((r) => r.group !== "output")
      .reduce((sum, r) => sum + r.tokens, 0);
    expect(inputGroupSum).toBe(realInput);
    expect(result.totalTokens).toBe(realInput + realOutput);
  });

  it("falls back to estimates when no usage anchor exists", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "first message, no response yet", timestamp: 1 },
    ];

    const result = computeContextBreakdown(quickChat(messages), 32768);
    expect(result.estimated).toBe(true);
    expect(result.outputTokens).toBe(0);
    expect(result.inputTokens).toBeGreaterThan(0);
  });

  it("ignores usage at or before the last compaction summary when anchoring", () => {
    // The pre-compaction reply's usage reflects the pre-compaction context
    // size — anchoring on it would inflate every row against the shrunken
    // current context. The summary itself carries usage too (defensive: it is
    // an assistant message) and must not anchor either.
    const messages: ChatMessage[] = [
      { role: "user", content: "lots of work happened here", timestamp: 1 },
      {
        role: "assistant",
        content: "pre-compaction reply",
        usage: { input: 95_000, output: 500, totalTokens: 95_500 },
        timestamp: 2,
      },
      {
        role: "assistant",
        content: "Summary of earlier compacted work.",
        _isCompactionSummary: true,
        usage: { input: 95_000, output: 300, totalTokens: 95_300 },
        timestamp: 3,
      },
      { role: "user", content: "continue", timestamp: 4 },
    ];

    const result = computeContextBreakdown(quickChat(messages), 32768);

    expect(result.usage).toBeNull();
    expect(result.estimated).toBe(true);
    expect(result.inputTokens).toBeLessThan(95_000);
  });

  it("anchors on the latest reply strictly after the last compaction summary", () => {
    const realInput = 40_000;
    const realOutput = 120;
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "pre-compaction reply",
        usage: { input: 95_000, output: 500, totalTokens: 95_500 },
        timestamp: 1,
      },
      { role: "assistant", content: "Summary of earlier compacted work.", _isCompactionSummary: true, timestamp: 2 },
      { role: "user", content: "continue", timestamp: 3 },
      {
        role: "assistant",
        content: "post-compaction reply",
        usage: { input: realInput, output: realOutput, totalTokens: realInput + realOutput },
        timestamp: 4,
      },
    ];

    const result = computeContextBreakdown(quickChat(messages), 32768);

    expect(result.estimated).toBe(false);
    expect(result.inputTokens).toBe(realInput);
    expect(result.outputTokens).toBe(realOutput);
  });

  it("reports cold sections when the rendered prompt is cached but no section breakdown was captured", () => {
    // Simulates a resumed prompt re-cached after a restart (or a
    // stable-prefix fallback): rendered-prompt cache warm, breakdown cache
    // empty. The cold-cache footnote must fire instead of silently inflating
    // the base-prompt row.
    const chatId = "chat-cold-sections";
    setCachedAugmentedPrompt(chatId, "a warm cached prompt without sections");
    const chat: Chat = { ...quickChat([]), id: chatId, type: "agent" };

    const result = computeContextBreakdown(chat, 32768);

    expect(result.promptCached).toBe(false);
  });

  it("counts compaction summaries separately from normal assistant text", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "Summary of earlier compacted work.", timestamp: 1, _isCompactionSummary: true },
      { role: "user", content: "continue", timestamp: 2 },
    ];

    const result = computeContextBreakdown(quickChat(messages), 32768);
    const summary = result.rows.find((r) => r.key === "compactionSummary");
    expect(summary).toBeDefined();
    expect(summary!.tokens).toBeGreaterThan(0);
  });
});
