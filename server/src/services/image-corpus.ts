import { v4 as uuid } from "uuid";
import { mkdir, writeFile, readFile, readdir, access, rm } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { homedir } from "os";

const CORPUS_DIR = join(homedir(), ".quje-agent", "image-corpus");
const CORPUS_FILE = join(CORPUS_DIR, "corpus.json");
const OLLAMA_BASE = process.env.OLLAMA_URL || "http://localhost:11434";

export interface ImageCorpusEntry {
  id: string;
  type: "generated" | "analyzed" | "uploaded";
  imagePath: string;           // Relative path to image file
  thumbnailPath?: string;      // Relative path to thumbnail
  prompt?: string;             // Generation prompt (for generated images)
  description: string;         // VLM analysis description
  elements: Record<string, string[]>;  // Dynamic element types (themes, characters, etc.)
  promptEmbedding?: number[];  // For similarity clustering
  createdAt: number;           // Timestamp
  updatedAt: number;           // Last modification
  chatId?: string;             // Associated chat (if any)
  projectId?: string;          // Associated project (if any)
  generationId?: string;       // Link to generation record (for generated images)
  visionId?: string;           // Link to vision analysis record (for analyzed images)
}

export interface CorpusStats {
  totalCount: number;
  byType: { generated: number; analyzed: number; uploaded: number };
  withEmbeddings: number;
  withElements: number;
  dateRange: { earliest: number; latest: number };
}

// In-memory cache
let corpusCache: Map<string, ImageCorpusEntry> | null = null;

async function ensureCorpusDir() {
  if (!existsSync(CORPUS_DIR)) {
    await mkdir(CORPUS_DIR, { recursive: true });
  }
}

async function loadCorpusFromDisk(): Promise<Map<string, ImageCorpusEntry>> {
  const cache = new Map<string, ImageCorpusEntry>();
  
  try {
    await ensureCorpusDir();
    if (existsSync(CORPUS_FILE)) {
      const data = await readFile(CORPUS_FILE, "utf-8");
      const entries: ImageCorpusEntry[] = JSON.parse(data);
      for (const entry of entries) {
        cache.set(entry.id, entry);
      }
      console.log(`[image-corpus] loaded ${cache.size} entries from disk`);
    }
  } catch (err) {
    console.error("[image-corpus] failed to load corpus:", err);
  }
  
  return cache;
}

async function persistCorpus(): Promise<void> {
  if (!corpusCache) return;
  
  try {
    await ensureCorpusDir();
    const entries = Array.from(corpusCache.values());
    await writeFile(CORPUS_FILE, JSON.stringify(entries, null, 2));
  } catch (err) {
    console.error("[image-corpus] failed to persist corpus:", err);
  }
}

// Debounced persist
let persistTimeout: ReturnType<typeof setTimeout> | null = null;
function schedulePersist() {
  if (persistTimeout) clearTimeout(persistTimeout);
  persistTimeout = setTimeout(() => persistCorpus(), 500);
}

export async function getCorpus(): Promise<Map<string, ImageCorpusEntry>> {
  if (corpusCache === null) {
    corpusCache = await loadCorpusFromDisk();
  }
  return corpusCache;
}

export async function getCorpusEntry(id: string): Promise<ImageCorpusEntry | undefined> {
  const corpus = await getCorpus();
  return corpus.get(id);
}

export async function getAllCorpusEntries(): Promise<ImageCorpusEntry[]> {
  const corpus = await getCorpus();
  return Array.from(corpus.values()).sort((a, b) => b.createdAt - a.createdAt);
}

export async function addCorpusEntry(entry: ImageCorpusEntry): Promise<ImageCorpusEntry> {
  const corpus = await getCorpus();
  corpus.set(entry.id, entry);
  schedulePersist();
  return entry;
}

export async function updateCorpusEntry(
  id: string,
  updates: Partial<ImageCorpusEntry>
): Promise<ImageCorpusEntry | undefined> {
  const corpus = await getCorpus();
  const existing = corpus.get(id);
  if (!existing) return undefined;
  
  const updated = { ...existing, ...updates, updatedAt: Date.now() };
  corpus.set(id, updated);
  schedulePersist();
  return updated;
}

export async function deleteCorpusEntry(id: string): Promise<boolean> {
  const corpus = await getCorpus();
  const deleted = corpus.delete(id);
  if (deleted) schedulePersist();
  return deleted;
}

export async function getCorpusStats(): Promise<CorpusStats> {
  const corpus = await getCorpus();
  const entries = Array.from(corpus.values());
  
  const byType = {
    generated: entries.filter(e => e.type === "generated").length,
    analyzed: entries.filter(e => e.type === "analyzed").length,
    uploaded: entries.filter(e => e.type === "uploaded").length,
  };
  
  const withEmbeddings = entries.filter(e => e.promptEmbedding).length;
  const withElements = entries.filter(e => Object.keys(e.elements).length > 0).length;
  
  const timestamps = entries.map(e => e.createdAt).sort((a, b) => a - b);
  
  return {
    totalCount: entries.length,
    byType,
    withEmbeddings,
    withElements,
    dateRange: {
      earliest: timestamps[0] || 0,
      latest: timestamps[timestamps.length - 1] || 0,
    },
  };
}

export async function embedPrompt(prompt: string): Promise<number[]> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.EMBEDDING_MODEL || "qwen3-embedding:0.6b",  // Same as memory system
        input: prompt,
      }),
    });
    
    if (!res.ok) {
      throw new Error(`Embedding failed: ${res.status}`);
    }
    
    const data = await res.json();
    const embeddings = data.embeddings || [];
    return embeddings[0] || [];
  } catch (err) {
    console.error("[image-corpus] embedding error:", err);
    return [];
  }
}

export async function enrichCorpusEntry(
  id: string,
  prompt?: string,
  description?: string
): Promise<ImageCorpusEntry | undefined> {
  const entry = await getCorpusEntry(id);
  if (!entry) return undefined;
  
  const updates: Partial<ImageCorpusEntry> = {};
  
  // Embed prompt if available
  if (prompt && (!entry.promptEmbedding || entry.promptEmbedding.length === 0)) {
    const embedding = await embedPrompt(prompt);
    if (embedding.length > 0) {
      updates.promptEmbedding = embedding;
    }
  }
  
  // Extract elements from description or prompt
  if (description && Object.keys(entry.elements).length === 0) {
    const { extractElements } = await import("./element-extraction.js");
    const elements = await extractElements(description, prompt);
    if (Object.keys(elements).length > 0) {
      updates.elements = elements;
    }
  } else if (prompt && Object.keys(entry.elements).length === 0) {
    const { extractElements } = await import("./element-extraction.js");
    const elements = await extractElements("", prompt);
    if (Object.keys(elements).length > 0) {
      updates.elements = elements;
    }
  }
  
  if (Object.keys(updates).length > 0) {
    return updateCorpusEntry(id, updates);
  }
  
  return entry;
}

// Bulk enrich all entries (run during idle time)
export async function enrichCorpusBatch(batchSize = 10): Promise<number> {
  const corpus = await getCorpus();
  const entries = Array.from(corpus.values());
  
  // Find entries missing embeddings or elements
  const needsEnrichment = entries.filter(
    e => (!e.promptEmbedding && e.prompt) || Object.keys(e.elements).length === 0
  );
  
  const batch = needsEnrichment.slice(0, batchSize);
  let enrichedCount = 0;
  
  for (const entry of batch) {
    const result = await enrichCorpusEntry(entry.id, entry.prompt, entry.description);
    if (result) enrichedCount++;
  }
  
  return enrichedCount;
}

export async function searchCorpusByElement(
  elementType: string,
  value: string
): Promise<ImageCorpusEntry[]> {
  const corpus = await getCorpus();
  const entries = Array.from(corpus.values());
  
  return entries.filter(entry => 
    entry.elements[elementType]?.some(e => 
      e.toLowerCase().includes(value.toLowerCase())
    )
  );
}

export async function getCorpusByChat(chatId: string): Promise<ImageCorpusEntry[]> {
  const corpus = await getCorpus();
  return Array.from(corpus.values()).filter(e => e.chatId === chatId);
}

export async function getCorpusByProject(projectId: string): Promise<ImageCorpusEntry[]> {
  const corpus = await getCorpus();
  return Array.from(corpus.values()).filter(e => e.projectId === projectId);
}

// Initialize corpus on module load
getCorpus().catch(console.error);
