import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../types";
import { applyFollowUpStart, isEmptyAssistantPlaceholder } from "./steeringPlaceholders";

const user = (content: string): ChatMessage => ({ role: "user", content, timestamp: 1 });
const assistant = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  role: "assistant",
  content: "",
  timestamp: 1,
  ...overrides,
});

describe("applyFollowUpStart", () => {
  it("clears the steering flag when the optimistic placeholder is last", () => {
    const messages = [user("first"), assistant({ _steeringPending: true })];

    const next = applyFollowUpStart(messages);

    expect(next).toHaveLength(2);
    expect(next[1]._steeringPending).toBeUndefined();
    expect(next[1].content).toBe("");
  });

  it("reuses a tool-loop continuation placeholder appended after the steering send", () => {
    // send() added [user, steering placeholder]; the tool-use turn then
    // appended a continuation placeholder before the queue drained.
    const messages = [
      user("first"),
      user("steer"),
      assistant({ _steeringPending: true }),
      assistant({ _toolLoopId: "loop-1" }),
    ];

    const next = applyFollowUpStart(messages);

    expect(next.map((m) => m.content)).toEqual(["first", "steer", ""]);
    expect(next.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(next[2]).toMatchObject({ content: "", _toolLoopId: "loop-1" });
    expect(next.some((m) => m._steeringPending)).toBe(false);
  });

  it("drops a superseded steering placeholder and appends a slot when the tail is finalized", () => {
    // Race variant: the continuation placeholder was already finalized by the
    // time the drained message was announced, so the response needs a fresh row.
    const messages = [
      user("steer"),
      assistant({ _steeringPending: true }),
      assistant({ content: "tool-loop response", _toolLoopId: "loop-1" }),
    ];

    const next = applyFollowUpStart(messages);

    expect(next.map((m) => m.content)).toEqual(["steer", "tool-loop response", ""]);
    expect(next.some((m) => m._steeringPending)).toBe(false);
  });

  it("reuses an existing empty tail placeholder for non-optimistic follow-ups", () => {
    const messages = [user("queued remotely"), assistant({ _toolLoopId: "loop-1" })];

    const next = applyFollowUpStart(messages);

    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ content: "", _toolLoopId: "loop-1" });
  });

  it("appends a placeholder for a pure follow-up when no slot exists", () => {
    const messages = [user("queued remotely"), assistant({ content: "done" })];

    const next = applyFollowUpStart(messages);

    expect(next).toHaveLength(3);
    expect(next[2]).toMatchObject({ role: "assistant", content: "" });
  });

  it("tolerates an empty list", () => {
    const next = applyFollowUpStart([]);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ role: "assistant", content: "" });
  });
});

describe("isEmptyAssistantPlaceholder", () => {
  it("treats text, thinking, tool calls, and compaction summaries as non-empty", () => {
    expect(isEmptyAssistantPlaceholder(assistant())).toBe(true);
    expect(isEmptyAssistantPlaceholder(assistant({ content: "hi" }))).toBe(false);
    expect(isEmptyAssistantPlaceholder(assistant({ thinking: "hmm" }))).toBe(false);
    expect(
      isEmptyAssistantPlaceholder(assistant({ toolCalls: [{ id: "1", name: "bash", arguments: {} }] })),
    ).toBe(false);
    expect(isEmptyAssistantPlaceholder(assistant({ _isCompactionSummary: true }))).toBe(false);
    expect(isEmptyAssistantPlaceholder(undefined)).toBe(false);
    expect(isEmptyAssistantPlaceholder(user("hi"))).toBe(false);
  });
});
