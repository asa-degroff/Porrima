import { mkdir, readdir, rm, stat, unlink } from "fs/promises";
import { join } from "path";
import { appDataPath } from "./paths.js";

// ---------------------------------------------------------------------------
// Shared tool-output spill store — one policy for bash capture and kernel cell
// output (see docs/design/pi-1.0-migration.md §4).
//
// Layout:
//   ~/.porrima/tool-output/<chatId>/bash-<id>.log
//   ~/.porrima/tool-output/<chatId>/py-<id>.txt
//
// Remote SSH keeps the in-workspace `.porrima-tool-output/` convention because
// `read_file` resolves against the remote workspace root; this store is the
// local/server-side half only.
//
// Retention: newest 64 files per chat, 24 h TTL, removed with the chat. Each
// file also stops at a per-file byte cap (writers honor it) so a runaway
// producer cannot fill the disk; file-count/TTL rules do not bound bytes.
// ---------------------------------------------------------------------------

export const DEFAULT_SPILL_MAX_BYTES = 64 * 1024 * 1024;
export const SPILL_RETENTION_COUNT = 64;
export const SPILL_TTL_MS = 24 * 60 * 60 * 1000;

export type SpillTool = "bash" | "py";

const TOOL_EXTENSIONS: Record<SpillTool, string> = { bash: ".log", py: ".txt" };

/** Root override exists for tests; production always uses the data dir. */
export function toolOutputRoot(): string {
  return process.env.PORRIMA_TOOL_OUTPUT_DIR || appDataPath("tool-output");
}

export function toolOutputDir(chatId: string): string {
  return join(toolOutputRoot(), chatId);
}

/** Stable per-call path. The id must be a short per-call uuid, never derived
 *  from command content — two identical commands in one chat must not collide. */
export function createSpillPath(chatId: string, tool: SpillTool, id: string): string {
  return join(toolOutputDir(chatId), `${tool}-${id}${TOOL_EXTENSIONS[tool]}`);
}

export async function ensureToolOutputDir(chatId: string): Promise<string> {
  const dir = toolOutputDir(chatId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Footer appended to a truncated tool result. The path is result text, so this
 * format is replay-visible and must stay byte-stable; it preserves the
 * pre-migration bash wording for the uncapped case.
 */
export function formatSpillFooter(info: {
  path: string;
  totalBytes: number;
  windowBytes: number;
  capped?: boolean;
  capBytes?: number;
}): string {
  const windowKb = Math.round(info.windowBytes / 1024);
  const totalKb = Math.round(info.totalBytes / 1024);
  const lead = info.capped
    ? `[Output exceeded ${windowKb}KB. The spill was capped at ${formatMib(info.capBytes)}; the captured output was saved to: ${info.path}`
    : `[Output exceeded ${windowKb}KB. The full output (${totalKb}KB) was saved to: ${info.path}`;
  return `\n\n${lead}\nUse read_file(path="${info.path}", offset=N) to read more. The tail is shown above.]`;
}

function formatMib(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "the configured cap";
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

async function listFiles(dir: string): Promise<Array<{ path: string; mtimeMs: number }>> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files: Array<{ path: string; mtimeMs: number }> = [];
  for (const name of names) {
    const filePath = join(dir, name);
    try {
      const info = await stat(filePath);
      if (info.isFile()) files.push({ path: filePath, mtimeMs: info.mtimeMs });
    } catch {
      // Vanished mid-scan; nothing to retain.
    }
  }
  return files;
}

/** Keep only the newest `keep` files in one chat's spill directory. */
export async function pruneChat(chatId: string, keep = SPILL_RETENTION_COUNT): Promise<number> {
  return pruneDir(toolOutputDir(chatId), keep);
}

async function pruneDir(dir: string, keep: number): Promise<number> {
  const files = await listFiles(dir);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let removed = 0;
  for (const file of files.slice(keep)) {
    try {
      await unlink(file.path);
      removed++;
    } catch {
      // Already gone or unreadable; leave it for the next sweep.
    }
  }
  return removed;
}

/** Remove everything for a deleted chat (cascade from chat-deletion.ts). */
export async function cleanupChat(chatId: string): Promise<void> {
  await rm(toolOutputDir(chatId), { recursive: true, force: true });
}

/**
 * TTL sweep across all chats: drop expired files, enforce per-chat count, and
 * remove now-empty chat directories. Returns the number of files removed.
 */
export async function sweepExpired(nowMs = Date.now(), ttlMs = SPILL_TTL_MS): Promise<number> {
  const root = toolOutputRoot();
  let chatDirs: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    chatDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
  } catch {
    return 0;
  }

  let removed = 0;
  for (const dir of chatDirs) {
    const files = await listFiles(dir);
    for (const file of files) {
      if (nowMs - file.mtimeMs > ttlMs) {
        try {
          await unlink(file.path);
          removed++;
        } catch {
          // Best effort.
        }
      }
    }
    removed += await pruneDir(dir, SPILL_RETENTION_COUNT);
    try {
      const remaining = await readdir(dir);
      if (remaining.length === 0) await rm(dir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
  return removed;
}
