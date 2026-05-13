import { describe, expect, it } from "vitest";
import { buildPassiveRecallQuery } from "../services/passive-memory-recall.js";
import type { ChatMessage } from "../types.js";

describe("passive memory recall query building", () => {
  it("uses recent user, assistant, and tool-result context", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Can you inspect the retry behavior?", timestamp: 1000 },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "server/src/routes/chat.ts" } }],
        toolResults: [
          {
            toolCallId: "call-1",
            toolName: "read_file",
            content: "The route persists hidden system rows before user messages.",
            isError: false,
          },
        ],
        timestamp: 2000,
      },
    ];

    const query = buildPassiveRecallQuery(messages);

    expect(query).toContain("User: Can you inspect the retry behavior?");
    expect(query).toContain("tool calls: read_file");
    expect(query).toContain("tool result from read_file");
    expect(query).toContain("hidden system rows");
  });

  it("skips hidden memory rows so recalled memories do not search for themselves", () => {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: "[System context - passively recalled memories]\nRemember the cache setting.",
        timestamp: 1000,
        _isPassiveMemoryRecall: true,
      },
      { role: "user", content: "Now continue the implementation.", timestamp: 2000 },
    ];

    const query = buildPassiveRecallQuery(messages);

    expect(query).toBe("User: Now continue the implementation.");
    expect(query).not.toContain("cache setting");
  });

  it("keeps the most recent context when the query is capped", () => {
    const older = "old topic ".repeat(200);
    const newer = "new topic ".repeat(200);
    const query = buildPassiveRecallQuery(
      [
        { role: "user", content: older, timestamp: 1000 },
        { role: "assistant", content: newer, timestamp: 2000 },
      ],
      500,
    );

    expect(query).toContain("new topic");
    expect(query).not.toContain("old topic old topic old topic old topic old topic");
  });
});
