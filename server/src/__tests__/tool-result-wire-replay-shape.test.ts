import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../types.js";

const MODEL_ID = "test-model";
const TOOL_IMAGE_BUFFER = Buffer.from("tool-result-image-bytes");

/**
 * Mirrors digestWireShape in routes/chat.ts: the KV-cache prefix check hashes
 * role + JSON.stringify(content) per replayed message. Wire and replay only
 * agree when content shapes are byte-identical.
 */
function digestContent(content: unknown): string {
  return JSON.stringify(content);
}

async function loadReplayModules(homeDir: string) {
  vi.resetModules();
  vi.doMock("os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("os")>();
    return {
      ...actual,
      homedir: () => homeDir,
    };
  });

  const { mkdirSync } = await import("fs");
  mkdirSync(join(homeDir, ".porrima"), { recursive: true });
  const agent = await import("../services/agent.js");
  const toolImages = await import("../services/tool-result-image-storage.js");
  const agentTools = await import("../services/agent-tools.js");
  return { ...agent, ...toolImages, ...agentTools };
}

afterEach(() => {
  vi.doUnmock("os");
  vi.resetModules();
});

describe("normalizeToolResultContent", () => {
  it("strips extra fields from text and image items so wire matches replay", async () => {
    const { normalizeToolResultContent } = await import("../services/agent-tools.js");
    const raw = [
      { type: "text", text: "Screenshot of http://x/front.png", name: "ignored" },
      { type: "image", data: "aGk=", mimeType: "image/png", name: "browser-screenshot" },
    ];
    expect(normalizeToolResultContent(raw)).toEqual([
      { type: "text", text: "Screenshot of http://x/front.png" },
      { type: "image", data: "aGk=", mimeType: "image/png" },
    ]);
  });

  it("is idempotent on strict items and converts string content to a text item", async () => {
    const { normalizeToolResultContent } = await import("../services/agent-tools.js");
    const strict = [
      { type: "text", text: "ok" },
      { type: "image", data: "aGk=", mimeType: "image/png" },
    ];
    expect(normalizeToolResultContent(strict)).toEqual(strict);
    // String content becomes the single text item the replay rebuilds — the
    // array IS the canonical wire shape (the provider serializer requires
    // it), so a bare string on the wire would diverge from the replay.
    expect(normalizeToolResultContent("plain text")).toEqual([
      { type: "text", text: "plain text" },
    ]);
  });
});

describe("tool result wire-vs-replay shape parity", () => {
  it("replayed tool result content is byte-identical to the normalized wire content", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-wire-replay-shape-"));
    try {
      const replay = await loadReplayModules(homeDir);
      const imageData = TOOL_IMAGE_BUFFER.toString("base64");

      // Wire side: what a browser_screenshot-style executor returns, after the
      // getAgentTools normalization wrapper (strict pi-ai shapes, no extras).
      const rawExecutorContent = [
        { type: "text", text: "Screenshot of http://127.0.0.1:8917/cmp-front.png" },
        { type: "image", data: imageData, mimeType: "image/png", name: "browser-screenshot" },
      ];
      const wireContent = replay.normalizeToolResultContent(rawExecutorContent);

      // Persisted side: what buildPersistedToolResult stores — text + data-
      // stripped image records (id/url/name), hydrated from disk on replay.
      const record = await replay.saveToolResultImage("wire-shape-1", TOOL_IMAGE_BUFFER, "image/png", "tool-result-call-1.png");
      const persistedMessages: ChatMessage[] = [{
        role: "assistant",
        content: "capturing",
        timestamp: 3,
        _toolLoopFragment: true,
        toolCalls: [{ id: "call-1", name: "browser_screenshot", arguments: {} }],
        toolResults: [{
          toolCallId: "call-1",
          toolName: "browser_screenshot",
          content: "Screenshot of http://127.0.0.1:8917/cmp-front.png",
          isError: false,
          images: [{
            id: record.id,
            url: record.url,
            mimeType: record.mimeType,
            name: record.name,
          }],
        }],
      }];

      const pi = await replay.chatMessagesToHydratedPiMessages(persistedMessages, MODEL_ID);
      const replayedToolResult = pi.find((m: any) => m.role === "toolResult") as any;

      // The exact invariant digestWireShape checks per message: if these two
      // serializations differ, the persisted history cannot rebuild the wire
      // shape and the next send re-prefills the entire context.
      expect(digestContent(replayedToolResult.content)).toBe(digestContent(wireContent));
      expect(replayedToolResult.content).toEqual([
        { type: "text", text: "Screenshot of http://127.0.0.1:8917/cmp-front.png" },
        { type: "image", data: imageData, mimeType: "image/png" },
      ]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("keeps parity when the persisted image record carries extra metadata fields", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-wire-replay-parity-"));
    try {
      const replay = await loadReplayModules(homeDir);
      const imageData = TOOL_IMAGE_BUFFER.toString("base64");
      const record = await replay.saveToolResultImage("wire-shape-2", TOOL_IMAGE_BUFFER, "image/png", "shot.png");

      const wireContent = replay.normalizeToolResultContent([
        { type: "text", text: "shot ready" },
        { type: "image", data: imageData, mimeType: "image/png", name: "browser-screenshot" },
      ]);

      const persistedMessages: ChatMessage[] = [{
        role: "assistant",
        content: "",
        timestamp: 4,
        _toolLoopFragment: true,
        toolCalls: [{ id: "call-2", name: "browser_screenshot", arguments: {} }],
        toolResults: [{
          toolCallId: "call-2",
          toolName: "browser_screenshot",
          content: "shot ready",
          isError: false,
          // Records may carry persisted-only metadata (name/size/createdAt);
          // replay must still rebuild exactly the normalized wire shape.
          images: [{
            ...record,
            size: record.size,
            createdAt: record.createdAt,
          } as any],
        }],
      }];

      const pi = await replay.chatMessagesToHydratedPiMessages(persistedMessages, MODEL_ID);
      const replayedToolResult = pi.find((m: any) => m.role === "toolResult") as any;
      expect(digestContent(replayedToolResult.content)).toBe(digestContent(wireContent));
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("keeps parity when the executor returns string content (converted to a text item)", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-wire-replay-string-"));
    try {
      const replay = await loadReplayModules(homeDir);

      // Wire side: a string executor return, after normalization — the
      // canonical array shape with a single text item.
      const wireContent = replay.normalizeToolResultContent("plain string result");

      // Persisted side: the row carries the text; replay rebuilds it.
      const persistedMessages: ChatMessage[] = [{
        role: "assistant",
        content: "",
        timestamp: 5,
        _toolLoopFragment: true,
        toolCalls: [{ id: "call-3", name: "bash", arguments: {} }],
        toolResults: [{
          toolCallId: "call-3",
          toolName: "bash",
          content: "plain string result",
          isError: false,
        }],
      }];

      const pi = await replay.chatMessagesToHydratedPiMessages(persistedMessages, MODEL_ID);
      const replayedToolResult = pi.find((m: any) => m.role === "toolResult") as any;
      expect(digestContent(replayedToolResult.content)).toBe(digestContent(wireContent));
      expect(replayedToolResult.content).toEqual([{ type: "text", text: "plain string result" }]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
