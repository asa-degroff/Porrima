import Database from "better-sqlite3";
import { readdirSync, readFileSync, existsSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Chat, ChatListItem, Project, Settings } from "../types.js";

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
      askToolCallId TEXT NOT NULL
    );
  `);

  // Indexes for common queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chats_lastModified ON chats(lastModified DESC);
    CREATE INDEX IF NOT EXISTS idx_chats_projectId ON chats(projectId) WHERE projectId IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_chats_type ON chats(type);
    CREATE INDEX IF NOT EXISTS idx_projects_lastModified ON projects(lastModified DESC);
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
  const result = db.prepare("DELETE FROM chats WHERE id = ?").run(id);
  return result.changes > 0;
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
}

export async function savePendingState(chatId: string, state: PendingAgentState): Promise<void> {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO pending_states (chatId, agentMessages, systemPrompt, askToolCallId)
    VALUES (?, ?, ?, ?)
  `).run(chatId, JSON.stringify(state.agentMessages), state.systemPrompt, state.askToolCallId);
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
        }
      | undefined;

    if (!row) return null;

    // Delete after loading (one-time use) — atomic with the read
    db.prepare("DELETE FROM pending_states WHERE chatId = ?").run(chatId);

    return {
      agentMessages: JSON.parse(row.agentMessages),
      systemPrompt: row.systemPrompt,
      askToolCallId: row.askToolCallId,
    };
  });

  return txn();
}

export async function hasPendingState(chatId: string): Promise<boolean> {
  const db = getDb();
  const row = db.prepare("SELECT 1 FROM pending_states WHERE chatId = ?").get(chatId);
  return row !== undefined;
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
