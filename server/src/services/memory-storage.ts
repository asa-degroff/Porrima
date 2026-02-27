import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { cosineSimilarity } from "./embeddings.js";
import type { Memory, MemoryStore } from "../types.js";

const BASE_DIR = join(homedir(), ".quje-agent");
const MEMORY_DIR = join(BASE_DIR, "memory");
const MEMORY_FILE = join(MEMORY_DIR, "memories.json");
const DAILY_DIR = join(MEMORY_DIR, "daily");

async function ensureMemoryDir() {
  await mkdir(MEMORY_DIR, { recursive: true });
}

async function ensureDailyDir() {
  await mkdir(DAILY_DIR, { recursive: true });
}

export async function loadMemoryStore(): Promise<MemoryStore> {
  await ensureMemoryDir();
  try {
    const data = await readFile(MEMORY_FILE, "utf-8");
    return JSON.parse(data) as MemoryStore;
  } catch {
    return { memories: [], lastSynthesis: null };
  }
}

export async function saveMemoryStore(store: MemoryStore): Promise<void> {
  await ensureMemoryDir();
  await writeFile(MEMORY_FILE, JSON.stringify(store, null, 2));
}

export async function addMemory(memory: Memory): Promise<void> {
  const store = await loadMemoryStore();
  store.memories.push(memory);
  await saveMemoryStore(store);
}

export async function updateMemory(
  id: string,
  updates: Partial<Omit<Memory, "id">>
): Promise<boolean> {
  const store = await loadMemoryStore();
  const idx = store.memories.findIndex((m) => m.id === id);
  if (idx === -1) return false;
  store.memories[idx] = { ...store.memories[idx], ...updates };
  await saveMemoryStore(store);
  return true;
}

export async function deleteMemory(id: string): Promise<boolean> {
  const store = await loadMemoryStore();
  const before = store.memories.length;
  store.memories = store.memories.filter((m) => m.id !== id);
  if (store.memories.length === before) return false;
  await saveMemoryStore(store);
  return true;
}

export interface ScoredMemory {
  memory: Memory;
  score: number;
}

export async function searchMemories(
  queryEmbedding: number[],
  topK: number,
  now: Date = new Date()
): Promise<ScoredMemory[]> {
  const store = await loadMemoryStore();
  const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

  const scored: ScoredMemory[] = store.memories.map((memory) => {
    const sim = cosineSimilarity(queryEmbedding, memory.embedding);
    const ageMs = now.getTime() - new Date(memory.lastAccessed).getTime();
    const recencyDecay = Math.pow(0.5, ageMs / HALF_LIFE_MS);
    const importanceWeight = memory.importance / 10;
    const score = sim * recencyDecay * importanceWeight;
    return { memory, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

export async function saveDailyLog(
  date: string,
  content: string
): Promise<void> {
  await ensureDailyDir();
  const filePath = join(DAILY_DIR, `${date}.md`);
  await writeFile(filePath, content);
}
