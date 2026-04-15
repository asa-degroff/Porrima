/**
 * Embedding migration: backup/restore databases and re-embed stored content
 * after changing the embedding model or provider.
 *
 * Storage layout:
 *   ~/.quje-agent/backups/<id>/
 *     manifest.json
 *     memories.db
 *     corpus.db
 *
 * Migration rebuilds vec_memories and vec_corpus at whatever dimension the
 * currently-configured embedding model produces, then re-embeds every stored
 * memory text and corpus prompt.
 */

import { copyFile, mkdir, readdir, readFile, stat, writeFile, rm } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
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

const BACKUPS_DIR = join(homedir(), ".quje-agent", "backups");
const EMBED_BATCH_SIZE = 16;

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
      provider: settings.embeddingProvider ?? "ollama",
      url: settings.embeddingUrl ?? "",
      model: settings.embeddingModel ?? "qwen3-embedding:0.6b",
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
    embeddingProvider: (manifest.embedding.provider as "ollama" | "llamacpp") || "ollama",
    embeddingUrl: manifest.embedding.url || undefined,
    embeddingModel: manifest.embedding.model || undefined,
    embeddingDimension: manifest.embedding.dimension,
  });
}

export async function migrate(
  onProgress: (p: MigrationProgress) => void
): Promise<{ memories: number; corpus: number; dimension: number }> {
  const cfg = await getEmbeddingConfig();

  onProgress({ phase: "probe", message: `Probing ${cfg.provider} ${cfg.model}` });
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
      onProgress({ phase: "memories", processed, total: memRows.length })
  );

  // Gather corpus entries that have prompt text
  const corpusDb = getCorpusDb();
  const corpusRows = corpusDb
    .prepare(
      "SELECT id, prompt FROM corpus_entries WHERE prompt IS NOT NULL AND prompt != ''"
    )
    .all() as Array<{ id: string; prompt: string }>;

  const corpusVectors = await embedInBatches(
    cfg,
    corpusRows.map((r) => r.prompt),
    (processed) =>
      onProgress({ phase: "corpus", processed, total: corpusRows.length })
  );

  onProgress({ phase: "commit", message: "Rebuilding vector tables" });

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

  // Record the new dimension in user settings so the UI can warn if config
  // drifts without a migration.
  const settings = await getSettings();
  await saveSettings({ ...settings, embeddingDimension: dimension });

  onProgress({ phase: "done", message: `Re-embedded ${memRows.length} memories + ${corpusRows.length} corpus entries at dim ${dimension}` });
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
