import { describe, expect, it } from "vitest";
import { upsertAssistantRow } from "../services/assistant-boundary.js";
import type { ChatMessage } from "../types.js";

/**
 * Placement rules for mid-loop assistant commits (issue #10 wire-order fix).
 * The cluster this replaces was real: fragment(call klTW) → steering row →
 * recall row → re-commit(call klTW + result) under a new loop id, appended
 * AFTER the injections — replay could then never reproduce the wire order
 * (call+result adjacent, injections after them).
 */

const frag = (loop: string, callId: string, opts: Partial<ChatMessage> = {}): ChatMessage => ({
  role: "assistant",
  content: "thinking out loud",
  timestamp: 100,
  toolCalls: [{ id: callId, name: "run_python", arguments: {} }],
  _toolLoopId: loop,
  _toolLoopFragment: true,
  ...opts,
});

const systemInject = (text: string): ChatMessage => ({
  role: "system",
  content: text,
  timestamp: 101,
  _isSystemMessage: true,
});

const withResults = (loop: string, callId: string): ChatMessage => ({
  ...frag(loop, callId),
  timestamp: 102,
  toolResults: [{ toolCallId: callId, toolName: "run_python", content: "42", isError: false }],
});

describe("upsertAssistantRow", () => {
  it("replaces an _inProgress row in place and carries identity", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi", timestamp: 1 },
      { role: "assistant", content: "partial", timestamp: 2, _inProgress: true, _rowId: "r1", _rowSequence: 1 },
    ];
    const out = upsertAssistantRow(messages, {
      role: "assistant", content: "done", timestamp: 3, _rowId: undefined,
    });
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toBe("done");
    expect(messages[1]._inProgress).toBeUndefined();
    expect(out._rowId).toBe("r1");
    expect(out._rowSequence).toBe(1);
  });

  it("replaces a committed fragment re-committed with the exact same call set, at the ORIGINAL position", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi", timestamp: 1 },
      Object.assign(frag("loop-A", "klTW"), { _rowId: "row-frag", _rowSequence: 1 }),
      systemInject("[System context - queued message]"),
      systemInject("[System context - passively recalled memories]"),
    ];
    const out = upsertAssistantRow(messages, withResults("loop-B", "klTW"));

    // No duplicate appended: length stable, pair at index 1, injections follow.
    expect(messages).toHaveLength(4);
    expect(messages[1].toolResults?.[0]?.toolCallId).toBe("klTW");
    expect(messages[1]._toolLoopId).toBe("loop-B"); // re-commit wins metadata
    expect(messages[1]._rowId).toBe("row-frag"); // durable identity preserved
    expect(messages[2].role).toBe("system");
    expect(messages[3].role).toBe("system");
    expect(out).toBe(messages[1]);
  });

  it("unions results so an earlier fragment's result is never dropped", () => {
    const first = { ...withResults("loop-A", "X1"), _rowId: "r1", _rowSequence: 1 };
    const messages: ChatMessage[] = [first];
    // Re-commit WITHOUT the result (drain split the accumulator).
    upsertAssistantRow(messages, frag("loop-B", "X1"));
    expect(messages).toHaveLength(1);
    expect(messages[0].toolResults?.map((t) => t.toolCallId)).toEqual(["X1"]);
    expect(messages[0]._rowId).toBe("r1");
  });

  it("keeps the re-commit's text when present, falls back to the fragment's when not", () => {
    const messages: ChatMessage[] = [Object.assign(frag("loop-A", "X1", { content: "pre text" }), { _rowId: "r" })];
    upsertAssistantRow(messages, { ...frag("loop-B", "X1"), content: "" });
    expect(messages[0].content).toBe("pre text");
    const messages2: ChatMessage[] = [Object.assign(frag("loop-A", "X1", { content: "pre text" }), { _rowId: "r" })];
    upsertAssistantRow(messages2, frag("loop-B", "X1", { content: "post text" }));
    expect(messages2[0].content).toBe("post text");
  });

  it("appends when the call sets differ (partial overlap stays conservative)", () => {
    const messages: ChatMessage[] = [Object.assign(frag("loop-A", "X1"), { _rowId: "r1" })];
    // Two calls, one shared — NOT an exact-set re-commit.
    upsertAssistantRow(messages, {
      role: "assistant",
      content: "",
      timestamp: 3,
      toolCalls: [
        { id: "X1", name: "a", arguments: {} },
        { id: "X2", name: "b", arguments: {} },
      ],
      _toolLoopId: "loop-B",
      _toolLoopFragment: true,
    });
    expect(messages).toHaveLength(2);
    expect(messages[1]._toolLoopId).toBe("loop-B");
  });

  it("appends a final (non-fragment) assistant even when call ids match a fragment", () => {
    const messages: ChatMessage[] = [Object.assign(frag("loop-A", "X1"), { _rowId: "r1" })];
    const out = upsertAssistantRow(messages, {
      role: "assistant",
      content: "final answer",
      timestamp: 5,
      toolCalls: [{ id: "X1", name: "a", arguments: {} }],
      _toolLoopId: "loop-A",
    });
    expect(messages).toHaveLength(2);
    expect(out._toolLoopFragment).toBeUndefined();
  });

  it("post-settle drain: the full-batch commit is merged in place by the turn_end re-commit, results + segments preserved", () => {
    // After the drain settle-wait the committed row carries the FULL call set
    // with every result and every segment (balanced state).
    const calls = [
      { id: "A1", name: "update_artifact", arguments: {} },
      { id: "B2", name: "save_memory", arguments: {} },
    ];
    const results = [
      { toolCallId: "A1", toolName: "update_artifact", content: "ok", isError: false },
      { toolCallId: "B2", toolName: "save_memory", content: "saved", isError: false },
    ];
    const segments = [
      { seq: 1, type: "text", content: "working" },
      { seq: 2, type: "tool_call", toolCall: calls[0] },
      { seq: 3, type: "tool_result", toolResult: results[0] },
      { seq: 4, type: "tool_call", toolCall: calls[1] },
      { seq: 5, type: "tool_result", toolResult: results[1] },
    ] as ChatMessage["segments"];
    const messages: ChatMessage[] = [
      { role: "user", content: "hi", timestamp: 1 },
      Object.assign(frag("loop-A", "A1"), {
        timestamp: 105,
        toolCalls: calls,
        toolResults: results,
        segments,
        _rowId: "row-full",
        _rowSequence: 1,
      }),
      systemInject("[System context - queued message]"),
    ];
    // The turn_end re-commit after the drain's reset: the pi message's call
    // set, but the accumulator is empty — no results, no segments.
    const out = upsertAssistantRow(messages, {
      role: "assistant",
      content: "working",
      timestamp: 104,
      toolCalls: calls,
      _toolLoopId: "loop-B",
      _toolLoopFragment: true,
    });
    // Merged in place — no duplicate row, no orphan; the fragment's results
    // and segments survive the merge (the re-commit lacks them).
    expect(messages).toHaveLength(3);
    expect(out.toolResults?.map((t) => t.toolCallId)).toEqual(["A1", "B2"]);
    expect(out.segments).toHaveLength(5);
    expect(out._toolLoopId).toBe("loop-B");
    expect(out._rowId).toBe("row-full");
    expect(messages[2].role).toBe("system"); // injection still after the pair
  });

  it("post-settle drain via _inProgress refresh: the re-commit merges into the refreshed row, not an append", () => {
    // A self-modifying tool checkpoint left the in-flight scratch row.
    const messages: ChatMessage[] = [
      { role: "user", content: "hi", timestamp: 1 },
      { role: "assistant", content: "partial", timestamp: 2, _inProgress: true, _rowId: "r-flight", _rowSequence: 1 },
    ];
    const calls = [{ id: "A1", name: "bash", arguments: { command: "npm run build" } }];
    const results = [{ toolCallId: "A1", toolName: "bash", content: "ok", isError: false }];
    const segments = [
      { seq: 1, type: "text", content: "working" },
      { seq: 2, type: "tool_call", toolCall: calls[0] },
      { seq: 3, type: "tool_result", toolResult: results[0] },
    ] as ChatMessage["segments"];
    // The drain's finalize commits the full batch — refreshing the scratch
    // row in place (the _inProgress flag is dropped by the replacement).
    const full = upsertAssistantRow(messages, {
      role: "assistant",
      content: "working",
      timestamp: 105,
      toolCalls: calls,
      toolResults: results,
      segments,
      _toolLoopId: "loop-A",
      _toolLoopFragment: true,
    });
    expect(messages).toHaveLength(2);
    expect(full._inProgress).toBeUndefined();
    // The turn_end re-commit after the drain's reset (empty accumulator).
    const out = upsertAssistantRow(messages, {
      role: "assistant",
      content: "working",
      timestamp: 104,
      toolCalls: calls,
      _toolLoopId: "loop-B",
      _toolLoopFragment: true,
    });
    expect(messages).toHaveLength(2); // merged in place — not appended
    expect(out.toolResults?.[0]?.toolCallId).toBe("A1");
    expect(out.segments).toHaveLength(3);
    expect(out._rowId).toBe("r-flight");
  });

  it("prefers an _inProgress refresh over fragment replacement", () => {
    const messages: ChatMessage[] = [
      Object.assign(frag("loop-A", "X1"), { _rowId: "r1", _rowSequence: 1 }),
      { role: "assistant", content: "in flight", timestamp: 2, _inProgress: true, _rowId: "r2", _rowSequence: 2 },
    ];
    upsertAssistantRow(messages, withResults("loop-A", "X1"));
    // The in-flight row (index 1) gets the refresh; the fragment is untouched.
    expect(messages).toHaveLength(2);
    expect(messages[1]._inProgress).toBeUndefined();
    expect(messages[1].content).toBe("thinking out loud");
    expect(messages[1].toolResults?.[0]?.toolCallId).toBe("X1");
    expect(messages[1]._rowId).toBe("r2");
    expect(messages[0].toolResults).toBeUndefined();
  });
});
