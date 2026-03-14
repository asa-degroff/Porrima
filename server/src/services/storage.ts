import { readFile, writeFile, readdir, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { Chat, ChatListItem, Settings } from "../types.js";

const BASE_DIR = join(homedir(), ".quje-agent");
const STORAGE_DIR = join(BASE_DIR, "chats");
const SETTINGS_PATH = join(BASE_DIR, "settings.json");

async function ensureDir() {
  await mkdir(STORAGE_DIR, { recursive: true });
}

function chatPath(id: string): string {
  return join(STORAGE_DIR, `${id}.json`);
}

export async function listChats(): Promise<ChatListItem[]> {
  await ensureDir();
  const files = await readdir(STORAGE_DIR);
  const chats: ChatListItem[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const data = await readFile(join(STORAGE_DIR, file), "utf-8");
      const chat: Chat = JSON.parse(data);
      const lastMsg = chat.messages[chat.messages.length - 1];
      chats.push({
        id: chat.id,
        title: chat.title,
        type: chat.type || "quick",
        lastModified: chat.lastModified,
        preview: lastMsg
          ? lastMsg.content.slice(0, 100)
          : "",
        ...(chat.projectId ? { projectId: chat.projectId } : {}),
      });
    } catch {
      // skip corrupt files
    }
  }

  return chats.sort(
    (a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime()
  );
}

export async function getChat(id: string): Promise<Chat | null> {
  try {
    const data = await readFile(chatPath(id), "utf-8");
    const chat = JSON.parse(data) as Chat;
    if (!chat.type) chat.type = "quick";
    return chat;
  } catch {
    return null;
  }
}

export async function saveChat(chat: Chat): Promise<void> {
  await ensureDir();
  chat.lastModified = new Date().toISOString();
  await writeFile(chatPath(chat.id), JSON.stringify(chat, null, 2));
}

export async function deleteChat(id: string): Promise<boolean> {
  try {
    await unlink(chatPath(id));
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_SETTINGS: Settings = {
  defaultModelId: "",
  defaultSystemPrompt: "You are a helpful assistant.",
  braveApiKey: "",
};

export async function getSettings(): Promise<Settings> {
  try {
    const data = await readFile(SETTINGS_PATH, "utf-8");
    return { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: Settings): Promise<Settings> {
  await mkdir(BASE_DIR, { recursive: true });
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  await writeFile(SETTINGS_PATH, JSON.stringify(merged, null, 2));
  return merged;
}
