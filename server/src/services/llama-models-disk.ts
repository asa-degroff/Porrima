import { promises as fs } from "fs";
import path from "path";
import os from "os";

export type LlamaModelKind = "chat" | "embedding" | "rerank";

export interface DiskLlamaModel {
  id: string;          // Directory name; matches inference router /v1/models id
  name: string;        // Display name (same as id)
  ggufPath: string;    // Absolute path to the primary .gguf file
  sizeBytes: number;   // Size of the primary .gguf file
  hasMmproj: boolean;  // Vision projector sibling present
  kind: LlamaModelKind;
  scanDir: string;     // Absolute path of the scan directory this model was found in
}

const DEFAULT_MODELS_DIR = path.join(os.homedir(), ".local", "share", "llama-models");

/**
 * Resolve the list of directories to scan for GGUF models.
 *
 * Priority:
 *  1. Explicit `llamaModelsDirs` array (from Settings)
 *  2. `LLAMA_MODELS_DIR` environment variable (single directory)
 *  3. Default: ~/.local/share/llama-models
 */
export function resolveModelsDirs(explicit?: string[]): string[] {
  if (Array.isArray(explicit) && explicit.length > 0) {
    const dirs = explicit.map((d) => d.trim()).filter(Boolean);
    if (dirs.length > 0) return [...new Set(dirs)];
  }
  const env = process.env.LLAMA_MODELS_DIR?.trim();
  if (env) return [env];
  return [DEFAULT_MODELS_DIR];
}

/**
 * @deprecated Use resolveModelsDirs() instead. Kept for backward compatibility
 * with callers that only need the first (primary) directory.
 */
export function getLlamaModelsDir(): string {
  return resolveModelsDirs()[0];
}

function classifyKind(idLower: string): LlamaModelKind {
  if (/rerank|cross-encoder/.test(idLower)) return "rerank";
  if (/embed|bge|e5|nomic|mxbai|jina|gte/.test(idLower)) return "embedding";
  return "chat";
}

// Pick the primary GGUF in a model directory, ignoring vision projectors and
// multi-part shard suffixes. Prefers a file whose basename matches the dir.
function pickPrimaryGguf(dirName: string, files: string[]): string | null {
  const ggufs = files.filter((f) => f.toLowerCase().endsWith(".gguf") && !/^mmproj/i.test(f));
  if (ggufs.length === 0) return null;
  const exact = ggufs.find((f) => f === `${dirName}.gguf`);
  if (exact) return exact;
  // Prefer a file that contains the dir name and isn't a shard part.
  const nonShard = ggufs.filter((f) => !/-of-\d+\.gguf$/i.test(f) || /-00001-of-\d+\.gguf$/i.test(f));
  if (nonShard.length > 0) return nonShard[0];
  return ggufs[0];
}

/**
 * Scan a single directory for GGUF models. Each top-level subdirectory
 * containing a .gguf file is treated as one model; mmproj siblings are
 * detected but never returned as standalone entries.
 * Exported for use by the scan-paths preview endpoint.
 */
export async function scanDirectory(scanDir: string, options: { requireReadable?: boolean } = {}): Promise<DiskLlamaModel[]> {
  let entries: string[];
  try {
    const stat = await fs.stat(scanDir);
    if (!stat.isDirectory()) throw new Error("Path is not a directory");
    entries = await fs.readdir(scanDir);
  } catch (e: any) {
    if (options.requireReadable) {
      throw new Error(e?.message || "Directory not found or not readable");
    }
    return [];
  }

  const results: DiskLlamaModel[] = [];
  for (const entry of entries) {
    const subdir = path.join(scanDir, entry);
    let stat;
    try {
      stat = await fs.stat(subdir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    let files: string[];
    try {
      files = await fs.readdir(subdir);
    } catch {
      continue;
    }

    const primary = pickPrimaryGguf(entry, files);
    if (!primary) continue;
    const ggufPath = path.join(subdir, primary);
    const hasMmproj = files.some((f) => /^mmproj.*\.gguf$/i.test(f));

    let sizeBytes = 0;
    try {
      const ggufStat = await fs.stat(ggufPath);
      sizeBytes = ggufStat.size;
    } catch {}

    results.push({
      id: entry,
      name: entry,
      ggufPath,
      sizeBytes,
      hasMmproj,
      kind: classifyKind(entry.toLowerCase()),
      scanDir,
    });
  }

  return results;
}

/**
 * Scan all configured llama-models directories for available GGUFs.
 *
 * When the same model ID (directory name) appears in multiple scan
 * directories, both entries are included. The caller can disambiguate
 * using the `scanDir` field or display the directory alongside the model
 * name.
 */
export async function listLocalModels(explicitDirs?: string[]): Promise<DiskLlamaModel[]> {
  const dirs = resolveModelsDirs(explicitDirs);
  const all: DiskLlamaModel[] = [];

  for (const dir of dirs) {
    const models = await scanDirectory(dir);
    all.push(...models);
  }

  // Sort by id, then by scanDir for determinism when the same id appears
  // in multiple directories.
  all.sort((a, b) => {
    const idCmp = a.id.localeCompare(b.id);
    if (idCmp !== 0) return idCmp;
    return a.scanDir.localeCompare(b.scanDir);
  });
  return all;
}

export async function findLocalModel(id: string, explicitDirs?: string[], scanDir?: string): Promise<DiskLlamaModel | null> {
  const all = await listLocalModels(explicitDirs);
  if (scanDir) {
    const exact = all.find((m) => m.id === id && m.scanDir === scanDir);
    if (exact) return exact;
  }
  return all.find((m) => m.id === id) ?? null;
}
