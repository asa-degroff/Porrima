import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { closeChatDb, getChatDbPath, getDb as getChatDb, backupChatDb, getSettings } from "./chat-storage.js";
import { closeMemoryDb, getDb as getMemoryDb, getMemoryDbPath } from "./memory-storage.js";
import { closeCorpusDb, getCorpusDb, getCorpusDbPath } from "./image-corpus.js";
import { resetAllMemoryContextCaches } from "./memory-context.js";
import { appDataPath } from "./paths.js";

const SNAPSHOTS_DIR = appDataPath("snapshots");
const SYSTEM_SNAPSHOT_MAX_COUNT = 10;
const SYSTEM_SNAPSHOT_MAX_AGE_DAYS = 30;
const COUNT_TABLES = new Set([
  "chats",
  "chat_message_rows",
  "context_archives",
  "memories",
  "memory_blocks",
  "corpus_entries",
]);

export interface AgentSnapshotManifest {
  id: string;
  kind: "agent-snapshot";
  schemaVersion: 1;
  createdAt: string;
  label?: string;
  createdBy?: "user" | "system";
  reason?: "manual" | "pre-restore";
  protected?: boolean;
  includes: {
    app: true;
    memories: true;
    corpus: boolean;
  };
  embedding: {
    provider: string;
    url: string;
    model: string;
    dimension?: number;
  };
  counts: {
    chats: number;
    chatMessageRows: number;
    contextArchives: number;
    memories: number;
    memoryBlocks: number;
    corpus?: number;
  };
  sourceSizes: {
    appBytes: number;
    memoriesBytes: number;
    corpusBytes?: number;
  };
}

export interface CreateAgentSnapshotOptions {
  label?: string;
  includeCorpus?: boolean;
  createdBy?: "user" | "system";
  reason?: "manual" | "pre-restore";
  protected?: boolean;
}

let operationQueue: Promise<void> = Promise.resolve();

async function withSnapshotOperation<T>(fn: () => Promise<T>): Promise<T> {
  const previous = operationQueue;
  let release: () => void;
  operationQueue = previous.then(
    () => new Promise<void>((resolve) => {
      release = resolve;
    })
  );

  await previous;
  try {
    return await fn();
  } finally {
    release!();
  }
}

async function ensureSnapshotsDir(): Promise<void> {
  if (!existsSync(SNAPSHOTS_DIR)) {
    await mkdir(SNAPSHOTS_DIR, { recursive: true });
  }
}

function formatId(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export async function listAgentSnapshots(): Promise<AgentSnapshotManifest[]> {
  await ensureSnapshotsDir();
  const entries = await readdir(SNAPSHOTS_DIR, { withFileTypes: true });
  const manifests: AgentSnapshotManifest[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(SNAPSHOTS_DIR, entry.name, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    try {
      manifests.push(JSON.parse(await readFile(manifestPath, "utf-8")) as AgentSnapshotManifest);
    } catch {
      // Ignore corrupt or partial snapshot directories.
    }
  }

  manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return manifests;
}

export async function createAgentSnapshot(
  options: CreateAgentSnapshotOptions = {}
): Promise<AgentSnapshotManifest> {
  return withSnapshotOperation(() => createAgentSnapshotUnlocked(options));
}

async function createAgentSnapshotUnlocked(
  options: CreateAgentSnapshotOptions = {}
): Promise<AgentSnapshotManifest> {
  await ensureSnapshotsDir();
  const id = await nextAvailableId();
  const dir = join(SNAPSHOTS_DIR, id);
  await mkdir(dir, { recursive: true });

  const appDest = join(dir, "app.db");
  const memoriesDest = join(dir, "memories.db");
  const corpusDest = join(dir, "corpus.db");

  await backupChatDb(appDest);
  await getMemoryDb().backup(memoriesDest);
  if (options.includeCorpus) {
    await getCorpusDb().backup(corpusDest);
  }

  const settings = await getSettings();
  const counts = countRows(options.includeCorpus === true);
  const [appBytes, memoriesBytes, corpusBytes] = await Promise.all([
    fileSize(appDest),
    fileSize(memoriesDest),
    options.includeCorpus ? fileSize(corpusDest) : Promise.resolve(undefined),
  ]);

  const manifest: AgentSnapshotManifest = {
    id,
    kind: "agent-snapshot",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    label: options.label,
    createdBy: options.createdBy ?? "user",
    reason: options.reason ?? "manual",
    protected: options.protected === true,
    includes: {
      app: true,
      memories: true,
      corpus: options.includeCorpus === true,
    },
    embedding: {
      provider: settings.embeddingProvider ?? "llamacpp",
      url: settings.embeddingUrl ?? "",
      model: settings.embeddingModel ?? "qwen3-embedding:0.6b",
      dimension: settings.embeddingDimension,
    },
    counts,
    sourceSizes: {
      appBytes,
      memoriesBytes,
      ...(corpusBytes !== undefined ? { corpusBytes } : {}),
    },
  };

  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  return manifest;
}

export async function deleteAgentSnapshot(id: string): Promise<void> {
  return withSnapshotOperation(async () => {
    const dir = snapshotDir(id);
    await rm(dir, { recursive: true, force: true });
  });
}

export async function restoreAgentSnapshot(
  id: string
): Promise<{ restored: AgentSnapshotManifest; preRestoreSnapshot: AgentSnapshotManifest }> {
  return withSnapshotOperation(() => restoreAgentSnapshotUnlocked(id));
}

async function restoreAgentSnapshotUnlocked(
  id: string
): Promise<{ restored: AgentSnapshotManifest; preRestoreSnapshot: AgentSnapshotManifest }> {
  const dir = snapshotDir(id);
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error("Snapshot manifest missing");
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as AgentSnapshotManifest;
  if (manifest.kind !== "agent-snapshot") {
    throw new Error("Snapshot has unsupported manifest kind");
  }

  const appSrc = join(dir, "app.db");
  const memoriesSrc = join(dir, "memories.db");
  const corpusSrc = join(dir, "corpus.db");
  if (!existsSync(appSrc) || !existsSync(memoriesSrc)) {
    throw new Error("Snapshot is missing required database files");
  }

  validateSqliteDb(appSrc, false);
  validateSqliteDb(memoriesSrc, true);
  if (manifest.includes.corpus && existsSync(corpusSrc)) {
    validateSqliteDb(corpusSrc, true);
  }

  const preRestoreSnapshot = await createAgentSnapshotUnlocked({
    label: `pre-restore ${id}`,
    includeCorpus: manifest.includes.corpus,
    createdBy: "system",
    reason: "pre-restore",
  });
  await pruneSystemSnapshots(new Set([id, preRestoreSnapshot.id]));
  const rollbackSources = getSnapshotSources(preRestoreSnapshot);

  try {
    checkpointActiveDbs(manifest.includes.corpus);
    closeChatDb();
    closeMemoryDb();
    if (manifest.includes.corpus) {
      closeCorpusDb();
    }

    await replaceSqliteFile(appSrc, getChatDbPath());
    await replaceSqliteFile(memoriesSrc, getMemoryDbPath());
    if (manifest.includes.corpus && existsSync(corpusSrc)) {
      await replaceSqliteFile(corpusSrc, getCorpusDbPath());
    }

    reopenRestoredDbs(manifest.includes.corpus);
  } catch (restoreError: any) {
    try {
      closeChatDb();
      closeMemoryDb();
      if (manifest.includes.corpus) {
        closeCorpusDb();
      }
      await replaceSqliteFile(rollbackSources.app, getChatDbPath());
      await replaceSqliteFile(rollbackSources.memories, getMemoryDbPath());
      if (manifest.includes.corpus && rollbackSources.corpus && existsSync(rollbackSources.corpus)) {
        await replaceSqliteFile(rollbackSources.corpus, getCorpusDbPath());
      }
      reopenRestoredDbs(manifest.includes.corpus);
    } catch (rollbackError: any) {
      throw new Error(
        `Restore failed and rollback also failed. Restore error: ${restoreError?.message || restoreError}. Rollback error: ${rollbackError?.message || rollbackError}`
      );
    }
    throw new Error(
      `Restore failed while reopening databases. Rolled back to pre-restore snapshot ${preRestoreSnapshot.id}. ${restoreError?.message || restoreError}`
    );
  }

  resetAllMemoryContextCaches();

  return { restored: manifest, preRestoreSnapshot };
}

function countRows(includeCorpus: boolean): AgentSnapshotManifest["counts"] {
  const appDb = getChatDb();
  const memoryDb = getMemoryDb();

  const counts: AgentSnapshotManifest["counts"] = {
    chats: countTable(appDb, "chats"),
    chatMessageRows: countTable(appDb, "chat_message_rows"),
    contextArchives: countTable(appDb, "context_archives"),
    memories: countTable(memoryDb, "memories"),
    memoryBlocks: countTable(memoryDb, "memory_blocks"),
  };

  if (includeCorpus) {
    counts.corpus = countTable(getCorpusDb(), "corpus_entries");
  }

  return counts;
}

function countTable(db: Database.Database, table: string): number {
  if (!COUNT_TABLES.has(table)) {
    throw new Error(`Unsupported count table: ${table}`);
  }
  try {
    return (db.prepare(`SELECT COUNT(*) c FROM "${table}"`).get() as { c: number }).c;
  } catch {
    return 0;
  }
}

async function pruneSystemSnapshots(protectedIds: Set<string>): Promise<void> {
  const snapshots = await listAgentSnapshots();
  const now = Date.now();
  const maxAgeMs = SYSTEM_SNAPSHOT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const systemSnapshots = snapshots
    .filter((snapshot) => isSystemManagedSnapshot(snapshot))
    .filter((snapshot) => !snapshot.protected)
    .filter((snapshot) => !protectedIds.has(snapshot.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const toDelete = new Set<string>();
  for (let i = 0; i < systemSnapshots.length; i++) {
    const snapshot = systemSnapshots[i];
    const createdMs = Date.parse(snapshot.createdAt);
    const isExpired = Number.isFinite(createdMs) && now - createdMs > maxAgeMs;
    const exceedsCount = i >= SYSTEM_SNAPSHOT_MAX_COUNT;
    if (isExpired || exceedsCount) {
      toDelete.add(snapshot.id);
    }
  }

  for (const snapshotId of toDelete) {
    try {
      await rm(snapshotDir(snapshotId), { recursive: true, force: true });
    } catch (e) {
      console.warn(`[snapshots] Failed to prune system snapshot ${snapshotId}:`, e);
    }
  }
}

function isSystemManagedSnapshot(snapshot: AgentSnapshotManifest): boolean {
  if (snapshot.createdBy === "system") return true;
  // Legacy auto-created rollback snapshots existed before createdBy/reason metadata.
  return snapshot.label?.startsWith("pre-restore ") === true;
}

async function nextAvailableId(): Promise<string> {
  let id = formatId(new Date());
  let suffix = 2;
  while (existsSync(join(SNAPSHOTS_DIR, id))) {
    id = `${formatId(new Date())}-${suffix}`;
    suffix++;
  }
  return id;
}

function snapshotDir(id: string): string {
  if (!isSafeSnapshotId(id)) {
    throw new Error(`Invalid snapshot id: ${id}`);
  }
  const dir = join(SNAPSHOTS_DIR, id);
  if (!existsSync(dir)) {
    throw new Error(`Snapshot not found: ${id}`);
  }
  return dir;
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function replaceSqliteFile(sourcePath: string, destinationPath: string): Promise<void> {
  const tmpPath = `${destinationPath}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(destinationPath), { recursive: true });
  await copyFile(sourcePath, tmpPath);
  await rm(`${destinationPath}-wal`, { force: true });
  await rm(`${destinationPath}-shm`, { force: true });
  try {
    await rename(tmpPath, destinationPath);
  } catch (e) {
    await rm(tmpPath, { force: true });
    throw e;
  }
}

function getSnapshotSources(manifest: AgentSnapshotManifest): {
  app: string;
  memories: string;
  corpus?: string;
} {
  const dir = snapshotDir(manifest.id);
  return {
    app: join(dir, "app.db"),
    memories: join(dir, "memories.db"),
    ...(manifest.includes.corpus ? { corpus: join(dir, "corpus.db") } : {}),
  };
}

function checkpointActiveDbs(includeCorpus: boolean): void {
  try {
    getChatDb().pragma("wal_checkpoint(TRUNCATE)");
  } catch (e) {
    console.warn("[snapshots] app wal_checkpoint failed:", e);
  }
  try {
    getMemoryDb().pragma("wal_checkpoint(TRUNCATE)");
  } catch (e) {
    console.warn("[snapshots] memory wal_checkpoint failed:", e);
  }
  if (includeCorpus) {
    try {
      getCorpusDb().pragma("wal_checkpoint(TRUNCATE)");
    } catch (e) {
      console.warn("[snapshots] corpus wal_checkpoint failed:", e);
    }
  }
}

function reopenRestoredDbs(includeCorpus: boolean): void {
  getChatDb();
  getMemoryDb();
  if (includeCorpus) {
    getCorpusDb();
  }
}

function validateSqliteDb(path: string, loadVec: boolean): void {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    if (loadVec) {
      sqliteVec.load(db);
    }
    const result = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    const status = result[0]?.integrity_check;
    if (status !== "ok") {
      throw new Error(`SQLite integrity check failed for ${path}: ${status || "unknown error"}`);
    }
  } finally {
    db.close();
  }
}

function isSafeSnapshotId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}
