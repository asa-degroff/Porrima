import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { closeChatDb, getChatDbPath, getDb as getChatDb, backupChatDb, getSettings } from "./chat-storage.js";
import { closeMemoryDb, getDb as getMemoryDb, getMemoryDbPath } from "./memory-storage.js";
import { closeCorpusDb, getCorpusDb, getCorpusDbPath } from "./image-corpus.js";
import { resetAllMemoryContextCaches } from "./memory-context.js";

const SNAPSHOTS_DIR = join(homedir(), ".quje-agent", "snapshots");

export interface AgentSnapshotManifest {
  id: string;
  kind: "agent-snapshot";
  schemaVersion: 1;
  createdAt: string;
  label?: string;
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
}

let restoreInProgress = false;

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
  if (restoreInProgress) {
    throw new Error("Cannot create a snapshot while restore is in progress");
  }

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
    includes: {
      app: true,
      memories: true,
      corpus: options.includeCorpus === true,
    },
    embedding: {
      provider: settings.embeddingProvider ?? "ollama",
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
  if (restoreInProgress) {
    throw new Error("Cannot delete a snapshot while restore is in progress");
  }
  const dir = snapshotDir(id);
  await rm(dir, { recursive: true, force: true });
}

export async function restoreAgentSnapshot(
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

  const preRestoreSnapshot = await createAgentSnapshot({
    label: `pre-restore ${id}`,
    includeCorpus: manifest.includes.corpus,
  });

  restoreInProgress = true;
  try {
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

    getChatDb();
    getMemoryDb();
    if (manifest.includes.corpus) {
      getCorpusDb();
    }
    resetAllMemoryContextCaches();
  } finally {
    restoreInProgress = false;
  }

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
  try {
    return (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
  } catch {
    return 0;
  }
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
  await mkdir(dirname(destinationPath), { recursive: true });
  await rm(`${destinationPath}-wal`, { force: true });
  await rm(`${destinationPath}-shm`, { force: true });
  await copyFile(sourcePath, destinationPath);
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
