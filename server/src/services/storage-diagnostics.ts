import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { APP_DATA_DIR } from "./paths.js";
import { getDb as getChatDb } from "./chat-storage.js";
import { getDb as getMemoryDb } from "./memory-storage.js";

export interface StorageMigrationDiagnostics {
  generatedAt: string;
  appDataDir: string;
  chatStorage: {
    chatCount: number;
    jsonMessageCount: number;
    rowMessageCount: number;
    rowChatCount: number;
    mismatchCount: number;
    maxMismatch: number;
    indexedMessageCount: number;
    ftsMessageCount: number;
    storageMigrations: Array<{ name: string; appliedAt: string }>;
  };
  memoryStorage: {
    dbMemoryCount: number;
    dbBlockCount: number;
    dbLastSynthesis: string | null;
    jsonBackup: LegacyJsonSummary & {
      memoryCount?: number;
      lastSynthesis?: string | null;
      staleComparedToDb: boolean;
    };
  };
  legacySources: {
    chatJsonFiles: number;
    projectJsonFiles: number;
    settingsJson: LegacyJsonSummary;
    notebookJsonFiles: {
      userActive: number;
      agentActive: number;
      userBackup: number;
      agentBackup: number;
    };
    corpusJsonBackup: LegacyJsonSummary;
  };
  warnings: string[];
}

interface LegacyJsonSummary {
  exists: boolean;
  path: string;
  sizeBytes?: number;
  modifiedAt?: string;
}

function fileSummary(path: string): LegacyJsonSummary {
  if (!existsSync(path)) return { exists: false, path };
  const stat = statSync(path);
  return {
    exists: true,
    path,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

function countJsonFiles(dir: string, opts?: { includeIndex?: boolean }): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((file) =>
    file.endsWith(".json") && (opts?.includeIndex || file !== "index.json")
  ).length;
}

function readScalar(db: any, sql: string): number {
  const row = db.prepare(sql).get() as { value?: number } | undefined;
  return Number(row?.value ?? 0);
}

function readMemoryJsonSummary(path: string, dbMemoryCount: number, dbLastSynthesis: string | null) {
  const summary = {
    ...fileSummary(path),
    staleComparedToDb: false,
  } as StorageMigrationDiagnostics["memoryStorage"]["jsonBackup"];

  if (!summary.exists) return summary;

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      memories?: unknown[];
      lastSynthesis?: string | null;
    };
    summary.memoryCount = Array.isArray(parsed.memories) ? parsed.memories.length : undefined;
    summary.lastSynthesis = parsed.lastSynthesis ?? null;
    const jsonLast = summary.lastSynthesis ? Date.parse(summary.lastSynthesis) : NaN;
    const dbLast = dbLastSynthesis ? Date.parse(dbLastSynthesis) : NaN;
    summary.staleComparedToDb =
      (summary.memoryCount !== undefined && summary.memoryCount < dbMemoryCount) ||
      (Number.isFinite(jsonLast) && Number.isFinite(dbLast) && jsonLast < dbLast);
  } catch {
    summary.staleComparedToDb = true;
  }

  return summary;
}

export function getStorageMigrationDiagnostics(): StorageMigrationDiagnostics {
  const chatDb = getChatDb();
  const memoryDb = getMemoryDb();

  const chatStorage = {
    chatCount: readScalar(chatDb, "SELECT COUNT(*) AS value FROM chats"),
    jsonMessageCount: readScalar(chatDb, "SELECT COALESCE(SUM(json_array_length(messages)), 0) AS value FROM chats"),
    rowMessageCount: readScalar(chatDb, "SELECT COUNT(*) AS value FROM chat_message_rows"),
    rowChatCount: readScalar(chatDb, "SELECT COUNT(DISTINCT chat_id) AS value FROM chat_message_rows"),
    mismatchCount: 0,
    maxMismatch: 0,
    indexedMessageCount: readScalar(chatDb, "SELECT COUNT(*) AS value FROM chat_messages"),
    ftsMessageCount: readScalar(chatDb, "SELECT COUNT(*) AS value FROM chat_messages_fts"),
    storageMigrations: chatDb.prepare("SELECT name, appliedAt FROM storage_migrations ORDER BY appliedAt ASC").all() as Array<{ name: string; appliedAt: string }>,
  };

  const mismatch = chatDb.prepare(`
    WITH j AS (
      SELECT id, json_array_length(messages) AS jm FROM chats
    ), r AS (
      SELECT chat_id AS id, COUNT(*) AS rm FROM chat_message_rows GROUP BY chat_id
    )
    SELECT
      COUNT(*) AS mismatchCount,
      COALESCE(MAX(ABS(COALESCE(jm, 0) - COALESCE(rm, 0))), 0) AS maxMismatch
    FROM j LEFT JOIN r USING(id)
    WHERE COALESCE(jm, 0) != COALESCE(rm, 0)
  `).get() as { mismatchCount: number; maxMismatch: number };
  chatStorage.mismatchCount = mismatch.mismatchCount;
  chatStorage.maxMismatch = mismatch.maxMismatch;

  const dbLastSynthesis = (memoryDb.prepare("SELECT value FROM metadata WHERE key = 'lastSynthesis'").get() as { value: string } | undefined)?.value ?? null;
  const dbMemoryCount = readScalar(memoryDb, "SELECT COUNT(*) AS value FROM memories");
  const memoryStorage = {
    dbMemoryCount,
    dbBlockCount: readScalar(memoryDb, "SELECT COUNT(*) AS value FROM memory_blocks"),
    dbLastSynthesis,
    jsonBackup: readMemoryJsonSummary(join(APP_DATA_DIR, "memory", "memories.json"), dbMemoryCount, dbLastSynthesis),
  };

  const notebookJsonFiles = {
    userActive: countJsonFiles(join(APP_DATA_DIR, "notebooks", "user", "entries")),
    agentActive: countJsonFiles(join(APP_DATA_DIR, "notebooks", "agent", "entries")),
    userBackup: countJsonFiles(join(APP_DATA_DIR, "notebooks", "user", "entries", ".backup"), { includeIndex: true }),
    agentBackup: countJsonFiles(join(APP_DATA_DIR, "notebooks", "agent", "entries", ".backup"), { includeIndex: true }),
  };

  const legacySources = {
    chatJsonFiles: countJsonFiles(join(APP_DATA_DIR, "chats")),
    projectJsonFiles: countJsonFiles(join(APP_DATA_DIR, "projects")),
    settingsJson: fileSummary(join(APP_DATA_DIR, "settings.json")),
    notebookJsonFiles,
    corpusJsonBackup: fileSummary(join(APP_DATA_DIR, "image-corpus", "corpus.json.bak")),
  };

  const warnings: string[] = [];
  if (chatStorage.mismatchCount > 0) {
    warnings.push(`chat JSON snapshot and row store differ for ${chatStorage.mismatchCount} chat(s); max difference ${chatStorage.maxMismatch} message(s)`);
  }
  if (chatStorage.indexedMessageCount !== chatStorage.ftsMessageCount) {
    warnings.push(`chat_messages and chat_messages_fts counts differ (${chatStorage.indexedMessageCount} vs ${chatStorage.ftsMessageCount})`);
  }
  if (legacySources.chatJsonFiles > 0) {
    warnings.push(`legacy chat JSON directory contains ${legacySources.chatJsonFiles} active file(s)`);
  }
  if (legacySources.projectJsonFiles > 0) {
    warnings.push(`legacy project JSON directory contains ${legacySources.projectJsonFiles} active file(s)`);
  }
  const activeNotebookFiles = notebookJsonFiles.userActive + notebookJsonFiles.agentActive;
  if (activeNotebookFiles > 0) {
    warnings.push(`legacy notebook entry directories contain ${activeNotebookFiles} active JSON file(s) that startup migration would import`);
  }
  if (memoryStorage.jsonBackup.staleComparedToDb) {
    warnings.push(
      `memory/memories.json appears stale (${memoryStorage.jsonBackup.memoryCount ?? "unknown"} JSON memories vs ${dbMemoryCount} DB memories)`
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    appDataDir: APP_DATA_DIR,
    chatStorage,
    memoryStorage,
    legacySources,
    warnings,
  };
}

export function logStorageMigrationDiagnostics(): void {
  try {
    const diagnostics = getStorageMigrationDiagnostics();
    if (diagnostics.warnings.length === 0) {
      console.log("[storage-diagnostics] compatibility check clean");
      return;
    }
    console.warn(`[storage-diagnostics] ${diagnostics.warnings.length} compatibility warning(s):`);
    for (const warning of diagnostics.warnings) {
      console.warn(`[storage-diagnostics] - ${warning}`);
    }
  } catch (error: any) {
    console.warn("[storage-diagnostics] failed:", error?.message || error);
  }
}
