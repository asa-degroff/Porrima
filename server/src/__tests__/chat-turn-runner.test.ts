import { describe, expect, it } from "vitest";
import type { ToolCall } from "@earendil-works/pi-ai";
import { chatMessagesToPiMessages } from "../services/agent.js";
import {
  buildTransientIterations,
  splitAssistantMessageIntoCanonicalToolLoopRows,
  type IterationMarker,
} from "../services/chat-turn-runner.js";
import type { ChatMessage, ChatToolResult } from "../types.js";

describe("headless chat turn persistence", () => {
  it("splits collapsed assistant tool output into canonical replay rows", () => {
    const aggregate: ChatMessage = {
      role: "assistant",
      content: "Done with the update.",
      thinking: "Need to call the notebook tool.",
      usage: { input: 10, output: 5, totalTokens: 15 },
      toolCalls: [{ id: "call-1", name: "create_notebook_entry", arguments: { title: "Note" } }],
      toolResults: [{ toolCallId: "call-1", toolName: "create_notebook_entry", content: "Notebook entry saved", isError: false }],
      timestamp: 123,
      _isSystemMessage: true,
      _isAutomationMessage: true,
      _api: "openai-compat",
      _provider: "llamacpp",
      _model: "test-model",
    };

    const rows = splitAssistantMessageIntoCanonicalToolLoopRows(aggregate, "loop-1");

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      role: "assistant",
      content: "",
      thinking: "Need to call the notebook tool.",
      toolCalls: aggregate.toolCalls,
      toolResults: aggregate.toolResults,
      _toolLoopId: "loop-1",
      _toolLoopFragment: true,
      _isAutomationMessage: true,
    });
    expect(rows[1]).toMatchObject({
      role: "assistant",
      content: "Done with the update.",
      usage: aggregate.usage,
      _toolLoopId: "loop-1",
      _isAutomationMessage: true,
    });
    expect(rows[1].toolCalls).toBeUndefined();
    expect(rows[1].toolResults).toBeUndefined();
    expect(rows[1]._toolLoopFragment).toBeUndefined();

    const replay = chatMessagesToPiMessages(rows, "fallback-model");
    expect(replay.map((message) => message.role)).toEqual(["assistant", "toolResult", "assistant"]);
    expect(replay[0]).toMatchObject({ role: "assistant", stopReason: "toolUse" });
    expect(replay[2]).toMatchObject({ role: "assistant", stopReason: "stop" });
  });
});

describe("buildTransientIterations", () => {
  const call = (id: string, name = "bash"): ToolCall => ({ type: "toolCall", id, name, arguments: {} });
  const result = (toolCallId: string): ChatToolResult => ({
    toolCallId,
    toolName: "bash",
    content: `result for ${toolCallId}`,
    isError: false,
  });
  const zeroBoundary: IterationMarker = { textChunks: 0, thinkingChunks: 0, toolCalls: 0, toolResults: 0 };

  it("rebuilds one aligned message per sealed iteration (no off-by-one on tool calls)", () => {
    // pi-agent-core emits turn_end AFTER tool execution, so marker i already
    // includes iteration i's calls and results. Pin the alignment: message i
    // must carry iteration i's OWN calls/results, not iteration i-1's.
    const marker1: IterationMarker = { textChunks: 1, thinkingChunks: 1, toolCalls: 1, toolResults: 1 };
    const marker2: IterationMarker = { textChunks: 2, thinkingChunks: 3, toolCalls: 3, toolResults: 3 };

    const messages = buildTransientIterations(zeroBoundary, [marker1, marker2], {
      textChunks: ["text-1", "text-2"],
      thinkingChunks: ["think-1", "think-2a", "think-2b"],
      toolCalls: [call("c1"), call("c2"), call("c3")],
      toolResults: [result("c1"), result("c2"), result("c3")],
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: "text-1",
      thinking: "think-1",
      toolCalls: [{ id: "c1", name: "bash", arguments: {} }],
    });
    expect(messages[0].toolResults?.map((r) => r.toolCallId)).toEqual(["c1"]);
    // Iteration 2: two thinking chunks join with a blank line; calls c2 AND c3
    // both belong to this iteration (seal at its turn_end includes them both).
    expect(messages[1]).toMatchObject({
      content: "text-2",
      thinking: "think-2a\n\nthink-2b",
    });
    expect(messages[1].toolCalls?.map((c) => c.id)).toEqual(["c2", "c3"]);
    expect(messages[1].toolResults?.map((r) => r.toolCallId)).toEqual(["c2", "c3"]);
  });

  it("appends a trailing message for unsealed in-flight work after the last marker", () => {
    const marker1: IterationMarker = { textChunks: 1, thinkingChunks: 0, toolCalls: 1, toolResults: 1 };

    const messages = buildTransientIterations(zeroBoundary, [marker1], {
      textChunks: ["sealed-text", "inflight-text"],
      thinkingChunks: ["inflight-thought"],
      toolCalls: [call("c1"), call("c2")],
      toolResults: [result("c1")],
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("sealed-text");
    expect(messages[1]).toMatchObject({
      content: "inflight-text",
      thinking: "inflight-thought",
    });
    expect(messages[1].toolCalls?.map((c) => c.id)).toEqual(["c2"]);
    expect(messages[1].toolResults).toBeUndefined();
  });

  it("returns empty when nothing exists since the boundary", () => {
    expect(
      buildTransientIterations(zeroBoundary, [], {
        textChunks: [],
        thinkingChunks: [],
        toolCalls: [],
        toolResults: [],
      }),
    ).toEqual([]);
  });

  it("skips iteration slices that contributed nothing", () => {
    // Marker 2 advances no array — an empty iteration must not emit a message.
    const marker1: IterationMarker = { textChunks: 1, thinkingChunks: 1, toolCalls: 0, toolResults: 0 };
    const marker2: IterationMarker = { textChunks: 1, thinkingChunks: 1, toolCalls: 0, toolResults: 0 };

    const messages = buildTransientIterations(zeroBoundary, [marker1, marker2], {
      textChunks: ["text-1"],
      thinkingChunks: ["think-1"],
      toolCalls: [],
      toolResults: [],
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("text-1");
  });

  it("respects a non-zero persisted boundary", () => {
    // Boundary already covers iteration 1; only iteration 2 may surface.
    const boundary: IterationMarker = { textChunks: 1, thinkingChunks: 1, toolCalls: 1, toolResults: 1 };
    const marker2: IterationMarker = { textChunks: 2, thinkingChunks: 2, toolCalls: 2, toolResults: 2 };

    const messages = buildTransientIterations(boundary, [marker2], {
      textChunks: ["persisted-text", "new-text"],
      thinkingChunks: ["persisted-think", "new-think"],
      toolCalls: [call("c-persisted"), call("c-new")],
      toolResults: [result("c-persisted"), result("c-new")],
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ content: "new-text", thinking: "new-think" });
    expect(messages[0].toolCalls?.map((c) => c.id)).toEqual(["c-new"]);
    expect(messages[0].toolResults?.map((r) => r.toolCallId)).toEqual(["c-new"]);
  });

  it("orders tool results by call id within each slice", () => {
    // Tools may finish out of order; the rebuild must restore call order.
    const marker: IterationMarker = { textChunks: 0, thinkingChunks: 0, toolCalls: 2, toolResults: 2 };

    const messages = buildTransientIterations(zeroBoundary, [marker], {
      textChunks: [],
      thinkingChunks: [],
      toolCalls: [call("c-a"), call("c-b")],
      toolResults: [result("c-b"), result("c-a")],
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].toolResults?.map((r) => r.toolCallId)).toEqual(["c-a", "c-b"]);
  });

  it("tail-clamps long iteration text so the conclusion survives", () => {
    const longText = "opening ".repeat(100) + "the conclusion that matters";
    const marker: IterationMarker = { textChunks: 1, thinkingChunks: 0, toolCalls: 0, toolResults: 0 };

    const messages = buildTransientIterations(zeroBoundary, [marker], {
      textChunks: [longText],
      thinkingChunks: [],
      toolCalls: [],
      toolResults: [],
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("the conclusion that matters");
    expect(messages[0].content).not.toContain("opening ".repeat(90));
    expect(messages[0].content?.startsWith("[truncated]")).toBe(true);
  });
});
