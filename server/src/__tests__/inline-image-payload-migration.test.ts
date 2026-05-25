import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../types.js";

const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

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
  const imageStorage = await import("../services/user-image-storage.js");
  const migration = await import("../services/inline-image-payload-migration.js");
  return { ...chatStorage, ...imageStorage, ...migration };
}

afterEach(() => {
  vi.doUnmock("os");
  vi.resetModules();
});

describe("inline image payload migration", () => {
  it("strips inline image data when persisted bytes are recoverable", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-inline-image-migration-"));
    try {
      const storage = await loadStorage(homeDir);
      const data = ONE_BY_ONE_PNG.toString("base64");
      const record = await storage.saveUserImage("image-existing", ONE_BY_ONE_PNG, "image/png", "pixel.png");
      const chat: Chat = {
        id: "inline-image-chat",
        title: "Inline Image Chat",
        type: "agent",
        modelId: "test-model",
        systemPrompt: "You are helpful.",
        messages: [{
          role: "user",
          content: "look",
          timestamp: 1,
          images: [{
            data,
            mimeType: "image/png",
            name: "pixel.png",
            id: record.id,
            url: record.url,
            thumbUrl: record.thumbUrl,
          }],
        }],
        createdAt: "2026-05-25T00:00:00.000Z",
        lastModified: "2026-05-25T00:00:00.000Z",
      };
      await storage.createChat(chat);

      const result = await storage.migrateInlineImagePayloads({ dryRun: false });
      expect(result).toMatchObject({
        scannedRows: 1,
        changedRows: 1,
        strippedAttachments: 1,
        skippedAttachments: 0,
        afterInlineAttachments: 0,
      });

      const row = storage.getDb().prepare(`
        SELECT payload_json FROM chat_message_rows WHERE chat_id = ? AND sequence = 0
      `).get("inline-image-chat") as { payload_json: string };
      const payload = JSON.parse(row.payload_json);
      expect(payload.images[0].data).toBeUndefined();
      expect(payload.images[0].id).toBe(record.id);
    } finally {
      const chatStorage = await import("../services/chat-storage.js");
      chatStorage.closeChatDb();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
