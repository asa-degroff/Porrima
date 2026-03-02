import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { writeFile, mkdir } from "fs/promises";
import { existsSync, mkdirSync, readFileSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Memory, MemoryStore } from "../types.js";

const BASE_DIR = join(homedir(), ".quje-agent");
const MEMORY_DIR = join(BASE_DIR, "memory");
const MEMORY_FILE = join(MEMORY_DIR, "memories.json");
const MEMORY_DB = join(MEMORY_DIR, "memories.db");
const DAILY_DIR = join(MEMORY_DIR, "daily");

// ---------------------------------------------------------------------------
// Lazy singleton database
// ---------------------------------------------------------------------------

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;

  // Ensure directory exists (sync — only runs once)
  if (!existsSync(MEMORY_DIR)) {
    mkdirSync(MEMORY_DIR, { recursive: true });
  }

  const needsMigration = existsSync(MEMORY_FILE) && !existsSync(MEMORY_DB);

  const db = new Database(MEMORY_DB);
  sqliteVec.load(db);
  db.pragma("journal_mode = WAL");

  // Create tables (idempotent)
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      category TEXT NOT NULL,
      importance INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      last_accessed TEXT NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      source_chat_id TEXT NOT NULL DEFAULT ''
    );
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
      id TEXT PRIMARY KEY,
      embedding float[1024] distance_metric=cosine
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Auto-migrate from JSON if needed
  if (needsMigration) {
    migrateFromJson(db);
  }

  _db = db;
  return db;
}

function migrateFromJson(db: Database.Database): void {
  try {
    const raw = readFileSync(MEMORY_FILE, "utf-8");
    const store = JSON.parse(raw) as MemoryStore;

    const insertMemory = db.prepare(`
      INSERT OR IGNORE INTO memories (id, text, category, importance, created_at, last_accessed, access_count, source_chat_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertVec = db.prepare(`
      INSERT OR IGNORE INTO vec_memories (id, embedding)
      VALUES (?, ?)
    `);

    const migrate = db.transaction(() => {
      for (const m of store.memories) {
        insertMemory.run(
          m.id,
          m.text,
          m.category,
          m.importance,
          m.createdAt,
          m.lastAccessed,
          m.accessCount,
          m.sourceChatId || ""
        );
        insertVec.run(m.id, new Float32Array(m.embedding));
      }
      if (store.lastSynthesis) {
        db.prepare(
          "INSERT OR REPLACE INTO metadata (key, value) VALUES ('lastSynthesis', ?)"
        ).run(store.lastSynthesis);
      }
    });
    migrate();

    const count = (
      db.prepare("SELECT COUNT(*) as cnt FROM memories").get() as {
        cnt: number;
      }
    ).cnt;
    console.log(
      `[memory] Migrated ${count} memories to SQLite (from ${store.memories.length} in JSON)`
    );

    // Rename old file as backup (sync — in init path)
    renameSync(MEMORY_FILE, MEMORY_FILE + ".bak");
    console.log("[memory] Renamed memories.json → memories.json.bak");
  } catch (e) {
    console.error("[memory] Migration from JSON failed:", e);
  }
}

// ---------------------------------------------------------------------------
// Write lock — no-op passthrough (SQLite handles concurrency)
// ---------------------------------------------------------------------------

export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}

// ---------------------------------------------------------------------------
// Full store load/save (for synthesis compatibility)
// ---------------------------------------------------------------------------

export async function loadMemoryStore(): Promise<MemoryStore> {
  const db = getDb();

  const rows = db
    .prepare(
      "SELECT m.id, m.text, m.category, m.importance, m.created_at, m.last_accessed, m.access_count, m.source_chat_id, v.embedding FROM memories m JOIN vec_memories v ON m.id = v.id"
    )
    .all() as Array<{
    id: string;
    text: string;
    category: string;
    importance: number;
    created_at: string;
    last_accessed: string;
    access_count: number;
    source_chat_id: string;
    embedding: Buffer;
  }>;

  const memories: Memory[] = rows.map((r) => ({
    id: r.id,
    text: r.text,
    category: r.category as Memory["category"],
    importance: r.importance,
    embedding: Array.from(new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4)),
    createdAt: r.created_at,
    lastAccessed: r.last_accessed,
    accessCount: r.access_count,
    sourceChatId: r.source_chat_id,
  }));

  const meta = db
    .prepare("SELECT value FROM metadata WHERE key = 'lastSynthesis'")
    .get() as { value: string } | undefined;

  return {
    memories,
    lastSynthesis: meta?.value ?? null,
  };
}

export async function saveMemoryStore(store: MemoryStore): Promise<void> {
  const db = getDb();

  const save = db.transaction(() => {
    db.prepare("DELETE FROM vec_memories").run();
    db.prepare("DELETE FROM memories").run();

    const insertMemory = db.prepare(`
      INSERT INTO memories (id, text, category, importance, created_at, last_accessed, access_count, source_chat_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertVec = db.prepare(`
      INSERT INTO vec_memories (id, embedding)
      VALUES (?, ?)
    `);

    for (const m of store.memories) {
      insertMemory.run(
        m.id,
        m.text,
        m.category,
        m.importance,
        m.createdAt,
        m.lastAccessed,
        m.accessCount,
        m.sourceChatId || ""
      );
      insertVec.run(m.id, new Float32Array(m.embedding));
    }

    if (store.lastSynthesis) {
      db.prepare(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('lastSynthesis', ?)"
      ).run(store.lastSynthesis);
    } else {
      db.prepare("DELETE FROM metadata WHERE key = 'lastSynthesis'").run();
    }
  });
  save();
}

// ---------------------------------------------------------------------------
// Individual CRUD
// ---------------------------------------------------------------------------

export async function addMemory(memory: Memory): Promise<void> {
  const db = getDb();

  const add = db.transaction(() => {
    db.prepare(`
      INSERT INTO memories (id, text, category, importance, created_at, last_accessed, access_count, source_chat_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      memory.id,
      memory.text,
      memory.category,
      memory.importance,
      memory.createdAt,
      memory.lastAccessed,
      memory.accessCount,
      memory.sourceChatId || ""
    );
    db.prepare("INSERT INTO vec_memories (id, embedding) VALUES (?, ?)").run(
      memory.id,
      new Float32Array(memory.embedding)
    );
  });
  add();
}

export async function updateMemory(
  id: string,
  updates: Partial<Omit<Memory, "id">>
): Promise<boolean> {
  const db = getDb();

  const setClauses: string[] = [];
  const values: any[] = [];

  if (updates.text !== undefined) {
    setClauses.push("text = ?");
    values.push(updates.text);
  }
  if (updates.category !== undefined) {
    setClauses.push("category = ?");
    values.push(updates.category);
  }
  if (updates.importance !== undefined) {
    setClauses.push("importance = ?");
    values.push(updates.importance);
  }
  if (updates.lastAccessed !== undefined) {
    setClauses.push("last_accessed = ?");
    values.push(updates.lastAccessed);
  }
  if (updates.accessCount !== undefined) {
    setClauses.push("access_count = ?");
    values.push(updates.accessCount);
  }
  if (updates.sourceChatId !== undefined) {
    setClauses.push("source_chat_id = ?");
    values.push(updates.sourceChatId);
  }

  if (setClauses.length === 0 && !updates.embedding) return true;

  const update = db.transaction(() => {
    if (setClauses.length > 0) {
      const result = db
        .prepare(`UPDATE memories SET ${setClauses.join(", ")} WHERE id = ?`)
        .run(...values, id);
      if (result.changes === 0) return false;
    }

    if (updates.embedding) {
      // vec0 doesn't support UPDATE — delete + re-insert
      db.prepare("DELETE FROM vec_memories WHERE id = ?").run(id);
      db.prepare("INSERT INTO vec_memories (id, embedding) VALUES (?, ?)").run(
        id,
        new Float32Array(updates.embedding)
      );
    }

    return true;
  });

  return update();
}

export async function deleteMemory(id: string): Promise<boolean> {
  const db = getDb();

  const del = db.transaction(() => {
    const result = db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    db.prepare("DELETE FROM vec_memories WHERE id = ?").run(id);
    return result.changes > 0;
  });

  return del();
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface ScoredMemory {
  memory: Memory;
  score: number;
}

export async function searchMemories(
  queryEmbedding: number[],
  topK: number,
  now: Date = new Date()
): Promise<ScoredMemory[]> {
  const db = getDb();
  const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

  // Oversample from vec_memories to allow recency/importance re-ranking
  const oversample = Math.max(20, topK * 3);

  const vecRows = db
    .prepare(
      `SELECT id, distance FROM vec_memories WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
    )
    .all(new Float32Array(queryEmbedding), oversample) as Array<{
    id: string;
    distance: number;
  }>;

  if (vecRows.length === 0) return [];

  // Build a map of cosine similarity (1 - distance) by id
  const simMap = new Map<string, number>();
  for (const r of vecRows) {
    simMap.set(r.id, 1 - r.distance);
  }

  // Fetch metadata for matching IDs
  const placeholders = vecRows.map(() => "?").join(",");
  const ids = vecRows.map((r) => r.id);
  const metaRows = db
    .prepare(
      `SELECT id, text, category, importance, created_at, last_accessed, access_count, source_chat_id FROM memories WHERE id IN (${placeholders})`
    )
    .all(...ids) as Array<{
    id: string;
    text: string;
    category: string;
    importance: number;
    created_at: string;
    last_accessed: string;
    access_count: number;
    source_chat_id: string;
  }>;

  const nowMs = now.getTime();
  const scored: ScoredMemory[] = metaRows.map((r) => {
    const sim = simMap.get(r.id) ?? 0;
    const ageMs = nowMs - new Date(r.last_accessed).getTime();
    const recencyDecay = Math.pow(0.5, ageMs / HALF_LIFE_MS);
    const importanceWeight = r.importance / 10;
    const score = sim * recencyDecay * importanceWeight;

    return {
      memory: {
        id: r.id,
        text: r.text,
        category: r.category as Memory["category"],
        importance: r.importance,
        embedding: [], // not needed by any caller of searchMemories
        createdAt: r.created_at,
        lastAccessed: r.last_accessed,
        accessCount: r.access_count,
        sourceChatId: r.source_chat_id,
      },
      score,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

// ---------------------------------------------------------------------------
// Targeted lookups (avoid full-table loads)
// ---------------------------------------------------------------------------

export async function getMemoryById(id: string): Promise<Memory | null> {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT id, text, category, importance, created_at, last_accessed, access_count, source_chat_id FROM memories WHERE id = ?"
    )
    .get(id) as {
    id: string;
    text: string;
    category: string;
    importance: number;
    created_at: string;
    last_accessed: string;
    access_count: number;
    source_chat_id: string;
  } | undefined;

  if (!row) return null;

  return {
    id: row.id,
    text: row.text,
    category: row.category as Memory["category"],
    importance: row.importance,
    embedding: [], // callers don't need embedding from this function
    createdAt: row.created_at,
    lastAccessed: row.last_accessed,
    accessCount: row.access_count,
    sourceChatId: row.source_chat_id,
  };
}

export async function getMemoryCount(): Promise<number> {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as cnt FROM memories").get() as {
    cnt: number;
  };
  return row.cnt;
}

export async function getLastSynthesis(): Promise<string | null> {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM metadata WHERE key = 'lastSynthesis'")
    .get() as { value: string } | undefined;
  return row?.value ?? null;
}

export async function setLastSynthesis(value: string | null): Promise<void> {
  const db = getDb();
  if (value) {
    db.prepare(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('lastSynthesis', ?)"
    ).run(value);
  } else {
    db.prepare("DELETE FROM metadata WHERE key = 'lastSynthesis'").run();
  }
}

export async function getAllMemories(): Promise<
  Omit<Memory, "embedding">[]
> {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, text, category, importance, created_at, last_accessed, access_count, source_chat_id FROM memories"
    )
    .all() as Array<{
    id: string;
    text: string;
    category: string;
    importance: number;
    created_at: string;
    last_accessed: string;
    access_count: number;
    source_chat_id: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    category: r.category as Memory["category"],
    importance: r.importance,
    createdAt: r.created_at,
    lastAccessed: r.last_accessed,
    accessCount: r.access_count,
    sourceChatId: r.source_chat_id,
  }));
}

export interface DuplicateMatch {
  memory: Memory;
  similarity: number;
}

export async function findDuplicates(
  embedding: number[],
  threshold: number
): Promise<DuplicateMatch | null> {
  const db = getDb();

  // Get the single nearest neighbor
  const vecRow = db
    .prepare(
      "SELECT id, distance FROM vec_memories WHERE embedding MATCH ? ORDER BY distance LIMIT 1"
    )
    .get(new Float32Array(embedding)) as
    | { id: string; distance: number }
    | undefined;

  if (!vecRow) return null;

  const similarity = 1 - vecRow.distance;
  if (similarity < threshold) return null;

  const metaRow = db
    .prepare(
      "SELECT id, text, category, importance, created_at, last_accessed, access_count, source_chat_id FROM memories WHERE id = ?"
    )
    .get(vecRow.id) as {
    id: string;
    text: string;
    category: string;
    importance: number;
    created_at: string;
    last_accessed: string;
    access_count: number;
    source_chat_id: string;
  } | undefined;

  if (!metaRow) return null;

  return {
    memory: {
      id: metaRow.id,
      text: metaRow.text,
      category: metaRow.category as Memory["category"],
      importance: metaRow.importance,
      embedding: [], // not needed by callers
      createdAt: metaRow.created_at,
      lastAccessed: metaRow.last_accessed,
      accessCount: metaRow.access_count,
      sourceChatId: metaRow.source_chat_id,
    },
    similarity,
  };
}

// ---------------------------------------------------------------------------
// Daily log (unchanged — still writes markdown files)
// ---------------------------------------------------------------------------

async function ensureDailyDir() {
  await mkdir(DAILY_DIR, { recursive: true });
}

export async function saveDailyLog(
  date: string,
  content: string
): Promise<void> {
  await ensureDailyDir();
  const filePath = join(DAILY_DIR, `${date}.md`);
  await writeFile(filePath, content);
}
