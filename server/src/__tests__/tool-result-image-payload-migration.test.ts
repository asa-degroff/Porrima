import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../types.js";

const INLINE_IMAGE = Buffer.from("tool-result-image").toString("base64");

async function loadStorage(homeDir: string) {
  vi.resetModules();
  vi.doMock("os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("os")>();
    return {
      ...actual,
      homedir: () => homeDir,
    };
  });

  mkdirSync(join(homeDir, ".porrima"), { recursive: true });
  const chatStorage = await import("../services/chat-storage.js");
  const migration = await import("../services/tool-result-image-payload-migration.js");
  const imageStorage = await import("../services/tool-result-image-storage.js");
  return { ...chatStorage, ...migration, ...imageStorage };
}

afterEach(() => {
  vi.doUnmock("os");
  vi.resetModules();
});

describe("tool result image payload migration", () => {
  it("persists tool result image bytes and strips inline data from chat rows", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-tool-result-image-migration-"));
    try {
      const storage = await loadStorage(homeDir);
      const chat: Chat = {
        id: "tool-image-chat",
        title: "Tool Image Chat",
        type: "agent",
        modelId: "test-model",
        systemPrompt: "You are helpful.",
        messages: [{
          role: "assistant",
          content: "done",
          timestamp: 1,
          toolCalls: [{ id: "call-1", name: "generate_and_review", arguments: {} }],
          toolResults: [{
            toolCallId: "call-1",
            toolName: "generate_and_review",
            content: "image",
            isError: false,
            images: [{ data: INLINE_IMAGE, mimeType: "image/jxl", name: "generated-call-1.jxl" }],
          }],
        }],
        createdAt: "2026-05-25T00:00:00.000Z",
        lastModified: "2026-05-25T00:00:00.000Z",
      };
      await storage.createChat(chat);

      const result = await storage.migrateToolResultImagePayloads({ dryRun: false });
      expect(result).toMatchObject({
        scannedRows: 1,
        changedRows: 1,
        persistedAttachments: 1,
        skippedAttachments: 0,
        afterInlineAttachments: 0,
      });

      const row = storage.getDb().prepare(`
        SELECT payload_json FROM chat_message_rows WHERE chat_id = ? AND sequence = 0
      `).get("tool-image-chat") as { payload_json: string };
      const payload = JSON.parse(row.payload_json);
      const image = payload.toolResults[0].images[0];
      expect(image.data).toBeUndefined();
      expect(image.url).toMatch(/^\/api\/tool-result-images\//);

      const hydrated = await storage.hydrateToolResultImageAttachment(image);
      expect(hydrated.data).toBe(INLINE_IMAGE);
    } finally {
      const chatStorage = await import("../services/chat-storage.js");
      chatStorage.closeChatDb();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
