import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import type { ImageAttachment } from "../types.js";
import { appDataPath } from "./paths.js";

const QUEUE_DIR = appDataPath("queue");
const MAX_QUEUE_SIZE = 10;

export interface QueuedUserMessage {
  id: string;
  message: string;
  images?: ImageAttachment[];
  timestamp: number;
  hidden?: boolean;
  kind?: "user" | "artifact_repair";
  metadata?: Record<string, unknown>;
}

/** In-memory queues per chat */
const queues = new Map<string, QueuedUserMessage[]>();

async function persistQueue(chatId: string): Promise<void> {
  const queue = queues.get(chatId);
  await mkdir(QUEUE_DIR, { recursive: true });
  const filePath = join(QUEUE_DIR, `${chatId}.json`);
  if (!queue || queue.length === 0) {
    await unlink(filePath).catch(() => {});
    return;
  }
  await writeFile(filePath, JSON.stringify(queue), "utf-8");
}

export async function enqueue(
  chatId: string,
  message: string,
  images?: ImageAttachment[],
  options?: {
    hidden?: boolean;
    kind?: QueuedUserMessage["kind"];
    metadata?: Record<string, unknown>;
  }
): Promise<QueuedUserMessage> {
  const item: QueuedUserMessage = {
    id: crypto.randomUUID(),
    message,
    images,
    timestamp: Date.now(),
    hidden: options?.hidden || undefined,
    kind: options?.kind || undefined,
    metadata: options?.metadata,
  };
  let queue = queues.get(chatId);
  if (!queue) {
    queue = [];
    queues.set(chatId, queue);
  }
  if (queue.length >= MAX_QUEUE_SIZE) {
    throw new Error(`Queue full (max ${MAX_QUEUE_SIZE} messages)`);
  }
  queue.push(item);
  await persistQueue(chatId);
  return item;
}

export async function drainOne(chatId: string): Promise<QueuedUserMessage | null> {
  const queue = queues.get(chatId);
  if (!queue || queue.length === 0) return null;
  const item = queue.shift()!;
  await persistQueue(chatId);
  return item;
}

export function peek(chatId: string): QueuedUserMessage | null {
  const queue = queues.get(chatId);
  if (!queue || queue.length === 0) return null;
  return queue[0];
}

export async function loadFromDisk(chatId: string): Promise<void> {
  if (queues.has(chatId) && queues.get(chatId)!.length > 0) return;
  try {
    const filePath = join(QUEUE_DIR, `${chatId}.json`);
    const content = await readFile(filePath, "utf-8");
    const items = JSON.parse(content) as QueuedUserMessage[];
    if (items.length > 0) {
      queues.set(chatId, items);
    }
  } catch {
    // No queue file — that's fine
  }
}

export async function clear(chatId: string): Promise<void> {
  queues.delete(chatId);
  await persistQueue(chatId);
}
