/**
 * Chat Poster — Post system messages to a chat from background processes.
 * Used by scheduler and other automated systems to log progress/results.
 */

import { getChat, saveChat, listChats, createChat, getSettings } from "./chat-storage.js";
import type { Chat, ChatMessage, GeneratedImage } from "../types.js";

const DIRECTIONS_PROJECT_ID = "creative-engine-directions";

/**
 * Find or create the Creative Directions chat.
 * Returns the chat ID for posting messages.
 */
export async function findOrCreateDirectionsChat(): Promise<Chat> {
  const chats = await listChats();
  const existing = chats.find(c => c.projectId === DIRECTIONS_PROJECT_ID);
  
  if (existing) {
    const chat = await getChat(existing.id);
    if (chat) return chat;
  }
  
  // Create new directions chat
  const settings = await getSettings();
  const chat: Chat = {
    id: crypto.randomUUID(),
    title: "Creative Directions",
    type: "agent",
    modelId: settings.defaultModelId || "qwen3:8b",
    systemPrompt: settings.defaultSystemPrompt || "You are a helpful assistant.",
    projectId: DIRECTIONS_PROJECT_ID,
    messages: [],
    createdAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
  };
  
  await createChat(chat);
  return chat;
}

/**
 * Post a system message to a chat.
 * This inserts a message into the chat history without triggering agent response.
 * 
 * @param chatId - The chat to post to
 * @param content - The message content
 * @param options - Optional metadata (images, etc.)
 */
export async function postSystemMessage(
  chatId: string,
  content: string,
  options: {
    images?: GeneratedImage[];
    directionId?: string;
    isProgress?: boolean;
  } = {}
): Promise<void> {
  const chat = await getChat(chatId);
  if (!chat) throw new Error(`Chat ${chatId} not found`);
  
  const message: ChatMessage = {
    role: "assistant",
    content,
    timestamp: Date.now(),
    generatedImages: options.images,
    _isSystemMessage: true, // Flag to distinguish from agent responses
  };
  
  chat.messages.push(message);
  chat.lastModified = new Date().toISOString();
  
  await saveChat(chat);
  
  // TODO: Emit SSE event if chat is currently open (for real-time updates)
  // This would require tracking active SSE connections per chat
}

/**
 * Post a progress update for a direction execution.
 * Formats the message consistently.
 */
export async function postDirectionProgress(
  chatId: string,
  directionId: string,
  status: "started" | "iteration" | "complete" | "failed",
  details: {
    description?: string;
    type?: string;
    iteration?: number;
    maxIterations?: number;
    imageUrl?: string;
    error?: string;
  }
): Promise<void> {
  let content: string;
  
  switch (status) {
    case "started":
      content = `🎨 **Starting:** ${details.type || "Direction"} — ${details.description || ""}`;
      break;
    case "iteration":
      content = `🔄 **Iteration ${details.iteration}/${details.maxIterations}** for ${details.type || "direction"}`;
      break;
    case "complete":
      content = `✅ **Complete:** ${details.type || "Direction"} — ${details.description || ""}`;
      break;
    case "failed":
      content = `❌ **Failed:** ${details.type || "Direction"} — ${details.error || "Unknown error"}`;
      break;
  }
  
  const images: GeneratedImage[] = [];
  if (details.imageUrl) {
    // Parse image ID from URL if needed
    const imageId = details.imageUrl.replace("/api/images/", "").split("/")[0];
    images.push({
      id: imageId,
      url: details.imageUrl,
      thumbUrl: `${details.imageUrl}/thumb`,
      createdAt: new Date().toISOString(),
      params: {
        positivePrompt: "",
        model: "",
        steps: 0,
        cfgScale: 0,
        width: 0,
        height: 0,
      },
      resolvedSeed: -1,
    } as GeneratedImage);
  }
  
  await postSystemMessage(chatId, content, {
    images: images.length > 0 ? images : undefined,
    directionId,
    isProgress: true,
  });
}

/**
 * Post a cycle summary after all directions are executed.
 */
export async function postCycleSummary(
  chatId: string,
  total: number,
  successful: number,
  failed: number,
  results: Array<{ directionId: string; imageUrl?: string; error?: string }>
): Promise<void> {
  const content = `## 🎨 Creative Cycle Complete

**Results:** ${successful}/${total} successful, ${failed} failed

${results.map((r, i) => {
  if (r.error) {
    return `❌ Direction ${i + 1}: ${r.error}`;
  }
  return `✅ Direction ${i + 1}: [View Image](${r.imageUrl})`;
}).join("\n")}
`;
  
  await postSystemMessage(chatId, content);
}
