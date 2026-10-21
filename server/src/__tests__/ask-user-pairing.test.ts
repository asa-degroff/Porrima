import { describe, expect, it } from "vitest";
import { chatMessagesToPiMessages } from "../services/agent.js";
import { findAskUserToolCallId, lastAskUserCallIdFromCalls } from "../services/pi-message-utils.js";

const ANSWER = "keep going[time: 2026-10-20 17:05 MDT (UTC-06:00)]";

function askUserRows() {
  return [
    {
      role: "assistant" as const,
      content: "",
      thinking: "I should ask what to prioritise.",
      timestamp: 1000,
      toolCalls: [{ id: "call_ask_1", name: "ask_user", arguments: { question: "which first?" } }],
      toolResults: [{ toolCallId: "call_ask_1", toolName: "ask_user", content: ANSWER, isError: false }],
      _toolLoopFragment: true,
    },
    { role: "user" as const, content: ANSWER, timestamp: 1001, _askUserAnswer: true },
  ];
}

describe("ask_user call-id resolution", () => {
  it("reads the id from the persisted accumulator calls", () => {
    expect(lastAskUserCallIdFromCalls([
      { id: "call_bash_1", name: "bash" },
      { id: "call_ask_1", name: "ask_user" },
      { id: "call_bash_2", name: "bash" },
    ])).toBe("call_ask_1");
  });

  it("prefers the most recent ask_user call", () => {
    expect(lastAskUserCallIdFromCalls([
      { id: "call_ask_old", name: "ask_user" },
      { id: "call_ask_new", name: "ask_user" },
    ])).toBe("call_ask_new");
  });

  it("returns null when nothing asked", () => {
    expect(lastAskUserCallIdFromCalls([{ id: "call_bash_1", name: "bash" }])).toBeNull();
    expect(lastAskUserCallIdFromCalls(undefined)).toBeNull();
  });

  it("falls back to the transcript when the pause state lost the id", () => {
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", id: "call_ask_1", name: "ask_user", arguments: {} }] },
      { role: "assistant", content: [{ type: "toolCall", id: "call_ask_2", name: "ask_user", arguments: {} }] },
    ] as any[];
    expect(findAskUserToolCallId(messages)).toBe("call_ask_2");
    expect(findAskUserToolCallId([{ role: "assistant", content: [{ type: "text", text: "hi" }] } as any])).toBeNull();
  });
});

describe("ask_user replay pairing", () => {
  it("replays the answer once, as the tool result of its own call", () => {
    const emitted = chatMessagesToPiMessages(askUserRows() as any, "test-model");

    expect(emitted.map((m: any) => m.role)).toEqual(["assistant", "toolResult"]);

    const assistant: any = emitted[0];
    const call = assistant.content.find((b: any) => b.type === "toolCall");
    expect(call?.name).toBe("ask_user");
    expect(call?.id).toBe("call_ask_1");

    const result: any = emitted[1];
    expect(result.toolCallId).toBe(call.id);
    expect(result.toolName).toBe("ask_user");
    // The invariant that matters: the answer is not also present as a user turn.
    expect(emitted.filter((m: any) => m.role === "user")).toHaveLength(0);
  });

  it("keeps a memory delta injected before the answer at its position", () => {
    const rows = [
      { role: "system" as const, content: "[System context — updated memories]\nnew fact", timestamp: 900, _isSystemMessage: true },
      ...askUserRows(),
    ];
    const emitted = chatMessagesToPiMessages(rows as any, "test-model");

    expect(emitted.map((m: any) => m.role)).toEqual(["user", "assistant", "toolResult"]);
    expect((emitted[0] as any).content).toContain("new fact");
    expect((emitted[0] as any).content).not.toContain(ANSWER);
  });

  it("leaves an unpaired answer replayable (fallback path)", () => {
    const rows = [{ role: "user" as const, content: ANSWER, timestamp: 1001 }];
    const emitted = chatMessagesToPiMessages(rows as any, "test-model");
    expect(emitted.map((m: any) => m.role)).toEqual(["user"]);
    expect((emitted[0] as any).content).toContain(ANSWER);
  });
});
