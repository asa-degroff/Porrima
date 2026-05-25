import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { APP_DATA_DIR } from "./paths.js";
import { CHAT_ROWS_ARE_AUTHORITATIVE, getDb as getChatDb } from "./chat-storage.js";
import { getDb as getMemoryDb } from "./memory-storage.js";

export interface StorageMigrationDiagnostics {
  generatedAt: string;
  appDataDir: string;
  chatStorage: {
    chatCount: number;
    jsonMessageCount: number;
    totalJsonMessageBytes: number;
    staleJsonSnapshots: {
      count: number;
      totalSizeBytes: number;
      maxMessageDelta: number;
      largest: Array<{
        id: string;
        title: string;
        type: string;
        jsonMessageCount: number;
        rowMessageCount: number;
        messageDelta: number;
        sizeBytes: number;
      }>;
    };
    largestJsonSnapshots: Array<{
      id: string;
      title: string;
      type: string;
      messageCount: number;
      sizeBytes: number;
      rowMessageCount: number;
    }>;
    rowMessageCount: number;
    rowChatCount: number;
    rowsAuthoritative: boolean;
    mismatchCount: number;
    maxMismatch: number;
    corruptRowPayloads: number;
    rowGapChatCount: number;
    totalRowPayloadBytes: number;
    largestRowPayloads: Array<{
      chatId: string;
      title: string;
      type: string;
      sequence: number;
      role: string;
      timestamp: number | null;
      sizeBytes: number;
      toolResultCount: number;
    }>;
    largestToolResultRows: Array<{
      chatId: string;
      title: string;
      type: string;
      sequence: number;
      timestamp: number | null;
      payloadSizeBytes: number;
      toolResultCount: number;
      toolResultContentBytes: number;
      toolNames: string;
    }>;
    legacyCollapsedToolRows: number;
    canonicalToolLoopRows: number;
    canonicalToolLoopFragments: number;
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
    totalJsonMessageBytes: readScalar(chatDb, "SELECT COALESCE(SUM(length(messages)), 0) AS value FROM chats"),
    staleJsonSnapshots: {
      count: 0,
      totalSizeBytes: 0,
      maxMessageDelta: 0,
      largest: [] as StorageMigrationDiagnostics["chatStorage"]["staleJsonSnapshots"]["largest"],
    },
    largestJsonSnapshots: chatDb.prepare(`
      SELECT
        c.id,
        c.title,
        c.type,
        json_array_length(c.messages) AS messageCount,
        length(c.messages) AS sizeBytes,
        COALESCE(r.rowMessageCount, 0) AS rowMessageCount
      FROM chats c
      LEFT JOIN (
        SELECT chat_id, COUNT(*) AS rowMessageCount
        FROM chat_message_rows
        GROUP BY chat_id
      ) r ON r.chat_id = c.id
      ORDER BY sizeBytes DESC
      LIMIT 10
    `).all() as StorageMigrationDiagnostics["chatStorage"]["largestJsonSnapshots"],
    rowMessageCount: readScalar(chatDb, "SELECT COUNT(*) AS value FROM chat_message_rows"),
    rowChatCount: readScalar(chatDb, "SELECT COUNT(DISTINCT chat_id) AS value FROM chat_message_rows"),
    rowsAuthoritative: CHAT_ROWS_ARE_AUTHORITATIVE,
    mismatchCount: 0,
    maxMismatch: 0,
    corruptRowPayloads: readScalar(chatDb, "SELECT COUNT(*) AS value FROM chat_message_rows WHERE NOT json_valid(payload_json)"),
    rowGapChatCount: readScalar(chatDb, `
      SELECT COUNT(*) AS value
      FROM (
        SELECT chat_id
        FROM chat_message_rows
        GROUP BY chat_id
        HAVING MIN(sequence) != 0 OR MAX(sequence) != COUNT(*) - 1
      )
    `),
    totalRowPayloadBytes: readScalar(chatDb, "SELECT COALESCE(SUM(length(payload_json)), 0) AS value FROM chat_message_rows"),
    largestRowPayloads: chatDb.prepare(`
      SELECT
        r.chat_id AS chatId,
        c.title,
        c.type,
        r.sequence,
        r.role,
        r.timestamp,
        length(r.payload_json) AS sizeBytes,
        CASE
          WHEN json_type(r.payload_json, '$.toolResults') = 'array'
          THEN json_array_length(r.payload_json, '$.toolResults')
          ELSE 0
        END AS toolResultCount
      FROM chat_message_rows r
      JOIN chats c ON c.id = r.chat_id
      WHERE json_valid(r.payload_json)
      ORDER BY sizeBytes DESC
      LIMIT 10
    `).all() as StorageMigrationDiagnostics["chatStorage"]["largestRowPayloads"],
    largestToolResultRows: chatDb.prepare(`
      SELECT
        r.chat_id AS chatId,
        r.title,
        r.type,
        r.sequence,
        r.timestamp,
        length(r.payload_json) AS payloadSizeBytes,
        COUNT(tr.key) AS toolResultCount,
        COALESCE(SUM(length(COALESCE(json_extract(tr.value, '$.content'), ''))), 0) AS toolResultContentBytes,
        GROUP_CONCAT(DISTINCT COALESCE(json_extract(tr.value, '$.toolName'), 'unknown')) AS toolNames
      FROM (
        SELECT
          rows.chat_id,
          c.title,
          c.type,
          rows.sequence,
          rows.timestamp,
          rows.payload_json
        FROM chat_message_rows rows
        JOIN chats c ON c.id = rows.chat_id
        WHERE json_valid(rows.payload_json)
          AND json_type(rows.payload_json, '$.toolResults') = 'array'
      ) r
      JOIN json_each(r.payload_json, '$.toolResults') tr
      GROUP BY r.chat_id, r.title, r.type, r.sequence, r.timestamp, r.payload_json
      ORDER BY toolResultContentBytes DESC
      LIMIT 10
    `).all() as StorageMigrationDiagnostics["chatStorage"]["largestToolResultRows"],
    legacyCollapsedToolRows: readScalar(chatDb, `
      SELECT COUNT(*) AS value
      FROM chat_message_rows
      WHERE role = 'assistant'
        AND json_valid(payload_json)
        AND json_type(payload_json, '$.toolCalls') = 'array'
        AND json_array_length(payload_json, '$.toolCalls') > 0
        AND COALESCE(json_extract(payload_json, '$._toolLoopFragment'), 0) != 1
    `),
    canonicalToolLoopRows: readScalar(chatDb, `
      SELECT COUNT(*) AS value
      FROM chat_message_rows
      WHERE role = 'assistant'
        AND json_valid(payload_json)
        AND json_extract(payload_json, '$._toolLoopId') IS NOT NULL
    `),
    canonicalToolLoopFragments: readScalar(chatDb, `
      SELECT COUNT(*) AS value
      FROM chat_message_rows
      WHERE role = 'assistant'
        AND json_valid(payload_json)
        AND json_extract(payload_json, '$._toolLoopFragment') = 1
    `),
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

  const staleSnapshotSummary = chatDb.prepare(`
    WITH j AS (
      SELECT id, title, type, json_array_length(messages) AS jsonMessageCount, length(messages) AS sizeBytes
      FROM chats
    ), r AS (
      SELECT chat_id AS id, COUNT(*) AS rowMessageCount
      FROM chat_message_rows
      GROUP BY chat_id
    ), stale AS (
      SELECT
        j.id,
        j.title,
        j.type,
        COALESCE(j.jsonMessageCount, 0) AS jsonMessageCount,
        COALESCE(r.rowMessageCount, 0) AS rowMessageCount,
        ABS(COALESCE(j.jsonMessageCount, 0) - COALESCE(r.rowMessageCount, 0)) AS messageDelta,
        COALESCE(j.sizeBytes, 0) AS sizeBytes
      FROM j LEFT JOIN r USING(id)
      WHERE COALESCE(j.jsonMessageCount, 0) != COALESCE(r.rowMessageCount, 0)
    )
    SELECT
      COUNT(*) AS count,
      COALESCE(SUM(sizeBytes), 0) AS totalSizeBytes,
      COALESCE(MAX(messageDelta), 0) AS maxMessageDelta
    FROM stale
  `).get() as { count: number; totalSizeBytes: number; maxMessageDelta: number };
  chatStorage.staleJsonSnapshots.count = staleSnapshotSummary.count;
  chatStorage.staleJsonSnapshots.totalSizeBytes = staleSnapshotSummary.totalSizeBytes;
  chatStorage.staleJsonSnapshots.maxMessageDelta = staleSnapshotSummary.maxMessageDelta;
  chatStorage.staleJsonSnapshots.largest = chatDb.prepare(`
    WITH j AS (
      SELECT id, title, type, json_array_length(messages) AS jsonMessageCount, length(messages) AS sizeBytes
      FROM chats
    ), r AS (
      SELECT chat_id AS id, COUNT(*) AS rowMessageCount
      FROM chat_message_rows
      GROUP BY chat_id
    )
    SELECT
      j.id,
      j.title,
      j.type,
      COALESCE(j.jsonMessageCount, 0) AS jsonMessageCount,
      COALESCE(r.rowMessageCount, 0) AS rowMessageCount,
      ABS(COALESCE(j.jsonMessageCount, 0) - COALESCE(r.rowMessageCount, 0)) AS messageDelta,
      COALESCE(j.sizeBytes, 0) AS sizeBytes
    FROM j LEFT JOIN r USING(id)
    WHERE COALESCE(j.jsonMessageCount, 0) != COALESCE(r.rowMessageCount, 0)
    ORDER BY sizeBytes DESC
    LIMIT 10
  `).all() as StorageMigrationDiagnostics["chatStorage"]["staleJsonSnapshots"]["largest"];

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
  if (chatStorage.mismatchCount > 0 && !chatStorage.rowsAuthoritative) {
    warnings.push(`chat JSON snapshot and row store differ for ${chatStorage.mismatchCount} chat(s); max difference ${chatStorage.maxMismatch} message(s)`);
  }
  if (chatStorage.corruptRowPayloads > 0) {
    warnings.push(`chat_message_rows contains ${chatStorage.corruptRowPayloads} invalid JSON payload(s)`);
  }
  if (chatStorage.rowGapChatCount > 0) {
    warnings.push(`chat_message_rows has non-dense sequence numbers for ${chatStorage.rowGapChatCount} chat(s)`);
  }
  if (chatStorage.legacyCollapsedToolRows > 0) {
    warnings.push(`chat replay still depends on ${chatStorage.legacyCollapsedToolRows} legacy collapsed assistant tool row(s)`);
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
