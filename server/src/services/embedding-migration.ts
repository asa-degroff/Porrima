/**
 * Embedding migration: backup/restore databases and re-embed stored content
 * after changing the embedding model or provider.
 *
 * Storage layout:
 *   ~/.porrima/backups/<id>/
 *     manifest.json
 *     memories.db
 *     corpus.db
 *
 * Migration rebuilds vec_memories and vec_corpus at whatever dimension the
 * currently-configured embedding model produces, then re-embeds every stored
 * memory text and corpus prompt/description.
 */

import { copyFile, mkdir, readdir, readFile, stat, writeFile, rm } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import {
  getDb as getMemoryDb,
  closeMemoryDb,
  getMemoryDbPath,
  rebuildVecMemoriesTable,
} from "./memory-storage.js";
import {
  getCorpusDb,
  closeCorpusDb,
  getCorpusDbPath,
  rebuildCorpusVecTable,
} from "./image-corpus.js";
import {
  embedBatchWithConfig,
  getEmbeddingConfig,
  type EmbeddingConfig,
} from "./embeddings.js";
import { getSettings, saveSettings } from "./chat-storage.js";
import { appDataPath } from "./paths.js";

const BACKUPS_DIR = appDataPath("backups");
const EMBED_BATCH_SIZE = 16;

// Persistent migration progress — survives client reconnects.
// Stored as JSON file so a new process can pick it up, plus in-memory for speed.
const MIGRATION_PROGRESS_FILE = join(BACKUPS_DIR, "migration-progress.json");

interface MigrationProgressState {
  startedAt: string;
  progress: MigrationProgress;
}

let inMemoryProgress: MigrationProgressState | null = null;

async function persistProgress(state: MigrationProgressState | null): Promise<void> {
  try {
    inMemoryProgress = state;
    if (state) {
      await writeFile(MIGRATION_PROGRESS_FILE, JSON.stringify(state), "utf-8");
    } else {
      if (existsSync(MIGRATION_PROGRESS_FILE)) {
        await rm(MIGRATION_PROGRESS_FILE, { force: true });
      }
    }
  } catch (e) {
    console.warn("[migration] persistProgress failed:", e);
  }
}

export async function getMigrationProgress(): Promise<MigrationProgressState | null> {
  // Return in-memory if available
  if (inMemoryProgress) return inMemoryProgress;
  // Otherwise load from disk
  try {
    if (existsSync(MIGRATION_PROGRESS_FILE)) {
      const raw = await readFile(MIGRATION_PROGRESS_FILE, "utf-8");
      const state = JSON.parse(raw) as MigrationProgressState;
      inMemoryProgress = state;
      return state;
    }
  } catch (e) {
    console.warn("[migration] getMigrationProgress load failed:", e);
  }
  return null;
}

export async function clearMigrationProgress(): Promise<void> {
  await persistProgress(null);
}

export async function persistMigrationError(message: string): Promise<void> {
  const state = inMemoryProgress || { startedAt: new Date().toISOString(), progress: { phase: "error" as const } };
  await persistProgress({
    ...state,
    progress: { ...state.progress, phase: "error", message },
  });
}

export interface BackupManifest {
  id: string;
  createdAt: string;
  label?: string;
  embedding: {
    provider: string;
    url: string;
    model: string;
    dimension?: number;
  };
  counts: {
    memories: number;
    corpus: number;
  };
  sourceSizes: {
    memoriesBytes: number;
    corpusBytes: number;
  };
}

export interface MigrationProgress {
  phase: "probe" | "memories" | "corpus" | "commit" | "done" | "error";
  processed?: number;
  total?: number;
  message?: string;
}

async function ensureBackupsDir(): Promise<void> {
  if (!existsSync(BACKUPS_DIR)) {
    await mkdir(BACKUPS_DIR, { recursive: true });
  }
}

function formatId(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export async function listBackups(): Promise<BackupManifest[]> {
  await ensureBackupsDir();
  const entries = await readdir(BACKUPS_DIR, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  const manifests: BackupManifest[] = [];
  for (const id of dirs) {
    const manifestPath = join(BACKUPS_DIR, id, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const raw = await readFile(manifestPath, "utf-8");
      manifests.push(JSON.parse(raw) as BackupManifest);
    } catch {
      // skip corrupt manifests
    }
  }
  manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return manifests;
}

export async function createBackup(label?: string): Promise<BackupManifest> {
  await ensureBackupsDir();
  const id = formatId(new Date());
  const dir = join(BACKUPS_DIR, id);
  await mkdir(dir, { recursive: true });

  const memoryPath = getMemoryDbPath();
  const corpusPath = getCorpusDbPath();

  // Checkpoint WAL before copy so the snapshot is self-contained.
  try {
    getMemoryDb().pragma("wal_checkpoint(TRUNCATE)");
  } catch (e) {
    console.warn("[migration] memory wal_checkpoint failed:", e);
  }
  try {
    getCorpusDb().pragma("wal_checkpoint(TRUNCATE)");
  } catch (e) {
    console.warn("[migration] corpus wal_checkpoint failed:", e);
  }

  const destMemory = join(dir, "memories.db");
  const destCorpus = join(dir, "corpus.db");
  if (existsSync(memoryPath)) await copyFile(memoryPath, destMemory);
  if (existsSync(corpusPath)) await copyFile(corpusPath, destCorpus);

  const [memoryCount, corpusCount] = countRows();
  const [memSize, corpSize] = await Promise.all([
    fileSize(destMemory),
    fileSize(destCorpus),
  ]);

  const settings = await getSettings();
  const manifest: BackupManifest = {
    id,
    createdAt: new Date().toISOString(),
    label,
    embedding: {
      provider: settings.embeddingProvider ?? "llamacpp",
      url: settings.embeddingUrl ?? "",
      model: settings.embeddedByModel ?? settings.embeddingModel ?? "qwen3-embedding:0.6b",
      dimension: settings.embeddingDimension,
    },
    counts: { memories: memoryCount, corpus: corpusCount },
    sourceSizes: { memoriesBytes: memSize, corpusBytes: corpSize },
  };

  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  return manifest;
}

export async function deleteBackup(id: string): Promise<void> {
  const dir = join(BACKUPS_DIR, id);
  if (!isSafeBackupId(id) || !existsSync(dir)) {
    throw new Error(`Backup not found: ${id}`);
  }
  await rm(dir, { recursive: true, force: true });
}

export async function restoreBackup(id: string): Promise<void> {
  const dir = join(BACKUPS_DIR, id);
  if (!isSafeBackupId(id) || !existsSync(dir)) {
    throw new Error(`Backup not found: ${id}`);
  }
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error("Backup manifest missing");
  const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as BackupManifest;

  const srcMemory = join(dir, "memories.db");
  const srcCorpus = join(dir, "corpus.db");

  closeMemoryDb();
  closeCorpusDb();

  if (existsSync(srcMemory)) await copyFile(srcMemory, getMemoryDbPath());
  if (existsSync(srcCorpus)) await copyFile(srcCorpus, getCorpusDbPath());

  // Reopen by touching getDb (via a trivial call)
  getMemoryDb();
  getCorpusDb();

  // Restore the embedding settings recorded at backup time so subsequent
  // reads/writes use the same model that produced the restored vectors.
  const settings = await getSettings();
  await saveSettings({
    ...settings,
    embeddingProvider: (manifest.embedding.provider === "llamacpp" ? "llamacpp" : "llamacpp") as "llamacpp",
    embeddingUrl: manifest.embedding.url || undefined,
    embeddingModel: manifest.embedding.model || undefined,
    embeddingDimension: manifest.embedding.dimension,
    embeddedByModel: manifest.embedding.model || undefined,
  });
}

export async function migrate(
  onProgress: (p: MigrationProgress) => void
): Promise<{ memories: number; corpus: number; dimension: number }> {
  const cfg = await getEmbeddingConfig();

  const startedAt = new Date().toISOString();

  const wrapProgress = (p: MigrationProgress) => {
    persistProgress({ startedAt, progress: p });
    onProgress(p);
  };

  wrapProgress({ phase: "probe", message: `Probing ${cfg.model}` });
  const probe = await embedBatchWithConfig(cfg, ["migration probe"]);
  if (!probe.length || !probe[0].length) {
    throw new Error("Embedding probe returned no vector");
  }
  const dimension = probe[0].length;

  // Gather all memory texts (preserving id)
  const memoryDb = getMemoryDb();
  const memRows = memoryDb
    .prepare("SELECT id, text FROM memories")
    .all() as Array<{ id: string; text: string }>;

  const memoryVectors = await embedInBatches(
    cfg,
    memRows.map((r) => r.text),
    (processed) =>
      wrapProgress({ phase: "memories", processed, total: memRows.length })
  );

  // Gather corpus entries that have prompt text, falling back to descriptions
  // for analyzed/uploaded images.
  const corpusDb = getCorpusDb();
  const corpusRows = corpusDb
    .prepare(
      `SELECT id, COALESCE(NULLIF(prompt, ''), NULLIF(description, '')) AS text
       FROM corpus_entries
       WHERE (prompt IS NOT NULL AND prompt != '') OR description != ''`
    )
    .all() as Array<{ id: string; text: string }>;

  const corpusVectors = await embedInBatches(
    cfg,
    corpusRows.map((r) => r.text),
    (processed) =>
      wrapProgress({ phase: "corpus", processed, total: corpusRows.length })
  );

  wrapProgress({ phase: "commit", message: "Rebuilding vector tables" });

  rebuildVecMemoriesTable(dimension);
  rebuildCorpusVecTable(dimension);

  const insertMemVec = memoryDb.prepare(
    "INSERT INTO vec_memories (id, embedding) VALUES (?, ?)"
  );
  const insertMem = memoryDb.transaction(() => {
    for (let i = 0; i < memRows.length; i++) {
      insertMemVec.run(memRows[i].id, new Float32Array(memoryVectors[i]));
    }
  });
  insertMem();

  const insertCorpusVec = corpusDb.prepare(
    "INSERT INTO vec_corpus (id, embedding) VALUES (?, ?)"
  );
  const insertCorpus = corpusDb.transaction(() => {
    for (let i = 0; i < corpusRows.length; i++) {
      insertCorpusVec.run(corpusRows[i].id, new Float32Array(corpusVectors[i]));
    }
  });
  insertCorpus();

  // Record the new dimension and source model in user settings so the UI can
  // warn if config drifts without a migration, and so createBackup() records
  // the correct model name for the vectors that actually live in the DB.
  const settings = await getSettings();
  await saveSettings({
    ...settings,
    embeddingDimension: dimension,
    embeddedByModel: cfg.model,
  });

  const doneMsg = `Re-embedded ${memRows.length} memories + ${corpusRows.length} corpus entries at dim ${dimension}`;
  wrapProgress({ phase: "done", message: doneMsg });

  // Clear persisted progress on success so a fresh open shows clean state.
  await persistProgress(null);

  return { memories: memRows.length, corpus: corpusRows.length, dimension };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function embedInBatches(
  cfg: EmbeddingConfig,
  texts: string[],
  onProgress: (processed: number) => void
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const chunk = texts.slice(i, i + EMBED_BATCH_SIZE);
    const vectors = await embedBatchWithConfig(cfg, chunk);
    out.push(...vectors);
    onProgress(out.length);
  }
  return out;
}

function countRows(): [number, number] {
  let memoryCount = 0;
  let corpusCount = 0;
  try {
    memoryCount = (getMemoryDb().prepare("SELECT COUNT(*) c FROM memories").get() as { c: number }).c;
  } catch {
    // ignore
  }
  try {
    corpusCount = (getCorpusDb().prepare("SELECT COUNT(*) c FROM corpus_entries").get() as { c: number }).c;
  } catch {
    // ignore
  }
  return [memoryCount, corpusCount];
}

async function fileSize(path: string): Promise<number> {
  try {
    const s = await stat(path);
    return s.size;
  } catch {
    return 0;
  }
}

function isSafeBackupId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}
