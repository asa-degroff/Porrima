import { EventEmitter } from "events";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { ImageGenerationParams, GeneratedImage } from "../types.js";
import { addCorpusEntry, enrichCorpusEntry } from "./image-corpus.js";

const IMAGES_DIR = join(homedir(), ".quje-agent", "images");
const GENERATIONS_FILE = join(IMAGES_DIR, "generations.json");

export type GenerationStatus = "queued" | "processing" | "completed" | "error";

export interface GenerationState {
  id: string;           // Our unique generation ID (UUID)
  chatId?: string;      // Optional: associated chat
  promptId?: string;    // ComfyUI prompt ID
  clientId: string;     // ComfyUI client ID (for WebSocket)
  params: ImageGenerationParams;
  status: GenerationStatus;
  progress: { step: number; total: number } | null;
  imageUrl?: string;    // Set when completed
  error?: string;       // Set when failed
  createdAt: number;    // Timestamp
  updatedAt: number;    // Last state change
}

// In-memory store
const generations = new Map<string, GenerationState>();
const events = new EventEmitter();

// Debounced persist to disk
let persistTimeout: ReturnType<typeof setTimeout> | null = null;

async function persistGenerations() {
  if (persistTimeout) clearTimeout(persistTimeout);
  persistTimeout = setTimeout(async () => {
    try {
      await mkdir(IMAGES_DIR, { recursive: true });
      const data = Array.from(generations.values());
      await writeFile(GENERATIONS_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error("[image-generation] failed to persist:", err);
    }
  }, 500);
}

export async function loadGenerations(): Promise<void> {
  try {
    const raw = await readFile(GENERATIONS_FILE, "utf-8");
    const data: GenerationState[] = JSON.parse(raw);
    let staleCount = 0;
    for (const gen of data) {
      // Generations that were in-flight can't survive a server restart —
      // ComfyUI WebSocket connections are lost, so mark them as failed.
      if (gen.status === "processing" || gen.status === "queued") {
        gen.status = "error";
        gen.error = "Server restarted while generation was in progress";
        gen.progress = null;
        gen.updatedAt = Date.now();
        staleCount++;
      }
      const age = Date.now() - gen.updatedAt;
      const oneDay = 24 * 60 * 60 * 1000;
      if (age < oneDay) {
        generations.set(gen.id, gen);
      }
    }
    if (staleCount > 0) {
      console.log(`[image-generation] marked ${staleCount} stale generation(s) as error`);
      persistGenerations();
    }
    console.log(`[image-generation] loaded ${generations.size} generations from disk`);
  } catch {
    // File doesn't exist or is corrupted - start fresh
  }
}

export function createGeneration(
  params: ImageGenerationParams,
  chatId?: string
): GenerationState {
  const id = crypto.randomUUID();
  const now = Date.now();
  const state: GenerationState = {
    id,
    chatId,
    clientId: crypto.randomUUID(),
    params,
    status: "queued",
    progress: null,
    createdAt: now,
    updatedAt: now,
  };
  generations.set(id, state);
  persistGenerations();
  return state;
}

export function getGeneration(id: string): GenerationState | undefined {
  return generations.get(id);
}

export function getAllGenerations(): GenerationState[] {
  return Array.from(generations.values()).sort(
    (a, b) => b.createdAt - a.createdAt
  );
}

export function getGenerationsByChat(chatId: string): GenerationState[] {
  return Array.from(generations.values())
    .filter((g) => g.chatId === chatId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function updateGeneration(
  id: string,
  updates: Partial<GenerationState>
): GenerationState | undefined {
  const existing = generations.get(id);
  if (!existing) return undefined;

  const updated = { ...existing, ...updates, updatedAt: Date.now() };
  generations.set(id, updated);
  persistGenerations();

  // Emit event for SSE subscribers
  events.emit(`generation:${id}`, updated);
  events.emit("generation:update", updated);

  return updated;
}

export function linkComfyUIIds(
  id: string,
  promptId: string
): GenerationState | undefined {
  return updateGeneration(id, { promptId, status: "processing" });
}

export function updateProgress(
  id: string,
  step: number,
  total: number
): GenerationState | undefined {
  return updateGeneration(id, { progress: { step, total } });
}

export async function completeGeneration(
  id: string,
  imageUrl: string
): Promise<GenerationState | undefined> {
  const updated = updateGeneration(id, {
    status: "completed",
    imageUrl,
    progress: null,
  });
  
  if (updated) {
    // Add to image corpus
    const corpusEntry = {
      id: crypto.randomUUID(),
      type: "generated" as const,
      imagePath: imageUrl.replace("/api/images/", ""),
      thumbnailPath: undefined, // Will be generated if needed
      prompt: updated.params.positivePrompt,
      description: "", // Will be enriched later
      elements: {},
      promptEmbedding: undefined, // Will be enriched
      createdAt: updated.createdAt,
      updatedAt: Date.now(),
      chatId: updated.chatId,
      generationId: updated.id,
    };
    
    // Enrich with embedding and elements (async, non-blocking)
    enrichCorpusEntry(corpusEntry.id, updated.params.positivePrompt, undefined).catch(console.error);
    
    await addCorpusEntry(corpusEntry);
  }
  
  return updated;
}

export function failGeneration(
  id: string,
  error: string
): GenerationState | undefined {
  return updateGeneration(id, {
    status: "error",
    error,
    progress: null,
  });
}

export function deleteGeneration(id: string): boolean {
  const deleted = generations.delete(id);
  if (deleted) persistGenerations();
  return deleted;
}

// SSE subscription
export function subscribeToGeneration(
  id: string,
  callback: (state: GenerationState) => void
): () => void {
  const handler = (state: GenerationState) => callback(state);
  events.on(`generation:${id}`, handler);

  // Return unsubscribe function
  return () => events.off(`generation:${id}`, handler);
}

// Clean up old completed generations (keep last 100)
export function cleanupOldGenerations(maxCount = 100): void {
  const all = getAllGenerations();
  const completed = all.filter((g) => g.status === "completed" || g.status === "error");

  if (completed.length > maxCount) {
    const toDelete = completed.slice(maxCount);
    for (const gen of toDelete) {
      generations.delete(gen.id);
    }
    persistGenerations();
    console.log(`[image-generation] cleaned up ${toDelete.length} old generations`);
  }
}
