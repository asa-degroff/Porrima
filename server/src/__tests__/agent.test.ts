import { describe, it, expect } from "vitest";
import { chatMessagesToPiMessages } from "../services/agent.js";
import type { ChatMessage } from "../types.js";
import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";

const MODEL_ID = "test-model:latest";

describe("chatMessagesToPiMessages", () => {
  it("converts a simple user message", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Hello", timestamp: 1000 },
    ];
    const result = chatMessagesToPiMessages(messages, MODEL_ID);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      role: "user",
      content: "Hello",
      timestamp: 1000,
    });
  });

  it("merges persisted system memory deltas into the following user message", () => {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: "[System context - updated memories]\nRemember the recap token setting.",
        timestamp: 900,
      },
      { role: "user", content: "Make it configurable.", timestamp: 1000 },
    ];

    const result = chatMessagesToPiMessages(messages, MODEL_ID);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      role: "user",
      content: "[System context - updated memories]\nRemember the recap token setting.\n\nMake it configurable.",
      timestamp: 1000,
    });
  });

  it("merges persisted system memory deltas into image user messages", () => {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: "[System context - updated memories]\nPrefer concise visual analysis.",
        timestamp: 900,
      },
      {
        role: "user",
        content: "What changed here?",
        images: [
          { data: "base64data", mimeType: "image/png", name: "screenshot.png" },
        ],
        timestamp: 1000,
      },
    ];

    const result = chatMessagesToPiMessages(messages, MODEL_ID);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "[System context - updated memories]\nPrefer concise visual analysis.\n\nWhat changed here?",
        },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ],
      timestamp: 1000,
    });
  });

  it("converts a simple assistant message", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "Hi there!", timestamp: 1000 },
    ];
    const result = chatMessagesToPiMessages(messages, MODEL_ID);
    expect(result).toHaveLength(1);
    const msg = result[0] as AssistantMessage;
    expect(msg.role).toBe("assistant");
    expect(msg.content).toEqual([{ type: "text", text: "Hi there!" }]);
    expect(msg.stopReason).toBe("stop");
  });

  it("includes thinking in assistant message", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "The answer is 42.",
        thinking: "Let me think about this...",
        timestamp: 1000,
      },
    ];
    const result = chatMessagesToPiMessages(messages, MODEL_ID);
    expect(result).toHaveLength(1);
    const msg = result[0] as AssistantMessage;
    expect(msg.content).toEqual([
      { type: "thinking", thinking: "Let me think about this..." },
      { type: "text", text: "The answer is 42." },
    ]);
  });

  it("reconstructs tool-calling turn into three separate messages", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "I found the file.",
        thinking: "Let me search...",
        toolCalls: [
          { id: "tc1", name: "read_file", arguments: { path: "test.txt" } },
        ],
        toolResults: [
          {
            toolCallId: "tc1",
            toolName: "read_file",
            content: "file contents here",
            isError: false,
          },
        ],
        timestamp: 2000,
      },
    ];
    const result = chatMessagesToPiMessages(messages, MODEL_ID);

    // Should produce: AssistantMessage(toolUse) + ToolResultMessage + AssistantMessage(stop)
    expect(result).toHaveLength(3);

    // First: assistant with tool calls
    const toolCallMsg = result[0] as AssistantMessage;
    expect(toolCallMsg.role).toBe("assistant");
    expect(toolCallMsg.stopReason).toBe("toolUse");
    expect(toolCallMsg.content).toEqual([
      { type: "thinking", thinking: "Let me search..." },
      { type: "toolCall", id: "tc1", name: "read_file", arguments: { path: "test.txt" } },
    ]);

    // Second: tool result
    const toolResult = result[1] as ToolResultMessage;
    expect(toolResult.role).toBe("toolResult");
    expect(toolResult.toolCallId).toBe("tc1");
    expect(toolResult.content).toEqual([{ type: "text", text: "file contents here" }]);
    expect(toolResult.isError).toBe(false);

    // Third: final assistant text
    const finalMsg = result[2] as AssistantMessage;
    expect(finalMsg.role).toBe("assistant");
    expect(finalMsg.stopReason).toBe("stop");
    expect(finalMsg.content).toEqual([{ type: "text", text: "I found the file." }]);
  });

  it("replays canonical split tool-loop rows without collapsing iterations", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "Checking the first file.",
        thinking: "First I need file A.",
        toolCalls: [
          { id: "tc1", name: "read_file", arguments: { path: "a.txt" } },
        ],
        toolResults: [
          { toolCallId: "tc1", toolName: "read_file", content: "aaa", isError: false },
        ],
        timestamp: 2000,
        _toolLoopId: "loop-1",
        _toolLoopFragment: true,
      },
      {
        role: "assistant",
        content: "Checking the second file.",
        toolCalls: [
          { id: "tc2", name: "read_file", arguments: { path: "b.txt" } },
        ],
        toolResults: [
          { toolCallId: "tc2", toolName: "read_file", content: "bbb", isError: false },
        ],
        timestamp: 2100,
        _toolLoopId: "loop-1",
        _toolLoopFragment: true,
      },
      {
        role: "assistant",
        content: "Done with both files.",
        timestamp: 2200,
        _toolLoopId: "loop-1",
      },
    ];

    const result = chatMessagesToPiMessages(messages, MODEL_ID);

    expect(result).toHaveLength(5);
    expect((result[0] as AssistantMessage).content).toEqual([
      { type: "thinking", thinking: "First I need file A." },
      { type: "text", text: "Checking the first file." },
      { type: "toolCall", id: "tc1", name: "read_file", arguments: { path: "a.txt" } },
    ]);
    expect(result[1].role).toBe("toolResult");
    expect((result[2] as AssistantMessage).content).toEqual([
      { type: "text", text: "Checking the second file." },
      { type: "toolCall", id: "tc2", name: "read_file", arguments: { path: "b.txt" } },
    ]);
    expect(result[3].role).toBe("toolResult");
    expect((result[4] as AssistantMessage).content).toEqual([
      { type: "text", text: "Done with both files." },
    ]);
  });

  it("handles multiple tool calls in a single turn", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "Done with both files.",
        toolCalls: [
          { id: "tc1", name: "read_file", arguments: { path: "a.txt" } },
          { id: "tc2", name: "read_file", arguments: { path: "b.txt" } },
        ],
        toolResults: [
          { toolCallId: "tc1", toolName: "read_file", content: "aaa", isError: false },
          { toolCallId: "tc2", toolName: "read_file", content: "bbb", isError: false },
        ],
        timestamp: 3000,
      },
    ];
    const result = chatMessagesToPiMessages(messages, MODEL_ID);

    // AssistantMessage(toolUse) + 2 ToolResults + AssistantMessage(stop)
    expect(result).toHaveLength(4);
    expect(result[0].role).toBe("assistant");
    expect((result[0] as AssistantMessage).stopReason).toBe("toolUse");
    expect(result[1].role).toBe("toolResult");
    expect(result[2].role).toBe("toolResult");
    expect(result[3].role).toBe("assistant");
    expect((result[3] as AssistantMessage).stopReason).toBe("stop");
  });

  it("handles tool call with no final text content", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "tc1", name: "bash", arguments: { command: "ls" } },
        ],
        toolResults: [
          { toolCallId: "tc1", toolName: "bash", content: "file1\nfile2", isError: false },
        ],
        timestamp: 4000,
      },
    ];
    const result = chatMessagesToPiMessages(messages, MODEL_ID);

    // No final text → only 2 messages (assistant+toolUse, toolResult)
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("assistant");
    expect(result[1].role).toBe("toolResult");
  });

  it("converts user message with images", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: "What is this?",
        images: [
          { data: "base64data", mimeType: "image/png", name: "screenshot.png" },
        ],
        timestamp: 5000,
      },
    ];
    const result = chatMessagesToPiMessages(messages, MODEL_ID);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "What is this?" },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ],
      timestamp: 5000,
    });
  });

  it("converts a full multi-turn conversation", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Read test.txt", timestamp: 1000 },
      {
        role: "assistant",
        content: "Here's the content.",
        toolCalls: [
          { id: "tc1", name: "read_file", arguments: { path: "test.txt" } },
        ],
        toolResults: [
          { toolCallId: "tc1", toolName: "read_file", content: "hello world", isError: false },
        ],
        timestamp: 2000,
      },
      { role: "user", content: "Thanks!", timestamp: 3000 },
      { role: "assistant", content: "You're welcome!", timestamp: 4000 },
    ];
    const result = chatMessagesToPiMessages(messages, MODEL_ID);

    // user + (assistant+toolUse + toolResult + assistant) + user + assistant = 6
    expect(result).toHaveLength(6);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
    expect(result[2].role).toBe("toolResult");
    expect(result[3].role).toBe("assistant");
    expect(result[4].role).toBe("user");
    expect(result[5].role).toBe("assistant");
  });

  it("handles error tool results", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "The file doesn't exist.",
        toolCalls: [
          { id: "tc1", name: "read_file", arguments: { path: "missing.txt" } },
        ],
        toolResults: [
          { toolCallId: "tc1", toolName: "read_file", content: "ENOENT: file not found", isError: true },
        ],
        timestamp: 6000,
      },
    ];
    const result = chatMessagesToPiMessages(messages, MODEL_ID);
    const toolResult = result[1] as ToolResultMessage;
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content).toEqual([{ type: "text", text: "ENOENT: file not found" }]);
  });
});
