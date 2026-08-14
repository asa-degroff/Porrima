import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

async function loadMemoryStorage(homeDir: string) {
  vi.resetModules();
  vi.doMock("os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("os")>();
    return {
      ...actual,
      homedir: () => homeDir,
    };
  });
  return import("../services/memory-storage.js");
}

afterEach(() => {
  vi.doUnmock("os");
  vi.resetModules();
});

describe("memory block storage", () => {
  it("updates global blocks without binding a null projectId", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-memory-storage-"));
    try {
      const { createMemoryBlock, getMemoryBlock, updateMemoryBlock } = await loadMemoryStorage(homeDir);
      const now = new Date().toISOString();

      createMemoryBlock({
        id: "blk-global-test",
        name: "Global Test",
        description: "A global block",
        content: "Before",
        scope: "global",
        projectId: "",
        createdAt: now,
        updatedAt: now,
        updatedBy: "agent",
        supersededBy: undefined,
        supersedes: undefined,
      });

      expect(updateMemoryBlock("blk-global-test", { content: "After" })).toBe(true);

      const updated = getMemoryBlock("blk-global-test");
      expect(updated?.content).toBe("After");
      expect(updated?.projectId).toBe("");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("snapshots the pre-supersede state into history when a block is superseded", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-memory-storage-"));
    try {
      const { createMemoryBlock, supersedeBlock, getBlockHistory } = await loadMemoryStorage(homeDir);
      const now = new Date().toISOString();

      createMemoryBlock({
        id: "blk-sup-old",
        name: "Superseded Test",
        description: "Supersede versioning",
        content: "Original state.",
        scope: "global",
        projectId: "",
        createdAt: now,
        updatedAt: now,
        updatedBy: "agent",
        supersededBy: undefined,
        supersedes: undefined,
      });

      supersedeBlock("blk-sup-old", {
        id: "blk-sup-new",
        name: "Superseded Test",
        description: "Supersede versioning",
        content: "New state.",
        scope: "global",
        projectId: "",
        createdAt: now,
        updatedAt: now,
        updatedBy: "agent",
        supersededBy: undefined,
        supersedes: undefined,
      });

      // The supersede UPDATE changes only supersededBy — the pre-supersede
      // state must still be snapshotted so the lineage stays recoverable.
      const history = getBlockHistory("blk-sup-old");
      const snapshots = history.filter((h) => h.id !== "blk-sup-old");
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].content).toBe("Original state.");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("lists blocks by query tokens across punctuation and content", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-memory-storage-"));
    try {
      const { createMemoryBlock, listMemoryBlocks } = await loadMemoryStorage(homeDir);
      const now = new Date().toISOString();

      createMemoryBlock({
        id: "blk-website-test",
        name: "porrima.cc Website",
        description: "Astro project documentation",
        content: "Header uses an inverted corner SVG.",
        scope: "project",
        projectId: "project-1",
        createdAt: now,
        updatedAt: now,
        updatedBy: "agent",
        supersededBy: undefined,
        supersedes: undefined,
      });

      expect(listMemoryBlocks({ query: "porrima website" }).map((b) => b.id)).toContain("blk-website-test");
      expect(listMemoryBlocks({ query: "inverted corner" }).map((b) => b.id)).toContain("blk-website-test");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("builds index text that includes the subject when present", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-memory-storage-"));
    try {
      const { buildMemoryIndexText } = await loadMemoryStorage(homeDir);
      expect(buildMemoryIndexText("Body text", "Topic framing")).toBe("Topic framing\nBody text");
      expect(buildMemoryIndexText("Body text", "")).toBe("Body text");
      expect(buildMemoryIndexText("Body text", "   ")).toBe("Body text");
      expect(buildMemoryIndexText("Body text")).toBe("Body text");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("makes subject-only keywords searchable via FTS", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-memory-storage-"));
    try {
      const storage = await loadMemoryStorage(homeDir);
      const now = new Date().toISOString();
      await storage.addMemory({
        id: "mem-subject",
        text: "Merged the slot persistence fix",
        category: "fact",
        importance: 5,
        embedding: new Array(storage.DEFAULT_VEC_DIMENSION).fill(0),
        createdAt: now,
        lastAccessed: now,
        accessCount: 0,
        subject: "KV cache slot persistence debugging",
      });

      const db = storage.getDb();
      const viaSubject = db
        .prepare("SELECT id FROM fts_memories WHERE fts_memories MATCH ?")
        .all('"KV cache"') as Array<{ id: string }>;
      expect(viaSubject.map((r) => r.id)).toContain("mem-subject");

      const viaText = db
        .prepare("SELECT id FROM fts_memories WHERE fts_memories MATCH ?")
        .all('"persistence fix"') as Array<{ id: string }>;
      expect(viaText.map((r) => r.id)).toContain("mem-subject");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("recreates a legacy FTS index that lacks the subject column", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-memory-storage-"));
    try {
      const now = new Date().toISOString();
      const memoryDir = join(homeDir, ".porrima", "memory");
      mkdirSync(memoryDir, { recursive: true });

      // Seed a legacy database: FTS table + triggers without the subject column.
      const Database = (await import("better-sqlite3")).default;
      const raw = new Database(join(memoryDir, "memories.db"));
      raw.exec(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          text TEXT NOT NULL,
          category TEXT NOT NULL,
          importance INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          last_accessed TEXT NOT NULL,
          access_count INTEGER NOT NULL DEFAULT 0,
          source_chat_id TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
        CREATE VIRTUAL TABLE fts_memories
          USING fts5(id UNINDEXED, text, content=memories, content_rowid=rowid);
        CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO fts_memories(rowid, id, text) VALUES (new.rowid, new.id, new.text);
        END;
      `);
      raw
        .prepare(
          "INSERT INTO memories (id, text, category, importance, created_at, last_accessed) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run("mem-legacy", "Merged the slot persistence fix", "fact", 5, now, now);
      raw.exec(`INSERT INTO fts_memories(fts_memories) VALUES('rebuild')`);
      raw.exec(`INSERT INTO metadata (key, value) VALUES ('fts_initialized', '1')`);
      raw.close();

      const storage = await loadMemoryStorage(homeDir);
      const db = storage.getDb();

      const ftsCols = db.prepare("PRAGMA table_info(fts_memories)").all() as Array<{ name: string }>;
      expect(ftsCols.some((c) => c.name === "subject")).toBe(true);

      // Legacy rows are searchable after the rebuild.
      const rows = db
        .prepare("SELECT id FROM fts_memories WHERE fts_memories MATCH ?")
        .all('"slot persistence"') as Array<{ id: string }>;
      expect(rows.map((r) => r.id)).toContain("mem-legacy");

      // New inserts flow through the subject-aware triggers.
      await storage.addMemory({
        id: "mem-new",
        text: "Unrelated body text",
        category: "fact",
        importance: 5,
        embedding: new Array(storage.DEFAULT_VEC_DIMENSION).fill(0),
        createdAt: now,
        lastAccessed: now,
        accessCount: 0,
        subject: "Router failover drill",
      });
      const viaSubject = db
        .prepare("SELECT id FROM fts_memories WHERE fts_memories MATCH ?")
        .all('"failover drill"') as Array<{ id: string }>;
      expect(viaSubject.map((r) => r.id)).toContain("mem-new");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("renames stale memories.json when a newer memory database exists", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-memory-storage-"));
    try {
      const storage = await loadMemoryStorage(homeDir);
      const now = new Date("2026-05-24T00:00:00.000Z").toISOString();
      await storage.addMemory({
        id: "mem-current",
        text: "Current memory in SQLite",
        category: "fact",
        importance: 3,
        embedding: new Array(storage.DEFAULT_VEC_DIMENSION).fill(0),
        createdAt: now,
        lastAccessed: now,
        accessCount: 0,
        subject: "",
      });
      await storage.setLastSynthesis(now);
      storage.closeMemoryDb();

      const memoryDir = join(homeDir, ".porrima", "memory");
      const jsonPath = join(memoryDir, "memories.json");
      writeFileSync(jsonPath, JSON.stringify({
        memories: [],
        lastSynthesis: "2026-03-01T00:00:00.000Z",
      }));

      storage.getDb();

      expect(existsSync(jsonPath)).toBe(false);
      expect(readdirSync(memoryDir).some((file) => file.startsWith("memories.json.stale-"))).toBe(true);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
