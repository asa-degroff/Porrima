import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { Message } from "@mariozechner/pi-ai";

const PENDING_DIR = join(homedir(), ".quje-agent", "pending");

export interface PendingAgentState {
  piMessages: Message[];
  systemPrompt: string;
  askToolCallId: string;
}

export async function savePendingState(
  chatId: string,
  state: PendingAgentState
): Promise<void> {
  await mkdir(PENDING_DIR, { recursive: true });
  const filePath = join(PENDING_DIR, `${chatId}.json`);
  await writeFile(filePath, JSON.stringify(state), "utf-8");
}

export async function loadPendingState(
  chatId: string
): Promise<PendingAgentState | null> {
  try {
    const filePath = join(PENDING_DIR, `${chatId}.json`);
    const content = await readFile(filePath, "utf-8");
    // Delete the file after loading (one-time use)
    await unlink(filePath).catch(() => {});
    return JSON.parse(content) as PendingAgentState;
  } catch {
    return null;
  }
}

export async function hasPendingState(chatId: string): Promise<boolean> {
  try {
    const filePath = join(PENDING_DIR, `${chatId}.json`);
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}
