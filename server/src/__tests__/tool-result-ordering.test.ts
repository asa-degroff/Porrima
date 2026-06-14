import { describe, expect, it } from "vitest";
import { orderToolResultsByToolCalls } from "../services/tool-result-ordering.js";
import type { ChatToolCall, ChatToolResult } from "../types.js";

describe("tool result ordering", () => {
  it("orders parallel tool results by assistant tool-call order", () => {
    const toolCalls: ChatToolCall[] = [
      { id: "call-a", name: "web_search", arguments: { query: "docs" } },
      { id: "call-b", name: "list_files", arguments: { pattern: "**/*.md" } },
    ];
    const completionOrderResults: ChatToolResult[] = [
      { toolCallId: "call-b", toolName: "list_files", content: "README.md", isError: false },
      { toolCallId: "call-a", toolName: "web_search", content: "No search results found.", isError: false },
    ];

    expect(orderToolResultsByToolCalls(toolCalls, completionOrderResults).map((r) => r.toolCallId))
      .toEqual(["call-a", "call-b"]);
  });

  it("preserves unmatched tool results after ordered matches", () => {
    const toolCalls: ChatToolCall[] = [
      { id: "call-a", name: "first", arguments: {} },
      { id: "call-b", name: "second", arguments: {} },
    ];
    const results: ChatToolResult[] = [
      { toolCallId: "extra", toolName: "legacy", content: "extra", isError: false },
      { toolCallId: "call-b", toolName: "second", content: "b", isError: false },
      { toolCallId: "call-a", toolName: "first", content: "a", isError: false },
    ];

    expect(orderToolResultsByToolCalls(toolCalls, results).map((r) => r.toolCallId))
      .toEqual(["call-a", "call-b", "extra"]);
  });
});
