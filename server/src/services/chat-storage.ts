import Database from "better-sqlite3";
import { readdirSync, readFileSync, existsSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Chat, ChatListItem, ChatMessage, ChatMessageWindow, Project, Settings, SshConnection } from "../types.js";

const PROJECT_COLORS = ["emerald", "purple", "blue", "amber", "rose", "cyan", "violet", "orange", "pink", "teal"];

const BASE_DIR = join(homedir(), ".quje-agent");
const CHATS_DIR = join(BASE_DIR, "chats");
const PROJECTS_DIR = join(BASE_DIR, "projects");
const SETTINGS_PATH = join(BASE_DIR, "settings.json");

const DB_PATH = join(BASE_DIR, "app.db");
const MESSAGE_ROWS_MIGRATION = "chat_message_rows_v1";

// ---------------------------------------------------------------------------
// Per-chat write lock — serializes concurrent saveChat / enrichArchive calls
// so a read-modify-write cycle can't be interleaved by a background task.
// Re-entrant: a call to saveChat from inside an existing withChatWriteLock
// will not deadlock (depth counter tracks nested acquisitions).
// ---------------------------------------------------------------------------

interface ChatLockEntry {
  promise: Promise<void>;
  depth: number;
}

const chatWriteLocks = new Map<string, ChatLockEntry>();

/**
 * Acquire an exclusive write lock for a given chat, execute fn, and release.
 * Calls for the same chatId are serialized; calls for different chatIds run
 * concurrently. Re-entrant: if fn itself acquires the same lock (e.g. saveChat
 * called from inside enrichArchiveDescriptions), it executes immediately
 * without deadlocking.
 *
 * Entries are never deleted from the map — they persist with depth=0 between
 * uses. This avoids a race where a new caller slips in between depth-- and
 * map.delete(), creating a fresh entry and running concurrently. One entry
 * per chat is negligible memory.
 */
export async function withChatWriteLock<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
  let entry = chatWriteLocks.get(chatId);
  if (!entry) {
    entry = { promise: Promise.resolve(), depth: 0 };
    chatWriteLocks.set(chatId, entry);
  }

  if (entry.depth > 0) {
    // Re-entrant acquisition — we're already inside a lock for this chat.
    // Just bump depth so the outer release doesn't pop the lock prematurely.
    // Don't touch entry.promise — only the first acquirer manages the chain.
    entry.depth++;
    try {
      return await fn();
    } finally {
      entry.depth--;
    }
  }

  // First acquisition — wait for all previous writes to complete.
  const prev = entry.promise;
  let release: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  entry.promise = prev.then(() => next);
  entry.depth = 1;

  await prev;

  try {
    return await fn();
  } finally {
    entry.depth = 0;
    release!();
    // Don't delete the entry — see function comment.
  }
}
const CHAT_SEARCH_REBUILD_MIGRATION = "chat_messages_search_from_rows_v1";
const CHAT_SEARCH_TOOLLOOP_MERGE_MIGRATION = "chat_messages_search_toolloop_merge_v1";

// ---------------------------------------------------------------------------
// Lazy singleton database
// ---------------------------------------------------------------------------

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const needsChatMigration = existsSync(CHATS_DIR) && !existsSync(DB_PATH);
  const needsProjectMigration = existsSync(PROJECTS_DIR) && !existsSync(DB_PATH);
  const needsSettingsMigration = existsSync(SETTINGS_PATH);

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  // Create tables idempotently
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      modelId TEXT NOT NULL,
      systemPrompt TEXT,
      contextWindow INTEGER,
      projectId TEXT,
      activeSkills TEXT,
      messages JSON NOT NULL,
      createdAt TEXT NOT NULL,
      lastModified TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      locationType TEXT NOT NULL DEFAULT 'local',
      sshConnectionId TEXT,
      color TEXT NOT NULL DEFAULT 'emerald',
      pinned INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      lastModified TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ssh_connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 22,
      username TEXT,
      identityFile TEXT,
      knownHostsMode TEXT NOT NULL DEFAULT 'accept-new',
      enabled INTEGER NOT NULL DEFAULT 1,
      allowBash INTEGER NOT NULL DEFAULT 1,
      allowFileWrite INTEGER NOT NULL DEFAULT 1,
      allowAbsolutePaths INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      lastModified TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSON NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS storage_migrations (
      name TEXT PRIMARY KEY,
      appliedAt TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_states (
      chatId TEXT PRIMARY KEY,
      agentMessages JSON NOT NULL,
      systemPrompt TEXT NOT NULL,
      askToolCallId TEXT NOT NULL,
      fullText TEXT,
      thinkingText TEXT,
      toolCalls JSON,
      toolResults JSON,
      iterations INTEGER,
      lastUserMessage TEXT
    );
  `);



  // User UI state persistence (sidebar state, notebook last-seen, etc.)
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_ui_state (
      key TEXT PRIMARY KEY,
      value JSON NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `);

  // Migration: add mid-turn recovery columns if upgrading from earlier schema
  const pendingCols = db.prepare("PRAGMA table_info(pending_states)").all() as Array<{ name: string }>;
  if (!pendingCols.some((c) => c.name === "fullText")) {
    db.exec("ALTER TABLE pending_states ADD COLUMN fullText TEXT");
    console.log("[chat-storage] Added fullText column to pending_states");
  }
  if (!pendingCols.some((c) => c.name === "thinkingText")) {
    db.exec("ALTER TABLE pending_states ADD COLUMN thinkingText TEXT");
    console.log("[chat-storage] Added thinkingText column to pending_states");
  }
  if (!pendingCols.some((c) => c.name === "toolCalls")) {
    db.exec("ALTER TABLE pending_states ADD COLUMN toolCalls JSON");
    console.log("[chat-storage] Added toolCalls column to pending_states");
  }
  if (!pendingCols.some((c) => c.name === "toolResults")) {
    db.exec("ALTER TABLE pending_states ADD COLUMN toolResults JSON");
    console.log("[chat-storage] Added toolResults column to pending_states");
  }
  if (!pendingCols.some((c) => c.name === "iterations")) {
    db.exec("ALTER TABLE pending_states ADD COLUMN iterations INTEGER");
    console.log("[chat-storage] Added iterations column to pending_states");
  }
  if (!pendingCols.some((c) => c.name === "lastUserMessage")) {
    db.exec("ALTER TABLE pending_states ADD COLUMN lastUserMessage TEXT");
    console.log("[chat-storage] Added lastUserMessage column to pending_states");
  }

  // Indexes for common queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chats_lastModified ON chats(lastModified DESC);
    CREATE INDEX IF NOT EXISTS idx_chats_projectId ON chats(projectId) WHERE projectId IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_chats_type ON chats(type);
    CREATE INDEX IF NOT EXISTS idx_projects_lastModified ON projects(lastModified DESC);
  `);

  // ---------------------------------------------------------------------------
  // Full-fidelity chat messages (compatibility source for Chat.messages)
  // ---------------------------------------------------------------------------

  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_message_rows (
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
    CREATE INDEX IF NOT EXISTS idx_chat_message_rows_chat_sequence
      ON chat_message_rows(chat_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_chat_message_rows_chat_role
      ON chat_message_rows(chat_id, role);
  `);

  // ---------------------------------------------------------------------------
  // Chat messages FTS5 (denormalized for full-text search over conversations)
  // ---------------------------------------------------------------------------

  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      chat_id TEXT NOT NULL,
      message_index INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER,
      PRIMARY KEY (chat_id, message_index)
    );
  `);

  // FTS5 with chat_id as UNINDEXED column — allows filtering by chat during MATCH phase
  // Migration: if old FTS table exists without chat_id column, drop and recreate
  const ftsInfo = db.prepare("PRAGMA table_info(chat_messages_fts)").all() as Array<{ name: string }>;
  if (ftsInfo.length > 0 && !ftsInfo.some((c) => c.name === "chat_id")) {
    db.exec("DROP TABLE IF EXISTS chat_messages_fts");
    db.exec("DROP TRIGGER IF EXISTS chat_messages_ai");
    db.exec("DROP TRIGGER IF EXISTS chat_messages_ad");
    db.exec("DROP TRIGGER IF EXISTS chat_messages_au");
    // Also clear chat_messages so backfill rebuilds everything
    db.exec("DELETE FROM chat_messages");
    console.log("[chat-storage] Rebuilt chat_messages_fts with chat_id UNINDEXED column");
  }

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
      content,
      chat_id UNINDEXED,
      content='chat_messages',
      content_rowid='rowid'
    );
  `);

  // Triggers to keep chat_messages_fts in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chat_messages_ai AFTER INSERT ON chat_messages BEGIN
      INSERT INTO chat_messages_fts(rowid, content, chat_id) VALUES (new.rowid, new.content, new.chat_id);
    END;
    CREATE TRIGGER IF NOT EXISTS chat_messages_ad AFTER DELETE ON chat_messages BEGIN
      INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content, chat_id) VALUES('delete', old.rowid, old.content, old.chat_id);
    END;
    CREATE TRIGGER IF NOT EXISTS chat_messages_au AFTER UPDATE ON chat_messages BEGIN
      INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content, chat_id) VALUES('delete', old.rowid, old.content, old.chat_id);
      INSERT INTO chat_messages_fts(rowid, content, chat_id) VALUES (new.rowid, new.content, new.chat_id);
    END;
  `);

  // Index for scoped searches within a single chat
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_id ON chat_messages(chat_id);
  `);

  // ---------------------------------------------------------------------------
  // Context archives (indexed compaction — preserves full-fidelity messages)
  // ---------------------------------------------------------------------------

  db.exec(`
    CREATE TABLE IF NOT EXISTS context_archives (
      id TEXT PRIMARY KEY,
      chatId TEXT NOT NULL,
      sequenceNum INTEGER NOT NULL,
      messages JSON NOT NULL,
      indexEntry TEXT NOT NULL,
      messageCount INTEGER NOT NULL,
      estimatedTokens INTEGER,
      createdAt TEXT NOT NULL,
      UNIQUE(chatId, sequenceNum)
    );
    CREATE INDEX IF NOT EXISTS idx_archives_chat ON context_archives(chatId);
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS context_archives_fts USING fts5(
      content,
      indexEntry,
      chatId UNINDEXED,
      content='context_archives',
      content_rowid='rowid'
    );
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS context_archives_ai AFTER INSERT ON context_archives BEGIN
      INSERT INTO context_archives_fts(rowid, content, indexEntry, chatId) VALUES (new.rowid, new.messages, new.indexEntry, new.chatId);
    END;
    CREATE TRIGGER IF NOT EXISTS context_archives_ad AFTER DELETE ON context_archives BEGIN
      INSERT INTO context_archives_fts(context_archives_fts, rowid, content, indexEntry, chatId) VALUES('delete', old.rowid, old.messages, old.indexEntry, old.chatId);
    END;
  `);

  // Auto-add activeSkills column if upgrading from earlier schema
  const cols = db.prepare("PRAGMA table_info(chats)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "activeSkills")) {
    db.exec("ALTER TABLE chats ADD COLUMN activeSkills TEXT");
  }

  // Auto-add color column to projects if upgrading from earlier schema
  const projectCols = db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
  if (!projectCols.some((c) => c.name === "color")) {
    db.exec("ALTER TABLE projects ADD COLUMN color TEXT NOT NULL DEFAULT 'emerald'");
    // Assign colors to existing projects
    const existing = db.prepare("SELECT id FROM projects ORDER BY lastModified DESC").all() as { id: string }[];
    const update = db.prepare("UPDATE projects SET color = ? WHERE id = ?");
    existing.forEach((p, i) => {
      update.run(PROJECT_COLORS[i % PROJECT_COLORS.length], p.id);
    });
    console.log(`[chat-storage] Added color column to projects, assigned ${existing.length} projects`);
  }

  // Auto-add pinned column to projects if upgrading from earlier schema
  if (!projectCols.some((c) => c.name === "pinned")) {
    db.exec("ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
    console.log("[chat-storage] Added pinned column to projects");
  }

  if (!projectCols.some((c) => c.name === "locationType")) {
    db.exec("ALTER TABLE projects ADD COLUMN locationType TEXT NOT NULL DEFAULT 'local'");
    console.log("[chat-storage] Added locationType column to projects");
  }

  if (!projectCols.some((c) => c.name === "sshConnectionId")) {
    db.exec("ALTER TABLE projects ADD COLUMN sshConnectionId TEXT");
    console.log("[chat-storage] Added sshConnectionId column to projects");
  }

  // Auto-add delayed extraction tracking columns
  if (!cols.some((c) => c.name === "lastDelayedExtractionAt")) {
    db.exec("ALTER TABLE chats ADD COLUMN lastDelayedExtractionAt TEXT");
  }
  if (!cols.some((c) => c.name === "lastDelayedExtractionMessageIndex")) {
    db.exec("ALTER TABLE chats ADD COLUMN lastDelayedExtractionMessageIndex INTEGER");
  }

  // Auto-add zeitgeist synthesis tracking column
  if (!cols.some((c) => c.name === "lastZeitgeistSynthesisAt")) {
    db.exec("ALTER TABLE chats ADD COLUMN lastZeitgeistSynthesisAt TEXT");
  }

  // Auto-add preview column to avoid json_extract on messages in list queries
  if (!cols.some((c) => c.name === "preview")) {
    db.exec("ALTER TABLE chats ADD COLUMN preview TEXT DEFAULT ''");
    // Backfill preview from existing messages (will be recomputed below to skip compaction summaries)
    db.exec(`
      UPDATE chats SET preview = COALESCE(
        SUBSTR(json_extract(messages, '$[#-1].content'), 1, 100),
        ''
      )
    `);
  }

  // Migration: recompute previews to skip compaction summaries
  // Compaction summaries start with "The user..." and aren't useful for sidebar previews
  const previewNeedsRecompute = !cols.some((c) => c.name === "_previewRecomputed");
  if (previewNeedsRecompute) {
    db.exec("ALTER TABLE chats ADD COLUMN _previewRecomputed INTEGER DEFAULT 0");
    // Recompute in TypeScript to properly skip compaction summaries
    recomputePreviewsSkippingCompaction(db);
  }

  // Migration: recompute previews to also skip promoted-thinking messages
  const previewNeedsThinkingRecompute = !cols.some((c) => c.name === "_previewRecomputedV2");
  if (previewNeedsThinkingRecompute) {
    db.exec("ALTER TABLE chats ADD COLUMN _previewRecomputedV2 INTEGER DEFAULT 0");
    recomputePreviewsSkippingCompaction(db);
  }

  // Migration: recompute previews using segment-based text (matches UI display)
  const previewNeedsSegmentRecompute = !cols.some((c) => c.name === "_previewRecomputedV3");
  if (previewNeedsSegmentRecompute) {
    db.exec("ALTER TABLE chats ADD COLUMN _previewRecomputedV3 INTEGER DEFAULT 0");
    recomputePreviewsSkippingCompaction(db);
  }

  // Auto-migrate from JSON files if needed
  if (needsChatMigration) {
    migrateChatsFromJson(db);
  }
  if (needsProjectMigration) {
    migrateProjectsFromJson(db);
  }
  if (needsSettingsMigration) {
    migrateSettingsFromJson(db);
  }

  backfillChatMessageRows(db);
  rebuildChatSearchFromRowsOnce(db);
  remergeChatSearchToolLoopRowsOnce(db);

  _db = db;

  // Backfill chat_messages FTS index for existing chats (one-time on first upgrade)
  backfillChatMessages();

  return db;
}

// ---------------------------------------------------------------------------
// Chat CRUD
// ---------------------------------------------------------------------------

export async function listChats(): Promise<ChatListItem[]> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, title, type, lastModified, projectId, preview
    FROM chats
    ORDER BY lastModified DESC
  `).all() as Array<{
    id: string;
    title: string;
    type: string;
    lastModified: string;
    projectId: string | null;
    preview: string | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    type: r.type as "agent" | "quick" | "system",
    lastModified: r.lastModified,
    preview: r.preview || "",
    ...(r.projectId ? { projectId: r.projectId } : {}),
  }));
}

export async function backupChatDb(destinationPath: string): Promise<void> {
  await getDb().backup(destinationPath);
}

export function closeChatDb(): void {
  if (_db) {
    try {
      _db.close();
    } catch (e) {
      console.warn("[chat-storage] close failed:", e);
    }
    _db = null;
  }
}

export function getChatDbPath(): string {
  return DB_PATH;
}

export async function getChat(id: string): Promise<Chat | null> {
  const db = getDb();
  const row = db.prepare("SELECT * FROM chats WHERE id = ?").get(id) as
    | {
        id: string;
        title: string;
        type: string;
        modelId: string;
        systemPrompt: string | null;
        contextWindow: number | null;
        projectId: string | null;
        activeSkills: string | null;
        messages: string;
        createdAt: string;
        lastModified: string;
        lastDelayedExtractionAt: string | null;
        lastDelayedExtractionMessageIndex: number | null;
        lastZeitgeistSynthesisAt: string | null;
      }
    | undefined;

  if (!row) return null;

  const legacyMessages = parseMessagesJson(row.messages, row.id);
  let rowMessages = loadChatMessageRows(db, row.id);

  // Consistency check: detect divergence between row table and JSON column.
  // When they disagree on message count, the source with more messages is
  // authoritative — it preserves data that the other may have lost due to a
  // partial write or a sync guard rejection. Log the discrepancy and
  // reconcile on the spot so subsequent saves don't magnify the divergence.
  //
  // Previously, the row table was preferred unconditionally. But if the
  // safety guard in syncChatMessageRows blocked a sync (the old v1 guard
  // returned null, skipping both row and FTS updates), the JSON column could
  // be newer than the rows. In that case, preferring the stale rows would
  // silently drop messages that survived in the JSON column.
  if (rowMessages && legacyMessages.length > 0 && rowMessages.length !== legacyMessages.length) {
    const diff = Math.abs(rowMessages.length - legacyMessages.length);
    if (rowMessages.length > legacyMessages.length) {
      console.warn(
        `[chat-storage] getChat inconsistency for ${row.id}: row table has ${rowMessages.length} messages, ` +
        `JSON column has ${legacyMessages.length}. Using rows (larger source). ` +
        `Difference: ${diff} messages.`
      );
    } else {
      console.warn(
        `[chat-storage] getChat inconsistency for ${row.id}: JSON column has ${legacyMessages.length} messages, ` +
        `row table has ${rowMessages.length}. Using JSON (larger source) — ` +
        `rows may be stale from a prior sync guard rejection. Difference: ${diff} messages.`
      );
      // JSON column has more messages — likely the rows fell behind after a
      // sync guard rejection. Override rowMessages so the caller gets the
      // complete data, then immediately re-sync the row table to match.
      rowMessages = legacyMessages;
      try {
        const firstChanged = syncChatMessageRows(db, row.id, legacyMessages, true);
        if (firstChanged !== null) {
          syncChatMessages(db, row.id, legacyMessages, firstChanged);
          console.log(
            `[chat-storage] Reconciled ${row.id}: re-synced ${legacyMessages.length} rows from JSON column (firstChanged=${firstChanged})`
          );
        }
      } catch (err) {
        console.error(`[chat-storage] Failed to reconcile ${row.id} from JSON column:`, err);
      }
    }
  }

  const rawMessages = rowMessages && (rowMessages.length > 0 || legacyMessages.length === 0)
    ? rowMessages
    : legacyMessages;
  const messages = rawMessages.map((message, index) =>
    message._rowSequence === undefined ? withRowSequence(message, index) : message
  );

  const chat: Chat = {
    id: row.id,
    title: row.title,
    type: (row.type as "agent" | "quick" | "system") || "quick",
    modelId: row.modelId,
    systemPrompt: row.systemPrompt || "You are a helpful assistant.",
    ...(row.contextWindow ? { contextWindow: row.contextWindow } : {}),
    messages,
    createdAt: row.createdAt,
    lastModified: row.lastModified,
    ...(row.projectId ? { projectId: row.projectId } : {}),
    ...(row.activeSkills ? { activeSkills: JSON.parse(row.activeSkills) } : {}),
    ...(row.lastDelayedExtractionAt ? { lastDelayedExtractionAt: row.lastDelayedExtractionAt } : {}),
    ...(row.lastDelayedExtractionMessageIndex !== null && row.lastDelayedExtractionMessageIndex !== undefined ? { lastDelayedExtractionMessageIndex: row.lastDelayedExtractionMessageIndex } : {}),
    ...(row.lastZeitgeistSynthesisAt ? { lastZeitgeistSynthesisAt: row.lastZeitgeistSynthesisAt } : {}),
  };

  return chat;
}

export function getChatMessageWindow(
  chatId: string,
  opts: { before?: number; limit?: number } = {}
): ChatMessageWindow {
  const db = getDb();
  const totalRow = db.prepare(`
    SELECT COUNT(*) as total
    FROM chat_message_rows
    WHERE chat_id = ?
  `).get(chatId) as { total: number };

  const total = totalRow.total;
  if (total === 0) {
    return { messages: [], offset: 0, total: 0, hasMoreBefore: false };
  }

  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 200), 1), 1000);
  const rawBefore = opts.before == null ? total : Math.floor(opts.before);
  const endExclusive = Math.max(0, Math.min(rawBefore, total));
  const offset = Math.max(0, endExclusive - limit);

  const rows = db.prepare(`
    SELECT sequence, payload_json
    FROM chat_message_rows
    WHERE chat_id = ? AND sequence >= ? AND sequence < ?
    ORDER BY sequence ASC
  `).all(chatId, offset, endExclusive) as Array<{ sequence: number; payload_json: string }>;

  const messages: ChatMessage[] = [];
  for (const row of rows) {
    try {
      messages.push(withRowSequence(JSON.parse(row.payload_json) as ChatMessage, row.sequence));
    } catch (e) {
      console.warn(
        `[chat-storage] Skipping corrupt message row ${chatId}:${row.sequence} in window: ${(e as Error).message}`
      );
    }
  }

  return {
    messages,
    offset,
    total,
    hasMoreBefore: offset > 0,
  };
}

/**
 * Optimized chat fetch: loads metadata + windowed messages directly from the
 * message row table without parsing the full JSON column. Saves significant
 * time for large chats (thousands of messages) since getChat() would otherwise
 * parse ALL messages from both storage formats before discarding most of them.
 */
export async function getChatWithWindow(
  id: string,
  opts: { before?: number; limit?: number } = {}
): Promise<Chat | null> {
  const db = getDb();
  const row = db.prepare(
    `SELECT id, title, type, modelId, systemPrompt, contextWindow, projectId,
            activeSkills, createdAt, lastModified,
            lastDelayedExtractionAt, lastDelayedExtractionMessageIndex, lastZeitgeistSynthesisAt
     FROM chats WHERE id = ?`
  ).get(id) as
    | {
        id: string; title: string; type: string; modelId: string;
        systemPrompt: string | null; contextWindow: number | null;
        projectId: string | null; activeSkills: string | null;
        createdAt: string; lastModified: string;
        lastDelayedExtractionAt: string | null;
        lastDelayedExtractionMessageIndex: number | null;
        lastZeitgeistSynthesisAt: string | null;
      }
    | undefined;

  if (!row) return null;

  const window = getChatMessageWindow(id, {
    before: opts.before,
    limit: opts.limit ?? 200,
  });

  const chat: Chat = {
    id: row.id,
    title: row.title,
    type: (row.type as "agent" | "quick" | "system") || "quick",
    modelId: row.modelId,
    systemPrompt: row.systemPrompt || "You are a helpful assistant.",
    ...(row.contextWindow ? { contextWindow: row.contextWindow } : {}),
    messages: window.messages,
    messageOffset: window.offset,
    messageTotal: window.total,
    hasMoreMessages: window.hasMoreBefore,
    createdAt: row.createdAt,
    lastModified: row.lastModified,
    ...(row.projectId ? { projectId: row.projectId } : {}),
    ...(row.activeSkills ? { activeSkills: JSON.parse(row.activeSkills) } : {}),
    ...(row.lastDelayedExtractionAt ? { lastDelayedExtractionAt: row.lastDelayedExtractionAt } : {}),
    ...(row.lastDelayedExtractionMessageIndex !== null && row.lastDelayedExtractionMessageIndex !== undefined ? { lastDelayedExtractionMessageIndex: row.lastDelayedExtractionMessageIndex } : {}),
    ...(row.lastZeitgeistSynthesisAt ? { lastZeitgeistSynthesisAt: row.lastZeitgeistSynthesisAt } : {}),
  };

  return chat;
}

export async function saveChat(chat: Chat, opts?: { allowTruncation?: boolean }): Promise<void> {
  await withChatWriteLock(chat.id, async () => {
    const db = getDb();
    chat.lastModified = new Date().toISOString();
    const preview = computeChatPreview(chat.messages);

    const save = db.transaction(() => {
      // Sync row table first — if the row sync encounters an error,
      // the JSON column hasn't been touched yet, so there's no
      // inconsistency to recover from on the next load.
      const firstChanged = syncChatMessageRows(db, chat.id, chat.messages, opts?.allowTruncation ?? false);
      syncChatMessages(db, chat.id, chat.messages, firstChanged);

      // JSON column mirrors the now-synced row table.
      db.prepare(`
        INSERT OR REPLACE INTO chats (
          id, title, type, modelId, systemPrompt,
          contextWindow, projectId, activeSkills, messages,
          createdAt, lastModified, lastDelayedExtractionAt, lastDelayedExtractionMessageIndex,
          preview
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        chat.id,
        chat.title,
        chat.type,
        chat.modelId,
        chat.systemPrompt || "",
        chat.contextWindow ?? null,
        chat.projectId ?? null,
        chat.activeSkills ? JSON.stringify(chat.activeSkills) : null,
        JSON.stringify(chat.messages.map(withoutTransientMessageMetadata)),
        chat.createdAt,
        chat.lastModified,
        chat.lastDelayedExtractionAt ?? null,
        chat.lastDelayedExtractionMessageIndex ?? null,
        preview
      );
    });

    save();
  });
}

export async function updateChatExtractionState(
  chatId: string,
  extractionAt: string,
  messageIndex: number
): Promise<void> {
  const db = getDb();
  db.prepare(`
    UPDATE chats
    SET lastDelayedExtractionAt = ?, lastDelayedExtractionMessageIndex = ?
    WHERE id = ?
  `).run(extractionAt, messageIndex, chatId);
}

export async function updateChatTitle(
  chatId: string,
  title: string
): Promise<void> {
  const db = getDb();
  db.prepare(`
    UPDATE chats
    SET title = ?, lastModified = ?
    WHERE id = ?
  `).run(title, new Date().toISOString(), chatId);
}

export async function deleteChat(id: string): Promise<boolean> {
  const db = getDb();
  const del = db.transaction(() => {
    const result = db.prepare("DELETE FROM chats WHERE id = ?").run(id);
    db.prepare("DELETE FROM chat_message_rows WHERE chat_id = ?").run(id);
    // Clean up denormalized messages (triggers handle FTS cleanup)
    db.prepare("DELETE FROM chat_messages WHERE chat_id = ?").run(id);
    return result.changes > 0;
  });
  return del();
}

export async function createChat(chat: Chat): Promise<void> {
  const db = getDb();
  const preview = computeChatPreview(chat.messages);

  const create = db.transaction(() => {
    db.prepare(`
      INSERT INTO chats (
        id, title, type, modelId, systemPrompt,
        contextWindow, projectId, activeSkills, messages,
        createdAt, lastModified, lastDelayedExtractionAt, lastDelayedExtractionMessageIndex,
        preview
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      chat.id,
      chat.title,
      chat.type,
      chat.modelId,
      chat.systemPrompt || "",
      chat.contextWindow ?? null,
      chat.projectId ?? null,
      chat.activeSkills ? JSON.stringify(chat.activeSkills) : null,
      JSON.stringify(chat.messages.map(withoutTransientMessageMetadata)),
      chat.createdAt,
      chat.lastModified,
      chat.lastDelayedExtractionAt ?? null,
      chat.lastDelayedExtractionMessageIndex ?? null,
      preview
    );

    const firstChanged = syncChatMessageRows(db, chat.id, chat.messages);
    syncChatMessages(db, chat.id, chat.messages, firstChanged);
  });

  create();
}

// ---------------------------------------------------------------------------
// Project CRUD
// ---------------------------------------------------------------------------

export async function listProjects(): Promise<Project[]> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, name, path, locationType, sshConnectionId, color, pinned, createdAt, lastModified
    FROM projects
    ORDER BY pinned DESC, lastModified DESC
  `).all() as Array<{ id: string; name: string; path: string; locationType?: string; sshConnectionId?: string | null; color: string; pinned: number; createdAt: string; lastModified: string }>;
  
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    path: r.path,
    locationType: r.locationType === "ssh" ? "ssh" : "local",
    sshConnectionId: r.sshConnectionId || undefined,
    color: r.color,
    pinned: r.pinned === 1,
    createdAt: r.createdAt,
    lastModified: r.lastModified,
  }));
}

export async function getProject(id: string): Promise<Project | null> {
  const db = getDb();
  const row = db.prepare("SELECT id, name, path, locationType, sshConnectionId, color, pinned, createdAt, lastModified FROM projects WHERE id = ?").get(id) as { id: string; name: string; path: string; locationType?: string; sshConnectionId?: string | null; color: string; pinned: number; createdAt: string; lastModified: string } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    locationType: row.locationType === "ssh" ? "ssh" : "local",
    sshConnectionId: row.sshConnectionId || undefined,
    color: row.color,
    pinned: row.pinned === 1,
    createdAt: row.createdAt,
    lastModified: row.lastModified,
  };
}

export async function createProject(project: Project): Promise<void> {
  const db = getDb();
  // Assign a color if not provided (cycle through available colors)
  if (!project.color) {
    const existing = db.prepare("SELECT color FROM projects ORDER BY lastModified DESC").all() as { color: string }[];
    const usedColors = existing.map(p => p.color);
    const nextColor = PROJECT_COLORS.find(c => !usedColors.includes(c)) || PROJECT_COLORS[existing.length % PROJECT_COLORS.length];
    project.color = nextColor;
  }
  db.prepare(`
    INSERT INTO projects (id, name, path, locationType, sshConnectionId, color, pinned, createdAt, lastModified)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    project.id,
    project.name,
    project.path,
    project.locationType === "ssh" ? "ssh" : "local",
    project.sshConnectionId || null,
    project.color,
    project.pinned ? 1 : 0,
    project.createdAt,
    project.lastModified
  );
}

export async function updateProject(id: string, updates: Partial<Project>): Promise<boolean> {
  const db = getDb();
  const project = await getProject(id);
  if (!project) return false;

  Object.assign(project, updates);
  project.lastModified = new Date().toISOString();

  db.prepare(`
    UPDATE projects
    SET name = ?, path = ?, locationType = ?, sshConnectionId = ?, color = ?, pinned = ?, lastModified = ?
    WHERE id = ?
  `).run(
    project.name,
    project.path,
    project.locationType === "ssh" ? "ssh" : "local",
    project.sshConnectionId || null,
    project.color,
    project.pinned ? 1 : 0,
    project.lastModified,
    project.id
  );

  return true;
}

export async function deleteProject(id: string): Promise<boolean> {
  const db = getDb();
  const result = db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// SSH connection CRUD
// ---------------------------------------------------------------------------

type SshConnectionRow = {
  id: string;
  name: string;
  host: string;
  port: number;
  username?: string | null;
  identityFile?: string | null;
  knownHostsMode?: string | null;
  enabled: number;
  allowBash: number;
  allowFileWrite: number;
  allowAbsolutePaths: number;
  createdAt: string;
  lastModified: string;
};

function rowToSshConnection(row: SshConnectionRow): SshConnection {
  const knownHostsMode = row.knownHostsMode === "strict" || row.knownHostsMode === "off"
    ? row.knownHostsMode
    : "accept-new";
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port || 22,
    username: row.username || undefined,
    identityFile: row.identityFile || undefined,
    knownHostsMode,
    enabled: row.enabled === 1,
    allowBash: row.allowBash === 1,
    allowFileWrite: row.allowFileWrite === 1,
    allowAbsolutePaths: row.allowAbsolutePaths === 1,
    createdAt: row.createdAt,
    lastModified: row.lastModified,
  };
}

export async function listSshConnections(): Promise<SshConnection[]> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, name, host, port, username, identityFile, knownHostsMode,
           enabled, allowBash, allowFileWrite, allowAbsolutePaths, createdAt, lastModified
    FROM ssh_connections
    ORDER BY name COLLATE NOCASE ASC
  `).all() as SshConnectionRow[];
  return rows.map(rowToSshConnection);
}

export async function getSshConnection(id: string): Promise<SshConnection | null> {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, name, host, port, username, identityFile, knownHostsMode,
           enabled, allowBash, allowFileWrite, allowAbsolutePaths, createdAt, lastModified
    FROM ssh_connections
    WHERE id = ?
  `).get(id) as SshConnectionRow | undefined;
  return row ? rowToSshConnection(row) : null;
}

export async function createSshConnection(connection: SshConnection): Promise<void> {
  const db = getDb();
  db.prepare(`
    INSERT INTO ssh_connections (
      id, name, host, port, username, identityFile, knownHostsMode,
      enabled, allowBash, allowFileWrite, allowAbsolutePaths, createdAt, lastModified
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    connection.id,
    connection.name,
    connection.host,
    connection.port || 22,
    connection.username || null,
    connection.identityFile || null,
    connection.knownHostsMode || "accept-new",
    connection.enabled ? 1 : 0,
    connection.allowBash ? 1 : 0,
    connection.allowFileWrite ? 1 : 0,
    connection.allowAbsolutePaths ? 1 : 0,
    connection.createdAt,
    connection.lastModified
  );
}

export async function updateSshConnection(id: string, updates: Partial<SshConnection>): Promise<boolean> {
  const existing = await getSshConnection(id);
  if (!existing) return false;
  const connection: SshConnection = {
    ...existing,
    ...updates,
    id: existing.id,
    lastModified: new Date().toISOString(),
  };

  const db = getDb();
  db.prepare(`
    UPDATE ssh_connections
    SET name = ?, host = ?, port = ?, username = ?, identityFile = ?, knownHostsMode = ?,
        enabled = ?, allowBash = ?, allowFileWrite = ?, allowAbsolutePaths = ?, lastModified = ?
    WHERE id = ?
  `).run(
    connection.name,
    connection.host,
    connection.port || 22,
    connection.username || null,
    connection.identityFile || null,
    connection.knownHostsMode || "accept-new",
    connection.enabled ? 1 : 0,
    connection.allowBash ? 1 : 0,
    connection.allowFileWrite ? 1 : 0,
    connection.allowAbsolutePaths ? 1 : 0,
    connection.lastModified,
    id
  );
  return true;
}

export async function deleteSshConnection(id: string): Promise<boolean> {
  const db = getDb();
  const result = db.prepare("DELETE FROM ssh_connections WHERE id = ?").run(id);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS: Settings = {
  defaultModelId: "",
  defaultSystemPrompt: "You are a helpful assistant.",
  braveApiKey: "",
  exaApiKey: "",
  tavilyApiKey: "",
  braveSearchEnabled: true,
  exaSearchEnabled: false,
  tavilySearchEnabled: false,
  defaultWebSearchProvider: "brave",
  readFileDefaultLines: 1000,
  readFileMaxBytes: 256 * 1024,
  crossProjectScoreMultiplier: 0.3,
  globalProjectScoreMultiplier: 1.0,
  retrievalDepthProfile: "balanced",
  rerankerTimeoutMs: 25_000,
  llamacppSlotBindingMode: "auto",
};

export async function getSettings(): Promise<Settings> {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as
    | { value: string }
    | undefined;

  if (!row) return { ...DEFAULT_SETTINGS };

  return { ...DEFAULT_SETTINGS, ...JSON.parse(row.value) };
}

export async function saveSettings(settings: Settings): Promise<Settings> {
  const db = getDb();

  // Merge against the currently-stored settings, not just DEFAULT_SETTINGS.
  // The previous behavior — `{ ...DEFAULT_SETTINGS, ...settings }` — replaced
  // the whole row from the incoming object, which made the server vulnerable
  // to clients that send a stale/partial Settings object (e.g., a UI modal
  // that mounts before its async settings fetch completes and then submits
  // empty defaults). With a true merge against existing, fields the client
  // didn't include are preserved, and a defensive guard below also refuses
  // to clobber non-empty stored strings with empty-string overwrites.
  const row = db.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as
    | { value: string }
    | undefined;
  const existing: Settings = row
    ? { ...DEFAULT_SETTINGS, ...JSON.parse(row.value) }
    : { ...DEFAULT_SETTINGS };

  const safeIncoming: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(settings)) {
    // Drop empty-string overwrites of non-empty stored string values. The
    // SettingsModal-mounts-before-load race is the canonical case: it would
    // submit `extractionModelId = ""` when the user really has it set. To
    // explicitly clear a string field, send `null` (treated as an explicit
    // clear and passed through) rather than `""`.
    const existingVal = (existing as unknown as Record<string, unknown>)[key];
    if (val === "" && typeof existingVal === "string" && existingVal.length > 0) {
      continue;
    }
    safeIncoming[key] = val;
  }

  const merged = { ...DEFAULT_SETTINGS, ...existing, ...safeIncoming } as Settings;

  db.prepare(`
    INSERT OR REPLACE INTO settings (key, value)
    VALUES ('settings', ?)
  `).run(JSON.stringify(merged));

  return merged;
}

// ---------------------------------------------------------------------------
// Pending State (for ask_user resume)
// ---------------------------------------------------------------------------

export interface PendingAgentState {
  agentMessages: any[];
  systemPrompt: string;
  askToolCallId: string;
  // In-flight accumulators for mid-turn resume
  fullText?: string;
  thinkingText?: string;
  toolCalls?: any[];
  toolResults?: any[];
  iterations?: number;
  lastUserMessage?: string;
}

export async function savePendingState(chatId: string, state: PendingAgentState): Promise<void> {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO pending_states (
      chatId, agentMessages, systemPrompt, askToolCallId,
      fullText, thinkingText, toolCalls, toolResults, iterations, lastUserMessage
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    chatId,
    JSON.stringify(state.agentMessages),
    state.systemPrompt,
    state.askToolCallId,
    state.fullText || null,
    state.thinkingText || null,
    state.toolCalls ? JSON.stringify(state.toolCalls) : null,
    state.toolResults ? JSON.stringify(state.toolResults) : null,
    state.iterations || null,
    state.lastUserMessage || null
  );
}

export async function loadPendingState(chatId: string): Promise<PendingAgentState | null> {
  const db = getDb();

  const txn = db.transaction(() => {
    const row = db.prepare("SELECT * FROM pending_states WHERE chatId = ?").get(chatId) as
      | {
          chatId: string;
          agentMessages: string;
          systemPrompt: string;
          askToolCallId: string;
          fullText: string | null;
          thinkingText: string | null;
          toolCalls: string | null;
          toolResults: string | null;
          iterations: number | null;
          lastUserMessage: string | null;
        }
      | undefined;

    if (!row) return null;

    // Delete after loading (one-time use) — atomic with the read
    db.prepare("DELETE FROM pending_states WHERE chatId = ?").run(chatId);

    return {
      agentMessages: JSON.parse(row.agentMessages),
      systemPrompt: row.systemPrompt,
      askToolCallId: row.askToolCallId,
      fullText: row.fullText || undefined,
      thinkingText: row.thinkingText || undefined,
      toolCalls: row.toolCalls ? JSON.parse(row.toolCalls) : undefined,
      toolResults: row.toolResults ? JSON.parse(row.toolResults) : undefined,
      iterations: row.iterations || undefined,
      lastUserMessage: row.lastUserMessage || undefined,
    };
  });

  return txn();
}

export async function clearPendingState(chatId: string): Promise<void> {
  const db = getDb();
  db.prepare("DELETE FROM pending_states WHERE chatId = ?").run(chatId);
}

export async function hasPendingState(chatId: string): Promise<boolean> {
  const db = getDb();
  const row = db.prepare("SELECT 1 FROM pending_states WHERE chatId = ?").get(chatId);
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Full-fidelity chat message row sync
// ---------------------------------------------------------------------------

/**
 * Parse the legacy chats.messages JSON column defensively. The row table is the
 * preferred source after migration, but the JSON mirror remains the rollback
 * and recovery path during the compatibility window.
 */
function parseMessagesJson(raw: string, chatId: string): ChatMessage[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as ChatMessage[] : [];
  } catch (e) {
    console.warn(`[chat-storage] Failed to parse legacy messages for chat ${chatId}: ${(e as Error).message}`);
    return [];
  }
}

function loadChatMessageRows(db: Database.Database, chatId: string): ChatMessage[] | null {
  const rows = db.prepare(`
    SELECT sequence, payload_json
    FROM chat_message_rows
    WHERE chat_id = ?
    ORDER BY sequence ASC
  `).all(chatId) as Array<{ sequence: number; payload_json: string }>;

  const messages: ChatMessage[] = [];
  for (const row of rows) {
    if (row.sequence !== messages.length) {
      console.warn(
        `[chat-storage] Message row sequence gap for chat ${chatId} at ${row.sequence} (expected ${messages.length}); ` +
        `falling back to legacy JSON`
      );
      return null;
    }
    try {
      messages.push(withRowSequence(JSON.parse(row.payload_json) as ChatMessage, row.sequence));
    } catch (e) {
      console.warn(
        `[chat-storage] Corrupt message row ${chatId}:${row.sequence}; falling back to legacy JSON: ${(e as Error).message}`
      );
      return null;
    }
  }
  return messages;
}

function withRowSequence(message: ChatMessage, sequence: number): ChatMessage {
  return { ...message, _rowSequence: sequence };
}

function withoutTransientMessageMetadata(message: ChatMessage): ChatMessage {
  const { _rowSequence, ...persisted } = message;
  return persisted;
}

function buildSearchContent(msg: ChatMessage): string {
  if (msg.role === "system") return "";

  const parts: string[] = [];
  if (msg.content) parts.push(msg.content);
  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      parts.push(`[tool:${tc.name}] ${JSON.stringify(tc.arguments)}`);
    }
  }
  if (msg.toolResults) {
    for (const tr of msg.toolResults) {
      parts.push(`[result:${tr.toolName}] ${tr.content}`);
    }
  }
  return parts.join("\n");
}

/**
 * Mirror Chat.messages into per-message rows. Returns the first changed
 * sequence, or null when the row table already matches the provided array.
 *
 * During the compatibility window, sequence deliberately remains the array
 * index so existing edit/retry/messageIndex semantics keep working.
 */
function syncChatMessageRows(
  db: Database.Database,
  chatId: string,
  messages: ChatMessage[],
  allowTruncation: boolean = false
): number | null {
  const existing = db.prepare(`
    SELECT sequence, payload_json
    FROM chat_message_rows
    WHERE chat_id = ?
    ORDER BY sequence ASC
  `).all(chatId) as Array<{ sequence: number; payload_json: string }>;

  // Safety guard: detect and log significant message shrinkage when in-memory
  // state may have been corrupted (e.g., shrunk to 1 message after a model
  // error). Legitimate truncation happens via the /edit endpoint or compaction,
  // which explicitly opt in with allowTruncation=true.
  //
  // OLD BEHAVIOR (v1): When the guard triggered, sync was refused entirely
  // (returned null), creating an inconsistency between chats.messages (JSON
  // column, updated by INSERT OR REPLACE) and chat_message_rows (stale). On
  // the next getChat, loadChatMessageRows could return stale row data, and
  // the in-memory chat.messages would be rebuilt from that — losing any
  // messages that appeared only in the JSON column. This caused silent
  // message loss during compaction when the count shrinks due to _outOfContext
  // marking + content stripping.
  //
  // NEW BEHAVIOR (v2): Always proceed with the sync regardless. The guard
  // only controls logging — a warning fires for significant shrinkage
  // (> 3 messages AND > 50% of existing count) when allowTruncation is false.
  // This ensures the DB always reflects current in-memory state, and the JSON
  // column serves as the recovery path if genuine corruption occurs.
  if (!allowTruncation) {
    const existingCount = existing.length;
    const newCount = messages.length;
    const shrinkage = existingCount - newCount;
    const shrinkagePct = existingCount > 0 ? shrinkage / existingCount : 0;
    if (shrinkage > 3 && shrinkagePct > 0.5) {
      // Extreme shrinkage — still sync but log prominently. The JSON column
      // already has this state (set above), so refusing sync would leave the
      // row table inconsistent with the JSON column. Syncing ensures both
      // sources agree and subsequent loads see the same data.
      console.warn(
        `[chat-storage] WARNING: syncing chat ${chatId} with significant shrinkage — ` +
        `in-memory state has ${newCount} messages but database has ${existingCount}. ` +
        `Syncing anyway to maintain consistency between storage layers.`
      );
    }
  }

  const persistedMessages = messages.map(withoutTransientMessageMetadata);
  const serialized = persistedMessages.map((msg) => JSON.stringify(msg));
  const commonLength = Math.min(existing.length, serialized.length);
  let firstChanged = commonLength;

  for (let i = 0; i < commonLength; i++) {
    if (existing[i].sequence !== i || existing[i].payload_json !== serialized[i]) {
      firstChanged = i;
      break;
    }
  }

  if (existing.length === serialized.length && firstChanged === serialized.length) {
    return null;
  }

  // Log significant sync operations for diagnosability. In normal operation,
  // syncs update 1-3 messages at a time (incremental saves during streaming).
  // Large syncs indicate either initial backfill, compaction, or a data issue.
  const rowsDeleted = Math.max(0, existing.length - firstChanged);
  const rowsInserted = serialized.length - firstChanged;
  if (rowsDeleted > 10 || rowsInserted > 10 || Math.abs(existing.length - serialized.length) > 3) {
    console.log(
      `[chat-storage] syncChatMessageRows(${chatId.slice(0, 8)}): firstChanged=${firstChanged}, ` +
      `deleting ${rowsDeleted} rows, inserting ${rowsInserted} rows. ` +
      `Total: ${existing.length} -> ${serialized.length} messages.`
    );
  }

  db.prepare(`
    DELETE FROM chat_message_rows
    WHERE chat_id = ? AND sequence >= ?
  `).run(chatId, firstChanged);

  const insert = db.prepare(`
    INSERT INTO chat_message_rows (
      chat_id, sequence, role, timestamp, payload_json, search_content,
      out_of_context, is_compaction_summary, is_system_message
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (let i = firstChanged; i < messages.length; i++) {
    const msg = persistedMessages[i];
    insert.run(
      chatId,
      i,
      msg.role,
      msg.timestamp || null,
      serialized[i],
      buildSearchContent(msg),
      msg._outOfContext ? 1 : 0,
      msg._isCompactionSummary ? 1 : 0,
      msg._isSystemMessage ? 1 : 0
    );
  }

  return firstChanged;
}

// ---------------------------------------------------------------------------
// Chat message FTS sync
// ---------------------------------------------------------------------------

/**
 * Walk backwards from `index` while preceding rows belong to the same
 * `_toolLoopId` group, returning the group's first sequence. Used to widen
 * the FTS rebuild window so a merged search row is never left stale.
 */
function findToolLoopGroupStart(messages: ChatMessage[], index: number): number {
  if (index <= 0) return index;

  // Tail deletion can report firstChanged === messages.length. If the new
  // remaining tail ends inside a merged tool-loop search row, back up to that
  // group's first sequence so the stale merged row is deleted and rewritten.
  if (messages.length === 0) return 0;
  const candidateIndex = Math.min(index, messages.length - 1);
  const m = messages[candidateIndex];
  if (m.role !== "assistant" || !m._toolLoopId) {
    return Math.min(index, messages.length);
  }

  const loopId = m._toolLoopId;
  let start = candidateIndex;
  while (
    start > 0 &&
    messages[start - 1].role === "assistant" &&
    messages[start - 1]._toolLoopId === loopId
  ) {
    start--;
  }
  return start;
}

/**
 * Sync the flattened chat_messages search table from a changed message tail.
 *
 * Edits, compaction rewrites, and truncation delete stale search rows before
 * re-indexing. Consecutive `_toolLoopId` rows are merged into one FTS document
 * keyed at the group's first sequence, so a multi-tool visible turn surfaces
 * as one search hit instead of N. When the changed tail starts inside an
 * existing group, the rebuild window is widened to that group's first row so
 * the merged document is rewritten rather than left stale.
 */
function syncChatMessages(
  db: Database.Database,
  chatId: string,
  messages: ChatMessage[],
  firstChanged: number | null
): void {
  if (firstChanged === null) return;

  const effectiveFirst = findToolLoopGroupStart(messages, firstChanged);

  db.prepare(`
    DELETE FROM chat_messages
    WHERE chat_id = ? AND message_index >= ?
  `).run(chatId, effectiveFirst);

  const insert = db.prepare(`
    INSERT INTO chat_messages (chat_id, message_index, role, content, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);

  let i = effectiveFirst;
  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === "assistant" && msg._toolLoopId) {
      const loopId = msg._toolLoopId;
      const groupStart = i;
      const parts: string[] = [];
      while (
        i < messages.length &&
        messages[i].role === "assistant" &&
        messages[i]._toolLoopId === loopId
      ) {
        const piece = buildSearchContent(messages[i]);
        if (piece.trim()) parts.push(piece);
        i++;
      }
      const content = parts.join("\n");
      if (content.trim()) {
        insert.run(
          chatId,
          groupStart,
          "assistant",
          content,
          messages[groupStart].timestamp || null
        );
      }
      continue;
    }

    const content = buildSearchContent(msg);
    if (!content.trim()) {
      i++;
      continue;
    }
    insert.run(chatId, i, msg.role, content, msg.timestamp || null);
    i++;
  }
}

/**
 * Search chat messages using FTS5.
 * If chatId is provided, scopes to that conversation. Otherwise searches all chats.
 * Returns matching messages with surrounding context.
 */
export function searchChatMessages(
  query: string,
  opts: { chatId?: string; limit?: number } = {}
): Array<{ chatId: string; messageIndex: number; role: string; content: string; rank: number }> {
  const db = getDb();
  const limit = opts.limit || 10;
  const trimmed = query.trim();
  if (!trimmed) return [];

  // Escape double quotes for FTS5
  const escaped = trimmed.replace(/"/g, '""');

  // Try phrase match first, then fall back to individual terms
  let ftsQuery = `"${escaped}"`;

  const runSearch = (matchExpr: string) => {
    if (opts.chatId) {
      // chat_id is UNINDEXED in FTS5 — filter on f.chat_id avoids full JOIN scan
      return db.prepare(`
        SELECT f.chat_id, cm.message_index, cm.role, cm.content, f.rank
        FROM chat_messages_fts f
        JOIN chat_messages cm ON cm.rowid = f.rowid
        WHERE f.chat_messages_fts MATCH ?
          AND f.chat_id = ?
        ORDER BY f.rank
        LIMIT ?
      `).all(matchExpr, opts.chatId, limit) as Array<{
        chat_id: string; message_index: number; role: string; content: string; rank: number;
      }>;
    } else {
      return db.prepare(`
        SELECT f.chat_id, cm.message_index, cm.role, cm.content, f.rank
        FROM chat_messages_fts f
        JOIN chat_messages cm ON cm.rowid = f.rowid
        WHERE f.chat_messages_fts MATCH ?
        ORDER BY f.rank
        LIMIT ?
      `).all(matchExpr, limit) as Array<{
        chat_id: string; message_index: number; role: string; content: string; rank: number;
      }>;
    }
  };

  let rows = runSearch(ftsQuery);

  // Fall back to individual terms if phrase match yields nothing
  if (rows.length === 0) {
    const terms = trimmed
      .split(/\s+/)
      .filter((t) => t.length > 0)
      .map((t) => `"${t.replace(/"/g, '""')}"`)
      .join(" OR ");
    if (terms) {
      rows = runSearch(terms);
    }
  }

  return rows.map((r) => ({
    chatId: r.chat_id,
    messageIndex: r.message_index,
    role: r.role,
    content: r.content,
    rank: r.rank,
  }));
}

/**
 * Get messages from a chat by index range (for fetching context around a match).
 */
export function getChatMessageRange(
  chatId: string,
  startIndex: number,
  endIndex: number
): Array<{ messageIndex: number; role: string; content: string }> {
  const db = getDb();
  return db.prepare(`
    SELECT message_index AS messageIndex, role, content
    FROM chat_messages
    WHERE chat_id = ? AND message_index >= ? AND message_index <= ?
    ORDER BY message_index ASC
  `).all(chatId, startIndex, endIndex) as Array<{
    messageIndex: number; role: string; content: string;
  }>;
}

/**
 * Get chat title by ID. Returns the title or null if not found.
 */
export function getChatTitle(chatId: string): string | null {
  const db = getDb();
  const row = db.prepare("SELECT title FROM chats WHERE id = ?").get(chatId) as { title: string } | undefined;
  return row?.title ?? null;
}

function computeChatPreview(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg._isCompactionSummary && msg.role !== "system") {
      return extractPreviewText(msg);
    }
  }
  return "";
}

/**
 * Extract preview text from a message.
 * For assistant messages with segments, uses the last text segment (matches what the UI displays).
 * This avoids showing promoted-thinking preamble that appears at the start of content
 * but is not visible in the UI's segment-based rendering.
 */
function extractPreviewText(msg: ChatMessage): string {
  if (msg.role === "assistant" && msg.segments?.length) {
    // Find the last text segment — this is what the UI actually displays last
    for (let i = msg.segments.length - 1; i >= 0; i--) {
      if (msg.segments[i].type === "text" && msg.segments[i].content?.trim()) {
        return msg.segments[i].content!.slice(0, 100);
      }
    }
  }
  return msg.content ? msg.content.slice(0, 100) : "";
}

/**
 * Recompute preview column for all chats, skipping compaction summary messages.
 * Called once during migration to fix previews that show "The user is reporting..." text.
 */
function recomputePreviewsSkippingCompaction(db: Database.Database): void {
  const chats = db.prepare("SELECT id, messages FROM chats").all() as Array<{
    id: string; messages: string;
  }>;

  const update = db.prepare("UPDATE chats SET preview = ?, _previewRecomputed = 1 WHERE id = ?");
  let updated = 0;

  for (const chat of chats) {
    try {
      const messages = parseMessagesJson(chat.messages, chat.id);
      const preview = computeChatPreview(messages);
      update.run(preview, chat.id);
      updated++;
    } catch (e) {
      console.warn(`[chat-storage] Skipping preview recompute for chat ${chat.id}: ${(e as Error).message}`);
    }
  }

  console.log(`[chat-storage] Recomputed previews for ${updated} chats (skipping compaction summaries)`);
}

function hasStorageMigration(db: Database.Database, name: string): boolean {
  const row = db.prepare("SELECT 1 FROM storage_migrations WHERE name = ?").get(name);
  return row !== undefined;
}

function markStorageMigration(db: Database.Database, name: string): void {
  db.prepare(`
    INSERT OR REPLACE INTO storage_migrations (name, appliedAt)
    VALUES (?, ?)
  `).run(name, new Date().toISOString());
}

function backfillChatMessageRows(db: Database.Database): void {
  if (hasStorageMigration(db, MESSAGE_ROWS_MIGRATION)) return;

  const chats = db.prepare("SELECT id, messages FROM chats").all() as Array<{
    id: string; messages: string;
  }>;
  let chatCount = 0;
  let messageCount = 0;

  const backfill = db.transaction(() => {
    for (const chat of chats) {
      const messages = parseMessagesJson(chat.messages, chat.id);
      const firstChanged = syncChatMessageRows(db, chat.id, messages);
      if (firstChanged !== null) {
        chatCount++;
        messageCount += messages.length - firstChanged;
      }
    }
    markStorageMigration(db, MESSAGE_ROWS_MIGRATION);
  });

  backfill();
  console.log(`[chat-storage] Backfilled chat_message_rows for ${chatCount} chats (${messageCount} changed rows)`);
}

function rebuildChatSearchFromRowsOnce(db: Database.Database): void {
  if (hasStorageMigration(db, CHAT_SEARCH_REBUILD_MIGRATION)) return;

  const rows = db.prepare(`
    SELECT chat_id, sequence, role, timestamp, search_content
    FROM chat_message_rows
    ORDER BY chat_id ASC, sequence ASC
  `).all() as Array<{
    chat_id: string;
    sequence: number;
    role: string;
    timestamp: number | null;
    search_content: string;
  }>;

  const rebuild = db.transaction(() => {
    db.prepare("DELETE FROM chat_messages").run();

    const insert = db.prepare(`
      INSERT INTO chat_messages (chat_id, message_index, role, content, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);

    let inserted = 0;
    for (const row of rows) {
      if (!row.search_content.trim()) continue;
      insert.run(row.chat_id, row.sequence, row.role, row.search_content, row.timestamp);
      inserted++;
    }

    markStorageMigration(db, CHAT_SEARCH_REBUILD_MIGRATION);
    return inserted;
  });

  const inserted = rebuild();
  console.log(`[chat-storage] Rebuilt chat_messages FTS source from row storage (${inserted} indexed rows)`);
}

/**
 * One-shot rebuild that re-runs `syncChatMessages` over every chat so that
 * already-indexed canonical tool-loop fragments collapse into the merged
 * search row introduced alongside this migration. Without it, chats stored
 * after the canonical-row fix but before the merge logic would keep one FTS
 * document per fragment until they were edited again.
 */
function remergeChatSearchToolLoopRowsOnce(db: Database.Database): void {
  if (hasStorageMigration(db, CHAT_SEARCH_TOOLLOOP_MERGE_MIGRATION)) return;

  const chatIds = db.prepare(`
    SELECT DISTINCT chat_id FROM chat_message_rows ORDER BY chat_id ASC
  `).all() as Array<{ chat_id: string }>;

  if (chatIds.length === 0) {
    markStorageMigration(db, CHAT_SEARCH_TOOLLOOP_MERGE_MIGRATION);
    return;
  }

  const remerge = db.transaction(() => {
    let touched = 0;
    for (const { chat_id } of chatIds) {
      const rows = db.prepare(`
        SELECT payload_json FROM chat_message_rows
        WHERE chat_id = ?
        ORDER BY sequence ASC
      `).all(chat_id) as Array<{ payload_json: string }>;

      const messages: ChatMessage[] = [];
      for (const row of rows) {
        try {
          messages.push(JSON.parse(row.payload_json) as ChatMessage);
        } catch {
          // Skip corrupt rows; they'll get cleaned up next time the chat is saved.
        }
      }
      if (messages.length === 0) continue;

      const hasLoopRows = messages.some((m) => m.role === "assistant" && m._toolLoopId);
      if (!hasLoopRows) continue;

      syncChatMessages(db, chat_id, messages, 0);
      touched++;
    }
    markStorageMigration(db, CHAT_SEARCH_TOOLLOOP_MERGE_MIGRATION);
    return touched;
  });

  const touched = remerge();
  console.log(`[chat-storage] Remerged tool-loop FTS rows for ${touched} chats`);
}

/**
 * Backfill chat_messages table for all existing chats that haven't been indexed yet.
 * Called once on startup if needed.
 */
export function backfillChatMessages(): void {
  const db = getDb();
  if (hasStorageMigration(db, CHAT_SEARCH_REBUILD_MIGRATION)) return;

  // Check if we've already backfilled
  const meta = db.prepare("SELECT 1 FROM chat_messages LIMIT 1").get();
  const chatCount = (db.prepare("SELECT COUNT(*) as cnt FROM chats").get() as { cnt: number }).cnt;

  if (meta || chatCount === 0) return; // already has data or no chats to index

  console.log("[chat-storage] Backfilling chat_messages FTS index...");

  const chats = db.prepare("SELECT id, messages FROM chats").all() as Array<{
    id: string; messages: string;
  }>;

  let totalMessages = 0;
  for (const chat of chats) {
    try {
      const messages = parseMessagesJson(chat.messages, chat.id);
      syncChatMessages(db, chat.id, messages, 0);
      totalMessages += messages.length;
    } catch (e) {
      console.warn(`[chat-storage] Skipping chat ${chat.id} during backfill: ${(e as Error).message}`);
    }
  }

  console.log(`[chat-storage] Backfilled ${totalMessages} messages from ${chats.length} chats`);
}

// ---------------------------------------------------------------------------
// Migration from JSON files
// ---------------------------------------------------------------------------

function migrateChatsFromJson(db: Database.Database): void {
  try {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO chats (
        id, title, type, modelId, systemPrompt,
        contextWindow, projectId, activeSkills, messages,
        createdAt, lastModified, lastDelayedExtractionAt, lastDelayedExtractionMessageIndex
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const migrate = db.transaction(() => {
      const files = readdirSync(CHATS_DIR);
      let count = 0;

      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const data = readFileSync(join(CHATS_DIR, file), "utf-8");
          const chat = JSON.parse(data) as Chat;
          insert.run(
            chat.id,
            chat.title,
            chat.type || "quick",
            chat.modelId,
            chat.systemPrompt || "",
            chat.contextWindow ?? null,
            chat.projectId ?? null,
            chat.activeSkills ? JSON.stringify(chat.activeSkills) : null,
            JSON.stringify(chat.messages.map(withoutTransientMessageMetadata)),
            chat.createdAt,
            chat.lastModified,
            chat.lastDelayedExtractionAt ?? null,
            chat.lastDelayedExtractionMessageIndex ?? null
          );
          count++;
        } catch (e) {
          console.warn(`[chat-storage] Skipping corrupt chat file: ${file}`);
        }
      }

      return count;
    });

    const count = migrate();
    console.log(`[chat-storage] Migrated ${count} chats to SQLite`);

    renameSync(CHATS_DIR, CHATS_DIR + ".bak");
    console.log("[chat-storage] Renamed chats/ → chats.bak/");
  } catch (e) {
    console.error("[chat-storage] Chat migration from JSON failed:", e);
  }
}

function migrateProjectsFromJson(db: Database.Database): void {
  try {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO projects (id, name, path, locationType, sshConnectionId, createdAt, lastModified)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const migrate = db.transaction(() => {
      const files = readdirSync(PROJECTS_DIR);
      let count = 0;

      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const data = readFileSync(join(PROJECTS_DIR, file), "utf-8");
          const project = JSON.parse(data) as Project;
          insert.run(
            project.id,
            project.name,
            project.path,
            project.locationType === "ssh" ? "ssh" : "local",
            project.sshConnectionId || null,
            project.createdAt,
            project.lastModified
          );
          count++;
        } catch (e) {
          console.warn(`[chat-storage] Skipping corrupt project file: ${file}`);
        }
      }

      return count;
    });

    const count = migrate();
    console.log(`[chat-storage] Migrated ${count} projects to SQLite`);

    renameSync(PROJECTS_DIR, PROJECTS_DIR + ".bak");
    console.log("[chat-storage] Renamed projects/ → projects.bak/");
  } catch (e) {
    console.error("[chat-storage] Projects migration from JSON failed:", e);
  }
}

function migrateSettingsFromJson(db: Database.Database): void {
  try {
    // Only migrate if settings table is empty (avoid overwriting on subsequent startups)
    const existing = db.prepare("SELECT 1 FROM settings WHERE key = 'settings'").get();
    if (existing) return;

    const data = readFileSync(SETTINGS_PATH, "utf-8");
    const settings = JSON.parse(data);
    const merged = { ...DEFAULT_SETTINGS, ...settings };

    db.prepare(`
      INSERT OR REPLACE INTO settings (key, value)
      VALUES ('settings', ?)
    `).run(JSON.stringify(merged));

    console.log("[chat-storage] Migrated settings.json to SQLite");
  } catch (e) {
    // settings.json may not exist or be corrupt — not fatal
    console.warn("[chat-storage] Settings migration skipped:", (e as Error).message);
  }
}

// ---------------------------------------------------------------------------
// User UI State Persistence
// ---------------------------------------------------------------------------

export interface UserUIState {
  sidebarState?: {
    projectsExpanded: boolean;
    agentExpanded: boolean;
    quickExpanded: boolean;
    projectStates: Record<string, boolean>;
  };
  notebookLastSeen?: string | null;
  activeChatId?: string | null;
  activeView?: 'chats' | 'notebooks' | 'image-sandbox';
}

const UI_STATE_KEY = 'user_ui_state';

export async function getUserUIState(): Promise<UserUIState> {
  const db = getDb();
  const row = db.prepare('SELECT value FROM user_ui_state WHERE key = ?').get(UI_STATE_KEY) as { value: string } | undefined;
  if (!row) return {};
  return JSON.parse(row.value);
}

export async function saveUserUIState(state: Partial<UserUIState>): Promise<void> {
  const db = getDb();
  const existing = await getUserUIState();
  const merged = { ...existing, ...state };
  db.prepare(`
    INSERT OR REPLACE INTO user_ui_state (key, value, updatedAt)
    VALUES (?, ?, ?)
  `).run(UI_STATE_KEY, JSON.stringify(merged), new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Context Archives (indexed compaction)
// ---------------------------------------------------------------------------

export interface ContextArchive {
  id: string;
  chatId: string;
  sequenceNum: number;
  messages: ChatMessage[];
  indexEntry: string;
  messageCount: number;
  estimatedTokens: number;
  createdAt: string;
}

/** Get the next sequence number for a chat's archives. */
export function getNextArchiveSequence(chatId: string): number {
  const db = getDb();
  const row = db.prepare(
    "SELECT MAX(sequenceNum) as maxSeq FROM context_archives WHERE chatId = ?"
  ).get(chatId) as { maxSeq: number | null } | undefined;
  return (row?.maxSeq ?? 0) + 1;
}

/** Save a batch of archive blocks for a single compaction event. */
export function saveArchives(archives: ContextArchive[]): void {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO context_archives (id, chatId, sequenceNum, messages, indexEntry, messageCount, estimatedTokens, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const a of archives) {
      // Store messages as JSON; the FTS trigger indexes the raw JSON (which contains the text)
      insert.run(a.id, a.chatId, a.sequenceNum, JSON.stringify(a.messages), a.indexEntry, a.messageCount, a.estimatedTokens, a.createdAt);
    }
  });
  tx();
}

/** Retrieve a single archive block by ID. */
export function getArchive(id: string): ContextArchive | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM context_archives WHERE id = ?").get(id) as any;
  if (!row) return null;
  return {
    ...row,
    messages: JSON.parse(row.messages),
  };
}

/** Search archives via FTS5. Returns matches with archive metadata. */
export function searchArchives(
  query: string,
  opts: { chatId?: string; limit?: number } = {}
): Array<{ id: string; chatId: string; indexEntry: string; rank: number }> {
  const db = getDb();
  const limit = opts.limit ?? 10;

  // Escape special FTS5 characters and try phrase match first
  const escaped = query.replace(/['"]/g, "");
  let sql: string;
  let params: any[];

  if (opts.chatId) {
    sql = `
      SELECT ca.id, ca.chatId, ca.indexEntry, f.rank
      FROM context_archives_fts f
      JOIN context_archives ca ON ca.rowid = f.rowid
      WHERE f.context_archives_fts MATCH ?
        AND f.chatId = ?
      ORDER BY f.rank LIMIT ?
    `;
    params = [`"${escaped}"`, opts.chatId, limit];
  } else {
    sql = `
      SELECT ca.id, ca.chatId, ca.indexEntry, f.rank
      FROM context_archives_fts f
      JOIN context_archives ca ON ca.rowid = f.rowid
      WHERE f.context_archives_fts MATCH ?
      ORDER BY f.rank LIMIT ?
    `;
    params = [`"${escaped}"`, limit];
  }

  try {
    const results = db.prepare(sql).all(...params) as any[];
    if (results.length > 0) return results;
  } catch { /* phrase match failed, try term-based */ }

  // Fallback: OR-based term search
  const terms = escaped.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const termQuery = terms.map((t) => `"${t}"`).join(" OR ");

  if (opts.chatId) {
    sql = `
      SELECT ca.id, ca.chatId, ca.indexEntry, f.rank
      FROM context_archives_fts f
      JOIN context_archives ca ON ca.rowid = f.rowid
      WHERE f.context_archives_fts MATCH ?
        AND f.chatId = ?
      ORDER BY f.rank LIMIT ?
    `;
    params = [termQuery, opts.chatId, limit];
  } else {
    sql = `
      SELECT ca.id, ca.chatId, ca.indexEntry, f.rank
      FROM context_archives_fts f
      JOIN context_archives ca ON ca.rowid = f.rowid
      WHERE f.context_archives_fts MATCH ?
      ORDER BY f.rank LIMIT ?
    `;
    params = [termQuery, limit];
  }

  try {
    return db.prepare(sql).all(...params) as any[];
  } catch {
    return [];
  }
}
