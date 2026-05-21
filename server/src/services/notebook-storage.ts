import { readFile, readdir, mkdir, rename, unlink, writeFile } from "fs/promises";
import { join } from "path";
import type { NotebookEntry, NotebookIndex, NotebookLink } from "../types.js";
import { APP_DATA_DIR } from "./paths.js";
import {
  createMemoryBlock,
  updateMemoryBlock,
  getMemoryBlock,
  deleteMemoryBlock,
  listMemoryBlocks,
  type MemoryBlock,
  type BlockAttachments,
} from "./memory-storage.js";
import { getDb } from "./memory-storage.js";

// --- Paths (kept for migration only; all active operations use SQLite) ---

const BASE_DIR = APP_DATA_DIR;
const NOTEBOOKS_DIR = join(BASE_DIR, "notebooks");
const USER_ENTRIES_DIR = join(NOTEBOOKS_DIR, "user", "entries");
const AGENT_ENTRIES_DIR = join(NOTEBOOKS_DIR, "agent", "entries");
const AGENT_BACKUP_DIR = join(AGENT_ENTRIES_DIR, ".backup");
const USER_BACKUP_DIR = join(USER_ENTRIES_DIR, ".backup");

// Synthetic chatId used by the synthesis follow-up tool loop. Also used by
// memory-tools.ts to route create_memory_block calls through the notebook
// naming convention so follow-up blocks get the same system-block exclusion
// as blocks created via createNotebookBlock.
export const NOTEBOOK_CYCLE_CHAT_ID = "synthesis-followup";

/** Generate a notebook-prefixed block ID matching createNotebookBlock's format. */
export function generateNotebookBlockId(type: 'synthesis' | 'notebook' = 'notebook', date?: string): string {
  const blockDate = (date || new Date().toISOString().split('T')[0]).replace(/-/g, "");
  const prefix = type === 'synthesis' ? 'blk-synth' : 'blk-notebook';
  return `${prefix}-${blockDate}-${crypto.randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// SQLite-backed user notebook entries
//
// User entries were originally stored as individual JSON files on disk. They
// have been migrated to a dedicated SQLite table (`user_notebook_entries`)
// with an FTS5 full-text index (`user_notebook_entries_fts`) for search.
// ---------------------------------------------------------------------------

/** Ensure the user_notebook_entries table, FTS5 index, and triggers exist.
 *  Idempotent — safe to call on every startup. */
function ensureUserEntryTables(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_notebook_entries (
      id TEXT PRIMARY KEY,
      createdAt TEXT NOT NULL,
      content TEXT NOT NULL,
      links TEXT,
      images TEXT
    );
  `);

  // FTS5 virtual table (content-sync'd with the main table)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS user_notebook_entries_fts
      USING fts5(id UNINDEXED, content, content='user_notebook_entries', content_rowid=rowid);
  `);

  // Triggers to keep FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS user_notebook_entries_ai AFTER INSERT ON user_notebook_entries BEGIN
      INSERT INTO user_notebook_entries_fts(rowid, id, content) VALUES (new.rowid, new.id, new.content);
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS user_notebook_entries_ad AFTER DELETE ON user_notebook_entries BEGIN
      INSERT INTO user_notebook_entries_fts(user_notebook_entries_fts, rowid, id, content) VALUES('delete', old.rowid, old.id, old.content);
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS user_notebook_entries_au AFTER UPDATE ON user_notebook_entries BEGIN
      INSERT INTO user_notebook_entries_fts(user_notebook_entries_fts, rowid, id, content) VALUES('delete', old.rowid, old.id, old.content);
      INSERT INTO user_notebook_entries_fts(rowid, id, content) VALUES (new.rowid, new.id, new.content);
    END;
  `);

  // One-time FTS rebuild for existing data (handles data inserted before triggers
  // were created, e.g. during migration)
  const ftsInit = db
    .prepare("SELECT value FROM metadata WHERE key = 'user_notebook_entries_fts_initialized'")
    .get() as { value: string } | undefined;
  if (!ftsInit) {
    db.exec(`INSERT INTO user_notebook_entries_fts(user_notebook_entries_fts) VALUES('rebuild')`);
    db.prepare(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('user_notebook_entries_fts_initialized', '1')"
    ).run();
    console.log("[notebook] Built FTS5 index for existing user notebook entries");
  }
}

// ---------------------------------------------------------------------------
// User notebook entries — SQLite-backed (formerly filesystem JSON)
// ---------------------------------------------------------------------------

function rowToUserEntry(row: any): NotebookEntry {
  let links: NotebookLink | undefined;
  if (row.links) {
    try { links = JSON.parse(row.links); } catch { links = undefined; }
  }
  let images: any[] | undefined;
  if (row.images) {
    try { images = JSON.parse(row.images); } catch { images = undefined; }
  }
  return {
    id: row.id,
    createdAt: row.createdAt,
    author: 'user',
    content: row.content,
    links,
    images,
  };
}

async function listUserNotebookEntries(): Promise<NotebookIndex> {
  ensureUserEntryTables();
  const db = getDb();
  const rows = db.prepare(
    "SELECT id, createdAt, content FROM user_notebook_entries ORDER BY createdAt DESC"
  ).all() as Array<{ id: string; createdAt: string; content: string }>;

  const entries = rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    author: 'user' as const,
    preview: r.content.slice(0, 300),
  }));

  const lastActivityDate = entries.length > 0 ? entries[0].createdAt : null;
  return { entries, lastActivityDate };
}

function getUserNotebookEntry(id: string): NotebookEntry | null {
  ensureUserEntryTables();
  const db = getDb();
  const row = db.prepare("SELECT * FROM user_notebook_entries WHERE id = ?").get(id) as any;
  if (!row) return null;
  return rowToUserEntry(row);
}

function createUserNotebookEntry(content: string): NotebookEntry {
  ensureUserEntryTables();
  const db = getDb();
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const entry: NotebookEntry = {
    id,
    createdAt,
    author: 'user',
    content,
  };
  db.prepare(
    "INSERT INTO user_notebook_entries (id, createdAt, content) VALUES (?, ?, ?)"
  ).run(id, createdAt, content);
  return entry;
}

function updateUserNotebookEntry(id: string, updates: Partial<NotebookEntry>): NotebookEntry | null {
  ensureUserEntryTables();
  const db = getDb();
  const existing = db.prepare("SELECT * FROM user_notebook_entries WHERE id = ?").get(id) as any;
  if (!existing) return null;

  const setClauses: string[] = [];
  const values: any[] = [];

  if (updates.content !== undefined) {
    setClauses.push("content = ?");
    values.push(updates.content);
  }
  if (updates.links !== undefined) {
    setClauses.push("links = ?");
    values.push(updates.links ? JSON.stringify(updates.links) : null);
  }
  if (updates.images !== undefined) {
    setClauses.push("images = ?");
    values.push(updates.images ? JSON.stringify(updates.images) : null);
  }

  if (setClauses.length === 0) return rowToUserEntry(existing);

  values.push(id);
  db.prepare(`UPDATE user_notebook_entries SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);

  const updated = db.prepare("SELECT * FROM user_notebook_entries WHERE id = ?").get(id) as any;
  return rowToUserEntry(updated);
}

function deleteUserNotebookEntry(id: string): boolean {
  ensureUserEntryTables();
  const db = getDb();
  const result = db.prepare("DELETE FROM user_notebook_entries WHERE id = ?").run(id);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Agent notebook entries — memory-block-backed (unchanged)
// ---------------------------------------------------------------------------

function blockToNotebookEntry(block: MemoryBlock): NotebookEntry {
  const att = block.attachments ?? {};
  const link = Array.isArray(att.links) && att.links.length > 0 ? (att.links[0] as NotebookLink) : undefined;
  return {
    id: block.id,
    createdAt: block.createdAt,
    author: 'agent',
    content: block.content,
    links: link,
    images: att.images as any,
    toolCalls: att.toolCalls as any,
    toolResults: att.toolResults as any,
    artifacts: att.artifacts as any,
    visuals: att.visuals as any,
  };
}

function notebookEntryAttachments(entry: Partial<NotebookEntry>): BlockAttachments | undefined {
  const att: BlockAttachments = {};
  let has = false;
  if (entry.images?.length) { att.images = entry.images as any; has = true; }
  if (entry.toolCalls?.length) { att.toolCalls = entry.toolCalls as any; has = true; }
  if (entry.toolResults?.length) { att.toolResults = entry.toolResults as any; has = true; }
  if (entry.artifacts?.length) { att.artifacts = entry.artifacts as any; has = true; }
  if (entry.visuals?.length) { att.visuals = entry.visuals as any; has = true; }
  if (entry.links) { att.links = [entry.links as any]; has = true; }
  return has ? att : undefined;
}

function listAgentNotebookEntries(): NotebookIndex {
  const blocks = listMemoryBlocks({ includeInternal: true }).filter(
    (b) => b.blockType === "notebook" || b.blockType === "synthesis"
  );
  const entries = blocks.map((b) => ({
    id: b.id,
    createdAt: b.createdAt,
    author: 'agent' as const,
    preview: b.description || b.content.slice(0, 300),
  }));
  return {
    entries,
    lastActivityDate: entries[0]?.createdAt ?? null,
  };
}

function getAgentNotebookEntry(id: string): NotebookEntry | null {
  const block = getMemoryBlock(id);
  if (!block) return null;
  if (block.blockType !== "notebook" && block.blockType !== "synthesis") return null;
  return blockToNotebookEntry(block);
}

function normalizeNotebookContent(content: string): string {
  return content.replace(/\r\n/g, "\n").trim();
}

export function findDuplicateAgentNotebookEntry(content: string, opts?: {
  type?: 'synthesis' | 'notebook';
  date?: string;
}): NotebookEntry | null {
  const type = opts?.type ?? 'notebook';
  const blockDate = (opts?.date || new Date().toISOString().split('T')[0]).replace(/-/g, "");
  const prefix = type === 'synthesis' ? 'blk-synth' : 'blk-notebook';
  const idPrefix = `${prefix}-${blockDate}-`;
  const normalized = normalizeNotebookContent(content);

  const duplicate = listMemoryBlocks({ includeInternal: true }).find(
    (b) =>
      b.blockType === type &&
      b.id.startsWith(idPrefix) &&
      normalizeNotebookContent(b.content) === normalized,
  );

  return duplicate ? blockToNotebookEntry(duplicate) : null;
}

function createAgentNotebookEntry(content: string, opts?: {
  type?: 'synthesis' | 'notebook';
  date?: string;
  attachments?: BlockAttachments;
}): NotebookEntry {
  const type = opts?.type ?? 'notebook';
  const existing = findDuplicateAgentNotebookEntry(content, { type, date: opts?.date });
  if (existing) return existing;

  const blockDate = opts?.date || new Date().toISOString().split('T')[0];
  const id = generateNotebookBlockId(type, blockDate);
  const description = extractBlockDescription(content);
  const prefix = type === 'synthesis' ? 'Synthesis' : 'Notebook';
  const now = new Date().toISOString();

  const block = createMemoryBlock({
    id,
    name: `${prefix} - ${blockDate}: ${description.slice(0, 50)}`,
    description,
    content,
    scope: 'global',
    projectId: '',
    createdAt: now,
    updatedAt: now,
    updatedBy: 'agent',
    blockType: type,
    attachments: opts?.attachments,
  });
  return blockToNotebookEntry(block);
}

function updateAgentNotebookEntry(id: string, updates: Partial<NotebookEntry>): NotebookEntry | null {
  const existing = getMemoryBlock(id);
  if (!existing) return null;
  if (existing.blockType !== "notebook" && existing.blockType !== "synthesis") return null;

  const mergedAtt: BlockAttachments = { ...(existing.attachments ?? {}) };
  const incoming = notebookEntryAttachments(updates);
  if (incoming) Object.assign(mergedAtt, incoming);
  const hasMergedAtt = Object.keys(mergedAtt).length > 0;

  const ok = updateMemoryBlock(id, {
    content: updates.content,
    attachments: hasMergedAtt ? mergedAtt : null,
  });
  if (!ok) return null;
  return getAgentNotebookEntry(id);
}

function deleteAgentNotebookEntry(id: string): boolean {
  const block = getMemoryBlock(id);
  if (!block) return false;
  if (block.blockType !== "notebook" && block.blockType !== "synthesis") return false;
  return deleteMemoryBlock(id);
}

// ---------------------------------------------------------------------------
// Full-text search
// ---------------------------------------------------------------------------

export interface NotebookSearchResult {
  id: string;
  author: 'user' | 'agent';
  createdAt: string;
  preview: string;
  excerpt: string;
  rank: number;
}

/**
 * Search notebook entries by full-text query.
 * Searches both user entries (user_notebook_entries_fts) and agent entries
 * (memory_blocks_fts filtered by blockType). Returns ranked results with
 * excerpts.
 */
export function searchNotebookEntries(
  query: string,
  opts: { author?: 'user' | 'agent'; limit?: number } = {}
): NotebookSearchResult[] {
  ensureUserEntryTables();
  const db = getDb();
  const limit = opts.limit ?? 20;
  const trimmed = query.trim();
  if (!trimmed) return [];

  // Tokenize into FTS5-safe terms
  const terms = trimmed
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  const ftsQuery = terms.join(" OR ");
  const phraseQuery = `"${trimmed.replace(/"/g, '""')}"`;

  const results: NotebookSearchResult[] = [];

  // --- Search user entries ---
  if (!opts.author || opts.author === 'user') {
    try {
      // Try phrase match first
      let rows = db.prepare(`
        SELECT e.id, e.createdAt, e.content, f.rank
        FROM user_notebook_entries_fts f
        JOIN user_notebook_entries e ON e.rowid = f.rowid
        WHERE f.user_notebook_entries_fts MATCH ?
        ORDER BY f.rank
        LIMIT ?
      `).all(phraseQuery, limit) as any[];

      // Fall back to OR terms if phrase match yields nothing
      if (rows.length === 0) {
        rows = db.prepare(`
          SELECT e.id, e.createdAt, e.content, f.rank
          FROM user_notebook_entries_fts f
          JOIN user_notebook_entries e ON e.rowid = f.rowid
          WHERE f.user_notebook_entries_fts MATCH ?
          ORDER BY f.rank
          LIMIT ?
        `).all(ftsQuery, limit) as any[];
      }

      for (const row of rows) {
        results.push({
          id: row.id,
          author: 'user',
          createdAt: row.createdAt,
          preview: row.content.slice(0, 300),
          excerpt: extractSearchExcerpt(row.content, trimmed, 200),
          rank: row.rank,
        });
      }
    } catch {
      // FTS5 may throw on malformed query; fall through gracefully
    }
  }

  // --- Search agent entries ---
  if (!opts.author || opts.author === 'agent') {
    try {
      // Try phrase match first
      let rows = db.prepare(`
        SELECT mb.id, mb.createdAt, mb.content, mb.blockType, f.rank
        FROM memory_blocks_fts f
        JOIN memory_blocks mb ON mb.rowid = f.rowid
        WHERE f.memory_blocks_fts MATCH ?
          AND mb.blockType IN ('notebook', 'synthesis')
          AND mb.supersededBy IS NULL
        ORDER BY f.rank
        LIMIT ?
      `).all(phraseQuery, limit) as any[];

      if (rows.length === 0) {
        rows = db.prepare(`
          SELECT mb.id, mb.createdAt, mb.content, mb.blockType, f.rank
          FROM memory_blocks_fts f
          JOIN memory_blocks mb ON mb.rowid = f.rowid
          WHERE f.memory_blocks_fts MATCH ?
            AND mb.blockType IN ('notebook', 'synthesis')
            AND mb.supersededBy IS NULL
          ORDER BY f.rank
          LIMIT ?
        `).all(ftsQuery, limit) as any[];
      }

      for (const row of rows) {
        results.push({
          id: row.id,
          author: 'agent',
          createdAt: row.createdAt,
          preview: (row.content || '').slice(0, 300),
          excerpt: extractSearchExcerpt(row.content || '', trimmed, 200),
          rank: row.rank,
        });
      }
    } catch {
      // FTS5 may throw on malformed query; fall through gracefully
    }
  }

  // Sort by rank (lower BM25 rank = better match) and dedupe
  results.sort((a, b) => a.rank - b.rank);
  const seen = new Set<string>();
  return results.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  }).slice(0, limit);
}

/** Extract a text excerpt around the first occurrence of any query term. */
function extractSearchExcerpt(text: string, query: string, radius = 200): string {
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

// ---------------------------------------------------------------------------
// Public API — dispatches by author. User = SQLite, agent = memory blocks.
// ---------------------------------------------------------------------------

export async function listNotebookEntries(author: 'user' | 'agent'): Promise<NotebookIndex> {
  if (author === 'user') {
    return await listUserNotebookEntries();
  }
  return listAgentNotebookEntries();
}

export async function getNotebookEntry(author: 'user' | 'agent', id: string): Promise<NotebookEntry | null> {
  if (author === 'user') return getUserNotebookEntry(id);
  return getAgentNotebookEntry(id);
}

export async function createNotebookEntry(
  author: 'user' | 'agent',
  content: string,
  opts?: { type?: 'synthesis' | 'notebook'; date?: string; attachments?: BlockAttachments },
): Promise<NotebookEntry> {
  if (author === 'user') return createUserNotebookEntry(content);
  return createAgentNotebookEntry(content, opts);
}

export async function updateNotebookEntry(
  author: 'user' | 'agent',
  id: string,
  updates: Partial<NotebookEntry>
): Promise<NotebookEntry | null> {
  if (author === 'user') return updateUserNotebookEntry(id, updates);
  return updateAgentNotebookEntry(id, updates);
}

export async function deleteNotebookEntry(author: 'user' | 'agent', id: string): Promise<boolean> {
  if (author === 'user') return deleteUserNotebookEntry(id);
  return deleteAgentNotebookEntry(id);
}

export async function hasUserActivityToday(): Promise<boolean> {
  const index = await listUserNotebookEntries();
  if (!index.lastActivityDate) return false;
  const today = new Date().toDateString();
  const lastActivity = new Date(index.lastActivityDate).toDateString();
  return today === lastActivity;
}

export async function getUserEntriesToday(): Promise<NotebookEntry[]> {
  const db = getDb();
  ensureUserEntryTables();
  const today = new Date().toISOString().split('T')[0];
  const rows = db.prepare(
    "SELECT * FROM user_notebook_entries WHERE date(createdAt) = date(?) ORDER BY createdAt DESC"
  ).all(today) as any[];
  return rows.map(rowToUserEntry);
}

/**
 * Extract a brief description from notebook content for use as a memory block description.
 * Strips leading markdown headers and takes the first ~150 characters.
 */
export function extractBlockDescription(content: string): string {
  const stripped = content.replace(/^#+\s+.*\n?/, '').trim();
  const excerpt = stripped.slice(0, 150).replace(/\n+/g, ' ').trim();
  return excerpt.length < stripped.length ? excerpt + '...' : excerpt;
}

/**
 * Create a memory block from notebook content for searchability.
 * Retained for backward compatibility with callers that want a block-only
 * write (no NotebookEntry return value). Prefer createNotebookEntry('agent',
 * ...) for new callers — it writes the same block and gives you the entry
 * shape back.
 */
export function createNotebookBlock(
  content: string,
  type: 'synthesis' | 'notebook',
  date?: string
): string {
  const entry = createAgentNotebookEntry(content, { type, date });
  return entry.id;
}

// ---------------------------------------------------------------------------
// Migration: move existing filesystem user notebook JSON entries into SQLite.
// Idempotent — runs at startup, no-ops if there's nothing in the filesystem.
// Migrated JSON files go to a .backup/ subfolder.
// ---------------------------------------------------------------------------

export async function migrateUserNotebookToDb(): Promise<{
  migrated: number;
  skipped: number;
  failed: number;
}> {
  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  // Check if the old filesystem directory exists
  try {
    await mkdir(USER_ENTRIES_DIR, { recursive: true });
  } catch {
    return { migrated, skipped, failed };
  }

  let files: string[];
  try {
    files = await readdir(USER_ENTRIES_DIR);
  } catch {
    return { migrated, skipped, failed };
  }

  const entryFiles = files.filter((f) => f.endsWith(".json") && f !== "index.json");
  if (entryFiles.length === 0) {
    return { migrated, skipped, failed };
  }

  ensureUserEntryTables();
  const db = getDb();

  await mkdir(USER_BACKUP_DIR, { recursive: true });

  for (const filename of entryFiles) {
    const entryId = filename.slice(0, -5); // strip .json
    try {
      // Skip if already migrated
      const existing = db.prepare("SELECT id FROM user_notebook_entries WHERE id = ?").get(entryId);
      if (existing) {
        await rename(join(USER_ENTRIES_DIR, filename), join(USER_BACKUP_DIR, filename));
        skipped++;
        continue;
      }

      const raw = await readFile(join(USER_ENTRIES_DIR, filename), "utf-8");
      const entry = JSON.parse(raw) as NotebookEntry;

      if (!entry?.content) {
        await rename(join(USER_ENTRIES_DIR, filename), join(USER_BACKUP_DIR, filename));
        failed++;
        continue;
      }

      db.prepare(
        "INSERT INTO user_notebook_entries (id, createdAt, content, links, images) VALUES (?, ?, ?, ?, ?)"
      ).run(
        entry.id,
        entry.createdAt,
        entry.content,
        entry.links ? JSON.stringify(entry.links) : null,
        entry.images ? JSON.stringify(entry.images) : null,
      );

      await rename(join(USER_ENTRIES_DIR, filename), join(USER_BACKUP_DIR, filename));
      migrated++;
    } catch (e: any) {
      console.error(`[notebook] User entry migration failed for ${filename}:`, e?.message || e);
      failed++;
    }
  }

  // Move the old index.json aside — it's stale now
  try {
    await rename(join(USER_ENTRIES_DIR, "index.json"), join(USER_BACKUP_DIR, "index.json"));
  } catch {
    // index didn't exist or already moved; not a problem
  }

  if (migrated > 0 || failed > 0) {
    console.log(
      `[notebook] User notebook migration complete: ${migrated} migrated, ${skipped} already migrated, ${failed} failed. ` +
      `Originals preserved in ${USER_BACKUP_DIR}`,
    );
  }

  return { migrated, skipped, failed };
}

// ---------------------------------------------------------------------------
// Migration: move existing filesystem agent notebook JSON entries into
// memory_blocks.  (Unchanged from before.)
// ---------------------------------------------------------------------------

export async function migrateAgentNotebookToBlocks(): Promise<{
  migrated: number;
  skipped: number;
  failed: number;
}> {
  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  try {
    await mkdir(AGENT_ENTRIES_DIR, { recursive: true });
  } catch {
    return { migrated, skipped, failed };
  }

  let files: string[];
  try {
    files = await readdir(AGENT_ENTRIES_DIR);
  } catch {
    return { migrated, skipped, failed };
  }

  const entryFiles = files.filter((f) => f.endsWith(".json") && f !== "index.json");
  if (entryFiles.length === 0) {
    return { migrated, skipped, failed };
  }

  await mkdir(AGENT_BACKUP_DIR, { recursive: true });

  for (const filename of entryFiles) {
    const entryId = filename.slice(0, -5);
    try {
      const raw = await readFile(join(AGENT_ENTRIES_DIR, filename), "utf-8");
      const entry = JSON.parse(raw) as NotebookEntry;

      if (!entry?.content) {
        await rename(join(AGENT_ENTRIES_DIR, filename), join(AGENT_BACKUP_DIR, filename));
        failed++;
        continue;
      }

      const blockId = `blk-notebook-migrated-${entryId}`;
      const existing = getMemoryBlock(blockId);
      if (existing) {
        await rename(join(AGENT_ENTRIES_DIR, filename), join(AGENT_BACKUP_DIR, filename));
        skipped++;
        continue;
      }

      const looksLikeSynthesis = /^#+\s*(daily\s+)?synthesis\b/i.test(entry.content);
      const blockType = looksLikeSynthesis ? 'synthesis' : 'notebook';

      const description = extractBlockDescription(entry.content);
      const prefix = blockType === 'synthesis' ? 'Synthesis' : 'Notebook';
      const blockDate = entry.createdAt.split("T")[0];

      const attachments = notebookEntryAttachments(entry);

      createMemoryBlock({
        id: blockId,
        name: `${prefix} - ${blockDate}: ${description.slice(0, 50)}`,
        description,
        content: entry.content,
        scope: "global",
        projectId: "",
        createdAt: entry.createdAt,
        updatedAt: entry.createdAt,
        updatedBy: "agent",
        blockType,
        attachments,
      });

      await rename(join(AGENT_ENTRIES_DIR, filename), join(AGENT_BACKUP_DIR, filename));
      migrated++;
    } catch (e: any) {
      console.error(`[notebook] Agent entry migration failed for ${filename}:`, e?.message || e);
      failed++;
    }
  }

  try {
    await rename(join(AGENT_ENTRIES_DIR, "index.json"), join(AGENT_BACKUP_DIR, "index.json"));
  } catch {
    // index didn't exist or already moved; not a problem
  }

  if (migrated > 0 || failed > 0) {
    console.log(
      `[notebook] Agent notebook migration complete: ${migrated} migrated, ${skipped} already migrated, ${failed} failed. ` +
      `Originals preserved in ${AGENT_BACKUP_DIR}`,
    );
  }

  return { migrated, skipped, failed };
}

// ---------------------------------------------------------------------------
// Legacy filesystem functions — retained only for the migration read path
// above. All active operations now go through SQLite.
// ---------------------------------------------------------------------------

// The following functions have been removed in favor of their SQLite
// counterparts above. If any external import still references them, it will
// need to be updated to use the sync function signatures.
