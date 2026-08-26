import { readFile, writeFile, unlink, mkdir, readdir } from "fs/promises";
import { join } from "path";
import type { ImageAttachment } from "../types.js";
import { appDataPath } from "./paths.js";

const QUEUE_DIR = appDataPath("queue");
const MAX_QUEUE_SIZE = 10;

/**
 * How recent a queued message must be to count as "the user is actively
 * waiting". Read at module load, overridable for tests/diagnostics.
 */
const QUEUE_ACTIVITY_WINDOW_MS =
  Number(process.env.QUEUE_ACTIVITY_WINDOW_MS) || 30 * 60_000;

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

/**
 * Visible (non-hidden) queued-message counts for every chat with a non-empty
 * queue. Merges the in-memory map with the on-disk queue directory so results
 * are correct even for chats whose queue hasn't been lazily loaded yet
 * (e.g. right after a server restart, before the first loadFromDisk call).
 * Hidden entries (artifact repairs) don't count — they aren't user messages.
 */
export async function listVisibleQueueCounts(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const countItems = (chatId: string, items: QueuedUserMessage[]) => {
    const visible = items.reduce((n, item) => n + (item.hidden ? 0 : 1), 0);
    if (visible > 0) counts.set(chatId, visible);
  };

  // In-memory queues are the live truth. Empty arrays are skipped so a stale
  // disk file (failed unlink) still gets reported from the disk pass below.
  for (const [chatId, items] of queues) {
    if (items.length === 0) continue;
    countItems(chatId, items);
  }

  let files: string[] = [];
  try {
    files = await readdir(QUEUE_DIR);
  } catch {
    return counts; // no queue dir yet
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const chatId = file.slice(0, -".json".length);
    if (counts.has(chatId)) continue; // already counted from memory
    try {
      const items = JSON.parse(await readFile(join(QUEUE_DIR, file), "utf-8")) as QueuedUserMessage[];
      countItems(chatId, items);
    } catch {
      // Corrupt or mid-write file — skip; loadFromDisk handles per-chat recovery
    }
  }
  return counts;
}

/**
 * Chats whose user is actively waiting on queued messages.
 *
 * A queued message drains the instant its chat's turn ends, so a *fresh*
 * visible item that has not drained means the turn is still in flight
 * (possibly between LLM calls) or the user is paused at a prompt — the user
 * is at the keyboard and more turns are coming. Background work (cache
 * prewarm) should yield to that.
 *
 * Items older than the activity window are treated as stranded (a server
 * restart killed the turn, or the user queued from another device and walked
 * away) and do not count: a queue nobody is coming back to must not starve
 * background work forever.
 */
export async function listActiveQueueChats(
  windowMs: number = QUEUE_ACTIVITY_WINDOW_MS,
): Promise<string[]> {
  const now = Date.now();
  const active: string[] = [];

  const consider = (chatId: string, items: QueuedUserMessage[]) => {
    const newestVisible = items.reduce(
      (max, item) => (item.hidden ? max : Math.max(max, item.timestamp)),
      0,
    );
    if (newestVisible > 0 && now - newestVisible < windowMs) {
      active.push(chatId);
    }
  };

  for (const [chatId, items] of queues) {
    if (items.length === 0) continue;
    consider(chatId, items);
  }

  let files: string[] = [];
  try {
    files = await readdir(QUEUE_DIR);
  } catch {
    return active; // no queue dir yet
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const chatId = file.slice(0, -".json".length);
    // The in-memory map is the live truth, including the "emptied" state: a
    // drained queue suppresses a stale disk file (unlike listVisibleQueueCounts,
    // which reports it as a failed-unlink safeguard).
    if (queues.has(chatId)) continue;
    try {
      const items = JSON.parse(await readFile(join(QUEUE_DIR, file), "utf-8")) as QueuedUserMessage[];
      if (items.length > 0) consider(chatId, items);
    } catch {
      // Corrupt or mid-write file — skip; loadFromDisk handles per-chat recovery
    }
  }
  return active;
}
