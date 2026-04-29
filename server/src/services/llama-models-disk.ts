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
}

const DEFAULT_MODELS_DIR = path.join(os.homedir(), ".local", "share", "llama-models");

function getModelsDir(): string {
  return process.env.LLAMA_MODELS_DIR?.trim() || DEFAULT_MODELS_DIR;
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
 * Scan the configured llama-models directory for available GGUFs. Each
 * top-level subdirectory containing a .gguf is treated as a single model;
 * mmproj-*.gguf siblings are detected but never returned as standalone entries.
 */
export async function listLocalModels(): Promise<DiskLlamaModel[]> {
  const dir = getModelsDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const results: DiskLlamaModel[] = [];
  for (const entry of entries) {
    const subdir = path.join(dir, entry);
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
    });
  }

  results.sort((a, b) => a.id.localeCompare(b.id));
  return results;
}

export async function findLocalModel(id: string): Promise<DiskLlamaModel | null> {
  const all = await listLocalModels();
  return all.find((m) => m.id === id) ?? null;
}

export function getLlamaModelsDir(): string {
  return getModelsDir();
}
