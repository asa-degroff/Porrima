import { describe, expect, it } from "vitest";
import { chatMessagesToPiMessages } from "../services/agent.js";
import { splitAssistantMessageIntoCanonicalToolLoopRows } from "../services/chat-turn-runner.js";
import type { ChatMessage } from "../types.js";

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
