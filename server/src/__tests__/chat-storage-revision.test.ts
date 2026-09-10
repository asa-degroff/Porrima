import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../types.js";
import { resolveCurrentMessageIndex } from "../services/current-message.js";

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
    title: "Revision Test",
    type: "agent",
    modelId: "test-model",
    systemPrompt: "You are helpful.",
    messages,
    createdAt: now,
    lastModified: now,
  };
}

function makeTempHome(): string {
  return mkdtempSync(join(tmpdir(), "porrima-chat-revision-"));
}

afterEach(() => {
  vi.doUnmock("os");
  vi.resetModules();
});

describe("chat storage revision + row identity", () => {
  it("assigns revision 0 and row ids on create", async () => {
    const homeDir = makeTempHome();
    try {
      const storage = await loadChatStorage(homeDir);
      const chat = makeChat("create-ids", [
        { role: "user", content: "first", timestamp: 1 },
        { role: "assistant", content: "second", timestamp: 2 },
      ]);
      await storage.createChat(chat);

      expect(chat._baseRevision).toBe(0);
      expect(chat.messages.every((m) => typeof m._rowId === "string" && m._rowId.length > 0)).toBe(true);

      const loaded = await storage.getChat("create-ids");
      expect(loaded?._baseRevision).toBe(0);
      expect(loaded?.messages.map((m) => m._rowId)).toEqual(chat.messages.map((m) => m._rowId));

      const revision = storage.getDb()
        .prepare("SELECT revision FROM chats WHERE id = ?")
        .get("create-ids") as { revision: number };
      expect(revision.revision).toBe(0);

      const rowIds = storage.getDb()
        .prepare("SELECT row_id FROM chat_message_rows WHERE chat_id = ? ORDER BY sequence")
        .all("create-ids") as Array<{ row_id: string | null }>;
      expect(rowIds.every((r) => typeof r.row_id === "string" && r.row_id.length > 0)).toBe(true);
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("bumps revision on save, pins _baseRevision, and keeps row ids stable", async () => {
    const homeDir = makeTempHome();
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("save-revision", [
        { role: "user", content: "first", timestamp: 1 },
      ]));

      const loaded = await storage.getChat("save-revision");
      const originalIds = loaded!.messages.map((m) => m._rowId);
      loaded!.messages.push({ role: "assistant", content: "second", timestamp: 2 });
      await storage.saveChat(loaded!);

      expect(loaded!._baseRevision).toBe(1);

      const reloaded = await storage.getChat("save-revision");
      expect(reloaded?._baseRevision).toBe(1);
      expect(reloaded?.messages).toHaveLength(2);
      expect(reloaded?.messages[0]._rowId).toBe(originalIds[0]);
      expect(reloaded?.messages[1]._rowId).toBeTruthy();
      expect(reloaded?.messages[1]._rowId).not.toBe(originalIds[0]);
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("strips transient identity from persisted payloads", async () => {
    const homeDir = makeTempHome();
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("payload-clean", [
        { role: "user", content: "hello", timestamp: 1 },
      ]));

      const payload = storage.getDb()
        .prepare("SELECT payload_json FROM chat_message_rows WHERE chat_id = ? AND sequence = 0")
        .get("payload-clean") as { payload_json: string };
      expect(payload.payload_json).not.toContain("_rowId");
      expect(payload.payload_json).not.toContain("_rowSequence");
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("exposes _rowId and _baseRevision in message windows", async () => {
    const homeDir = makeTempHome();
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("window-ids", [
        { role: "user", content: "one", timestamp: 1 },
        { role: "assistant", content: "two", timestamp: 2 },
        { role: "user", content: "three", timestamp: 3 },
      ]));

      const windowed = await storage.getChatWithWindow("window-ids", { limit: 2 });
      expect(windowed?._baseRevision).toBe(0);
      expect(windowed?.messageOffset).toBe(1);
      const full = await storage.getChat("window-ids");
      expect(windowed?.messages.map((m) => m._rowId)).toEqual(full?.messages.slice(1).map((m) => m._rowId));
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("backfills row_id and revision for a legacy database", async () => {
    const homeDir = makeTempHome();
    try {
      const dataDir = join(homeDir, ".porrima");
      mkdirSync(dataDir, { recursive: true });
      const raw = new Database(join(dataDir, "app.db"));
      raw.exec(`
        CREATE TABLE chats (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          type TEXT NOT NULL,
          modelId TEXT NOT NULL,
          systemPrompt TEXT,
          contextWindow INTEGER,
          projectId TEXT,
          messages JSON NOT NULL,
          createdAt TEXT NOT NULL,
          lastModified TEXT NOT NULL
        );
        CREATE TABLE chat_message_rows (
          chat_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          role TEXT NOT NULL,
          timestamp INTEGER,
          payload_json JSON NOT NULL,
          search_content TEXT NOT NULL DEFAULT '',
          out_of_context INTEGER NOT NULL DEFAULT 0,
          is_compaction_summary INTEGER NOT NULL DEFAULT 0,
          is_system_message INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (chat_id, sequence)
        );
      `);
      const now = new Date("2026-05-24T00:00:00.000Z").toISOString();
      const payload = JSON.stringify({ role: "user", content: "legacy row", timestamp: 1 });
      raw.prepare(`
        INSERT INTO chats (id, title, type, modelId, systemPrompt, messages, createdAt, lastModified)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run("legacy", "Legacy", "agent", "test-model", "You are helpful.", `[${payload}]`, now, now);
      raw.prepare(`
        INSERT INTO chat_message_rows (chat_id, sequence, role, timestamp, payload_json, search_content)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run("legacy", 0, "user", 1, payload, "legacy row");
      raw.close();

      const storage = await loadChatStorage(homeDir);
      const chat = await storage.getChat("legacy");
      expect(chat?._baseRevision).toBe(0);
      expect(chat?.messages[0]._rowId).toBeTruthy();

      const db = storage.getDb();
      const revisionCol = db.prepare("PRAGMA table_info(chats)").all() as Array<{ name: string }>;
      expect(revisionCol.some((c) => c.name === "revision")).toBe(true);
      const row = db.prepare("SELECT revision FROM chats WHERE id = ?").get("legacy") as { revision: number };
      expect(row.revision).toBe(0);

      const stored = db.prepare(
        "SELECT row_id FROM chat_message_rows WHERE chat_id = ? AND sequence = 0"
      ).get("legacy") as { row_id: string | null };
      expect(stored.row_id).toBeTruthy();
      expect(stored.row_id).toBe(chat?.messages[0]._rowId);
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("bumps revision when getChat repairs rows from the JSON snapshot", async () => {
    const homeDir = makeTempHome();
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("repair-revision", [
        { role: "user", content: "first", timestamp: 1 },
        { role: "assistant", content: "second", timestamp: 2 },
      ]));
      storage.getDb()
        .prepare("DELETE FROM chat_message_rows WHERE chat_id = ? AND sequence = ?")
        .run("repair-revision", 0);

      const repaired = await storage.getChat("repair-revision");
      expect(repaired?.messages.map((m) => m.content)).toEqual(["first", "second"]);
      expect(repaired?._baseRevision).toBe(1);

      const rowCount = storage.getDb()
        .prepare("SELECT COUNT(*) AS value FROM chat_message_rows WHERE chat_id = ?")
        .get("repair-revision") as { value: number };
      expect(rowCount.value).toBe(2);
      expect(repaired?.messages.every((m) => !!m._rowId)).toBe(true);
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("keeps a concurrent append when a stale writer saves (collision)", async () => {
    const homeDir = makeTempHome();
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("collision", [
        { role: "user", content: "origin one", timestamp: 1 },
        { role: "assistant", content: "origin two", timestamp: 2 },
      ]));

      const stale = await storage.getChat("collision");
      const post = await storage.getChat("collision");
      post!.messages.push({ role: "user", content: "[post] from another chat", timestamp: 3 });
      await storage.saveChat(post!);

      stale!.messages.push({ role: "assistant", content: "stale reply", timestamp: 4 });
      await storage.saveChat(stale!);

      const final = await storage.getChat("collision");
      expect(final?.messages.map((m) => m.content)).toEqual([
        "origin one",
        "origin two",
        "stale reply",
        "[post] from another chat",
      ]);
      const ids = final!.messages.map((m) => m._rowId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(final?.messages.map((m) => m._rowSequence)).toEqual([0, 1, 2, 3]);
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("persists both rows when two writers race from the same snapshot", async () => {
    const homeDir = makeTempHome();
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("double-send", [
        { role: "user", content: "origin", timestamp: 1 },
      ]));

      const first = await storage.getChat("double-send");
      const second = await storage.getChat("double-send");

      first!.messages.push({ role: "user", content: "user one", timestamp: 2 });
      await storage.saveChat(first!);

      second!.messages.push({ role: "user", content: "user two", timestamp: 3 });
      await storage.saveChat(second!);

      const final = await storage.getChat("double-send");
      expect(final?.messages.map((m) => m.content)).toEqual(["origin", "user two", "user one"]);
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("does not lose or duplicate rows when a third writer rebases after a renumber", async () => {
    const homeDir = makeTempHome();
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("drift", [
        { role: "user", content: "origin", timestamp: 1 },
      ]));

      const queued = await storage.getChat("drift");

      const postWriter = await storage.getChat("drift");
      postWriter!.messages.push({ role: "user", content: "post", timestamp: 2 });
      await storage.saveChat(postWriter!);

      const wake = await storage.getChat("drift");

      queued!.messages.push({ role: "user", content: "queued user", timestamp: 3 });
      await storage.saveChat(queued!);

      wake!.messages.push({ role: "assistant", content: "wake reply", timestamp: 4 });
      await storage.saveChat(wake!);

      const final = await storage.getChat("drift");
      expect(final?.messages.map((m) => m.content)).toEqual([
        "origin",
        "queued user",
        "post",
        "wake reply",
      ]);
      const ids = final!.messages.map((m) => m._rowId);
      expect(new Set(ids).size).toBe(ids.length);
      const dbIds = storage.getDb()
        .prepare("SELECT row_id FROM chat_message_rows WHERE chat_id = ? ORDER BY sequence")
        .all("drift") as Array<{ row_id: string }>;
      expect(dbIds.map((r) => r.row_id)).toEqual(ids);
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("rebases a mid-array splice around a concurrent append", async () => {
    const homeDir = makeTempHome();
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("mid-insert", [
        { role: "user", content: "origin", timestamp: 1 },
      ]));

      const stale = await storage.getChat("mid-insert");
      const post = await storage.getChat("mid-insert");
      post!.messages.push({ role: "user", content: "post", timestamp: 2 });
      await storage.saveChat(post!);

      const userRow: Chat["messages"][number] = { role: "user", content: "delta user", timestamp: 3 };
      stale!.messages.push(userRow);
      stale!.messages.splice(stale!.messages.length - 1, 0, {
        role: "system",
        content: "memory delta",
        timestamp: 4,
      });
      await storage.saveChat(stale!);

      const final = await storage.getChat("mid-insert");
      expect(final?.messages.map((m) => m.content)).toEqual([
        "origin",
        "memory delta",
        "delta user",
        "post",
      ]);
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("keeps a batch of new rows in array order around a concurrent append", async () => {
    const homeDir = makeTempHome();
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("batch", [
        { role: "user", content: "origin", timestamp: 1 },
      ]));

      const stale = await storage.getChat("batch");
      const post = await storage.getChat("batch");
      post!.messages.push({ role: "user", content: "post", timestamp: 2 });
      await storage.saveChat(post!);

      stale!.messages.push({ role: "assistant", content: "frag one", timestamp: 3 });
      stale!.messages.push({ role: "assistant", content: "frag two", timestamp: 4 });
      await storage.saveChat(stale!);

      const final = await storage.getChat("batch");
      expect(final?.messages.map((m) => m.content)).toEqual(["origin", "frag one", "frag two", "post"]);
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("drops an unclaimed _inProgress row and preserves unclaimed committed rows", async () => {
    const homeDir = makeTempHome();
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("ephemeral", [
        { role: "user", content: "origin", timestamp: 1 },
      ]));

      const stale = await storage.getChat("ephemeral");
      const other = await storage.getChat("ephemeral");
      other!.messages.push({ role: "assistant", content: "partial", timestamp: 2, _inProgress: true });
      await storage.saveChat(other!);

      stale!.messages.push({ role: "user", content: "stale row", timestamp: 3 });
      await storage.saveChat(stale!);

      const final = await storage.getChat("ephemeral");
      expect(final?.messages.map((m) => m.content)).toEqual(["origin", "stale row"]);
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("rewrites nothing beyond the changed tail on a matching revision", async () => {
    const homeDir = makeTempHome();
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("match-path", [
        { role: "user", content: "one", timestamp: 1 },
        { role: "assistant", content: "two", timestamp: 2 },
      ]));
      const loaded = await storage.getChat("match-path");
      const before = storage.getDb()
        .prepare("SELECT sequence, row_id, payload_json FROM chat_message_rows WHERE chat_id = ? ORDER BY sequence")
        .all("match-path");

      loaded!.messages.push({ role: "user", content: "three", timestamp: 3 });
      await storage.saveChat(loaded!);
      loaded!.messages.push({ role: "assistant", content: "four", timestamp: 4 });
      await storage.saveChat(loaded!);

      const after = storage.getDb()
        .prepare("SELECT sequence, row_id, payload_json FROM chat_message_rows WHERE chat_id = ? ORDER BY sequence")
        .all("match-path") as Array<{ sequence: number; row_id: string; payload_json: string }>;
      expect(after.slice(0, 2)).toEqual(before);
      expect(loaded!._baseRevision).toBe(2);
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("still truncates on allowTruncation", async () => {
    const homeDir = makeTempHome();
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("truncate", [
        { role: "user", content: "one", timestamp: 1 },
        { role: "assistant", content: "two", timestamp: 2 },
        { role: "user", content: "three", timestamp: 3 },
      ]));
      const loaded = await storage.getChat("truncate");
      loaded!.messages = loaded!.messages.slice(0, 2);
      await storage.saveChat(loaded!, { allowTruncation: true });

      const final = await storage.getChat("truncate");
      expect(final?.messages.map((m) => m.content)).toEqual(["one", "two"]);
      const count = storage.getDb()
        .prepare("SELECT COUNT(*) AS value FROM chat_message_rows WHERE chat_id = ?")
        .get("truncate") as { value: number };
      expect(count.value).toBe(2);
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("refuses a stale truncating save on rejectOnRevisionConflict", async () => {
    const homeDir = makeTempHome();
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("edit-refuse", [
        { role: "user", content: "one", timestamp: 1 },
        { role: "assistant", content: "two", timestamp: 2 },
        { role: "user", content: "three", timestamp: 3 },
      ]));

      // The /edit route's view: loaded, then truncated and re-pushed.
      const edit = await storage.getChat("edit-refuse");

      // A concurrent writer appends after the edit's load (a cross-chat post
      // or a queued send).
      const concurrent = await storage.getChat("edit-refuse");
      concurrent!.messages.push({ role: "user", content: "[post] from another chat", timestamp: 4 });
      await storage.saveChat(concurrent!);

      edit!.messages = edit!.messages.slice(0, 1);
      edit!.messages.push({ role: "user", content: "one (edited)", timestamp: 5 });
      await expect(
        storage.saveChat(edit!, { allowTruncation: true, rejectOnRevisionConflict: true }),
      ).rejects.toThrow("Revision conflict");

      // The concurrent append is intact and the truncation was NOT applied.
      const final = await storage.getChat("edit-refuse");
      expect(final?.messages.map((m) => m.content)).toEqual([
        "one",
        "two",
        "three",
        "[post] from another chat",
      ]);
      const rev = storage
        .getDb()
        .prepare("SELECT revision FROM chats WHERE id = ?")
        .get("edit-refuse") as { revision: number };
      expect(rev.revision).toBe(1); // the refused save wrote nothing
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("applies a guarded truncation when the revision has not moved", async () => {
    const homeDir = makeTempHome();
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("edit-apply", [
        { role: "user", content: "one", timestamp: 1 },
        { role: "assistant", content: "two", timestamp: 2 },
        { role: "user", content: "three", timestamp: 3 },
      ]));
      const edit = await storage.getChat("edit-apply");
      edit!.messages = edit!.messages.slice(0, 1);
      edit!.messages.push({ role: "user", content: "one (edited)", timestamp: 4 });
      await storage.saveChat(edit!, { allowTruncation: true, rejectOnRevisionConflict: true });

      const final = await storage.getChat("edit-apply");
      expect(final?.messages.map((m) => m.content)).toEqual(["one", "one (edited)"]);
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("a rebasing turn does not resurrect rows a truncating writer deleted", async () => {
    const homeDir = makeTempHome();
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("edit-truncate", [
        { role: "user", content: "one", timestamp: 1 },
        { role: "assistant", content: "two", timestamp: 2 },
        { role: "user", content: "three", timestamp: 3 },
        { role: "assistant", content: "four", timestamp: 4 },
      ]));

      // A queued turn loads the full thread, then /edit truncates at index 2
      // and saves its edited user row (array-authoritative, deletes 3-4).
      const queued = await storage.getChat("edit-truncate");
      const edit = await storage.getChat("edit-truncate");
      edit!.messages = edit!.messages.slice(0, 2);
      edit!.messages.push({ role: "user", content: "three (edited)", timestamp: 5 });
      await storage.saveChat(edit!, { allowTruncation: true });

      // The queued turn's save rebases. Its snapshot still contains "three"
      // and "four", which the edit deleted from the DB — re-emitting them
      // would silently undo the truncation.
      queued!.messages.push({ role: "user", content: "queued message", timestamp: 6 });
      await storage.saveChat(queued!);

      const final = await storage.getChat("edit-truncate");
      expect(final?.messages.map((m) => m.content)).toEqual([
        "one",
        "two",
        "queued message",
        "three (edited)",
      ]);
      const ids = final!.messages.map((m) => m._rowId);
      expect(new Set(ids).size).toBe(ids.length);
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("rebases an edit's later saves around a concurrent append (id-anchored delta)", async () => {
    const homeDir = makeTempHome();
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("edit-rebase", [
        { role: "user", content: "u1", timestamp: 1 },
        { role: "assistant", content: "a1", timestamp: 2 },
        { role: "user", content: "u2", timestamp: 3 },
        { role: "assistant", content: "a2", timestamp: 4 },
      ]));

      // /edit: truncate at the second user row, push the edit, guarded save.
      const edit = await storage.getChat("edit-rebase");
      edit!.messages = edit!.messages.slice(0, 2);
      const editedRow: Chat["messages"][number] = { role: "user", content: "u2 (edited)", timestamp: 5 };
      edit!.messages.push(editedRow);
      await storage.saveChat(edit!, { allowTruncation: true, rejectOnRevisionConflict: true });

      // A concurrent append lands after the truncation save.
      const other = await storage.getChat("edit-rebase");
      other!.messages.push({ role: "user", content: "concurrent post", timestamp: 6 });
      await storage.saveChat(other!);

      // /edit's delta splice is id-anchored, and its save now rebases instead
      // of refusing: the append survives and the delta stays adjacent.
      const insertAt = Math.max(0, resolveCurrentMessageIndex(edit!.messages, editedRow));
      edit!.messages.splice(insertAt, 0, {
        role: "system",
        content: "[System context — updated memories]",
        timestamp: 7,
      });
      await storage.saveChat(edit!);

      const final = await storage.getChat("edit-rebase");
      expect(final?.messages.map((m) => m.content)).toEqual([
        "u1",
        "a1",
        "[System context — updated memories]",
        "u2 (edited)",
        "concurrent post",
      ]);
      const ids = final!.messages.map((m) => m._rowId);
      expect(new Set(ids).size).toBe(ids.length);
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("refuses to save a partial message window", async () => {
    const homeDir = makeTempHome();
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("window-guard", [
        { role: "user", content: "one", timestamp: 1 },
        { role: "assistant", content: "two", timestamp: 2 },
        { role: "user", content: "three", timestamp: 3 },
      ]));
      const windowed = await storage.getChatWithWindow("window-guard", { limit: 2 });
      await expect(storage.saveChat(windowed!)).rejects.toThrow(/partial message window/);
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("falls back to the legacy sync when the rebase kill switch is set", async () => {
    const homeDir = makeTempHome();
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("kill-switch", [
        { role: "user", content: "origin", timestamp: 1 },
      ]));
      const stale = await storage.getChat("kill-switch");
      const post = await storage.getChat("kill-switch");
      post!.messages.push({ role: "user", content: "post", timestamp: 2 });
      await storage.saveChat(post!);

      process.env.PORRIMA_STORAGE_REBASE = "0";
      try {
        stale!.messages.push({ role: "assistant", content: "stale reply", timestamp: 3 });
        await storage.saveChat(stale!);
      } finally {
        delete process.env.PORRIMA_STORAGE_REBASE;
      }

      const final = await storage.getChat("kill-switch");
      // Legacy behavior: the stale array is authoritative and drops the post.
      expect(final?.messages.map((m) => m.content)).toEqual(["origin", "stale reply"]);
      storage.closeChatDb();
    } finally {
      delete process.env.PORRIMA_STORAGE_REBASE;
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("appends a row atomically at MAX+1 and indexes it for search", async () => {
    const homeDir = makeTempHome();
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("append-basic", [
        { role: "user", content: "origin", timestamp: 1 },
      ]));
      const before = storage.getDb()
        .prepare("SELECT lastModified FROM chats WHERE id = ?")
        .get("append-basic") as { lastModified: string };

      const appended = await storage.appendChatMessageRow("append-basic", {
        role: "user",
        content: "dispatchable herring",
        timestamp: 2,
      });

      expect(appended._rowSequence).toBe(1);
      expect(appended._rowId).toBeTruthy();

      const row = storage.getDb().prepare(
        "SELECT sequence, row_id, payload_json FROM chat_message_rows WHERE chat_id = ? AND sequence = 1"
      ).get("append-basic") as { sequence: number; row_id: string; payload_json: string };
      expect(row.row_id).toBe(appended._rowId);
      expect(row.payload_json).not.toContain("_rowId");

      const chatRow = storage.getDb()
        .prepare("SELECT revision, lastModified FROM chats WHERE id = ?")
        .get("append-basic") as { revision: number; lastModified: string };
      expect(chatRow.revision).toBe(1);
      expect(chatRow.lastModified).not.toBe(before.lastModified);

      const hits = storage.searchChatMessages("herring", { chatId: "append-basic" });
      expect(hits.map((h) => h.messageIndex)).toEqual([1]);
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("keeps a row appended behind a stale writer's back", async () => {
    const homeDir = makeTempHome();
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("append-stale", [
        { role: "user", content: "origin", timestamp: 1 },
      ]));
      const stale = await storage.getChat("append-stale");

      await storage.appendChatMessageRow("append-stale", {
        role: "user",
        content: "[post] appended out of band",
        timestamp: 2,
      });

      stale!.messages.push({ role: "assistant", content: "stale reply", timestamp: 3 });
      await storage.saveChat(stale!);

      const final = await storage.getChat("append-stale");
      expect(final?.messages.map((m) => m.content)).toEqual([
        "origin",
        "stale reply",
        "[post] appended out of band",
      ]);
      expect(final?._baseRevision).toBe(2);
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("merges appended tool-loop fragments into one search document", async () => {
    const homeDir = makeTempHome();
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("append-loop", [
        { role: "user", content: "origin", timestamp: 1 },
      ]));

      await storage.appendChatMessageRow("append-loop", {
        role: "assistant",
        content: "fragment alpha",
        timestamp: 2,
        _toolLoopId: "loop-1",
        _toolLoopFragment: true,
      });
      await storage.appendChatMessageRow("append-loop", {
        role: "assistant",
        content: "fragment beta",
        timestamp: 3,
        _toolLoopId: "loop-1",
        _toolLoopFragment: true,
      });
      await storage.appendChatMessageRow("append-loop", {
        role: "assistant",
        content: "final answer",
        timestamp: 4,
        _toolLoopId: "loop-1",
      });

      const searchRows = storage.getDb().prepare(
        "SELECT message_index, content FROM chat_messages WHERE chat_id = ? ORDER BY message_index"
      ).all("append-loop") as Array<{ message_index: number; content: string }>;
      const assistantRows = searchRows.filter((r) => r.content.includes("fragment"));
      expect(assistantRows).toHaveLength(1);
      expect(assistantRows[0].message_index).toBe(1);
      expect(assistantRows[0].content).toContain("fragment alpha");
      expect(assistantRows[0].content).toContain("fragment beta");
      expect(assistantRows[0].content).toContain("final answer");
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("refuses to append to a deleted chat", async () => {
    const homeDir = makeTempHome();
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("append-deleted", [
        { role: "user", content: "origin", timestamp: 1 },
      ]));
      await storage.deleteChat("append-deleted");
      await expect(
        storage.appendChatMessageRow("append-deleted", { role: "user", content: "late", timestamp: 2 }),
      ).rejects.toThrow(/deleted chat/);
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("removes only declared rows, preserving a concurrent append", async () => {
    const homeDir = makeTempHome();
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("targeted-removal", [
        { role: "user", content: "origin", timestamp: 1 },
      ]));

      const writer = await storage.getChat("targeted-removal");
      const boundaryOne: Chat["messages"][number] = { role: "assistant", content: "boundary one", timestamp: 2 };
      const boundaryTwo: Chat["messages"][number] = { role: "assistant", content: "boundary two", timestamp: 3 };
      writer!.messages.push(boundaryOne, boundaryTwo);
      await storage.saveChat(writer!);
      const removedIds = [boundaryOne._rowId!, boundaryTwo._rowId!];
      expect(removedIds.every((id) => !!id)).toBe(true);

      const other = await storage.getChat("targeted-removal");
      other!.messages.push({ role: "user", content: "concurrent post", timestamp: 4 });
      await storage.saveChat(other!);

      writer!.messages = writer!.messages.filter((m) => m !== boundaryOne && m !== boundaryTwo);
      writer!.messages.push({ role: "assistant", content: "aggregate", timestamp: 5 });
      await storage.saveChat(writer!, { removedRowIds: removedIds });

      const final = await storage.getChat("targeted-removal");
      expect(final?.messages.map((m) => m.content)).toEqual([
        "origin",
        "aggregate",
        "concurrent post",
      ]);
      const storedIds = storage.getDb()
        .prepare("SELECT row_id FROM chat_message_rows WHERE chat_id = ?")
        .all("targeted-removal") as Array<{ row_id: string }>;
      for (const id of removedIds) {
        expect(storedIds.some((r) => r.row_id === id)).toBe(false);
      }
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("carries row identity through an in-place replacement (no duplicate)", async () => {
    const homeDir = makeTempHome();
    try {
      const storage = await loadChatStorage(homeDir);
      await storage.createChat(makeChat("identity-carry", [
        { role: "user", content: "origin", timestamp: 1 },
      ]));

      const writer = await storage.getChat("identity-carry");
      const committed: Chat["messages"][number] = { role: "assistant", content: "draft", timestamp: 2 };
      writer!.messages.push(committed);
      await storage.saveChat(writer!);

      const other = await storage.getChat("identity-carry");
      other!.messages.push({ role: "user", content: "concurrent post", timestamp: 3 });
      await storage.saveChat(other!);

      const replacement = storage.carryRowIdentity(
        { role: "assistant", content: "finalized draft", timestamp: 4 },
        writer!.messages[writer!.messages.length - 1],
      );
      writer!.messages[writer!.messages.length - 1] = replacement;
      await storage.saveChat(writer!);

      const final = await storage.getChat("identity-carry");
      expect(final?.messages.map((m) => m.content)).toEqual([
        "origin",
        "finalized draft",
        "concurrent post",
      ]);
      const contents = final!.messages.map((m) => m.content);
      expect(contents.filter((c) => c === "draft")).toHaveLength(0);
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
