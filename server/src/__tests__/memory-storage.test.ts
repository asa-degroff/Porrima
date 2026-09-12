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
        durability: "durable",
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
        durability: "durable",
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
        durability: "durable",
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

// ---------------------------------------------------------------------------
// 09-08 dead-address audit: the live zeitgeist must be resolvable by its
// stable identity (blockType 'zeitgeist'), never by a stored block ID.
// A hardcoded ID kept resolving a superseded snapshot for two weeks — the
// Phase 2 trigger number was a faithful measurement of a dead address, and
// the injected continuity context was two weeks stale.
// ---------------------------------------------------------------------------

function zeitgeistBlockFields(over: {
  id: string;
  content: string;
  updatedAt?: string;
  supersededBy?: string;
  supersedes?: string;
  blockType?: "note" | "zeitgeist";
}) {
  return {
    id: over.id,
    name: "Zeitgeist - Continuity Block",
    description: "test",
    content: over.content,
    scope: "global" as const,
    projectId: "",
    createdAt: new Date().toISOString(),
    updatedAt: over.updatedAt ?? new Date().toISOString(),
    updatedBy: "agent" as const,
    supersededBy: over.supersededBy,
    supersedes: over.supersedes,
    blockType: over.blockType,
  };
}

describe("zeitgeist resolution (09-08 dead-address audit)", () => {
  it("resolves the live zeitgeist by its type marker, never by the legacy ID", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-memory-storage-"));
    try {
      const storage = await loadMemoryStorage(homeDir);
      // The legacy dead address: human-readable ID, already superseded, and
      // updated MORE RECENTLY than the live block — recency must not win.
      storage.createMemoryBlock(
        zeitgeistBlockFields({
          id: "blk-zeitgeist-continuity",
          content: "stale legacy narrative",
          updatedAt: new Date(Date.now() + 86_400_000).toISOString(),
          supersededBy: "blk-live-zeitgeist",
          blockType: "note",
        }),
      );
      storage.createMemoryBlock(
        zeitgeistBlockFields({
          id: "blk-live-zeitgeist",
          content: "current narrative",
          blockType: "zeitgeist",
        }),
      );

      expect(storage.getActiveZeitgeistBlock()?.id).toBe("blk-live-zeitgeist");

      const zeitgeist = await import("../services/zeitgeist.js");
      expect(zeitgeist.getZeitgeistContent()).toBe("current narrative");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("falls back to the canonical name and warns loudly when the marker is missing", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-memory-storage-"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const storage = await loadMemoryStorage(homeDir);
      storage.createMemoryBlock(
        zeitgeistBlockFields({ id: "blk-unmarked-zeitgeist", content: "current narrative" }),
      );

      expect(storage.getActiveZeitgeistBlock()?.id).toBe("blk-unmarked-zeitgeist");
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("name fallback"));
    } finally {
      warnSpy.mockRestore();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("warns loudly when a raw ID lookup resolves a superseded block", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-memory-storage-"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const storage = await loadMemoryStorage(homeDir);
      storage.createMemoryBlock(
        zeitgeistBlockFields({ id: "blk-old", content: "old", supersededBy: "blk-new" }),
      );

      storage.getMemoryBlock("blk-old");
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("SUPERSEDED"));
    } finally {
      warnSpy.mockRestore();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("treats the live zeitgeist as system-managed by type, not by the fossil ID", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-memory-storage-"));
    try {
      const storage = await loadMemoryStorage(homeDir);
      expect(
        storage.isSystemManagedMemoryBlock({ id: "blk-any", scope: "global", blockType: "zeitgeist" }),
      ).toBe(true);
      // The fossil ID with a plain type is no longer special-cased.
      expect(
        storage.isSystemManagedMemoryBlock({ id: "blk-zeitgeist-continuity", scope: "global", blockType: "note" }),
      ).toBe(false);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("carries the zeitgeist marker across supersession", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-memory-storage-"));
    try {
      const storage = await loadMemoryStorage(homeDir);
      storage.createMemoryBlock(
        zeitgeistBlockFields({
          id: "blk-current-zeitgeist",
          content: "current narrative",
          blockType: "zeitgeist",
        }),
      );

      const next = storage.supersedeBlock(
        "blk-current-zeitgeist",
        zeitgeistBlockFields({
          id: "blk-next-zeitgeist",
          content: "next narrative",
          supersedes: "blk-current-zeitgeist",
        }),
      );

      expect(next.blockType).toBe("zeitgeist");
      expect(storage.getActiveZeitgeistBlock()?.id).toBe("blk-next-zeitgeist");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe("memory durability", () => {
  it("round-trips session durability and supports in-place promotion", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-memory-storage-"));
    try {
      const storage = await loadMemoryStorage(homeDir);
      const now = new Date().toISOString();

      await storage.addMemory({
        id: "mem-session",
        text: "Currently migrating the extraction pipeline",
        category: "context",
        importance: 7,
        durability: "session",
        embedding: new Array(storage.DEFAULT_VEC_DIMENSION).fill(0),
        createdAt: now,
        lastAccessed: now,
        accessCount: 0,
        subject: "Extraction migration",
      });

      expect((await storage.getMemoryById("mem-session"))?.durability).toBe("session");
      expect((await storage.getAllMemories())[0]?.durability).toBe("session");

      await storage.updateMemory("mem-session", { durability: "durable" });
      expect((await storage.getMemoryById("mem-session"))?.durability).toBe("durable");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("adds the durability column to a legacy database with a durable default", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-memory-storage-"));
    try {
      const storage = await loadMemoryStorage(homeDir);
      const now = new Date().toISOString();
      await storage.addMemory({
        id: "mem-legacy",
        text: "Memory written before the durability column existed",
        category: "fact",
        importance: 5,
        durability: "durable",
        embedding: new Array(storage.DEFAULT_VEC_DIMENSION).fill(0),
        createdAt: now,
        lastAccessed: now,
        accessCount: 0,
        subject: "",
      });
      const dbPath = storage.getMemoryDbPath();
      storage.closeMemoryDb();

      // Drop the column to simulate a pre-migration database, then reload.
      const Database = (await import("better-sqlite3")).default;
      const raw = new Database(dbPath);
      raw.exec("ALTER TABLE memories DROP COLUMN durability");
      const colsAfterDrop = raw.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
      expect(colsAfterDrop.some((c) => c.name === "durability")).toBe(false);
      raw.close();

      const reloadedStorage = await loadMemoryStorage(homeDir);
      expect((await reloadedStorage.getMemoryById("mem-legacy"))?.durability).toBe("durable");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
