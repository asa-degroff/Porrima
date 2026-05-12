import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { writeFile, mkdir } from "fs/promises";
import { existsSync, mkdirSync, readFileSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { v4 as uuid } from "uuid";
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

export const DEFAULT_VEC_DIMENSION = 1024;

function readStoredVecDimension(db: Database.Database): number {
  try {
    const row = db.prepare("SELECT value FROM metadata WHERE key = 'vec_dimension'").get() as
      | { value: string }
      | undefined;
    const n = row ? parseInt(row.value, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_VEC_DIMENSION;
  } catch {
    return DEFAULT_VEC_DIMENSION;
  }
}

export function getDb(): Database.Database {
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
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const vecDim = readStoredVecDimension(db);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
      id TEXT PRIMARY KEY,
      embedding float[${vecDim}] distance_metric=cosine
    );
  `);

  // FTS5 full-text index (content-sync'd with memories table)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_memories
      USING fts5(id UNINDEXED, text, content=memories, content_rowid=rowid);
  `);

  // Triggers to keep FTS in sync with memories table
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO fts_memories(rowid, id, text) VALUES (new.rowid, new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO fts_memories(fts_memories, rowid, id, text) VALUES('delete', old.rowid, old.id, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO fts_memories(fts_memories, rowid, id, text) VALUES('delete', old.rowid, old.id, old.text);
      INSERT INTO fts_memories(rowid, id, text) VALUES (new.rowid, new.id, new.text);
    END;
  `);

  // One-time FTS rebuild for existing data
  const ftsInit = db
    .prepare("SELECT value FROM metadata WHERE key = 'fts_initialized'")
    .get() as { value: string } | undefined;
  if (!ftsInit) {
    db.exec(`INSERT INTO fts_memories(fts_memories) VALUES('rebuild')`);
    db.prepare(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('fts_initialized', '1')"
    ).run();
    console.log("[memory] Built FTS5 index for existing memories");
  }

  // Migration: add project_id column if missing
  const cols = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "project_id")) {
    db.exec(`ALTER TABLE memories ADD COLUMN project_id TEXT NOT NULL DEFAULT ''`);
    console.log("[memory] Added project_id column to memories table");
  }

  // Temporal layering migrations
  if (!cols.some((c) => c.name === "source_type")) {
    db.exec(`ALTER TABLE memories ADD COLUMN source_type TEXT NOT NULL DEFAULT 'chat'`);
    console.log("[memory] Added source_type column for temporal tracking");
  }
  if (!cols.some((c) => c.name === "source_id")) {
    db.exec(`ALTER TABLE memories ADD COLUMN source_id TEXT NOT NULL DEFAULT ''`);
    console.log("[memory] Added source_id column for temporal tracking");
  }
  if (!cols.some((c) => c.name === "superseded_by")) {
    db.exec(`ALTER TABLE memories ADD COLUMN superseded_by TEXT`);
    console.log("[memory] Added superseded_by column for lineage tracking");
  }
  if (!cols.some((c) => c.name === "supersedes")) {
    db.exec(`ALTER TABLE memories ADD COLUMN supersedes TEXT`);
    console.log("[memory] Added supersedes column for lineage tracking");
  }

  // Create memory_supersession_history table for audit trail
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_supersession_history (
      id TEXT PRIMARY KEY,
      older_memory_id TEXT NOT NULL,
      newer_memory_id TEXT NOT NULL,
      confidence REAL NOT NULL,
      created_at TEXT NOT NULL,
      removed_at TEXT,
      removal_reason TEXT
    );
  `);

  // Memory blocks — structured, editable knowledge documents
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_blocks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      content TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'global',
      projectId TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      updatedBy TEXT NOT NULL DEFAULT 'agent',
      tokenEstimate INTEGER NOT NULL DEFAULT 0,
      supersededBy TEXT,
      supersedes TEXT
    );
  `);

  // Migration: add blockType + attachments columns. blockType distinguishes
  // plain notes from notebook/synthesis/zeitgeist-archive entries (replaces
  // the brittle `id.startsWith('blk-notebook-')` prefix matching scattered
  // across memory-context.ts, zeitgeist.ts, memory-tools.ts). attachments is
  // a JSON blob for images, toolCalls, toolResults, artifacts, visuals,
  // links — references (ids/urls), not binary data.
  const blockCols = db.prepare("PRAGMA table_info(memory_blocks)").all() as Array<{ name: string }>;
  if (!blockCols.some((c) => c.name === "blockType")) {
    db.exec(`ALTER TABLE memory_blocks ADD COLUMN blockType TEXT NOT NULL DEFAULT 'note'`);
    // Backfill from id prefix so existing rows pick up the right type without
    // a separate migration step. Rollout step 2 will flip runtime filters to
    // read blockType; step 5 will remove the prefix fallback entirely.
    db.exec(`UPDATE memory_blocks SET blockType = 'notebook' WHERE id LIKE 'blk-notebook-%'`);
    db.exec(`UPDATE memory_blocks SET blockType = 'synthesis' WHERE id LIKE 'blk-synth-%'`);
    db.exec(`UPDATE memory_blocks SET blockType = 'zeitgeist-archive' WHERE id LIKE 'blk-archive-%'`);
    console.log("[memory] Added blockType column and backfilled from id prefixes");
  }
  if (!blockCols.some((c) => c.name === "attachments")) {
    db.exec(`ALTER TABLE memory_blocks ADD COLUMN attachments TEXT`);
    console.log("[memory] Added attachments column to memory_blocks");
  }

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_blocks_fts USING fts5(
      content,
      name,
      description,
      id UNINDEXED,
      content='memory_blocks',
      content_rowid='rowid'
    );
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memory_blocks_ai AFTER INSERT ON memory_blocks BEGIN
      INSERT INTO memory_blocks_fts(rowid, content, name, description, id) VALUES (new.rowid, new.content, new.name, new.description, new.id);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_blocks_ad AFTER DELETE ON memory_blocks BEGIN
      INSERT INTO memory_blocks_fts(memory_blocks_fts, rowid, content, name, description, id) VALUES('delete', old.rowid, old.content, old.name, old.description, old.id);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_blocks_au AFTER UPDATE ON memory_blocks BEGIN
      INSERT INTO memory_blocks_fts(memory_blocks_fts, rowid, content, name, description, id) VALUES('delete', old.rowid, old.content, old.name, old.description, old.id);
      INSERT INTO memory_blocks_fts(rowid, content, name, description, id) VALUES (new.rowid, new.content, new.name, new.description, new.id);
    END;
  `);

  // Block revision history — captures old state on every update.
  // No explicit primary key: SQLite rowid is unique per snapshot,
  // avoiding timestamp collision on rapid successive edits.
  // Used by getBlockHistory() to show the full edit timeline.
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_blocks_history (
      blockId TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      content TEXT NOT NULL,
      scope TEXT NOT NULL,
      projectId TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      updatedBy TEXT NOT NULL DEFAULT 'agent',
      tokenEstimate INTEGER NOT NULL DEFAULT 0,
      blockType TEXT NOT NULL DEFAULT 'note'
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_blocks_history_blockId ON memory_blocks_history(blockId)`);

  // Trigger: snapshot old state on every content/name/description change.
  // NOTE: If you alter the trigger body, you must DROP it first —
  // CREATE TRIGGER IF NOT EXISTS won't update an existing trigger.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memory_blocks_history_trigger
    AFTER UPDATE ON memory_blocks
    WHEN old.content != new.content
       OR old.name != new.name
       OR old.description != new.description
    BEGIN
      INSERT INTO memory_blocks_history (
        blockId, name, description, content, scope, projectId,
        createdAt, updatedAt, updatedBy, tokenEstimate, blockType
      ) VALUES (
        old.id, old.name, old.description, old.content,
        old.scope, old.projectId,
        old.createdAt, old.updatedAt, old.updatedBy, old.tokenEstimate,
        COALESCE(old.blockType, 'note')
      );
    END;
  `);

  // Auto-migrate from JSON if needed
  if (needsMigration) {
    migrateFromJson(db);
  }

  // Migration: add projectId to history table if it was created without it.
  const histCols = db.prepare("PRAGMA table_info(memory_blocks_history)").all() as Array<{ name: string }>;
  if (!histCols.some((c) => c.name === "projectId")) {
    db.exec(`ALTER TABLE memory_blocks_history ADD COLUMN projectId TEXT NOT NULL DEFAULT ''`);
    console.log("[memory] Added projectId column to memory_blocks_history");
  }

  _db = db;
  return db;
}

function migrateFromJson(db: Database.Database): void {
  try {
    const raw = readFileSync(MEMORY_FILE, "utf-8");
    const store = JSON.parse(raw) as MemoryStore;

    const insertMemory = db.prepare(`
      INSERT OR IGNORE INTO memories (id, text, category, importance, created_at, last_accessed, access_count, source_chat_id, project_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '')
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

/**
 * Drop and recreate vec_memories at a new dimension. Clears all stored vectors
 * — callers are responsible for re-embedding afterward. Updates the
 * `vec_dimension` metadata entry so subsequent startups use the new dimension.
 */
export function rebuildVecMemoriesTable(newDim: number): void {
  if (!Number.isInteger(newDim) || newDim <= 0) {
    throw new Error(`Invalid embedding dimension: ${newDim}`);
  }
  const db = getDb();
  db.exec(`DROP TABLE IF EXISTS vec_memories`);
  db.exec(`
    CREATE VIRTUAL TABLE vec_memories USING vec0(
      id TEXT PRIMARY KEY,
      embedding float[${newDim}] distance_metric=cosine
    );
  `);
  db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('vec_dimension', ?)").run(
    String(newDim)
  );
}

export function getStoredVecDimension(): number {
  return readStoredVecDimension(getDb());
}

export function closeMemoryDb(): void {
  if (_db) {
    try {
      _db.close();
    } catch (e) {
      console.warn("[memory] close failed:", e);
    }
    _db = null;
  }
}

export function getMemoryDbPath(): string {
  return MEMORY_DB;
}

// ---------------------------------------------------------------------------
// Full store load/save (for synthesis compatibility)
// ---------------------------------------------------------------------------

export async function loadMemoryStore(): Promise<MemoryStore> {
  const db = getDb();

  const rows = db
    .prepare(
      "SELECT m.id, m.text, m.category, m.importance, m.created_at, m.last_accessed, m.access_count, m.source_chat_id, m.project_id, v.embedding FROM memories m JOIN vec_memories v ON m.id = v.id"
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
    project_id: string;
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
    ...(r.project_id ? { projectId: r.project_id } : {}),
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
      INSERT INTO memories (id, text, category, importance, created_at, last_accessed, access_count, source_chat_id, project_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        m.sourceChatId || "",
        m.projectId || ""
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
      INSERT INTO memories (id, text, category, importance, created_at, last_accessed, access_count, source_chat_id, project_id, source_type, source_id, superseded_by, supersedes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      memory.id,
      memory.text,
      memory.category,
      memory.importance,
      memory.createdAt,
      memory.lastAccessed,
      memory.accessCount,
      memory.sourceChatId || "",
      memory.projectId || "",
      memory.sourceType || 'chat',
      memory.sourceId || '',
      memory.supersededBy || null,
      memory.supersedes || null
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
  if (updates.projectId !== undefined) {
    setClauses.push("project_id = ?");
    values.push(updates.projectId);
  }
  if (updates.sourceType !== undefined) {
    setClauses.push("source_type = ?");
    values.push(updates.sourceType);
  }
  if (updates.sourceId !== undefined) {
    setClauses.push("source_id = ?");
    values.push(updates.sourceId);
  }
  if (updates.supersededBy !== undefined) {
    setClauses.push("superseded_by = ?");
    values.push(updates.supersededBy);
  }
  if (updates.supersedes !== undefined) {
    setClauses.push("supersedes = ?");
    values.push(updates.supersedes);
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

/**
 * Maximal Marginal Relevance (MMR) re-ranking.
 * Balances relevance against redundancy by iteratively selecting items that
 * are both relevant to the query and dissimilar to already-selected items.
 * 
 * @param candidates - Pre-scored candidates (sorted by relevance)
 * @param queryEmbedding - The query embedding for similarity computation
 * @param k - Number of items to select
 * @param lambda - Tradeoff parameter: 1.0 = pure relevance, 0.0 = pure diversity
 * @returns Re-ranked subset of candidates
 */
export function mmrRerank(
  candidates: ScoredMemory[],
  queryEmbedding: number[],
  k: number,
  lambda: number = 0.7
): ScoredMemory[] {
  if (candidates.length <= k || lambda >= 1.0) {
    return candidates.slice(0, k);
  }

  const selected: ScoredMemory[] = [];
  const remaining = [...candidates];

  while (selected.length < k && remaining.length > 0) {
    if (selected.length === 0) {
      // First pick: highest relevance score
      const best = remaining.shift()!;
      selected.push(best);
      continue;
    }

    let bestCandidate: ScoredMemory | null = null;
    let bestMmrScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const relevance = candidate.score;

      // Compute max similarity to any already-selected item
      let maxSimilarity = 0;
      for (const sel of selected) {
        const sim = cosineSimilarity(
          candidate.memory.embedding,
          sel.memory.embedding
        );
        if (sim > maxSimilarity) {
          maxSimilarity = sim;
        }
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSimilarity;

      if (mmrScore > bestMmrScore) {
        bestMmrScore = mmrScore;
        bestCandidate = candidate;
      }
    }

    if (bestCandidate) {
      selected.push(bestCandidate);
      remaining.splice(remaining.indexOf(bestCandidate), 1);
    }
  }

  return selected;
}

/**
 * Compute cosine similarity between two embeddings.
 * Embeddings are assumed to be L2-normalized (as qwen3-embedding produces),
 * so cosine similarity = dot product.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * FTS5 full-text search. Returns ranked IDs.
 * Tries quoted phrase match first; falls back to individual terms on no results.
 */
function ftsSearch(query: string, limit: number): string[] {
  const db = getDb();
  const trimmed = query.trim();
  if (!trimmed) return [];

  // Escape double quotes for FTS5 syntax
  const escaped = trimmed.replace(/"/g, '""');

  // Try phrase match first (exact sequence)
  let rows = db
    .prepare(
      `SELECT id FROM fts_memories WHERE text MATCH ? ORDER BY rank LIMIT ?`
    )
    .all(`"${escaped}"`, limit) as Array<{ id: string }>;

  // Fall back to individual terms (implicit OR) if phrase match yields nothing
  if (rows.length === 0) {
    // Tokenize into words and join with OR for FTS5
    const terms = trimmed
      .split(/\s+/)
      .filter((t) => t.length > 0)
      .map((t) => `"${t.replace(/"/g, '""')}"`)
      .join(" OR ");
    if (terms) {
      rows = db
        .prepare(
          `SELECT id FROM fts_memories WHERE text MATCH ? ORDER BY rank LIMIT ?`
        )
        .all(terms, limit) as Array<{ id: string }>;
    }
  }

  return rows.map((r) => r.id);
}

export async function searchMemories(
  queryEmbedding: number[],
  topK: number,
  now: Date = new Date(),
  queryText?: string,
  dateRange?: { from?: string; to?: string }
): Promise<ScoredMemory[]> {
  const db = getDb();
  const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  const RRF_K = 60; // standard RRF constant

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

  // FTS search (if query text provided)
  const ftsIds = queryText ? ftsSearch(queryText, oversample) : [];

  // Collect all candidate IDs from both sources
  const allIds = new Set<string>();
  for (const r of vecRows) allIds.add(r.id);
  for (const id of ftsIds) allIds.add(id);

  if (allIds.size === 0) return [];

  // Build rank maps (1-based ranks)
  const vecRank = new Map<string, number>();
  vecRows.forEach((r, i) => vecRank.set(r.id, i + 1));

  const ftsRank = new Map<string, number>();
  ftsIds.forEach((id, i) => ftsRank.set(id, i + 1));

  // Compute RRF score for each candidate
  const rrfScores = new Map<string, number>();
  for (const id of allIds) {
    let score = 0;
    const vr = vecRank.get(id);
    if (vr !== undefined) score += 1 / (RRF_K + vr);
    const fr = ftsRank.get(id);
    if (fr !== undefined) score += 1 / (RRF_K + fr);
    rrfScores.set(id, score);
  }

  // Fetch metadata + embeddings for all candidate IDs
  const ids = Array.from(allIds);
  const placeholders = ids.map(() => "?").join(",");

  // Build date range filter
  let dateFilter = "";
  const dateParams: string[] = [];
  if (dateRange?.from) {
    dateFilter += " AND m.created_at >= ?";
    dateParams.push(dateRange.from);
  }
  if (dateRange?.to) {
    dateFilter += " AND m.created_at <= ?";
    dateParams.push(dateRange.to);
  }

  const metaRows = db
    .prepare(
      `SELECT m.id, m.text, m.category, m.importance, m.created_at, m.last_accessed, m.access_count, m.source_chat_id, m.project_id, m.superseded_by, m.supersedes, v.embedding
       FROM memories m
       JOIN vec_memories v ON m.id = v.id
       WHERE m.id IN (${placeholders})${dateFilter}`
    )
    .all(...ids, ...dateParams) as Array<{
    id: string;
    text: string;
    category: string;
    importance: number;
    created_at: string;
    last_accessed: string;
    access_count: number;
    source_chat_id: string;
    project_id: string;
    superseded_by: string | null;
    supersedes: string | null;
    embedding: Buffer;
  }>;

  const nowMs = now.getTime();
  const scored: ScoredMemory[] = metaRows.map((r) => {
    const rrf = rrfScores.get(r.id) ?? 0;
    const ageMs = nowMs - new Date(r.last_accessed).getTime();
    const recencyDecay = Math.pow(0.5, ageMs / HALF_LIFE_MS);
    const importanceWeight = r.importance / 10;
    // Heavily penalize superseded memories so current versions rank first
    const supersessionPenalty = r.superseded_by ? 0.1 : 1.0;
    const score = rrf * recencyDecay * importanceWeight * supersessionPenalty;

    return {
      memory: {
        id: r.id,
        text: r.text,
        category: r.category as Memory["category"],
        importance: r.importance,
        embedding: Array.from(new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4)),
        createdAt: r.created_at,
        lastAccessed: r.last_accessed,
        accessCount: r.access_count,
        sourceChatId: r.source_chat_id,
        ...(r.project_id ? { projectId: r.project_id } : {}),
        supersededBy: r.superseded_by || undefined,
        supersedes: r.supersedes || undefined,
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
      "SELECT id, text, category, importance, created_at, last_accessed, access_count, source_chat_id, project_id FROM memories WHERE id = ?"
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
    project_id: string;
  } | undefined;

  if (!row) return null;

  return {
    id: row.id,
    text: row.text,
    category: row.category as Memory["category"],
    importance: row.importance,
    embedding: [],
    createdAt: row.created_at,
    lastAccessed: row.last_accessed,
    accessCount: row.access_count,
    sourceChatId: row.source_chat_id,
    ...(row.project_id ? { projectId: row.project_id } : {}),
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

export async function getLastWakeCycleAt(): Promise<string | null> {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM metadata WHERE key = 'lastWakeCycleAt'")
    .get() as { value: string } | undefined;
  return row?.value ?? null;
}

export async function setLastWakeCycleAt(value: string | null): Promise<void> {
  const db = getDb();
  if (value) {
    db.prepare(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('lastWakeCycleAt', ?)"
    ).run(value);
  } else {
    db.prepare("DELETE FROM metadata WHERE key = 'lastWakeCycleAt'").run();
  }
}

export type MemorySortBy = "created_at_desc" | "created_at_asc" | "last_accessed_desc" | "importance_desc";

const SORT_CLAUSES: Record<MemorySortBy, string> = {
  created_at_desc: "ORDER BY created_at DESC",
  created_at_asc: "ORDER BY created_at ASC",
  last_accessed_desc: "ORDER BY last_accessed DESC",
  importance_desc: "ORDER BY importance DESC",
};

export async function getAllMemories(
  sortBy: MemorySortBy = "created_at_desc"
): Promise<Omit<Memory, "embedding">[]> {
  const db = getDb();
  const orderClause = SORT_CLAUSES[sortBy] || SORT_CLAUSES.created_at_desc;
  const rows = db
    .prepare(
      `SELECT id, text, category, importance, created_at, last_accessed, access_count, source_chat_id, project_id, source_type, source_id, superseded_by, supersedes FROM memories ${orderClause}`
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
    project_id: string;
    source_type: string;
    source_id: string;
    superseded_by: string | null;
    supersedes: string | null;
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
    ...(r.project_id ? { projectId: r.project_id } : {}),
    sourceType: r.source_type as Memory['sourceType'],
    sourceId: r.source_id || undefined,
    supersededBy: r.superseded_by || undefined,
    supersedes: r.supersedes || undefined,
  }));
}

/** Get memories extracted from a specific chat, newest first. */
export function getMemoriesFromChat(chatId: string, limit = 15): Omit<Memory, "embedding">[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, text, category, importance, created_at, last_accessed, access_count, source_chat_id, project_id, source_type, source_id, superseded_by, supersedes
     FROM memories WHERE source_chat_id = ? AND superseded_by IS NULL
     ORDER BY created_at DESC LIMIT ?`
  ).all(chatId, limit) as any[];

  return rows.map((r: any) => ({
    id: r.id,
    text: r.text,
    category: r.category,
    importance: r.importance,
    createdAt: r.created_at,
    lastAccessed: r.last_accessed,
    accessCount: r.access_count,
    sourceChatId: r.source_chat_id,
    ...(r.project_id ? { projectId: r.project_id } : {}),
    sourceType: r.source_type,
    sourceId: r.source_id || undefined,
    supersededBy: r.superseded_by || undefined,
    supersedes: r.supersedes || undefined,
  }));
}

/**
 * Raw semantic search without scoring/reranking - returns memories as-is.
 * Used for supersession detection.
 */
export async function searchMemoriesRaw(
  queryEmbedding: number[],
  topK: number
): Promise<ScoredMemory[]> {
  const db = getDb();
  
  const vecRows = db
    .prepare(
      `SELECT id, distance FROM vec_memories WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
    )
    .all(new Float32Array(queryEmbedding), topK) as Array<{
    id: string;
    distance: number;
  }>;

  if (vecRows.length === 0) return [];

  const ids = vecRows.map(r => r.id);
  const placeholders = ids.map(() => "?").join(",");
  const metaRows = db
    .prepare(
      `SELECT id, text, category, importance, created_at, last_accessed, access_count, source_chat_id, project_id, source_type, source_id, superseded_by, supersedes FROM memories WHERE id IN (${placeholders})`
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
    project_id: string;
    source_type: string;
    source_id: string;
    superseded_by: string | null;
    supersedes: string | null;
  }>;

  return metaRows.map(r => {
    const vecMatch = vecRows.find(v => v.id === r.id);
    const distance = vecMatch ? vecMatch.distance : 0;
    return {
      memory: {
        id: r.id,
        text: r.text,
        category: r.category as Memory["category"],
        importance: r.importance,
        embedding: [],
        createdAt: r.created_at,
        lastAccessed: r.last_accessed,
        accessCount: r.access_count,
        sourceChatId: r.source_chat_id,
        ...(r.project_id ? { projectId: r.project_id } : {}),
        sourceType: r.source_type as Memory['sourceType'],
        sourceId: r.source_id || undefined,
        supersededBy: r.superseded_by || undefined,
        supersedes: r.supersedes || undefined,
      },
      score: 1 - distance,
    };
  });
}

/**
 * Create a supersession link between two memories.
 * newerMemoryId supersedes olderMemoryId.
 * Returns false if the link would create a cycle or is a self-link.
 */
export async function createSupersessionLink(
  newerMemoryId: string,
  olderMemoryId: string,
  confidence: number
): Promise<boolean> {
  if (newerMemoryId === olderMemoryId) {
    console.warn(`[memory] Rejected self-supersession: ${newerMemoryId}`);
    return false;
  }

  const db = getDb();

  // Walk the chain from newerMemoryId forward (via superseded_by) to check if
  // olderMemoryId is already an ancestor — if so, linking would create a cycle.
  // Also walk backward (via supersedes) from olderMemoryId for the same reason.
  const visited = new Set<string>([newerMemoryId]);

  // Walk forward from newer: if we reach older, it's already "above" newer → cycle
  let currentId: string | null = newerMemoryId;
  while (currentId) {
    const row = db.prepare(
      "SELECT superseded_by FROM memories WHERE id = ?"
    ).get(currentId) as { superseded_by: string | null } | undefined;
    currentId = row?.superseded_by || null;
    if (!currentId) break;
    if (currentId === olderMemoryId) {
      console.warn(`[memory] Rejected supersession cycle: ${olderMemoryId} is already newer than ${newerMemoryId}`);
      return false;
    }
    if (visited.has(currentId)) break; // existing cycle in data — don't extend it
    visited.add(currentId);
  }

  // Walk backward from older: if we reach newer, it's already "below" older → cycle
  currentId = olderMemoryId;
  visited.add(olderMemoryId);
  while (currentId) {
    const row = db.prepare(
      "SELECT supersedes FROM memories WHERE id = ?"
    ).get(currentId) as { supersedes: string | null } | undefined;
    currentId = row?.supersedes || null;
    if (!currentId) break;
    if (currentId === newerMemoryId) {
      console.warn(`[memory] Rejected supersession cycle: ${newerMemoryId} is already older than ${olderMemoryId}`);
      return false;
    }
    if (visited.has(currentId)) break;
    visited.add(currentId);
  }

  const now = new Date().toISOString();
  const linkId = uuid();

  const insert = db.transaction(() => {
    // Insert audit record
    db.prepare(`
      INSERT INTO memory_supersession_history (id, older_memory_id, newer_memory_id, confidence, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(linkId, olderMemoryId, newerMemoryId, confidence, now);

    // Update newer memory to point to older
    db.prepare(`
      UPDATE memories SET supersedes = ? WHERE id = ?
    `).run(olderMemoryId, newerMemoryId);

    // Update older memory to point to newer
    db.prepare(`
      UPDATE memories SET superseded_by = ? WHERE id = ?
    `).run(newerMemoryId, olderMemoryId);
  });

  insert();
  console.log(`[memory] Created supersession link: ${olderMemoryId} → ${newerMemoryId}`);
  return true;
}

/**
 * Remove a supersession link (e.g., if it was a false positive).
 */
export async function removeSupersessionLink(
  newerMemoryId: string,
  olderMemoryId: string,
  reason?: string
): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  
  const remove = db.transaction(() => {
    // Mark the audit record as removed
    db.prepare(`
      UPDATE memory_supersession_history 
      SET removed_at = ?, removal_reason = ?
      WHERE older_memory_id = ? AND newer_memory_id = ? AND removed_at IS NULL
    `).run(now, reason || '', olderMemoryId, newerMemoryId);
    
    // Clear the links
    db.prepare(`
      UPDATE memories SET supersedes = NULL WHERE id = ? AND supersedes = ?
    `).run(newerMemoryId, olderMemoryId);
    
    db.prepare(`
      UPDATE memories SET superseded_by = NULL WHERE id = ? AND superseded_by = ?
    `).run(olderMemoryId, newerMemoryId);
  });
  
  remove();
  console.log(`[memory] Removed supersession link: ${olderMemoryId} → ${newerMemoryId}`);
}

/**
 * Get the supersession lineage for a memory.
 * Follows the chain in either direction.
 */
export async function getMemoryLineage(memoryId: string): Promise<{
  older: Array<{ id: string; text: string; createdAt: string }>;
  newer: Array<{ id: string; text: string; createdAt: string }>;
}> {
  const db = getDb();

  const older: Array<{ id: string; text: string; createdAt: string }> = [];
  const newer: Array<{ id: string; text: string; createdAt: string }> = [];
  const visited = new Set<string>([memoryId]);

  // Walk backwards (older memories this one supersedes)
  let currentId = memoryId;
  while (true) {
    const row = db.prepare(`
      SELECT supersedes FROM memories WHERE id = ?
    `).get(currentId) as { supersedes: string | null } | undefined;

    if (!row || !row.supersedes || visited.has(row.supersedes)) break;
    visited.add(row.supersedes);

    const olderRow = db.prepare(`
      SELECT id, text, created_at FROM memories WHERE id = ?
    `).get(row.supersedes) as { id: string; text: string; created_at: string } | undefined;

    if (!olderRow) break;

    older.push({ id: olderRow.id, text: olderRow.text, createdAt: olderRow.created_at });
    currentId = olderRow.id;
  }

  // Walk forwards (newer memories that supersede this one)
  currentId = memoryId;
  while (true) {
    const row = db.prepare(`
      SELECT superseded_by FROM memories WHERE id = ?
    `).get(currentId) as { superseded_by: string | null } | undefined;

    if (!row || !row.superseded_by || visited.has(row.superseded_by)) break;
    visited.add(row.superseded_by);

    const newerRow = db.prepare(`
      SELECT id, text, created_at FROM memories WHERE id = ?
    `).get(row.superseded_by) as { id: string; text: string; created_at: string } | undefined;

    if (!newerRow) break;

    newer.push({ id: newerRow.id, text: newerRow.text, createdAt: newerRow.created_at });
    currentId = newerRow.id;
  }

  return { older, newer };
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
      "SELECT id, text, category, importance, created_at, last_accessed, access_count, source_chat_id, project_id FROM memories WHERE id = ?"
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
    project_id: string;
  } | undefined;

  if (!metaRow) return null;

  return {
    memory: {
      id: metaRow.id,
      text: metaRow.text,
      category: metaRow.category as Memory["category"],
      importance: metaRow.importance,
      embedding: [],
      createdAt: metaRow.created_at,
      lastAccessed: metaRow.last_accessed,
      accessCount: metaRow.access_count,
      sourceChatId: metaRow.source_chat_id,
      ...(metaRow.project_id ? { projectId: metaRow.project_id } : {}),
    },
    similarity,
  };
}

// ---------------------------------------------------------------------------
// Chat-scoped memory queries (for delayed extraction)
// ---------------------------------------------------------------------------

/**
 * Get all memories extracted from a specific chat.
 * Used by delayed extraction to provide context about what was already captured.
 */
export async function getMemoriesByChatId(chatId: string): Promise<Omit<Memory, "embedding">[]> {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, text, category, importance, created_at, last_accessed, access_count, source_chat_id, project_id, source_type, source_id, superseded_by, supersedes FROM memories WHERE source_chat_id = ? ORDER BY created_at ASC"
    )
    .all(chatId) as Array<{
    id: string;
    text: string;
    category: string;
    importance: number;
    created_at: string;
    last_accessed: string;
    access_count: number;
    source_chat_id: string;
    project_id: string;
    source_type: string;
    source_id: string;
    superseded_by: string | null;
    supersedes: string | null;
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
    ...(r.project_id ? { projectId: r.project_id } : {}),
    sourceType: r.source_type as Memory['sourceType'],
    sourceId: r.source_id || undefined,
    supersededBy: r.superseded_by || undefined,
    supersedes: r.supersedes || undefined,
  }));
}

/**
 * Get memories from a chat created by delayed extraction.
 * Filters by sourceType = 'chat_delayed'.
 */
export async function getDelayedMemoriesByChatId(chatId: string): Promise<Omit<Memory, "embedding">[]> {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, text, category, importance, created_at, last_accessed, access_count, source_chat_id, project_id, source_type, source_id, superseded_by, supersedes FROM memories WHERE source_chat_id = ? AND source_type = 'chat_delayed' ORDER BY created_at ASC"
    )
    .all(chatId) as Array<{
    id: string;
    text: string;
    category: string;
    importance: number;
    created_at: string;
    last_accessed: string;
    access_count: number;
    source_chat_id: string;
    project_id: string;
    source_type: string;
    source_id: string;
    superseded_by: string | null;
    supersedes: string | null;
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
    ...(r.project_id ? { projectId: r.project_id } : {}),
    sourceType: r.source_type as Memory['sourceType'],
    sourceId: r.source_id || undefined,
    supersededBy: r.superseded_by || undefined,
    supersedes: r.supersedes || undefined,
  }));
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

// ---------------------------------------------------------------------------
// Memory Blocks — structured, editable knowledge documents
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BLOCK_CHARS = 4000;

export async function getMaxBlockChars(): Promise<number> {
  const { getSettings } = await import("./chat-storage.js");
  const settings = await getSettings();
  return settings.maxBlockChars ?? DEFAULT_MAX_BLOCK_CHARS;
}

// blockType distinguishes the different kinds of entries that all live in the
// memory_blocks table:
//   - 'note': plain agent-managed knowledge block (the default). Subject to
//     configurable maxBlockChars setting; eligible for auto-loading when active-scoped.
//   - 'notebook': agent-authored narrative/reflection entry. Archived by
//     default; exempt from the char cap.
//   - 'synthesis': agent-authored daily synthesis output from runSystemSynthesis.
//     Archived by default; exempt from the char cap.
//   - 'zeitgeist-archive': snapshot of the zeitgeist continuity block at a
//     point in time. Archived.
export type BlockType = "note" | "notebook" | "synthesis" | "zeitgeist-archive";

export function isArchivalBlockType(t: BlockType): boolean {
  return t !== "note";
}

// Attachments live in a JSON column — references only (image ids, artifact
// paths, tool-call metadata, chat links), never embedded binary data. The
// referenced assets already live in their own stores (user-images/,
// artifacts/, etc.) and are fetched on demand.
export interface BlockAttachments {
  images?: Array<{ id?: string; url?: string; thumbUrl?: string; mimeType?: string; name?: string }>;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, any> }>;
  toolResults?: Array<{ toolCallId: string; toolName: string; content: string; isError: boolean }>;
  artifacts?: Array<{ id: string; kind?: string; [k: string]: any }>;
  visuals?: Array<{ id?: string; [k: string]: any }>;
  links?: Array<{ type: string; id?: string; [k: string]: any }>;
}

export interface MemoryBlock {
  id: string;
  name: string;
  description: string;
  content: string;
  scope: "global" | "project" | "archived";
  projectId: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: "agent" | "user";
  tokenEstimate: number;
  blockType: BlockType;
  attachments?: BlockAttachments;
  supersededBy?: string;
  supersedes?: string;
}

function estimateBlockTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

// Shared row → MemoryBlock mapper. Handles blockType defaulting (for rows
// written before the migration landed), attachments JSON parsing, and nullable
// lineage columns. projectId intentionally remains an empty string for global
// blocks because the SQLite column is NOT NULL DEFAULT ''.
function mapBlockRow(row: any): MemoryBlock {
  let attachments: BlockAttachments | undefined;
  if (row.attachments) {
    try {
      attachments = JSON.parse(row.attachments);
    } catch {
      attachments = undefined;
    }
  }
  return {
    ...row,
    projectId: row.projectId || "",
    supersededBy: row.supersededBy || undefined,
    supersedes: row.supersedes || undefined,
    blockType: (row.blockType as BlockType) || "note",
    attachments,
  };
}

export function createMemoryBlock(
  block: Omit<MemoryBlock, "tokenEstimate" | "blockType" | "attachments"> & {
    blockType?: BlockType;
    attachments?: BlockAttachments;
  }
): MemoryBlock {
  const db = getDb();
  const full: MemoryBlock = {
    ...block,
    blockType: block.blockType ?? "note",
    attachments: block.attachments,
    tokenEstimate: estimateBlockTokens(block.content),
  };
  db.prepare(`
    INSERT INTO memory_blocks (id, name, description, content, scope, projectId, createdAt, updatedAt, updatedBy, tokenEstimate, blockType, attachments, supersededBy, supersedes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    full.id, full.name, full.description, full.content, full.scope,
    full.projectId || "", full.createdAt, full.updatedAt, full.updatedBy,
    full.tokenEstimate, full.blockType,
    full.attachments ? JSON.stringify(full.attachments) : null,
    full.supersededBy ?? null, full.supersedes ?? null
  );
  return full;
}

export function updateMemoryBlock(id: string, updates: {
  content?: string;
  description?: string;
  name?: string;
  scope?: "global" | "project" | "archived";
  blockType?: BlockType;
  attachments?: BlockAttachments | null;
  updatedBy?: "agent" | "user";
  projectId?: string | null;
}): boolean {
  const db = getDb();
  const existing = getMemoryBlock(id);
  if (!existing) return false;

  const content = updates.content ?? existing.content;
  const tokenEstimate = estimateBlockTokens(content);
  const now = new Date().toISOString();
  const newScope = updates.scope ?? existing.scope;
  const newType = updates.blockType ?? existing.blockType;
  // `attachments: null` explicitly clears; `undefined` keeps the existing.
  const attachmentsJson = updates.attachments === null
    ? null
    : updates.attachments !== undefined
      ? JSON.stringify(updates.attachments)
      : existing.attachments
        ? JSON.stringify(existing.attachments)
        : null;
  // `projectId: null` explicitly clears to the schema's blank global value;
  // `undefined` keeps the existing value.
  const newProjectId = updates.projectId !== undefined
    ? (updates.projectId ?? "")
    : (existing.projectId || "");

  db.prepare(`
    UPDATE memory_blocks SET
      content = ?, description = ?, name = ?, scope = ?,
      updatedAt = ?, updatedBy = ?, tokenEstimate = ?,
      blockType = ?, attachments = ?, projectId = ?
    WHERE id = ?
  `).run(
    content,
    updates.description ?? existing.description,
    updates.name ?? existing.name,
    newScope,
    now,
    updates.updatedBy ?? "agent",
    tokenEstimate,
    newType,
    attachmentsJson,
    newProjectId,
    id
  );
  return true;
}

export function getMemoryBlock(id: string): MemoryBlock | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM memory_blocks WHERE id = ?").get(id) as any;
  if (!row) return null;
  return mapBlockRow(row);
}

export function getMemoryBlocksByScope(scope: "global" | "project" | "archived", projectId?: string): MemoryBlock[] {
  const db = getDb();
  let rows: any[];
  if (scope === "archived") {
    rows = db.prepare(
      "SELECT * FROM memory_blocks WHERE scope = 'archived' AND supersededBy IS NULL ORDER BY updatedAt DESC"
    ).all();
  } else if (scope === "project" && projectId) {
    rows = db.prepare(
      "SELECT * FROM memory_blocks WHERE scope = 'project' AND projectId = ? AND supersededBy IS NULL ORDER BY updatedAt DESC"
    ).all(projectId);
  } else {
    rows = db.prepare(
      "SELECT * FROM memory_blocks WHERE scope = 'global' AND supersededBy IS NULL ORDER BY updatedAt DESC"
    ).all();
  }
  return rows.map(mapBlockRow);
}

export function getAllMemoryBlocks(): MemoryBlock[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM memory_blocks WHERE supersededBy IS NULL ORDER BY updatedAt DESC"
  ).all() as any[];
  return rows.map(mapBlockRow);
}

export function deleteMemoryBlock(id: string): boolean {
  const db = getDb();
  // Clean up revision history before deleting the block itself.
  db.prepare("DELETE FROM memory_blocks_history WHERE blockId = ?").run(id);
  const result = db.prepare("DELETE FROM memory_blocks WHERE id = ?").run(id);
  return result.changes > 0;
}

/** Supersede a block with a new version. */
export function supersedeBlock(
  oldBlockId: string,
  newBlock: Omit<MemoryBlock, "tokenEstimate" | "blockType" | "attachments"> & {
    blockType?: BlockType;
    attachments?: BlockAttachments;
  }
): MemoryBlock {
  const db = getDb();
  // Carry forward the old block's type when the caller doesn't override it —
  // supersession of a notebook entry should still be a notebook entry.
  const old = getMemoryBlock(oldBlockId);
  const inheritedType = newBlock.blockType ?? old?.blockType ?? "note";
  // Mark old block
  db.prepare("UPDATE memory_blocks SET supersededBy = ? WHERE id = ?").run(newBlock.id, oldBlockId);
  // Create new block with supersedes link
  const full = createMemoryBlock({ ...newBlock, blockType: inheritedType, supersedes: oldBlockId });
  return full;
}

/** Search block content via FTS5. Returns excerpts around matches. */
export function searchBlocks(
  query: string,
  opts: { projectId?: string; limit?: number } = {}
): Array<{ block: MemoryBlock; excerpt: string; rank: number }> {
  const db = getDb();
  const limit = opts.limit ?? 5;
  const escaped = query.replace(/['"]/g, "");
  const terms = escaped.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const termQuery = terms.map((t) => `"${t}"`).join(" OR ");
  try {
    const rows = db.prepare(`
      SELECT mb.*, f.rank
      FROM memory_blocks_fts f
      JOIN memory_blocks mb ON mb.rowid = f.rowid
      WHERE f.memory_blocks_fts MATCH ?
        AND mb.supersededBy IS NULL
      ORDER BY f.rank LIMIT ?
    `).all(termQuery, limit) as any[];

    return rows
      .filter((r) => !opts.projectId || r.scope === "global" || r.projectId === opts.projectId)
      .map((r) => ({
        block: mapBlockRow(r),
        excerpt: extractExcerpt(r.content, query, 400),
        rank: r.rank,
      }));
  } catch {
    return [];
  }
}

/** Extract a text excerpt around the first occurrence of any query term. */
function extractExcerpt(text: string, query: string, radius = 400): string {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = text.toLowerCase();
  let bestPos = -1;
  for (const term of terms) {
    const pos = lower.indexOf(term);
    if (pos >= 0 && (bestPos < 0 || pos < bestPos)) bestPos = pos;
  }
  if (bestPos < 0) return text.slice(0, radius);
  const start = Math.max(0, bestPos - radius / 2);
  const end = Math.min(text.length, bestPos + radius / 2);
  let excerpt = text.slice(start, end);
  if (start > 0) excerpt = "..." + excerpt;
  if (end < text.length) excerpt = excerpt + "...";
  return excerpt;
}

/** List blocks with optional filtering. */
export function listMemoryBlocks(opts: { scope?: "global" | "project" | "archived"; projectId?: string; query?: string; includeInternal?: boolean } = {}): MemoryBlock[] {
  const db = getDb();
  let querySQL = "SELECT * FROM memory_blocks WHERE supersededBy IS NULL";
  const params: any[] = [];

  if (opts.scope) {
    querySQL += " AND scope = ?";
    params.push(opts.scope);
  } else {
    // When no scope specified, exclude archived blocks by default
    querySQL += " AND scope != 'archived'";
  }

  if (opts.projectId) {
    querySQL += " AND projectId = ?";
    params.push(opts.projectId);
  }

  if (opts.query) {
    querySQL += " AND (name LIKE ? OR description LIKE ?)";
    const searchPattern = `%${opts.query}%`;
    params.push(searchPattern, searchPattern);
  }

  // Exclude internal block types (synthesis, zeitgeist-archive, notebook) unless
  // explicitly requested. These are managed by the agent and shouldn't appear in
  // the user-facing block indicator or dropdown.
  if (!opts.includeInternal) {
    querySQL += " AND blockType NOT IN ('synthesis', 'zeitgeist-archive', 'notebook')";
  }

  querySQL += " ORDER BY updatedAt DESC";

  const rows = db.prepare(querySQL).all(...params) as any[];
  return rows.map(mapBlockRow);
}

/** Get revision history: old snapshots from history table + current block. */
export function getBlockHistory(blockId: string): MemoryBlock[] {
  const db = getDb();
  const history: MemoryBlock[] = [];

  // Get historical snapshots, oldest first.
  // rowid is unique per snapshot — use it as a synthetic id so each
  // history entry has a distinct identity for the client's React keys.
  // ORDER BY updatedAt, rowid guarantees stable ordering when multiple
  // edits land in the same millisecond.
  const rows = db.prepare(`
    SELECT rowid AS id, blockId, name, description, content, scope, projectId,
           createdAt, updatedAt, updatedBy, tokenEstimate, blockType
    FROM memory_blocks_history
    WHERE blockId = ?
    ORDER BY updatedAt ASC, rowid ASC
  `).all(blockId) as any[];

  for (const row of rows) {
    // Ensure id is a string for MemoryBlock interface compatibility.
    // History ids use SQLite rowid; the current block uses its real id,
    // so `h.id === block.id` in the client correctly marks the latest version.
    history.push(mapBlockRow({ ...row, id: String(row.id) }));
  }

  // Append current block
  const current = db.prepare("SELECT * FROM memory_blocks WHERE id = ?").get(blockId) as any;
  if (current) {
    history.push(mapBlockRow(current));
  }

  return history;
}

export { DEFAULT_MAX_BLOCK_CHARS };
