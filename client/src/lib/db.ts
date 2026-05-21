import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Chat, ChatListItem, ImageAttachment } from "../types";

interface QueuedMessage {
  id?: number;
  chatId: string;
  message: string;
  images?: ImageAttachment[];
  timestamp: number;
}

interface PorrimaDB extends DBSchema {
  chatList: {
    key: string;
    value: { key: string; items: ChatListItem[] };
  };
  chats: {
    key: string;
    value: Chat;
  };
  messageQueue: {
    key: number;
    value: QueuedMessage;
    indexes: { "by-chatId": string };
  };
}

const DB_NAME = "porrima-db";
const LEGACY_DB_NAME = "quje-agent-db";

let dbPromise: Promise<IDBPDatabase<PorrimaDB>> | null = null;
let legacyMigrationPromise: Promise<void> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await openDB<PorrimaDB>(DB_NAME, 1, {
        upgrade(db) {
          db.createObjectStore("chatList");
          db.createObjectStore("chats", { keyPath: "id" });
          const queue = db.createObjectStore("messageQueue", {
            keyPath: "id",
            autoIncrement: true,
          });
          queue.createIndex("by-chatId", "chatId");
        },
      });
      await migrateLegacyDB(db);
      return db;
    })();
  }
  return dbPromise;
}

async function openLegacyDB(): Promise<IDBPDatabase<PorrimaDB>> {
  return openDB<PorrimaDB>(LEGACY_DB_NAME, 1, {
      upgrade(db) {
        db.createObjectStore("chatList");
        db.createObjectStore("chats", { keyPath: "id" });
        const queue = db.createObjectStore("messageQueue", {
          keyPath: "id",
          autoIncrement: true,
        });
        queue.createIndex("by-chatId", "chatId");
      },
  });
}

async function migrateLegacyDB(db: IDBPDatabase<PorrimaDB>): Promise<void> {
  if (legacyMigrationPromise) return legacyMigrationPromise;
  legacyMigrationPromise = (async () => {
    const hasCurrentData =
      (await db.count("chatList")) > 0 ||
      (await db.count("chats")) > 0 ||
      (await db.count("messageQueue")) > 0;
    if (hasCurrentData) return;

    const legacy = await openLegacyDB();
    try {
      for (const row of await legacy.getAll("chatList")) {
        await db.put("chatList", row, row.key);
      }
      for (const chat of await legacy.getAll("chats")) {
        await db.put("chats", chat);
      }
      for (const queued of await legacy.getAll("messageQueue")) {
        await db.put("messageQueue", queued);
      }
    } finally {
      legacy.close();
    }
  })();
  return legacyMigrationPromise;
}

// Chat list cache
export async function getCachedChatList(): Promise<ChatListItem[] | null> {
  const db = await getDB();
  const row = await db.get("chatList", "list");
  return row?.items ?? null;
}

export async function setCachedChatList(items: ChatListItem[]): Promise<void> {
  const db = await getDB();
  await db.put("chatList", { key: "list", items }, "list");
}

/**
 * Clear the cached chat list - forces fresh fetch on next refresh.
 * Call this when schema changes or to force re-sync with server.
 */
export async function clearCachedChatList(): Promise<void> {
  const db = await getDB();
  await db.delete("chatList", "list");
}

// Individual chat cache
export async function getCachedChat(id: string): Promise<Chat | null> {
  const db = await getDB();
  return (await db.get("chats", id)) ?? null;
}

export async function setCachedChat(chat: Chat): Promise<void> {
  const db = await getDB();
  await db.put("chats", chat);
}

export async function clearCachedChat(id: string): Promise<void> {
  const db = await getDB();
  await db.delete("chats", id);
}

// Message queue
export async function enqueueMessage(
  chatId: string,
  message: string,
  images?: ImageAttachment[]
): Promise<number> {
  const db = await getDB();
  return db.add("messageQueue", {
    chatId,
    message,
    images,
    timestamp: Date.now(),
  });
}

export async function dequeueMessage(id: number): Promise<void> {
  const db = await getDB();
  await db.delete("messageQueue", id);
}

export async function getQueuedMessages(): Promise<QueuedMessage[]> {
  const db = await getDB();
  return db.getAll("messageQueue");
}

export async function getQueuedMessagesForChat(
  chatId: string
): Promise<QueuedMessage[]> {
  const db = await getDB();
  return db.getAllFromIndex("messageQueue", "by-chatId", chatId);
}

export async function getQueuedMessageCount(): Promise<number> {
  const db = await getDB();
  return db.count("messageQueue");
}

export type { QueuedMessage };
