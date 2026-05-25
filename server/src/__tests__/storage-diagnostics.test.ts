import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../types.js";

async function loadStorageDiagnostics(homeDir: string) {
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
  const diagnostics = await import("../services/storage-diagnostics.js");
  const memoryStorage = await import("../services/memory-storage.js");
  return { ...memoryStorage, ...chatStorage, ...diagnostics };
}

afterEach(() => {
  vi.doUnmock("os");
  vi.resetModules();
});

describe("storage diagnostics", () => {
  it("reports chat row compatibility pressure points", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-storage-diagnostics-"));
    try {
      const storage = await loadStorageDiagnostics(homeDir);
      const now = new Date("2026-05-24T00:00:00.000Z").toISOString();
      const chat: Chat = {
        id: "chat-diagnostics-test",
        title: "Diagnostics Test",
        type: "agent",
        modelId: "test-model",
        systemPrompt: "You are helpful.",
        messages: [
          { role: "user", content: "Search for notes", timestamp: 1 },
          {
            role: "assistant",
            content: "I found it.",
            timestamp: 2,
            toolCalls: [{ id: "call-1", name: "search_memory", arguments: { query: "notes" } }],
            toolResults: [{ toolCallId: "call-1", toolName: "search_memory", content: "result", isError: false }],
          },
        ],
        createdAt: now,
        lastModified: now,
      };

      await storage.createChat(chat);
      const db = storage.getDb();
      db.prepare(`
        INSERT INTO chat_message_rows (
          chat_id, sequence, role, timestamp, payload_json, search_content,
          out_of_context, is_compaction_summary, is_system_message
        )
        VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0)
      `).run("corrupt-chat", 0, "assistant", 3, "{not json", "");

      const result = storage.getStorageMigrationDiagnostics();

      expect(result.chatStorage.legacyCollapsedToolRows).toBe(1);
      expect(result.chatStorage.corruptRowPayloads).toBe(1);
      expect(result.chatStorage.totalJsonMessageBytes).toBeGreaterThan(0);
      expect(result.chatStorage.largestJsonSnapshots[0]).toMatchObject({
        id: "chat-diagnostics-test",
        messageCount: 2,
        rowMessageCount: 2,
      });
      expect(result.warnings).toEqual(expect.arrayContaining([
        "chat_message_rows contains 1 invalid JSON payload(s)",
        "chat replay still depends on 1 legacy collapsed assistant tool row(s)",
      ]));
    } finally {
      const storage = await import("../services/chat-storage.js");
      const memoryStorage = await import("../services/memory-storage.js");
      storage.closeChatDb();
      memoryStorage.closeMemoryDb();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
