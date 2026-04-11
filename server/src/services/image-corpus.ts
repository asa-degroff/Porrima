import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { existsSync, mkdirSync, readFileSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const BASE_DIR = join(homedir(), ".quje-agent");
const CORPUS_DIR = join(BASE_DIR, "image-corpus");
const CORPUS_JSON = join(CORPUS_DIR, "corpus.json");
const CORPUS_DB = join(CORPUS_DIR, "corpus.db");

// ---------------------------------------------------------------------------
// Types (re-exported — consumers import from here)
// ---------------------------------------------------------------------------

export interface ImageCorpusEntry {
  id: string;
  type: "generated" | "analyzed" | "uploaded";
  imagePath: string;
  thumbnailPath?: string;
  prompt?: string;
  description: string;
  elements: Record<string, string[]>;
  promptEmbedding?: number[];
  createdAt: number;
  updatedAt: number;
  chatId?: string;
  projectId?: string;
  generationId?: string;
  visionId?: string;
}

export interface CorpusStats {
  totalCount: number;
  byType: { generated: number; analyzed: number; uploaded: number };
  withEmbeddings: number;
  withElements: number;
  dateRange: { earliest: number; latest: number };
}

// ---------------------------------------------------------------------------
// Lazy singleton database
// ---------------------------------------------------------------------------

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;

  if (!existsSync(CORPUS_DIR)) {
    mkdirSync(CORPUS_DIR, { recursive: true });
  }

  const needsMigration = existsSync(CORPUS_JSON) && !existsSync(CORPUS_DB);

  const db = new Database(CORPUS_DB);
  sqliteVec.load(db);
  db.pragma("journal_mode = WAL");

  // ── Schema ───────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS corpus_entries (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'generated',
      image_path TEXT NOT NULL,
      thumbnail_path TEXT,
      prompt TEXT,
      description TEXT NOT NULL DEFAULT '',
      elements TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      chat_id TEXT,
      project_id TEXT,
      generation_id TEXT,
      vision_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_corpus_type ON corpus_entries(type);
    CREATE INDEX IF NOT EXISTS idx_corpus_chat ON corpus_entries(chat_id);
    CREATE INDEX IF NOT EXISTS idx_corpus_project ON corpus_entries(project_id);
    CREATE INDEX IF NOT EXISTS idx_corpus_created ON corpus_entries(created_at);
  `);

  // sqlite-vec virtual table for prompt embeddings
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_corpus USING vec0(
      id TEXT PRIMARY KEY,
      embedding float[1024] distance_metric=cosine
    );
  `);

  // FTS5 on prompt + description for text search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_corpus USING fts5(
      id UNINDEXED, prompt, description,
      content=corpus_entries, content_rowid=rowid
    );
  `);

  // Auto-sync FTS triggers
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS corpus_ai AFTER INSERT ON corpus_entries BEGIN
      INSERT INTO fts_corpus(rowid, id, prompt, description)
        VALUES (new.rowid, new.id, COALESCE(new.prompt, ''), new.description);
    END;
    CREATE TRIGGER IF NOT EXISTS corpus_ad AFTER DELETE ON corpus_entries BEGIN
      INSERT INTO fts_corpus(fts_corpus, rowid, id, prompt, description)
        VALUES ('delete', old.rowid, old.id, COALESCE(old.prompt, ''), old.description);
    END;
    CREATE TRIGGER IF NOT EXISTS corpus_au AFTER UPDATE ON corpus_entries BEGIN
      INSERT INTO fts_corpus(fts_corpus, rowid, id, prompt, description)
        VALUES ('delete', old.rowid, old.id, COALESCE(old.prompt, ''), old.description);
      INSERT INTO fts_corpus(rowid, id, prompt, description)
        VALUES (new.rowid, new.id, COALESCE(new.prompt, ''), new.description);
    END;
  `);

  // Column migrations (for existing databases)
  const cols = db.prepare("PRAGMA table_info(corpus_entries)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map(c => c.name));
  // ── Migrate from JSON ────────────────────────────────────────────
  if (needsMigration) {
    migrateFromJson(db);
  }

  _db = db;
  console.log(`[image-corpus] SQLite database ready: ${CORPUS_DB}`);
  return db;
}

// ---------------------------------------------------------------------------
// JSON → SQLite migration
// ---------------------------------------------------------------------------

function migrateFromJson(db: Database.Database): void {
  try {
    const raw = readFileSync(CORPUS_JSON, "utf-8");
    const entries: ImageCorpusEntry[] = JSON.parse(raw);
    if (!Array.isArray(entries) || entries.length === 0) return;

    console.log(`[image-corpus] Migrating ${entries.length} entries from JSON to SQLite...`);

    const insertEntry = db.prepare(`
      INSERT OR IGNORE INTO corpus_entries
        (id, type, image_path, thumbnail_path, prompt, description, elements,
         created_at, updated_at, chat_id, project_id, generation_id, vision_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertVec = db.prepare(
      "INSERT OR IGNORE INTO vec_corpus (id, embedding) VALUES (?, ?)"
    );

    const migrate = db.transaction(() => {
      for (const e of entries) {
        insertEntry.run(
          e.id,
          e.type || "generated",
          e.imagePath,
          e.thumbnailPath ?? null,
          e.prompt ?? null,
          e.description || "",
          JSON.stringify(e.elements || {}),
          e.createdAt || Date.now(),
          e.updatedAt || Date.now(),
          e.chatId ?? null,
          e.projectId ?? null,
          e.generationId ?? null,
          e.visionId ?? null,
        );

        if (e.promptEmbedding && e.promptEmbedding.length === 1024) {
          insertVec.run(e.id, new Float32Array(e.promptEmbedding));
        }
      }
    });
    migrate();

    // Rebuild FTS index from migrated data
    db.exec("INSERT INTO fts_corpus(fts_corpus) VALUES('rebuild')");

    // Rename old file
    renameSync(CORPUS_JSON, CORPUS_JSON + ".bak");
    console.log(`[image-corpus] Migration complete. Old file renamed to corpus.json.bak`);
  } catch (err) {
    console.error("[image-corpus] JSON migration failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Row → Entry conversion
// ---------------------------------------------------------------------------

interface CorpusRow {
  id: string;
  type: string;
  image_path: string;
  thumbnail_path: string | null;
  prompt: string | null;
  description: string;
  elements: string;
  created_at: number;
  updated_at: number;
  chat_id: string | null;
  project_id: string | null;
  generation_id: string | null;
  vision_id: string | null;
}

function rowToEntry(row: CorpusRow, embedding?: number[]): ImageCorpusEntry {
  return {
    id: row.id,
    type: row.type as ImageCorpusEntry["type"],
    imagePath: row.image_path,
    thumbnailPath: row.thumbnail_path ?? undefined,
    prompt: row.prompt ?? undefined,
    description: row.description,
    elements: JSON.parse(row.elements || "{}"),
    promptEmbedding: embedding,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    chatId: row.chat_id ?? undefined,
    projectId: row.project_id ?? undefined,
    generationId: row.generation_id ?? undefined,
    visionId: row.vision_id ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Public API — same signatures as the original JSON implementation
// ---------------------------------------------------------------------------

/**
 * Get the full corpus as a Map. Consumers that need the map (clustering, etc.)
 * still get the same interface, but it's now built from SQLite each call.
 * For most uses, prefer the more specific query functions below.
 */
export async function getCorpus(): Promise<Map<string, ImageCorpusEntry>> {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM corpus_entries").all() as CorpusRow[];

  // Batch-load embeddings
  const embMap = new Map<string, number[]>();
  try {
    const vecRows = db.prepare("SELECT id, embedding FROM vec_corpus").all() as Array<{
      id: string;
      embedding: Buffer;
    }>;
    for (const vr of vecRows) {
      embMap.set(vr.id, Array.from(new Float32Array(vr.embedding.buffer, vr.embedding.byteOffset, vr.embedding.byteLength / 4)));
    }
  } catch {
    // vec table may be empty
  }

  const map = new Map<string, ImageCorpusEntry>();
  for (const row of rows) {
    map.set(row.id, rowToEntry(row, embMap.get(row.id)));
  }
  return map;
}

export async function getCorpusEntry(id: string): Promise<ImageCorpusEntry | undefined> {
  const db = getDb();
  const row = db.prepare("SELECT * FROM corpus_entries WHERE id = ?").get(id) as CorpusRow | undefined;
  if (!row) return undefined;

  let embedding: number[] | undefined;
  try {
    const vr = db.prepare("SELECT embedding FROM vec_corpus WHERE id = ?").get(id) as { embedding: Buffer } | undefined;
    if (vr) {
      embedding = Array.from(new Float32Array(vr.embedding.buffer, vr.embedding.byteOffset, vr.embedding.byteLength / 4));
    }
  } catch {}

  return rowToEntry(row, embedding);
}

export async function getAllCorpusEntries(): Promise<ImageCorpusEntry[]> {
  const corpus = await getCorpus();
  return Array.from(corpus.values()).sort((a, b) => b.createdAt - a.createdAt);
}

export async function addCorpusEntry(entry: ImageCorpusEntry): Promise<ImageCorpusEntry> {
  const db = getDb();

  const insert = db.transaction(() => {
    db.prepare(`
      INSERT OR REPLACE INTO corpus_entries
        (id, type, image_path, thumbnail_path, prompt, description, elements,
         created_at, updated_at, chat_id, project_id, generation_id, vision_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.type,
      entry.imagePath,
      entry.thumbnailPath ?? null,
      entry.prompt ?? null,
      entry.description || "",
      JSON.stringify(entry.elements || {}),
      entry.createdAt,
      entry.updatedAt,
      entry.chatId ?? null,
      entry.projectId ?? null,
      entry.generationId ?? null,
      entry.visionId ?? null,
    );

    if (entry.promptEmbedding && entry.promptEmbedding.length === 1024) {
      db.prepare("DELETE FROM vec_corpus WHERE id = ?").run(entry.id);
      db.prepare("INSERT INTO vec_corpus (id, embedding) VALUES (?, ?)").run(
        entry.id,
        new Float32Array(entry.promptEmbedding)
      );
    }
  });
  insert();

  return entry;
}

export async function updateCorpusEntry(
  id: string,
  updates: Partial<ImageCorpusEntry>
): Promise<ImageCorpusEntry | undefined> {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM corpus_entries WHERE id = ?").get(id) as CorpusRow | undefined;
  if (!existing) return undefined;

  // Merge existing elements with update
  const existingElements = JSON.parse(existing.elements || "{}");
  const mergedElements = updates.elements ?? existingElements;

  const update = db.transaction(() => {
    db.prepare(`
      UPDATE corpus_entries SET
        type = ?, image_path = ?, thumbnail_path = ?, prompt = ?, description = ?,
        elements = ?, updated_at = ?, chat_id = ?, project_id = ?,
        generation_id = ?, vision_id = ?
      WHERE id = ?
    `).run(
      updates.type ?? existing.type,
      updates.imagePath ?? existing.image_path,
      updates.thumbnailPath ?? existing.thumbnail_path,
      updates.prompt ?? existing.prompt,
      updates.description ?? existing.description,
      JSON.stringify(mergedElements),
      Date.now(),
      updates.chatId ?? existing.chat_id,
      updates.projectId ?? existing.project_id,
      updates.generationId ?? existing.generation_id,
      updates.visionId ?? existing.vision_id,
      id,
    );

    if (updates.promptEmbedding && updates.promptEmbedding.length === 1024) {
      db.prepare("DELETE FROM vec_corpus WHERE id = ?").run(id);
      db.prepare("INSERT INTO vec_corpus (id, embedding) VALUES (?, ?)").run(
        id,
        new Float32Array(updates.promptEmbedding)
      );
    }
  });
  update();

  // Return the updated entry
  return getCorpusEntry(id);
}

export async function deleteCorpusEntry(id: string): Promise<boolean> {
  const db = getDb();
  const del = db.transaction(() => {
    db.prepare("DELETE FROM vec_corpus WHERE id = ?").run(id);
    const result = db.prepare("DELETE FROM corpus_entries WHERE id = ?").run(id);
    return result.changes > 0;
  });
  return del();
}

/**
 * Delete a corpus entry by visionId (for analyzed images).
 * Returns true if a corpus entry was found and deleted.
 */
export async function deleteCorpusEntryByVisionId(visionId: string): Promise<boolean> {
  const db = getDb();
  const entry = db.prepare("SELECT id FROM corpus_entries WHERE vision_id = ?").get(visionId) as { id: string } | undefined;
  if (!entry) return false;
  
  const del = db.transaction(() => {
    db.prepare("DELETE FROM vec_corpus WHERE id = ?").run(entry.id);
    const result = db.prepare("DELETE FROM corpus_entries WHERE id = ?").run(entry.id);
    return result.changes > 0;
  });
  return del();
}

/**
 * Cleanup orphaned corpus entries - entries whose image files no longer exist on disk.
 * Returns a report of what was cleaned up.
 */
export async function cleanupOrphanedEntries(): Promise<{
  totalScanned: number;
  orphanedCount: number;
  generatedOrphans: number;
  analyzedOrphans: number;
  details: Array<{ id: string; type: string; reason: string }>;
}> {
  const db = getDb();
  const { access } = await import("fs/promises");
  const { join } = await import("path");
  const { homedir } = await import("os");
  
  const BASE_DIR = join(homedir(), ".quje-agent");
  const IMAGES_DIR = join(BASE_DIR, "images");
  const VISION_DIR = join(BASE_DIR, "vision");
  
  const rows = db.prepare("SELECT id, type, image_path, vision_id FROM corpus_entries").all() as Array<{
    id: string;
    type: string;
    image_path: string;
    vision_id: string | null;
  }>;
  
  const orphans: Array<{ id: string; type: string; reason: string }> = [];
  let generatedOrphans = 0;
  let analyzedOrphans = 0;
  
  for (const row of rows) {
    let fileExists = false;
    
    if (row.type === "generated") {
      // Generated images: image_path is the image ID
      // Check for JXL first, then PNG fallback
      const jxlPath = join(IMAGES_DIR, row.image_path, "image.jxl");
      const pngPath = join(IMAGES_DIR, row.image_path, "image.png");
      
      try {
        await access(jxlPath);
        fileExists = true;
      } catch {
        try {
          await access(pngPath);
          fileExists = true;
        } catch {
          fileExists = false;
        }
      }
      
      if (!fileExists) {
        orphans.push({ id: row.id, type: "generated", reason: "Image file not found" });
        generatedOrphans++;
      }
    } else if (row.type === "analyzed") {
      // Analyzed images: image_path is relative path like "vision/images/{id}/{filename}"
      // Or we can use vision_id to construct the path
      const visionId = row.vision_id || row.image_path.split("/")[2];
      const metadataPath = join(VISION_DIR, "images", visionId, "metadata.json");
      
      try {
        await access(metadataPath);
        fileExists = true;
      } catch {
        fileExists = false;
      }
      
      if (!fileExists) {
        orphans.push({ id: row.id, type: "analyzed", reason: "Vision metadata not found" });
        analyzedOrphans++;
      }
    } else if (row.type === "uploaded") {
      // Uploaded user images: image_path is relative path
      const fullPath = join(BASE_DIR, row.image_path);
      try {
        await access(fullPath);
        fileExists = true;
      } catch {
        fileExists = false;
      }
      
      if (!fileExists) {
        orphans.push({ id: row.id, type: "uploaded", reason: "User image file not found" });
      }
    }
  }
  
  // Delete orphaned entries
  const deletedIds: string[] = [];
  for (const orphan of orphans) {
    const del = db.transaction(() => {
      db.prepare("DELETE FROM vec_corpus WHERE id = ?").run(orphan.id);
      db.prepare("DELETE FROM corpus_entries WHERE id = ?").run(orphan.id);
    });
    del();
    deletedIds.push(orphan.id);
  }
  
  return {
    totalScanned: rows.length,
    orphanedCount: orphans.length,
    generatedOrphans,
    analyzedOrphans,
    details: orphans,
  };
}

export async function getCorpusStats(): Promise<CorpusStats> {
  const db = getDb();

  const total = (db.prepare("SELECT COUNT(*) as c FROM corpus_entries").get() as { c: number }).c;
  const generated = (db.prepare("SELECT COUNT(*) as c FROM corpus_entries WHERE type = 'generated'").get() as { c: number }).c;
  const analyzed = (db.prepare("SELECT COUNT(*) as c FROM corpus_entries WHERE type = 'analyzed'").get() as { c: number }).c;
  const uploaded = (db.prepare("SELECT COUNT(*) as c FROM corpus_entries WHERE type = 'uploaded'").get() as { c: number }).c;
  const withEmb = (db.prepare("SELECT COUNT(*) as c FROM vec_corpus").get() as { c: number }).c;

  // Count entries with non-empty elements
  const withElem = (db.prepare(
    "SELECT COUNT(*) as c FROM corpus_entries WHERE elements != '{}' AND elements != ''"
  ).get() as { c: number }).c;

  const earliest = (db.prepare("SELECT MIN(created_at) as m FROM corpus_entries").get() as { m: number | null }).m ?? 0;
  const latest = (db.prepare("SELECT MAX(created_at) as m FROM corpus_entries").get() as { m: number | null }).m ?? 0;

  return {
    totalCount: total,
    byType: { generated, analyzed, uploaded },
    withEmbeddings: withEmb,
    withElements: withElem,
    dateRange: { earliest, latest },
  };
}

// ---------------------------------------------------------------------------
// Embedding & enrichment
// ---------------------------------------------------------------------------

export async function embedPrompt(prompt: string): Promise<number[]> {
  try {
    const { embed } = await import("./embeddings.js");
    return await embed(prompt);
  } catch (err) {
    console.error("[image-corpus] embedding error:", err);
    return [];
  }
}

export async function enrichCorpusEntry(
  id: string,
  prompt?: string,
  description?: string
): Promise<ImageCorpusEntry | undefined> {
  const entry = await getCorpusEntry(id);
  if (!entry) return undefined;

  const updates: Partial<ImageCorpusEntry> = {};

  // Embed prompt if available and missing
  if (prompt && (!entry.promptEmbedding || entry.promptEmbedding.length === 0)) {
    const embedding = await embedPrompt(prompt);
    if (embedding.length > 0) {
      updates.promptEmbedding = embedding;
    }
  }

  // Extract elements from description or prompt
  if (description && Object.keys(entry.elements).length === 0) {
    const { extractElements } = await import("./element-extraction.js");
    const elements = await extractElements(description, prompt);
    if (Object.keys(elements).length > 0) {
      updates.elements = elements;
    }
  } else if (prompt && Object.keys(entry.elements).length === 0) {
    const { extractElements } = await import("./element-extraction.js");
    const elements = await extractElements("", prompt);
    if (Object.keys(elements).length > 0) {
      updates.elements = elements;
    }
  }

  if (Object.keys(updates).length > 0) {
    return updateCorpusEntry(id, updates);
  }

  return entry;
}

export async function enrichCorpusBatch(batchSize = 10): Promise<number> {
  const db = getDb();

  // Find entries needing embeddings (have prompt but no embedding)
  const needsEmbed = db.prepare(`
    SELECT ce.id, ce.prompt, ce.description FROM corpus_entries ce
    LEFT JOIN vec_corpus vc ON vc.id = ce.id
    WHERE ce.prompt IS NOT NULL AND ce.prompt != '' AND vc.id IS NULL
    LIMIT ?
  `).all(batchSize) as Array<{ id: string; prompt: string; description: string }>;

  // Find entries needing elements
  const needsElements = db.prepare(`
    SELECT id, prompt, description FROM corpus_entries
    WHERE (elements = '{}' OR elements = '') AND (prompt IS NOT NULL OR description != '')
    LIMIT ?
  `).all(batchSize) as Array<{ id: string; prompt: string | null; description: string }>;

  // Combine and deduplicate
  const toEnrich = new Map<string, { id: string; prompt?: string; description?: string }>();
  for (const r of needsEmbed) toEnrich.set(r.id, { id: r.id, prompt: r.prompt, description: r.description });
  for (const r of needsElements) {
    if (!toEnrich.has(r.id)) toEnrich.set(r.id, { id: r.id, prompt: r.prompt ?? undefined, description: r.description });
  }

  let enrichedCount = 0;
  const batch = Array.from(toEnrich.values()).slice(0, batchSize);
  for (const item of batch) {
    const result = await enrichCorpusEntry(item.id, item.prompt, item.description);
    if (result) enrichedCount++;
  }

  return enrichedCount;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export async function searchCorpusByElement(
  elementType: string,
  value: string
): Promise<ImageCorpusEntry[]> {
  const db = getDb();
  // SQLite JSON: use LIKE on the serialized elements column for simplicity
  const lowerVal = `%${value.toLowerCase()}%`;
  const rows = db.prepare(`
    SELECT * FROM corpus_entries
    WHERE LOWER(json_extract(elements, '$.' || ?)) LIKE ?
  `).all(elementType, lowerVal) as CorpusRow[];

  return rows.map(r => rowToEntry(r));
}

export async function getCorpusByChat(chatId: string): Promise<ImageCorpusEntry[]> {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM corpus_entries WHERE chat_id = ?").all(chatId) as CorpusRow[];
  return rows.map(r => rowToEntry(r));
}

export async function getCorpusByProject(projectId: string): Promise<ImageCorpusEntry[]> {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM corpus_entries WHERE project_id = ?").all(projectId) as CorpusRow[];
  return rows.map(r => rowToEntry(r));
}

// ---------------------------------------------------------------------------
// New: Vector similarity search (KNN via sqlite-vec)
// ---------------------------------------------------------------------------

/**
 * Find the K nearest corpus entries to a query embedding.
 * Returns entries sorted by similarity (highest first).
 */
export async function searchCorpusBySimilarity(
  queryEmbedding: number[],
  limit = 10
): Promise<Array<ImageCorpusEntry & { similarity: number }>> {
  const db = getDb();

  const vecRows = db.prepare(
    "SELECT id, distance FROM vec_corpus WHERE embedding MATCH ? ORDER BY distance LIMIT ?"
  ).all(new Float32Array(queryEmbedding), limit) as Array<{ id: string; distance: number }>;

  const results: Array<ImageCorpusEntry & { similarity: number }> = [];
  for (const vr of vecRows) {
    const entry = await getCorpusEntry(vr.id);
    if (entry) {
      results.push({ ...entry, similarity: 1 - vr.distance });
    }
  }

  return results;
}

/**
 * Find the nearest corpus entries to a given entry ID.
 */
export async function findSimilarEntries(
  entryId: string,
  limit = 5
): Promise<Array<ImageCorpusEntry & { similarity: number }>> {
  const entry = await getCorpusEntry(entryId);
  if (!entry?.promptEmbedding) return [];

  const results = await searchCorpusBySimilarity(entry.promptEmbedding, limit + 1);
  // Exclude self
  return results.filter(r => r.id !== entryId).slice(0, limit);
}

/**
 * Full-text search on prompts and descriptions.
 */
export async function searchCorpusByText(
  query: string,
  limit = 10
): Promise<ImageCorpusEntry[]> {
  const db = getDb();

  const rows = db.prepare(`
    SELECT ce.* FROM fts_corpus fts
    JOIN corpus_entries ce ON ce.id = fts.id
    WHERE fts_corpus MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(query, limit) as CorpusRow[];

  return rows.map(r => rowToEntry(r));
}

/**
 * Hybrid search combining FTS5 full-text + vector similarity with RRF ranking.
 * Returns entries sorted by combined relevance score.
 */
export async function searchCorpusHybrid(
  query: string,
  limit = 10
): Promise<Array<ImageCorpusEntry & { score: number }>> {
  console.log("[image-corpus] hybrid search starting for:", query);
  const startTime = Date.now();
  const db = getDb();
  const RRF_K = 60; // standard RRF constant

  // Get query embedding with timeout
  let queryEmbedding: number[] = [];
  try {
    console.log("[image-corpus] fetching embedding...");
    const { embed } = await import("./embeddings.js");
    const embedPromise = embed(query);
    const timeoutPromise = new Promise<number[]>((_, reject) => 
      setTimeout(() => reject(new Error("Embedding timeout")), 5000)
    );
    queryEmbedding = await Promise.race([embedPromise, timeoutPromise]);
    console.log("[image-corpus] embedding received, length:", queryEmbedding.length);
  } catch (err: any) {
    console.warn("[image-corpus] hybrid search embedding error (will use FTS-only):", err.message || err);
    // Fall back to FTS-only if embedding fails
  }

  // FTS search (phrase match first, then term match)
  const trimmed = query.trim();
  const escaped = trimmed.replace(/"/g, '""');
  console.log("[image-corpus] FTS phrase search for:", `"${escaped}"`);
  
  let ftsRows = db.prepare(`
    SELECT ce.*, fts.rank FROM fts_corpus fts
    JOIN corpus_entries ce ON ce.id = fts.id
    WHERE fts_corpus MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(`"${escaped}"`, Math.max(20, limit * 3)) as Array<CorpusRow & { rank: number }>;
  console.log("[image-corpus] FTS phrase results:", ftsRows.length);

  // Fall back to term search if phrase match yields nothing
  if (ftsRows.length === 0) {
    const terms = trimmed
      .split(/\s+/)
      .filter((t) => t.length > 0)
      .map((t) => `"${t.replace(/"/g, '""')}"`)
      .join(" OR ");
    if (terms) {
      console.log("[image-corpus] FTS term search for:", terms);
      ftsRows = db.prepare(`
        SELECT ce.*, fts.rank FROM fts_corpus fts
        JOIN corpus_entries ce ON ce.id = fts.id
        WHERE fts_corpus MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(terms, Math.max(20, limit * 3)) as Array<CorpusRow & { rank: number }>;
      console.log("[image-corpus] FTS term results:", ftsRows.length);
    }
  }

  // Vector search if embedding succeeded
  let vecRows: Array<{ id: string; distance: number }> = [];
  if (queryEmbedding.length > 0) {
    console.log("[image-corpus] running vector search...");
    vecRows = db.prepare(
      "SELECT id, distance FROM vec_corpus WHERE embedding MATCH ? ORDER BY distance LIMIT ?"
    ).all(new Float32Array(queryEmbedding), Math.max(20, limit * 3)) as Array<{ id: string; distance: number }>;
    console.log("[image-corpus] vector results:", vecRows.length);
  }

  // Collect all candidate IDs
  const allIds = new Set<string>();
  for (const r of ftsRows) allIds.add(r.id);
  for (const r of vecRows) allIds.add(r.id);

  if (allIds.size === 0) return [];

  // Build rank maps (1-based ranks)
  const ftsRank = new Map<string, number>();
  ftsRows.forEach((r, i) => ftsRank.set(r.id, i + 1));

  const vecRank = new Map<string, number>();
  vecRows.forEach((r, i) => vecRank.set(r.id, i + 1));

  // Compute RRF score for each candidate
  const rrfScores = new Map<string, number>();
  for (const id of allIds) {
    let score = 0;
    const fr = ftsRank.get(id);
    if (fr !== undefined) score += 1 / (RRF_K + fr);
    const vr = vecRank.get(id);
    if (vr !== undefined) score += 1 / (RRF_K + vr);
    rrfScores.set(id, score);
  }

  // Fetch full entries for all candidates
  const ids = Array.from(allIds);
  const results: Array<ImageCorpusEntry & { score: number }> = [];
  
  for (const id of ids) {
    const entry = await getCorpusEntry(id);
    if (entry) {
      results.push({
        ...entry,
        score: rrfScores.get(id) ?? 0,
      });
    }
  }

  // Sort by RRF score descending
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/**
 * Compute novelty of an embedding against the entire corpus.
 * Returns 1.0 - maxSimilarity (higher = more novel).
 */
export async function computeNovelty(embedding: number[]): Promise<number> {
  const db = getDb();
  const total = (db.prepare("SELECT COUNT(*) as c FROM vec_corpus").get() as { c: number }).c;
  if (total === 0) return 1.0;

  const nearest = db.prepare(
    "SELECT distance FROM vec_corpus WHERE embedding MATCH ? ORDER BY distance LIMIT 1"
  ).get(new Float32Array(embedding)) as { distance: number } | undefined;

  if (!nearest) return 1.0;
  return nearest.distance; // cosine distance = 1 - similarity, which is our novelty
}

/**
 * Get entries by their IDs (batch fetch for cluster member lookups).
 */
export async function getCorpusEntriesByIds(ids: string[]): Promise<ImageCorpusEntry[]> {
  if (ids.length === 0) return [];
  const db = getDb();

  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT * FROM corpus_entries WHERE id IN (${placeholders})`
  ).all(...ids) as CorpusRow[];

  // Batch-load embeddings for these IDs
  const embMap = new Map<string, number[]>();
  try {
    const vecRows = db.prepare(
      `SELECT id, embedding FROM vec_corpus WHERE id IN (${placeholders})`
    ).all(...ids) as Array<{ id: string; embedding: Buffer }>;
    for (const vr of vecRows) {
      embMap.set(vr.id, Array.from(new Float32Array(vr.embedding.buffer, vr.embedding.byteOffset, vr.embedding.byteLength / 4)));
    }
  } catch {}

  return rows.map(r => rowToEntry(r, embMap.get(r.id)));
}

// ---------------------------------------------------------------------------
// Init on module load (creates DB if needed, runs migration)
// ---------------------------------------------------------------------------

try {
  getDb();
} catch (err) {
  console.error("[image-corpus] Failed to initialize database:", err);
}
