import { readFile, writeFile, readdir, unlink, mkdir, rename } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { NotebookEntry, NotebookIndex, NotebookLink } from "../types.js";
import {
  createMemoryBlock,
  updateMemoryBlock,
  getMemoryBlock,
  deleteMemoryBlock,
  listMemoryBlocks,
  type MemoryBlock,
  type BlockAttachments,
} from "./memory-storage.js";

const BASE_DIR = join(homedir(), ".quje-agent");
const NOTEBOOKS_DIR = join(BASE_DIR, "notebooks");
const USER_ENTRIES_DIR = join(NOTEBOOKS_DIR, "user", "entries");
const AGENT_ENTRIES_DIR = join(NOTEBOOKS_DIR, "agent", "entries");
const AGENT_BACKUP_DIR = join(AGENT_ENTRIES_DIR, ".backup");

// Synthetic chatId used by the synthesis follow-up tool loop. Also used by
// memory-tools.ts to route create_memory_block calls through the notebook
// naming convention so follow-up blocks get the same system-block exclusion
// as blocks created via createNotebookBlock.
export const NOTEBOOK_CYCLE_CHAT_ID = "synthesis-followup";

/** Generate a notebook-prefixed block ID matching createNotebookBlock's format. */
export function generateNotebookBlockId(type: 'synthesis' | 'notebook' = 'notebook', date?: string): string {
  const blockDate = (date || new Date().toISOString().split('T')[0]).replace(/-/g, "");
  const prefix = type === 'synthesis' ? 'blk-synth' : 'blk-notebook';
  return `${prefix}-${blockDate}-${crypto.randomUUID().slice(0, 8)}`;
}

async function ensureDirs() {
  await mkdir(USER_ENTRIES_DIR, { recursive: true });
  await mkdir(AGENT_ENTRIES_DIR, { recursive: true });
}

function userEntryPath(id: string): string {
  return join(USER_ENTRIES_DIR, `${id}.json`);
}

function userIndexPath(): string {
  return join(USER_ENTRIES_DIR, "index.json");
}

// ---------------------------------------------------------------------------
// User notebook entries — filesystem-backed. User-generated content is kept
// separate from agent memory (memory_blocks); see step-plan in commit history
// for the rationale. May get its own SQLite store later; for now, JSON files.
// ---------------------------------------------------------------------------

async function loadUserIndex(): Promise<NotebookIndex> {
  try {
    const data = await readFile(userIndexPath(), "utf-8");
    return JSON.parse(data) as NotebookIndex;
  } catch {
    return { entries: [], lastActivityDate: null };
  }
}

async function saveUserIndex(index: NotebookIndex): Promise<void> {
  await ensureDirs();
  await writeFile(userIndexPath(), JSON.stringify(index, null, 2));
}

async function getUserNotebookEntry(id: string): Promise<NotebookEntry | null> {
  try {
    const data = await readFile(userEntryPath(id), "utf-8");
    return JSON.parse(data) as NotebookEntry;
  } catch {
    return null;
  }
}

async function createUserNotebookEntry(content: string): Promise<NotebookEntry> {
  await ensureDirs();
  const entry: NotebookEntry = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    author: 'user',
    content,
  };
  await writeFile(userEntryPath(entry.id), JSON.stringify(entry, null, 2));
  const index = await loadUserIndex();
  index.entries.unshift({
    id: entry.id,
    createdAt: entry.createdAt,
    author: 'user',
    preview: content.slice(0, 100),
  });
  index.lastActivityDate = new Date().toISOString();
  await saveUserIndex(index);
  return entry;
}

async function updateUserNotebookEntry(id: string, updates: Partial<NotebookEntry>): Promise<NotebookEntry | null> {
  const entry = await getUserNotebookEntry(id);
  if (!entry) return null;
  const safe: Partial<NotebookEntry> = {};
  if (updates.content !== undefined) safe.content = updates.content;
  if (updates.links !== undefined) safe.links = updates.links;
  if (updates.images !== undefined) safe.images = updates.images;
  if (updates.toolCalls !== undefined) safe.toolCalls = updates.toolCalls;
  if (updates.toolResults !== undefined) safe.toolResults = updates.toolResults;
  if (updates.artifacts !== undefined) safe.artifacts = updates.artifacts;
  if (updates.visuals !== undefined) safe.visuals = updates.visuals;
  Object.assign(entry, safe);
  await writeFile(userEntryPath(entry.id), JSON.stringify(entry, null, 2));
  if (safe.content !== undefined) {
    const index = await loadUserIndex();
    const idxEntry = index.entries.find(e => e.id === id);
    if (idxEntry) idxEntry.preview = safe.content.slice(0, 100);
    await saveUserIndex(index);
  }
  return entry;
}

async function deleteUserNotebookEntry(id: string): Promise<boolean> {
  try {
    await unlink(userEntryPath(id));
    const index = await loadUserIndex();
    index.entries = index.entries.filter(e => e.id !== id);
    if (index.entries.length > 0) {
      const sorted = [...index.entries].sort((a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      index.lastActivityDate = sorted[0].createdAt;
    } else {
      index.lastActivityDate = null;
    }
    await saveUserIndex(index);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Agent notebook entries — memory-block-backed. Each entry is a
// MemoryBlock row with blockType in ('notebook', 'synthesis'), attachments
// captured in the block's attachments column. The block id IS the entry id.
// ---------------------------------------------------------------------------

function blockToNotebookEntry(block: MemoryBlock): NotebookEntry {
  const att = block.attachments ?? {};
  // `links` is stored as an array in BlockAttachments for extensibility, but
  // NotebookEntry.links is a single NotebookLink shape. We pick the first if
  // multiple are stored.
  const link = Array.isArray(att.links) && att.links.length > 0 ? (att.links[0] as NotebookLink) : undefined;
  return {
    id: block.id,
    createdAt: block.createdAt,
    author: 'agent',
    content: block.content,
    links: link,
    images: att.images as any,
    toolCalls: att.toolCalls as any,
    toolResults: att.toolResults as any,
    artifacts: att.artifacts as any,
    visuals: att.visuals as any,
  };
}

function notebookEntryAttachments(entry: Partial<NotebookEntry>): BlockAttachments | undefined {
  const att: BlockAttachments = {};
  let has = false;
  if (entry.images?.length) { att.images = entry.images as any; has = true; }
  if (entry.toolCalls?.length) { att.toolCalls = entry.toolCalls as any; has = true; }
  if (entry.toolResults?.length) { att.toolResults = entry.toolResults as any; has = true; }
  if (entry.artifacts?.length) { att.artifacts = entry.artifacts as any; has = true; }
  if (entry.visuals?.length) { att.visuals = entry.visuals as any; has = true; }
  if (entry.links) { att.links = [entry.links as any]; has = true; }
  return has ? att : undefined;
}

function listAgentNotebookEntries(): NotebookIndex {
  // notebook + synthesis blocks, newest first. listMemoryBlocks already orders
  // by updatedAt DESC and excludes superseded rows.
  const blocks = listMemoryBlocks({ includeInternal: true }).filter(
    (b) => b.blockType === "notebook" || b.blockType === "synthesis"
  );
  const entries = blocks.map((b) => ({
    id: b.id,
    createdAt: b.createdAt,
    author: 'agent' as const,
    preview: b.description || b.content.slice(0, 100),
  }));
  return {
    entries,
    lastActivityDate: entries[0]?.createdAt ?? null,
  };
}

function getAgentNotebookEntry(id: string): NotebookEntry | null {
  const block = getMemoryBlock(id);
  if (!block) return null;
  if (block.blockType !== "notebook" && block.blockType !== "synthesis") return null;
  return blockToNotebookEntry(block);
}

function createAgentNotebookEntry(content: string, opts?: {
  type?: 'synthesis' | 'notebook';
  date?: string;
  attachments?: BlockAttachments;
}): NotebookEntry {
  const type = opts?.type ?? 'notebook';
  const blockDate = opts?.date || new Date().toISOString().split('T')[0];
  const id = generateNotebookBlockId(type, blockDate);
  const description = extractBlockDescription(content);
  const prefix = type === 'synthesis' ? 'Synthesis' : 'Notebook';
  const now = new Date().toISOString();

  const block = createMemoryBlock({
    id,
    name: `${prefix} - ${blockDate}: ${description.slice(0, 50)}`,
    description,
    content,
    scope: 'global',
    projectId: '',
    createdAt: now,
    updatedAt: now,
    updatedBy: 'agent',
    blockType: type,
    attachments: opts?.attachments,
  });
  return blockToNotebookEntry(block);
}

function updateAgentNotebookEntry(id: string, updates: Partial<NotebookEntry>): NotebookEntry | null {
  const existing = getMemoryBlock(id);
  if (!existing) return null;
  if (existing.blockType !== "notebook" && existing.blockType !== "synthesis") return null;

  // Merge attachments: start from existing, overlay any fields present in updates.
  const mergedAtt: BlockAttachments = { ...(existing.attachments ?? {}) };
  const incoming = notebookEntryAttachments(updates);
  if (incoming) Object.assign(mergedAtt, incoming);
  const hasMergedAtt = Object.keys(mergedAtt).length > 0;

  const ok = updateMemoryBlock(id, {
    content: updates.content,
    attachments: hasMergedAtt ? mergedAtt : null,
  });
  if (!ok) return null;
  return getAgentNotebookEntry(id);
}

function deleteAgentNotebookEntry(id: string): boolean {
  const block = getMemoryBlock(id);
  if (!block) return false;
  if (block.blockType !== "notebook" && block.blockType !== "synthesis") return false;
  return deleteMemoryBlock(id);
}

// ---------------------------------------------------------------------------
// Public API — dispatches by author. User = filesystem, agent = memory blocks.
// Callers outside this module should never need to know which backend is in
// use; shape comes back as NotebookEntry / NotebookIndex either way.
// ---------------------------------------------------------------------------

export async function listNotebookEntries(author: 'user' | 'agent'): Promise<NotebookIndex> {
  if (author === 'user') {
    await ensureDirs();
    return await loadUserIndex();
  }
  return listAgentNotebookEntries();
}

export async function getNotebookEntry(author: 'user' | 'agent', id: string): Promise<NotebookEntry | null> {
  if (author === 'user') return await getUserNotebookEntry(id);
  return getAgentNotebookEntry(id);
}

export async function createNotebookEntry(
  author: 'user' | 'agent',
  content: string,
  opts?: { type?: 'synthesis' | 'notebook'; date?: string; attachments?: BlockAttachments },
): Promise<NotebookEntry> {
  if (author === 'user') return await createUserNotebookEntry(content);
  return createAgentNotebookEntry(content, opts);
}

export async function updateNotebookEntry(
  author: 'user' | 'agent',
  id: string,
  updates: Partial<NotebookEntry>
): Promise<NotebookEntry | null> {
  if (author === 'user') return await updateUserNotebookEntry(id, updates);
  return updateAgentNotebookEntry(id, updates);
}

export async function deleteNotebookEntry(author: 'user' | 'agent', id: string): Promise<boolean> {
  if (author === 'user') return await deleteUserNotebookEntry(id);
  return deleteAgentNotebookEntry(id);
}

export async function hasUserActivityToday(): Promise<boolean> {
  const index = await loadUserIndex();
  if (!index.lastActivityDate) return false;
  const today = new Date().toDateString();
  const lastActivity = new Date(index.lastActivityDate).toDateString();
  return today === lastActivity;
}

export async function getUserEntriesToday(): Promise<NotebookEntry[]> {
  const index = await loadUserIndex();
  const today = new Date().toDateString();
  const entries: NotebookEntry[] = [];
  for (const entryInfo of index.entries) {
    if (new Date(entryInfo.createdAt).toDateString() === today) {
      const entry = await getUserNotebookEntry(entryInfo.id);
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

/**
 * Extract a brief description from notebook content for use as a memory block description.
 * Strips leading markdown headers and takes the first ~150 characters.
 */
export function extractBlockDescription(content: string): string {
  // Strip leading markdown headers (e.g., "# Daily Synthesis - 2026-04-15")
  const stripped = content.replace(/^#+\s+.*\n?/, '').trim();
  // Take first ~150 chars, collapse whitespace
  const excerpt = stripped.slice(0, 150).replace(/\n+/g, ' ').trim();
  return excerpt.length < stripped.length ? excerpt + '...' : excerpt;
}

/**
 * Create a memory block from notebook content for searchability.
 * Retained for backward compatibility with callers that want a block-only
 * write (no NotebookEntry return value). Prefer createNotebookEntry('agent',
 * ...) for new callers — it writes the same block and gives you the entry
 * shape back.
 */
export function createNotebookBlock(
  content: string,
  type: 'synthesis' | 'notebook',
  date?: string
): string {
  const entry = createAgentNotebookEntry(content, { type, date });
  return entry.id;
}

// ---------------------------------------------------------------------------
// One-shot migration: move existing filesystem agent notebook JSON entries
// into memory_blocks. Idempotent — runs at startup, no-ops if there's
// nothing left in AGENT_ENTRIES_DIR. Migrated JSON files go to a .backup/
// subfolder so the migration is reversible if something goes wrong.
// ---------------------------------------------------------------------------

export async function migrateAgentNotebookToBlocks(): Promise<{
  migrated: number;
  skipped: number;
  failed: number;
}> {
  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  try {
    await mkdir(AGENT_ENTRIES_DIR, { recursive: true });
  } catch {
    // dir doesn't exist, nothing to do
    return { migrated, skipped, failed };
  }

  let files: string[];
  try {
    files = await readdir(AGENT_ENTRIES_DIR);
  } catch {
    return { migrated, skipped, failed };
  }

  const entryFiles = files.filter((f) => f.endsWith(".json") && f !== "index.json");
  if (entryFiles.length === 0) {
    return { migrated, skipped, failed };
  }

  await mkdir(AGENT_BACKUP_DIR, { recursive: true });

  for (const filename of entryFiles) {
    const entryId = filename.slice(0, -5); // strip .json
    try {
      const raw = await readFile(join(AGENT_ENTRIES_DIR, filename), "utf-8");
      const entry = JSON.parse(raw) as NotebookEntry;

      if (!entry?.content) {
        // Malformed — move to backup anyway, log, and continue
        await rename(join(AGENT_ENTRIES_DIR, filename), join(AGENT_BACKUP_DIR, filename));
        failed++;
        continue;
      }

      // Choose a stable block id that won't collide with future generateNotebookBlockId
      // outputs. Using a fixed prefix + the original entry UUID guarantees:
      //   (a) idempotency — re-running finds an existing block and skips
      //   (b) reversibility — you can locate the originating JSON from the id
      const blockId = `blk-notebook-migrated-${entryId}`;
      const existing = getMemoryBlock(blockId);
      if (existing) {
        // Already migrated on a prior run; move JSON to backup and continue.
        await rename(join(AGENT_ENTRIES_DIR, filename), join(AGENT_BACKUP_DIR, filename));
        skipped++;
        continue;
      }

      // Heuristic: synthesis entries tend to start with "# Daily Synthesis" or
      // similar; anything else treat as a plain notebook. Type is mostly
      // cosmetic since both flavors are excluded from auto-load identically.
      const looksLikeSynthesis = /^#+\s*(daily\s+)?synthesis\b/i.test(entry.content);
      const blockType = looksLikeSynthesis ? 'synthesis' : 'notebook';

      const description = extractBlockDescription(entry.content);
      const prefix = blockType === 'synthesis' ? 'Synthesis' : 'Notebook';
      const blockDate = entry.createdAt.split("T")[0];

      const attachments = notebookEntryAttachments(entry);

      createMemoryBlock({
        id: blockId,
        name: `${prefix} - ${blockDate}: ${description.slice(0, 50)}`,
        description,
        content: entry.content,
        scope: "global",
        projectId: "",
        createdAt: entry.createdAt,
        updatedAt: entry.createdAt,
        updatedBy: "agent",
        blockType,
        attachments,
      });

      await rename(join(AGENT_ENTRIES_DIR, filename), join(AGENT_BACKUP_DIR, filename));
      migrated++;
    } catch (e: any) {
      console.error(`[notebook] Migration failed for ${filename}:`, e?.message || e);
      failed++;
    }
  }

  // Also move the old index.json aside — it's stale once entries are blocks.
  try {
    const indexSrc = join(AGENT_ENTRIES_DIR, "index.json");
    await rename(indexSrc, join(AGENT_BACKUP_DIR, "index.json"));
  } catch {
    // index didn't exist or already moved; not a problem
  }

  if (migrated > 0 || failed > 0) {
    console.log(
      `[notebook] Agent notebook migration complete: ${migrated} migrated, ${skipped} already migrated, ${failed} failed. ` +
      `Originals preserved in ${AGENT_BACKUP_DIR}`,
    );
  }

  return { migrated, skipped, failed };
}
