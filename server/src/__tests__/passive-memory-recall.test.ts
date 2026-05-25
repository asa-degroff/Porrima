import { describe, expect, it } from "vitest";
import { chatMessagesToPiMessages } from "../services/agent.js";
import {
  buildPassiveRecallQuery,
  buildPassiveRerankQuery,
  PassiveMemoryRecallController,
} from "../services/passive-memory-recall.js";
import type { ChatMessage } from "../types.js";

describe("passive memory recall query building", () => {
  it("uses recent user, assistant, and sanitized tool-result context", () => {
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
    expect(query).toContain("Observation:");
    expect(query).toContain("hidden system rows");
    expect(query).not.toContain("read_file");
    expect(query).not.toContain("server/src/routes/chat.ts");
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

  it("excludes automation trigger prompts from passive recall queries", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: "# Daily Synthesis\n\nWrite a daily synthesis and maintain your memory blocks.",
        timestamp: 1000,
        _isSystemMessage: true,
        _isAutomationMessage: true,
        _automationTaskId: "builtin:synthesis",
      },
      {
        role: "assistant",
        thinking: "I should inspect recent project work and summarize durable patterns.",
        content: "I found several recurring memory retrieval themes.",
        timestamp: 2000,
      },
    ];

    const recallQuery = buildPassiveRecallQuery(messages);
    const rerankQuery = buildPassiveRerankQuery(messages);

    expect(recallQuery).not.toContain("Daily Synthesis");
    expect(recallQuery).not.toContain("maintain your memory blocks");
    expect(recallQuery).toContain("Assistant:");
    expect(recallQuery).toContain("memory retrieval themes");

    expect(rerankQuery).not.toContain("User request:");
    expect(rerankQuery).not.toContain("Daily Synthesis");
    expect(rerankQuery).toContain("Agent thinking:");
    expect(rerankQuery).toContain("durable patterns");
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

  it("builds a compact topical rerank query while preserving agent thinking", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: "Can you check why the reranker is hitting fallback during passive memory recall?",
        timestamp: 1000,
      },
      {
        role: "assistant",
        thinking: "I need to diagnose why passive memory recall is selecting meta memories instead of topical context while checking server/src/services/passive-memory-recall.ts.",
        content: "I found /v1/rerank returning 500 while inspecting `reranker.service` and passive-memory-recall.ts.",
        toolCalls: [
          {
            id: "call-1",
            name: "read_file",
            arguments: { path: "server/src/services/passive-memory-recall.ts" },
          },
        ],
        toolResults: [
          {
            toolCallId: "call-1",
            toolName: "read_file",
            content: "srv send_error: input (1819 tokens) is too large to process. current batch size: 512",
            isError: false,
          },
        ],
        timestamp: 2000,
      },
    ];

    const query = buildPassiveRerankQuery(messages, 900);

    expect(query.length).toBeLessThanOrEqual(900);
    expect(query).toContain("Agent thinking:");
    expect(query).toContain("selecting meta memories");
    expect(query).toContain("topical context");
    expect(query).toContain("User request:");
    expect(query).toContain("passive memory recall");
    expect(query).toContain("current batch size");
    expect(query).not.toContain("Tool activity:");
    expect(query).not.toContain("Concrete anchors:");
    expect(query).not.toContain("read_file");
    expect(query).not.toContain("server/src/services/passive-memory-recall.ts");
    expect(query).not.toContain("passive-memory-recall.ts");
    expect(query).not.toContain("reranker.service");
    expect(query).not.toContain("/v1/rerank");
  });

  it("does not backfill stale assistant output when the active fragment only has tool calls", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Can you summarize the notebook design?", timestamp: 1000 },
      {
        role: "assistant",
        content: "The notebook design uses dual user and agent entries.",
        timestamp: 2000,
      },
      { role: "user", content: "Now debug why passive recall follows the wrong topic.", timestamp: 3000 },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "read_file",
            arguments: { path: "server/src/services/passive-memory-recall.ts" },
          },
        ],
        timestamp: 4000,
      },
    ];

    const query = buildPassiveRerankQuery(messages, 900);

    expect(query).toContain("User request:");
    expect(query).toContain("passive recall follows the wrong topic");
    expect(query).not.toContain("Assistant output:");
    expect(query).not.toContain("notebook design");
    expect(query).not.toContain("dual user and agent entries");
  });

  it("builds the same live message shape that persisted passive rows replay into", () => {
    const controller = new PassiveMemoryRecallController("chat-1");
    const content = [
      "[System context - passively recalled memories]",
      "## Recalled context - memories that may be relevant now:",
      "- Prefer preserving KV-cache prompt identity.",
      "",
      "Use these memories only if they help the current task.",
    ].join("\n");
    const timestamp = 3000;

    const liveMessage = controller.toReplayUserMessage({
      content,
      memoryIds: ["mem-1"],
      memories: ["Prefer preserving KV-cache prompt identity."],
      createdAt: timestamp,
    });
    const replayed = chatMessagesToPiMessages(
      [
        { role: "user", content: "Check the replay path.", timestamp: 1000 },
        { role: "assistant", content: "I will inspect it.", timestamp: 2000 },
        {
          role: "system",
          content,
          timestamp,
          _isSystemMessage: true,
          _isPassiveMemoryRecall: true,
        },
        { role: "assistant", content: "The replay path injects a synthetic user message.", timestamp: 4000 },
      ],
      "test-model:latest",
    );

    expect(liveMessage).toEqual(replayed[2]);
    expect(liveMessage).toEqual({
      role: "user",
      content,
      timestamp,
    });
  });
});
