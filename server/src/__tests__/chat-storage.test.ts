import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
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

  it("falls back to the JSON snapshot and repairs malformed rows", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-chat-storage-"));
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("json-repair", [
        { role: "user", content: "first", timestamp: 1 },
        { role: "assistant", content: "second", timestamp: 2 },
      ]));
      storage.getDb().prepare("DELETE FROM chat_message_rows WHERE chat_id = ? AND sequence = ?").run("json-repair", 0);

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

  it("checks chat existence without loading messages", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-chat-storage-"));
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("exists-test", [
        { role: "user", content: "hello", timestamp: 1 },
      ]));

      expect(await storage.chatExists("exists-test")).toBe(true);
      expect(await storage.chatExists("missing-test")).toBe(false);
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("updates metadata without rewriting message storage", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-chat-storage-"));
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("metadata-only", [
        { role: "user", content: "keep me", timestamp: 1 },
      ]));
      const db = storage.getDb();
      const beforeJson = (db.prepare("SELECT messages FROM chats WHERE id = ?").get("metadata-only") as { messages: string }).messages;
      const beforeRows = db.prepare(`
        SELECT sequence, payload_json
        FROM chat_message_rows
        WHERE chat_id = ?
        ORDER BY sequence ASC
      `).all("metadata-only");

      const updated = await storage.updateChatMetadata("metadata-only", {
        title: "Renamed",
        modelId: "new-model",
        clearContextWindow: true,
      });
      const afterJson = (db.prepare("SELECT messages FROM chats WHERE id = ?").get("metadata-only") as { messages: string }).messages;
      const afterRows = db.prepare(`
        SELECT sequence, payload_json
        FROM chat_message_rows
        WHERE chat_id = ?
        ORDER BY sequence ASC
      `).all("metadata-only");
      const reloaded = await storage.getChat("metadata-only");

      expect(updated).toMatchObject({
        id: "metadata-only",
        title: "Renamed",
        modelId: "new-model",
        messages: [],
      });
      expect(updated?.contextWindow).toBeUndefined();
      expect(afterJson).toBe(beforeJson);
      expect(afterRows).toEqual(beforeRows);
      expect(reloaded?.messages.map((message) => message.content)).toEqual(["keep me"]);
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("saves chats by updating rows without rewriting the legacy JSON mirror", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-chat-storage-"));
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("row-primary-save", [
        { role: "user", content: "first", timestamp: 1 },
      ]));
      const db = storage.getDb();
      const beforeJson = (db.prepare("SELECT messages FROM chats WHERE id = ?").get("row-primary-save") as { messages: string }).messages;

      const chat = await storage.getChat("row-primary-save");
      expect(chat).not.toBeNull();
      chat!.messages.push({ role: "assistant", content: "second", timestamp: 2 });
      await storage.saveChat(chat!);

      const afterJson = (db.prepare("SELECT messages FROM chats WHERE id = ?").get("row-primary-save") as { messages: string }).messages;
      const rowCount = (db.prepare(
        "SELECT COUNT(*) AS value FROM chat_message_rows WHERE chat_id = ?"
      ).get("row-primary-save") as { value: number }).value;
      const reloaded = await storage.getChat("row-primary-save");

      expect(afterJson).toBe(beforeJson);
      expect(rowCount).toBe(2);
      expect(reloaded?.messages.map((message) => message.content)).toEqual(["first", "second"]);
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("removes legacy quick chats and their dependent rows on open", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-chat-storage-"));
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("agent-keep", [
        { role: "user", content: "keep me", timestamp: 1 },
      ]));

      // Plant a quick chat plus dependent rows, simulating a database written
      // before the quick chat type was removed.
      const db = storage.getDb();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO chats (id, title, type, modelId, messages, createdAt, lastModified, revision)
        VALUES (?, ?, 'quick', ?, ?, ?, ?, 0)
      `).run(
        "quick-gone", "Legacy Quick", "test-model",
        JSON.stringify([{ role: "user", content: "scratch", timestamp: 1 }]), now, now,
      );
      db.prepare(`
        INSERT INTO chat_message_rows (chat_id, sequence, row_id, role, timestamp, payload_json, search_content)
        VALUES (?, 0, ?, 'user', 1, ?, 'scratch')
      `).run("quick-gone", "quick-gone:0", JSON.stringify({ role: "user", content: "scratch", timestamp: 1 }));
      db.prepare(`
        INSERT INTO chat_messages (chat_id, message_index, role, content, timestamp)
        VALUES (?, 0, 'user', 'scratch', 1)
      `).run("quick-gone");
      db.prepare(`
        INSERT INTO pending_states (chatId, agentMessages, systemPrompt, askToolCallId)
        VALUES (?, '[]', '', '')
      `).run("quick-gone");
      db.prepare(`
        INSERT INTO context_archives (id, chatId, sequenceNum, messages, indexEntry, messageCount, createdAt)
        VALUES (?, ?, 0, '[]', 'entry', 0, ?)
      `).run("archive-quick", "quick-gone", now);

      // Simulate a pre-migration database: forget the cleanup already ran.
      db.prepare("DELETE FROM storage_migrations WHERE name = ?").run("remove-quick-chats");
      const queueDir = join(homeDir, ".porrima", "queue");
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, "quick-gone.json"), "[]", "utf-8");
      storage.closeChatDb();

      // Reopening runs the migration before any reads.
      const reopened = await loadChatStorage(homeDir);
      const rdb = reopened.getDb();
      const chatIds = (rdb.prepare("SELECT id FROM chats ORDER BY id").all() as Array<{ id: string }>)
        .map((r) => r.id);
      const count = (sql: string) => (rdb.prepare(sql).get("quick-gone") as { value: number }).value;

      expect(chatIds).toEqual(["agent-keep"]);
      expect(count("SELECT COUNT(*) AS value FROM chat_message_rows WHERE chat_id = ?")).toBe(0);
      expect(count("SELECT COUNT(*) AS value FROM chat_messages WHERE chat_id = ?")).toBe(0);
      expect(count("SELECT COUNT(*) AS value FROM pending_states WHERE chatId = ?")).toBe(0);
      expect(count("SELECT COUNT(*) AS value FROM context_archives WHERE chatId = ?")).toBe(0);
      expect(existsSync(join(queueDir, "quick-gone.json"))).toBe(false);
      expect(rdb.prepare("SELECT 1 FROM storage_migrations WHERE name = ?").get("remove-quick-chats")).toBeDefined();

      const kept = await reopened.getChat("agent-keep");
      expect(kept?.messages.map((message) => message.content)).toEqual(["keep me"]);
      reopened.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("drops the legacy chats.systemPrompt column on open", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-chat-storage-"));
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("agent-keep", [
        { role: "user", content: "keep me", timestamp: 1 },
      ]));

      // Simulate a pre-removal database: re-add the column with the template
      // seeded, and forget the migration already ran.
      const db = storage.getDb();
      db.exec("ALTER TABLE chats ADD COLUMN systemPrompt TEXT");
      db.prepare("UPDATE chats SET systemPrompt = ? WHERE id = ?").run("You are helpful.", "agent-keep");
      db.prepare("DELETE FROM storage_migrations WHERE name = ?").run("remove-chat-system-prompt");
      storage.closeChatDb();

      // Reopening runs the drop before any reads.
      const reopened = await loadChatStorage(homeDir);
      const rdb = reopened.getDb();
      const columns = rdb.prepare("PRAGMA table_info(chats)").all() as Array<{ name: string }>;
      expect(columns.some((c) => c.name === "systemPrompt")).toBe(false);
      expect(rdb.prepare("SELECT 1 FROM storage_migrations WHERE name = ?").get("remove-chat-system-prompt")).toBeDefined();

      const kept = await reopened.getChat("agent-keep");
      expect(kept?.messages.map((message) => message.content)).toEqual(["keep me"]);
      reopened.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
