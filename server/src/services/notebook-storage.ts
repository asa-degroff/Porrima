import { readFile, writeFile, readdir, unlink, mkdir, access } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { NotebookEntry, NotebookIndex } from "../types.js";

const BASE_DIR = join(homedir(), ".quje-agent");
const NOTEBOOKS_DIR = join(BASE_DIR, "notebooks");
const USER_ENTRIES_DIR = join(NOTEBOOKS_DIR, "user", "entries");
const AGENT_ENTRIES_DIR = join(NOTEBOOKS_DIR, "agent", "entries");

async function ensureDirs() {
  await mkdir(USER_ENTRIES_DIR, { recursive: true });
  await mkdir(AGENT_ENTRIES_DIR, { recursive: true });
}

function entryPath(author: 'user' | 'agent', id: string): string {
  const dir = author === 'user' ? USER_ENTRIES_DIR : AGENT_ENTRIES_DIR;
  return join(dir, `${id}.json`);
}

function indexPath(author: 'user' | 'agent'): string {
  const dir = author === 'user' ? USER_ENTRIES_DIR : AGENT_ENTRIES_DIR;
  return join(dir, "index.json");
}

async function loadIndex(author: 'user' | 'agent'): Promise<NotebookIndex> {
  try {
    const data = await readFile(indexPath(author), "utf-8");
    return JSON.parse(data) as NotebookIndex;
  } catch {
    return { entries: [], lastActivityDate: null };
  }
}

async function saveIndex(author: 'user' | 'agent', index: NotebookIndex): Promise<void> {
  await ensureDirs();
  await writeFile(indexPath(author), JSON.stringify(index, null, 2));
}

export async function listNotebookEntries(author: 'user' | 'agent'): Promise<NotebookIndex> {
  await ensureDirs();
  return await loadIndex(author);
}

export async function getNotebookEntry(author: 'user' | 'agent', id: string): Promise<NotebookEntry | null> {
  try {
    const data = await readFile(entryPath(author, id), "utf-8");
    return JSON.parse(data) as NotebookEntry;
  } catch {
    return null;
  }
}

export async function createNotebookEntry(author: 'user' | 'agent', content: string): Promise<NotebookEntry> {
  await ensureDirs();
  
  const entry: NotebookEntry = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    author,
    content,
  };
  
  await writeFile(entryPath(author, entry.id), JSON.stringify(entry, null, 2));
  
  // Update index
  const index = await loadIndex(author);
  index.entries.unshift({
    id: entry.id,
    createdAt: entry.createdAt,
    author,
    preview: content.slice(0, 100),
  });
  index.lastActivityDate = new Date().toISOString();
  await saveIndex(author, index);
  
  return entry;
}

export async function updateNotebookEntry(
  author: 'user' | 'agent',
  id: string,
  updates: Partial<NotebookEntry>
): Promise<NotebookEntry | null> {
  const entry = await getNotebookEntry(author, id);
  if (!entry) return null;
  
  // Strip protected fields - only allow content and links to be updated
  const safeUpdates: Partial<NotebookEntry> = {};
  if (updates.content !== undefined) safeUpdates.content = updates.content;
  if (updates.links !== undefined) safeUpdates.links = updates.links;
  
  Object.assign(entry, safeUpdates);
  await writeFile(entryPath(author, entry.id), JSON.stringify(entry, null, 2));
  
  // Update index preview if content changed
  if (safeUpdates.content !== undefined) {
    const index = await loadIndex(author);
    const idxEntry = index.entries.find(e => e.id === id);
    if (idxEntry) {
      idxEntry.preview = safeUpdates.content.slice(0, 100);
    }
    await saveIndex(author, index);
  }
  
  return entry;
}

export async function deleteNotebookEntry(author: 'user' | 'agent', id: string): Promise<boolean> {
  try {
    await unlink(entryPath(author, id));
    
    // Update index
    const index = await loadIndex(author);
    index.entries = index.entries.filter(e => e.id !== id);
    
    // Update lastActivityDate if we deleted the most recent entry
    if (index.entries.length > 0) {
      const sorted = [...index.entries].sort((a, b) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      index.lastActivityDate = sorted[0].createdAt;
    } else {
      index.lastActivityDate = null;
    }
    
    await saveIndex(author, index);
    return true;
  } catch {
    return false;
  }
}

export async function hasUserActivityToday(): Promise<boolean> {
  const index = await loadIndex('user');
  if (!index.lastActivityDate) return false;
  
  const today = new Date().toDateString();
  const lastActivity = new Date(index.lastActivityDate).toDateString();
  return today === lastActivity;
}

export async function getUserEntriesToday(): Promise<NotebookEntry[]> {
  const index = await loadIndex('user');
  const today = new Date().toDateString();
  
  const entries: NotebookEntry[] = [];
  for (const entryInfo of index.entries) {
    if (new Date(entryInfo.createdAt).toDateString() === today) {
      const entry = await getNotebookEntry('user', entryInfo.id);
      if (entry) entries.push(entry);
    }
  }
  
  return entries;
}
