import Database from "better-sqlite3";
import { readdirSync, readFileSync, existsSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Chat, ChatListItem, ChatMessage, Project, Settings } from "../types.js";

const BASE_DIR = join(homedir(), ".quje-agent");
const CHATS_DIR = join(BASE_DIR, "chats");
const PROJECTS_DIR = join(BASE_DIR, "projects");
const SETTINGS_PATH = join(BASE_DIR, "settings.json");

const DB_PATH = join(BASE_DIR, "app.db");

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

  // Auto-add activeSkills column if upgrading from earlier schema
  const cols = db.prepare("PRAGMA table_info(chats)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "activeSkills")) {
    db.exec("ALTER TABLE chats ADD COLUMN activeSkills TEXT");
  }

  // Auto-add delayed extraction tracking columns
  if (!cols.some((c) => c.name === "lastDelayedExtractionAt")) {
    db.exec("ALTER TABLE chats ADD COLUMN lastDelayedExtractionAt TEXT");
  }
  if (!cols.some((c) => c.name === "lastDelayedExtractionMessageIndex")) {
    db.exec("ALTER TABLE chats ADD COLUMN lastDelayedExtractionMessageIndex INTEGER");
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
    SELECT id, title, type, lastModified, projectId,
           SUBSTR(json_extract(messages, '$[#-1].content'), 1, 100) as preview
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
    type: r.type as "agent" | "quick",
    lastModified: r.lastModified,
    preview: r.preview || "",
    ...(r.projectId ? { projectId: r.projectId } : {}),
  }));
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
      }
    | undefined;

  if (!row) return null;

  const chat: Chat = {
    id: row.id,
    title: row.title,
    type: (row.type as "agent" | "quick") || "quick",
    modelId: row.modelId,
    systemPrompt: row.systemPrompt || "You are a helpful assistant.",
    ...(row.contextWindow ? { contextWindow: row.contextWindow } : {}),
    messages: JSON.parse(row.messages),
    createdAt: row.createdAt,
    lastModified: row.lastModified,
    ...(row.projectId ? { projectId: row.projectId } : {}),
    ...(row.activeSkills ? { activeSkills: JSON.parse(row.activeSkills) } : {}),
    ...(row.lastDelayedExtractionAt ? { lastDelayedExtractionAt: row.lastDelayedExtractionAt } : {}),
    ...(row.lastDelayedExtractionMessageIndex !== null && row.lastDelayedExtractionMessageIndex !== undefined ? { lastDelayedExtractionMessageIndex: row.lastDelayedExtractionMessageIndex } : {}),
  };

  return chat;
}

export async function saveChat(chat: Chat): Promise<void> {
  const db = getDb();
  chat.lastModified = new Date().toISOString();

  db.prepare(`
    INSERT OR REPLACE INTO chats (
      id, title, type, modelId, systemPrompt,
      contextWindow, projectId, activeSkills, messages,
      createdAt, lastModified, lastDelayedExtractionAt, lastDelayedExtractionMessageIndex
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    chat.id,
    chat.title,
    chat.type,
    chat.modelId,
    chat.systemPrompt || "",
    chat.contextWindow ?? null,
    chat.projectId ?? null,
    chat.activeSkills ? JSON.stringify(chat.activeSkills) : null,
    JSON.stringify(chat.messages),
    chat.createdAt,
    chat.lastModified,
    chat.lastDelayedExtractionAt ?? null,
    chat.lastDelayedExtractionMessageIndex ?? null
  );

  // Sync messages to FTS index (append-only, only inserts new messages)
  syncChatMessages(db, chat.id, chat.messages);
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

export async function deleteChat(id: string): Promise<boolean> {
  const db = getDb();
  const del = db.transaction(() => {
    const result = db.prepare("DELETE FROM chats WHERE id = ?").run(id);
    // Clean up denormalized messages (triggers handle FTS cleanup)
    db.prepare("DELETE FROM chat_messages WHERE chat_id = ?").run(id);
    return result.changes > 0;
  });
  return del();
}

export async function createChat(chat: Chat): Promise<void> {
  const db = getDb();
  db.prepare(`
    INSERT INTO chats (
      id, title, type, modelId, systemPrompt,
      contextWindow, projectId, activeSkills, messages,
      createdAt, lastModified, lastDelayedExtractionAt, lastDelayedExtractionMessageIndex
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    chat.id,
    chat.title,
    chat.type,
    chat.modelId,
    chat.systemPrompt || "",
    chat.contextWindow ?? null,
    chat.projectId ?? null,
    chat.activeSkills ? JSON.stringify(chat.activeSkills) : null,
    JSON.stringify(chat.messages),
    chat.createdAt,
    chat.lastModified,
    chat.lastDelayedExtractionAt ?? null,
    chat.lastDelayedExtractionMessageIndex ?? null
  );

  // Sync messages to FTS index
  syncChatMessages(db, chat.id, chat.messages);
}

// ---------------------------------------------------------------------------
// Project CRUD
// ---------------------------------------------------------------------------

export async function listProjects(): Promise<Project[]> {
  const db = getDb();
  return db.prepare(`
    SELECT id, name, path, createdAt, lastModified
    FROM projects
    ORDER BY lastModified DESC
  `).all() as Project[];
}

export async function getProject(id: string): Promise<Project | null> {
  const db = getDb();
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Project | undefined;
  return row ?? null;
}

export async function createProject(project: Project): Promise<void> {
  const db = getDb();
  db.prepare(`
    INSERT INTO projects (id, name, path, createdAt, lastModified)
    VALUES (?, ?, ?, ?, ?)
  `).run(project.id, project.name, project.path, project.createdAt, project.lastModified);
}

export async function updateProject(id: string, updates: Partial<Project>): Promise<boolean> {
  const db = getDb();
  const project = await getProject(id);
  if (!project) return false;

  Object.assign(project, updates);
  project.lastModified = new Date().toISOString();

  db.prepare(`
    UPDATE projects
    SET name = ?, path = ?, lastModified = ?
    WHERE id = ?
  `).run(project.name, project.path, project.lastModified, project.id);

  return true;
}

export async function deleteProject(id: string): Promise<boolean> {
  const db = getDb();
  const result = db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS: Settings = {
  defaultModelId: "",
  defaultSystemPrompt: "You are a helpful assistant.",
  braveApiKey: "",
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
  const merged = { ...DEFAULT_SETTINGS, ...settings };

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
// Chat message FTS sync
// ---------------------------------------------------------------------------

/**
 * Sync chat messages to the denormalized chat_messages table for FTS search.
 * Only inserts new messages (append-only — messages are never edited/removed).
 */
function syncChatMessages(db: Database.Database, chatId: string, messages: ChatMessage[]): void {
  // How many messages are already indexed for this chat?
  const row = db.prepare(
    "SELECT MAX(message_index) as maxIdx FROM chat_messages WHERE chat_id = ?"
  ).get(chatId) as { maxIdx: number | null } | undefined;

  const existingCount = row?.maxIdx !== null && row?.maxIdx !== undefined ? row.maxIdx + 1 : 0;
  if (existingCount >= messages.length) return; // nothing new

  const insert = db.prepare(`
    INSERT OR IGNORE INTO chat_messages (chat_id, message_index, role, content, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);

  const sync = db.transaction(() => {
    for (let i = existingCount; i < messages.length; i++) {
      const msg = messages[i];
      // Build searchable content: main text + tool call arguments + tool results
      const parts: string[] = [];
      if (msg.content) parts.push(msg.content);
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          // Include tool name and stringified arguments for searchability
          parts.push(`[tool:${tc.name}] ${JSON.stringify(tc.arguments)}`);
        }
      }
      if (msg.toolResults) {
        for (const tr of msg.toolResults) {
          parts.push(`[result:${tr.toolName}] ${tr.content}`);
        }
      }
      const content = parts.join("\n");
      if (!content.trim()) continue; // skip empty messages

      insert.run(chatId, i, msg.role, content, msg.timestamp || null);
    }
  });
  sync();
}

/**
 * Search chat messages using FTS5.
 * If chatId is provided, scopes to that conversation. Otherwise searches all chats.
 * Returns matching messages with surrounding context.
 */
export function searchChatMessages(
  query: string,
  opts: { chatId?: string; limit?: number; contextMessages?: number } = {}
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
    SELECT message_index, role, content
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

/**
 * Backfill chat_messages table for all existing chats that haven't been indexed yet.
 * Called once on startup if needed.
 */
export function backfillChatMessages(): void {
  const db = getDb();

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
      const messages = JSON.parse(chat.messages) as ChatMessage[];
      syncChatMessages(db, chat.id, messages);
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
            JSON.stringify(chat.messages),
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
      INSERT OR REPLACE INTO projects (id, name, path, createdAt, lastModified)
      VALUES (?, ?, ?, ?, ?)
    `);

    const migrate = db.transaction(() => {
      const files = readdirSync(PROJECTS_DIR);
      let count = 0;

      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const data = readFileSync(join(PROJECTS_DIR, file), "utf-8");
          const project = JSON.parse(data) as Project;
          insert.run(project.id, project.name, project.path, project.createdAt, project.lastModified);
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
