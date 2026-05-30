import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../types.js";

const MODEL_ID = "test-model";
const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

async function loadReplayModules(homeDir: string) {
  vi.resetModules();
  vi.doMock("os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("os")>();
    return {
      ...actual,
      homedir: () => homeDir,
    };
  });

  mkdirSync(join(homeDir, ".porrima"), { recursive: true });
  const agent = await import("../services/agent.js");
  const userImages = await import("../services/user-image-storage.js");
  const toolImages = await import("../services/tool-result-image-storage.js");
  return { ...agent, ...userImages, ...toolImages };
}

afterEach(() => {
  vi.doUnmock("os");
  vi.resetModules();
});

describe("image replay hydration", () => {
  it("hydrates metadata-only user image rows before LLM replay", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-image-replay-"));
    try {
      const replay = await loadReplayModules(homeDir);
      const imageData = ONE_BY_ONE_PNG.toString("base64");
      const record = await replay.saveUserImage("user-image-1", ONE_BY_ONE_PNG, "image/png", "pixel.png");
      const persistedMessages: ChatMessage[] = [{
        role: "user",
        content: "look",
        timestamp: 1,
        images: [{
          id: record.id,
          url: record.url,
          thumbUrl: record.thumbUrl,
          mimeType: record.mimeType,
          name: record.name,
        }],
      }];
      const inlineMessages: ChatMessage[] = [{
        ...persistedMessages[0],
        images: [{ ...persistedMessages[0].images![0], data: imageData }],
      }];

      const fromPersisted = await replay.chatMessagesToHydratedPiMessages(persistedMessages, MODEL_ID);
      const fromInline = await replay.chatMessagesToHydratedPiMessages(inlineMessages, MODEL_ID);

      expect(fromPersisted).toEqual(fromInline);
      expect(fromPersisted[0]).toEqual({
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", data: imageData, mimeType: "image/png" },
        ],
        timestamp: 1,
      });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("hydrates metadata-only tool result images before LLM replay", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-tool-image-replay-"));
    try {
      const replay = await loadReplayModules(homeDir);
      const imageBuffer = Buffer.from("tool-result-image");
      const imageData = imageBuffer.toString("base64");
      const record = await replay.saveToolResultImage("tool-image-1", imageBuffer, "image/jxl", "generated.jxl");
      const persistedMessages: ChatMessage[] = [{
        role: "assistant",
        content: "rendered",
        timestamp: 2,
        _toolLoopFragment: true,
        toolCalls: [{ id: "call-1", name: "generate_and_review", arguments: {} }],
        toolResults: [{
          toolCallId: "call-1",
          toolName: "generate_and_review",
          content: "image ready",
          isError: false,
          images: [{
            id: record.id,
            url: record.url,
            mimeType: record.mimeType,
            name: record.name,
          }],
        }],
      }];
      const inlineMessages: ChatMessage[] = [{
        ...persistedMessages[0],
        toolResults: [{
          ...persistedMessages[0].toolResults![0],
          images: [{ ...persistedMessages[0].toolResults![0].images![0], data: imageData }],
        }],
      }];

      const fromPersisted = await replay.chatMessagesToHydratedPiMessages(persistedMessages, MODEL_ID);
      const fromInline = await replay.chatMessagesToHydratedPiMessages(inlineMessages, MODEL_ID);

      expect(fromPersisted).toEqual(fromInline);
      expect(fromPersisted[1]).toMatchObject({
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "generate_and_review",
        content: [
          { type: "text", text: "image ready" },
          { type: "image", data: imageData, mimeType: "image/jxl" },
        ],
      });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("keeps replay deterministic when an image file is missing", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-missing-image-replay-"));
    try {
      const replay = await loadReplayModules(homeDir);
      const messages: ChatMessage[] = [{
        role: "user",
        content: "look",
        timestamp: 1,
        images: [{
          id: "missing-image",
          url: "/api/user-images/missing-image/image.png",
          mimeType: "image/png",
          name: "missing.png",
        }],
      }];

      await expect(replay.chatMessagesToHydratedPiMessages(messages, MODEL_ID)).resolves.toEqual([{
        role: "user",
        content: [{ type: "text", text: "look" }],
        timestamp: 1,
      }]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
