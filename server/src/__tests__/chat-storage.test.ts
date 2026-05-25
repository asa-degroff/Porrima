import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../types.js";

async function loadChatStorage(homeDir: string) {
  vi.resetModules();
  vi.doMock("os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("os")>();
    return {
      ...actual,
      homedir: () => homeDir,
    };
  });

  mkdirSync(join(homeDir, ".porrima"), { recursive: true });
  return import("../services/chat-storage.js");
}

function makeChat(id: string, messages: Chat["messages"]): Chat {
  const now = new Date("2026-05-24T00:00:00.000Z").toISOString();
  return {
    id,
    title: "Storage Test",
    type: "agent",
    modelId: "test-model",
    systemPrompt: "You are helpful.",
    messages,
    createdAt: now,
    lastModified: now,
  };
}

afterEach(() => {
  vi.doUnmock("os");
  vi.resetModules();
});

describe("chat storage", () => {
  it("loads full chats from row storage when the JSON snapshot count matches", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-chat-storage-"));
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("row-first", [
        { role: "user", content: "from rows", timestamp: 1 },
      ]));

      storage.getDb().prepare("UPDATE chats SET messages = ? WHERE id = ?").run(
        JSON.stringify([{ role: "user", content: "from legacy json", timestamp: 1 }]),
        "row-first"
      );

      const chat = await storage.getChat("row-first");

      expect(chat?.messages).toHaveLength(1);
      expect(chat?.messages[0].content).toBe("from rows");
      expect(chat?.messages[0]._rowSequence).toBe(0);
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("falls back to a larger JSON snapshot and repairs stale rows", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-chat-storage-"));
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("json-repair", [
        { role: "user", content: "first", timestamp: 1 },
        { role: "assistant", content: "second", timestamp: 2 },
      ]));
      storage.getDb().prepare("DELETE FROM chat_message_rows WHERE chat_id = ? AND sequence = ?").run("json-repair", 1);

      const chat = await storage.getChat("json-repair");
      const repairedRows = storage.getDb().prepare(
        "SELECT COUNT(*) AS value FROM chat_message_rows WHERE chat_id = ?"
      ).get("json-repair") as { value: number };

      expect(chat?.messages.map((message) => message.content)).toEqual(["first", "second"]);
      expect(repairedRows.value).toBe(2);
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("uses healthy rows when the legacy JSON snapshot is invalid", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-chat-storage-"));
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("invalid-json", [
        { role: "user", content: "valid row", timestamp: 1 },
      ]));
      storage.getDb().prepare("UPDATE chats SET messages = ? WHERE id = ?").run("{not json", "invalid-json");

      const chat = await storage.getChat("invalid-json");

      expect(chat?.messages).toHaveLength(1);
      expect(chat?.messages[0].content).toBe("valid row");
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
